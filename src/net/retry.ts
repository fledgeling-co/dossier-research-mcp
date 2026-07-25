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
 * spends money unless the provider can deduplicate it. A timed-out
 * `createRun` may well have succeeded, and a retry then buys a second $7
 * report. `retry()` is therefore only for reads and for writes carrying a
 * provider-side idempotency key. Paid creation goes through
 * `attemptOnceThenSettle`, which prefers an orphaned run over a duplicate
 * charge, because one is a support question and the other is a refund request.
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

function statusOf(error: unknown): number | undefined {
  const e = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } } | null;
  for (const v of [e?.status, e?.statusCode, e?.response?.status]) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
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

      const cap = Math.min(baseMs * 2 ** (attempt - 1), maxDelayMs);
      const jittered = Math.max(1, Math.floor(random() * cap));
      // A provider that told us how long to wait knows better than our guess.
      const delayMs = retryAfterMs(error) ?? jittered;
      opts.onRetry?.({ attempt, delayMs, kind, error });
      await sleep(delayMs);
    }
  }
  throw lastError;
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
