/**
 * Retry with exponential backoff, jitter, and a hard rule about money.
 *
 * Before this existed the server had one fixed 2-second delay in the stream
 * supervisor and nothing else. The poller ran on a fixed `setInterval` with its
 * errors swallowed, so a 429 produced exactly the same request rate as a 200:
 * the one situation where backing off is the entire remedy was the one
 * situation nothing backed off. Provider rate limits are real and per-tier
 * (OpenAI publishes RPM per usage tier, Perplexity and xAI have their own), so
 * a research server that polls several providers needs this as infrastructure
 * rather than as a per-call afterthought.
 *
 * **The rule that matters more than the algorithm:** never retry a call that
 * spends money when the outcome is unknown. A timed-out `createRun` may well
 * have succeeded, and a retry then buys a second $7 report. `retry()` is
 * therefore only for reads and for writes carrying a provider-side idempotency
 * key. Paid creation goes through `attemptOnceThenSettle`, which prefers an
 * orphaned run over a duplicate charge, because one is a support question and
 * the other is a refund request.
 *
 * That rule used to be enforced as "attempt exactly once", which was too
 * coarse. **Unknown** and **refused** are not the same thing: a 429 is the
 * provider declining to admit the request and naming a wait, and treating it
 * like a timeout turned a one-second pause into two dead $9 runs. The statuses
 * that prove nothing was created are enumerated in
 * {@link DEFINITIVE_REJECTION_STATUSES}, with the reasoning per status, because
 * getting that list wrong in the other direction buys a second report.
 */

/** How a failure should be treated. */
export type FailureKind = 'retryable' | 'rate-limited' | 'fatal';

export interface RetryOptions {
  /** Total attempts including the first. */
  readonly attempts?: number;
  /** First backoff step; doubles each attempt. */
  readonly baseMs?: number;
  /** Ceiling for a single wait, before any Retry-After override. */
  readonly maxDelayMs?: number;
  /** Injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; must return [0,1). */
  readonly random?: () => number;
  /** Called before each wait, for logging. */
  readonly onRetry?: (info: { attempt: number; delayMs: number; kind: FailureKind; error: unknown }) => void;
}

const DEFAULTS = { attempts: 4, baseMs: 500, maxDelayMs: 30_000 } as const;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

/**
 * Classify a thrown value. Conservative by design: anything unrecognised is
 * fatal, because retrying an unknown failure against a paid API is the
 * expensive direction to be wrong in.
 */
export function classify(error: unknown): FailureKind {
  const status = statusOf(error);
  if (status === 429) return 'rate-limited';
  if (status !== undefined) {
    if (status === 408 || status === 409 || status === 425) return 'retryable';
    return status >= 500 && status < 600 ? 'retryable' : 'fatal';
  }
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string') {
    // Transport faults: the request demonstrably did not get an answer.
    if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND'].includes(code)) {
      return code === 'ENOTFOUND' ? 'fatal' : 'retryable';
    }
  }
  if (error instanceof Error && error.name === 'TimeoutError') return 'retryable';
  return 'fatal';
}

/**
 * The HTTP status behind a thrown value, following `cause` when it is wrapped.
 *
 * The unwrapping is load-bearing rather than tidy. `GeminiRequestError` wraps
 * the SDK's error and keeps it only on `cause`, so a Gemini 429 arrived here
 * looking like an unrecognised failure: classified `fatal`, never backed off,
 * and never eligible for the rate-limit retry below. Bounded depth, because a
 * cause chain can be circular.
 */
function statusOf(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    const e = current as { status?: unknown; statusCode?: unknown; response?: { status?: unknown }; cause?: unknown };
    for (const v of [e.status, e.statusCode, e.response?.status]) {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    current = e.cause;
  }
  return undefined;
}

