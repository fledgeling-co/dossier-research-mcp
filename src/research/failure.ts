import { AmbiguousSpendError, httpStatusOf, isDefinitiveRejection, isRateLimited } from '../net/retry.js';
import { ARGV_REJECTION_PATTERN } from '../local/cli.js';

/**
 * Why a run failed, as a thing a caller can branch on.
 *
 * Every failure used to render as the single word `failed`, and that word was
 * doing far too much work. "The adapter's invocation was rejected by the
 * binary" and "the research failed" are not the same event: the first means the
 * software is broken and no question would have succeeded, the second means the
 * question was hard. A `local-codex` adapter sending an argument Codex does not
 * accept died at argument parsing on every single run for months, showed up in
 * the run list as `failed` beside genuine research failures, and cost nothing
 * visible because CLI runs ledger at $0.
 *
 * Kept deliberately small. Four kinds a reader can hold in their head beat a
 * taxonomy nobody consults.
 */
export const RUN_FAILURE_KINDS = [
  /**
   * The binary refused the argv Dossier handed it. The adapter is wrong, not
   * the question, and no amount of re-running will help.
   */
  'adapter-rejected',
  /**
   * The provider answered 429. Nothing was created and nothing bills; the
   * request needed a wait, which is usually seconds.
   */
  'rate-limited',
  /**
   * The provider answered 400, 401 or 403. Nothing was created and nothing
   * bills; the request, the key or the entitlement needs fixing.
   */
  'provider-rejected',
  /**
   * The outcome could not be established: a timeout, a dropped connection, a
   * 5xx, or a status not on the definitive list. The provider may have accepted
   * the request and may be billing for it, so the budget commitment is held.
   */
  'ambiguous',
  /** The run started, ran, and failed on its own terms. */
  'research',
] as const;
export type RunFailureKind = (typeof RUN_FAILURE_KINDS)[number];

/**
 * Was the failure definitively rejected, meaning nothing was bought?
 *
 * The predicate the budget release is keyed on. Only two kinds qualify, and
 * both correspond to a status in `DEFINITIVE_REJECTION_STATUSES`. `ambiguous`
 * deliberately does not: releasing a commitment for a request the provider
 * accepted would under-count spend, which is the one direction a ceiling must
 * never fail.
 */
export function boughtNothing(kind: RunFailureKind | undefined): boolean {
  return kind === 'rate-limited' || kind === 'provider-rejected';
}

/**
 * Classify a throw from a paid create.
 *
 * Conservative in exactly one direction: anything that is not provably a
 * refusal is `ambiguous`, so a 404 or a 409 keeps its budget commitment even
 * though it very likely created nothing. "Very likely" is the wrong standard
 * when being wrong releases money against a report that was really bought.
 */
export function classifyCreateFailure(error: unknown): RunFailureKind {
  if (error instanceof AmbiguousSpendError) return 'ambiguous';
  if (isRateLimited(error)) return 'rate-limited';
  if (isDefinitiveRejection(error)) return 'provider-rejected';
  if (isArgvRejection(error)) return 'adapter-rejected';
  return 'ambiguous';
}

/**
 * Does this text look like an argument parser refusing what it was handed?
 *
 * Shares one pattern with the offline self-test in `local/cli.ts`, so a
 * signature added because a CLI phrases its refusal differently improves both
 * the audit and the run-time label rather than only one of them.
 */
export function isArgvRejection(value: unknown): boolean {
  const text = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  return text.length > 0 && ARGV_REJECTION_PATTERN.test(text);
}

/** One line naming what the kind means, and what to do about it. */
export function describeFailureKind(kind: RunFailureKind, status?: number): string {
  switch (kind) {
    case 'adapter-rejected':
      return (
        'THE ADAPTER IS BROKEN, not the research. The binary refused the invocation Dossier built, at argument parsing, ' +
        'so no research ran and re-running will fail identically. Run `research_doctor` to see the argv self-test for this backend.'
      );
    case 'rate-limited':
      return (
        `Rate limited by the provider${status === undefined ? '' : ` (HTTP ${String(status)})`}. ` +
        'The request was refused, so nothing was created and nothing was charged; the budget commitment has been released. ' +
        'This is usually a wait of seconds. Dossier already retried within its bounded window, so the limit was still in force when it gave up.'
      );
    case 'provider-rejected':
      return (
        `The provider refused the request${status === undefined ? '' : ` (HTTP ${String(status)})`}: nothing was created and nothing was charged, ` +
        'and the budget commitment has been released. Fix the request, the key or the entitlement; retrying unchanged fails the same way.'
      );
    case 'ambiguous':
      return (
        'The outcome is UNKNOWN. The provider may have accepted this request and may be billing for it, so it was not retried ' +
        'and the budget commitment is being held. Check the provider console for an in-flight job before starting another.'
      );
    case 'research':
      return 'The research itself failed after the run started. The provider’s reason is on the record.';
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/** A short tag for a dense listing line. */
export function failureTag(kind: RunFailureKind): string {
  switch (kind) {
    case 'adapter-rejected':
      return 'BROKEN ADAPTER';
    case 'rate-limited':
      return 'rate-limited';
    case 'provider-rejected':
      return 'rejected by provider';
    case 'ambiguous':
      return 'outcome unknown';
    case 'research':
      return 'research failed';
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/** The HTTP status behind a failure, when the provider gave one. */
export function statusOfFailure(error: unknown): number | undefined {
  return httpStatusOf(error);
}