/**
 * Statuses that prove the request was **refused**: nothing was created, nothing
 * was queued, and nothing bills.
 *
 * This list is the difference between a safe retry and buying a second $7
 * report, so each entry earns its place separately:
 *
 * - **429** the rate limiter answered. A limiter that returns a response has
 *   declined to admit the request; it has not quietly queued it. This is the
 *   entry that matters: two of the owner's OpenAI runs failed at 429 having
 *   used 923,902 of a 1,000,000 token-per-minute limit, and the provider's own
 *   message asked for a 1.2-second wait. $18 was lost to a wait of about a
 *   second.
 * - **400** the request was malformed. A body the API would not parse cannot
 *   have produced a job.
 * - **401** unauthenticated. Rejected before any handler ran.
 * - **403** unauthorised or entitlement missing. Same: rejected at the door.
 *
 * **Everything else stays ambiguous, on purpose.** Not 404, not 409, not 422,
 * not any 5xx, and not a timeout. Some of those very likely created nothing
 * either, but "very likely" is the wrong standard when being wrong in this
 * direction releases a budget commitment for a report that was in fact bought,
 * or retries a create the provider had already accepted. Holding a commitment
 * that turns out to be unnecessary costs a slightly early refusal; releasing
 * one that was real costs money and hides it.
 */
export const DEFINITIVE_REJECTION_STATUSES: readonly number[] = [400, 401, 403, 429];

/**
 * Did the provider definitively refuse this request?
 *
 * True means nothing was created, so a retry is safe and a budget commitment
 * for it is holding money against a call that never reached a model.
 */
export function isDefinitiveRejection(error: unknown): boolean {
  const status = statusOf(error);
  return status !== undefined && DEFINITIVE_REJECTION_STATUSES.includes(status);
}

/** True when the provider answered 429 specifically. */
export function isRateLimited(error: unknown): boolean {
  return statusOf(error) === 429;
}

/** The status a caller can report, when the provider gave one. */
export function httpStatusOf(error: unknown): number | undefined {
  return statusOf(error);
}

/**
 * A provider-supplied `Retry-After`, in ms, if it gave one.
 *
 * Honouring this matters: guessing a backoff shorter than the provider's own
 * window turns one 429 into a stream of them, and guessing longer wastes time
 * the provider was willing to serve.
 */
export function retryAfterMs(error: unknown, now: number = Date.now()): number | undefined {
  const headers = (error as { headers?: unknown; response?: { headers?: unknown } } | null)?.headers
    ?? (error as { response?: { headers?: unknown } } | null)?.response?.headers;
  if (!headers) return undefined;
  const raw =
    typeof (headers as Headers).get === 'function'
      ? (headers as Headers).get('retry-after')
      : ((headers as Record<string, unknown>)['retry-after'] as string | undefined);
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 300_000);
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.min(Math.max(0, at - now), 300_000);
  return undefined;
}

/**
 * The wait a provider named in the error text, when it sent no `Retry-After`.
 *
 * OpenAI does exactly this: the header is often absent and the body carries
 * `Please try again in 1.236s.` A backoff that ignores it either waits far
 * longer than the provider was willing to serve, or retries early and earns a
 * second 429. Both of the owner's lost runs carried a delay here and no header.
 *
 * Deliberately narrow: it matches only an explicit "try again in <n><unit>",
 * because a looser pattern would find numbers in quota text (`Limit 1000000`)
 * and sleep for eleven days.
 */
export function retryDelayFromMessage(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!message) return undefined;
  const match = /try again in\s+([\d.]+)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?)\b/i.exec(message);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return undefined;
  const unit = (match[2] ?? 's').toLowerCase();
  const ms = unit.startsWith('ms') || unit.startsWith('milli')
    ? value
    : unit.startsWith('m')
      ? value * 60_000
      : value * 1000;
  return Math.min(Math.round(ms), 300_000);
}

/** Exponential step with FULL jitter: `random() * cap`, never `cap/2 + random()`. */
function backoffMs(attempt: number, baseMs: number, maxDelayMs: number, random: () => number): number {
  const cap = Math.min(baseMs * 2 ** (attempt - 1), maxDelayMs);
  return Math.max(1, Math.floor(random() * cap));
}

/**
 * How long to wait before the next attempt.
 *
 * One implementation, used by both the read path and the paid rate-limit path,
 * so the two cannot drift into disagreeing about what `Retry-After` means.
 * Preference order is provider-said-so first: a header, then a delay named in
 * the message, then our own guess.
 */
export function nextRetryDelayMs(
  error: unknown,
  attempt: number,
  opts: { baseMs?: number; maxDelayMs?: number; random?: () => number } = {},
): number {
  return (
    retryAfterMs(error) ??
    retryDelayFromMessage(error) ??
    backoffMs(attempt, opts.baseMs ?? DEFAULTS.baseMs, opts.maxDelayMs ?? DEFAULTS.maxDelayMs, opts.random ?? Math.random)
  );
}

/**
 * Run `fn`, retrying transient failures with exponential backoff and **full
 * jitter** (`random() * cap`, not `cap/2 + random()`).
 *
 * Full jitter matters here specifically. Dossier polls every active run on one
 * timer, so without jitter a rate limit synchronises them: they all fail, all
 * wait the same interval, and all retry in the same instant, reproducing the
 * burst that caused the limit. Spreading retries across the window is the point.
 *
 * Only for idempotent work. See the module note.
 */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? DEFAULTS.attempts;
  const baseMs = opts.baseMs ?? DEFAULTS.baseMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      const kind = classify(error);
      if (kind === 'fatal' || attempt === attempts) throw error;

      // A provider that told us how long to wait knows better than our guess.
      const delayMs = nextRetryDelayMs(error, attempt, { baseMs, maxDelayMs, random });
      opts.onRetry?.({ attempt, delayMs, kind, error });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

/**
 * A charge whose outcome is unknown.
 *
 * The provider was reached, the response was not. The job may or may not exist,
 * and it may or may not bill. That is genuinely worse than a clean failure and
 * the caller must be able to tell the two apart, because the correct response
 * is "go and look at the provider console", never "try again".
 */
export class AmbiguousSpendError extends Error {
  readonly code = 'ambiguous_spend' as const;
  constructor(
    readonly provider: string,
    override readonly cause: unknown,
  ) {
    super(
      `The ${provider} request to create a run did not return a usable response, so it is unknown whether a job was created. ` +
        'It has NOT been retried, because a retry here buys a second report rather than recovering the first. ' +
        `Check your ${provider} console for an in-flight job before starting another. ` +
        `Underlying failure: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'AmbiguousSpendError';
  }
}

/** How the rate-limit retry inside {@link attemptOnceThenSettle} is bounded. */
export interface RateLimitRetryOptions {
  /** Total attempts including the first. */
  readonly attempts?: number;
  /**
   * Ceiling on the SUM of the waits, so a provider asking for five minutes
   * cannot hold a create open past the caller's own patience.
   */
  readonly maxTotalDelayMs?: number;
  /** Absolute epoch-ms deadline; the run's own, when the caller has one. */
  readonly deadlineAt?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const RATE_LIMIT_DEFAULTS = { attempts: 3, maxTotalDelayMs: 30_000 } as const;

/**
 * Run a paid creation, and settle honestly about what happened.
 *
 * The counterpart to `retry()` promised at the top of this file, and the reason
 * it exists: a timed-out `createRun` may well have succeeded, so retrying it
 * buys a second $7 report. One is a support question and the other is a refund
 * request, so this prefers the support question every time.
 *
 * The rule this enforces used to be "attempt exactly once", which was right
 * about timeouts and too coarse about everything else. It conflated two
 * genuinely different situations, and the conflation cost $18:
 *
 * - **Ambiguous.** A timeout, a dropped connection, a 5xx, or anything
 *   unrecognised. The provider may have accepted the request and be billing for
 *   it right now. **Never retried**, ever, for any reason. This raises
 *   `AmbiguousSpendError` and says to check the provider console.
 * - **Definitively rejected.** A status in `DEFINITIVE_REJECTION_STATUSES`
 *   (429, 400, 401, 403). The request was refused, nothing was created and
 *   nothing bills, so the caller gets the provider's own error unchanged and
 *   can fix the request.
 *
 * Only one of those definitive rejections is worth retrying, and it is retried:
 * **a 429 is a wait, not a refusal to serve.** Two of the owner's OpenAI runs
 * died at 429 having used 923,902 of a 1,000,000 token-per-minute limit, with
 * the provider's own message asking for 1.236 seconds. Both were reported as
 * hard failures, both cost $9, and both needed about a second's patience. The
 * wait honours `Retry-After`, then a delay named in the message, then a jittered
 * backoff, and it is bounded by attempt count, by a total-delay ceiling and by
 * the caller's deadline. A 400, 401 or 403 is not retried, because retrying a
 * malformed or unauthorised request just fails again more slowly.
 */
export async function attemptOnceThenSettle<T>(
  fn: () => Promise<T>,
  opts: { readonly provider: string; readonly rateLimit?: RateLimitRetryOptions },
): Promise<T> {
  const rl = opts.rateLimit ?? {};
  const attempts = Math.max(1, rl.attempts ?? RATE_LIMIT_DEFAULTS.attempts);
  const maxTotalDelayMs = rl.maxTotalDelayMs ?? RATE_LIMIT_DEFAULTS.maxTotalDelayMs;
  const sleep = rl.sleep ?? defaultSleep;
  const random = rl.random ?? Math.random;
  let spentMs = 0;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (e: unknown) {
      // Ambiguity is checked FIRST and is never retried. Reordering these two
      // is how a timeout on a request the provider had already accepted turns
      // into a second paid report.
      if (!isDefinitiveRejection(e)) {
        const status = httpStatusOf(e);
        // A status the provider actually returned means it answered. It is not
        // on the definitive list, so nothing here can promise the request was
        // not accepted, but the caller still gets the provider's own error
        // rather than an ambiguity warning that hides it.
        if (typeof status === 'number' && status < 500) throw e;
        throw new AmbiguousSpendError(opts.provider, e);
      }
      if (!isRateLimited(e) || attempt >= attempts) throw e;

      const delayMs = nextRetryDelayMs(e, attempt, { random });
      const wouldExceedBudget = spentMs + delayMs > maxTotalDelayMs;
      const wouldExceedDeadline = rl.deadlineAt !== undefined && Date.now() + delayMs > rl.deadlineAt;
      // Out of patience is a real answer. Sleeping past the caller's deadline
      // to make one more attempt it can no longer use helps nobody.
      if (wouldExceedBudget || wouldExceedDeadline) throw e;

      rl.onRetry?.({ attempt, delayMs, error: e });
      spentMs += delayMs;
      await sleep(delayMs);
    }
  }
}

/**
 * Adaptive interval for a repeating poll.
 *
 * Feed it the count of consecutive failures and it returns how long to wait.
 * Zero failures means the configured interval; each failure doubles it up to a
 * ceiling, so a provider outage degrades to occasional probing instead of a
 * fixed-rate hammer, and recovery snaps straight back to normal cadence.
 */
export function pollDelayMs(
  baseMs: number,
  consecutiveFailures: number,
  opts: { readonly maxMs?: number; readonly random?: () => number } = {},
): number {
  if (consecutiveFailures <= 0) return baseMs;
  const maxMs = opts.maxMs ?? 10 * 60_000;
  const random = opts.random ?? Math.random;
  const cap = Math.min(baseMs * 2 ** Math.min(consecutiveFailures, 10), maxMs);
  // Keep at least the base interval; jitter the growth above it.
  return Math.floor(baseMs + random() * Math.max(0, cap - baseMs));
}
