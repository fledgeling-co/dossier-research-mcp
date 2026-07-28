import { spreadEligibility, type SpreadEligibility } from '../run/cell.js';
import { quantile } from '../stats/quantile.js';

/**
 * A median, and the spread it is only sometimes allowed to carry.
 *
 * **This file must never import `node:fs`.** See `metrics.ts`.
 *
 * The floor lives in `bench/src/run/cell.ts` and is imported, never restated.
 * That file says in terms that the rule lives there once "so the reporting item
 * and the statistics item cannot end up disagreeing about what the floor is",
 * which is an instruction to this file. So `spreadWithheld` below carries
 * `spreadEligibility`'s own wording verbatim rather than a paraphrase, and if
 * the floor moves, every sentence this module prints moves with it.
 *
 * One divergence from the BENCH-08 brief is recorded rather than hidden. The
 * brief says "median with spread ... wherever `n` is above 1";
 * `docs/plan/benchmark.md` says three is the floor at which a spread is
 * reported at all, and BENCH-02 encoded that. The design document governs, so
 * at `n = 2` the value prints with its sample size and an explicit note that
 * the spread was withheld. It is never bare: every value carries `n`, which is
 * the property the brief's sentence is actually protecting.
 */

export interface Spread {
  /** Lower quartile of the sample. */
  readonly q1: number;
  /** Upper quartile. */
  readonly q3: number;
  /** `q3 - q1`. Carried so a reader does not have to subtract. */
  readonly iqr: number;
  readonly min: number;
  readonly max: number;
}

export interface SpreadReport {
  readonly median: number;
  /** How many values went into it. Printed beside every median, always. */
  readonly n: number;
  /** Null below the floor. Never an empty range standing in for one. */
  readonly spread: Spread | null;
  /** Why the spread is null. Empty when it is not. */
  readonly spreadWithheld: string;
  /** The eligibility verdict this was built from, floor included. */
  readonly eligibility: SpreadEligibility;
}

/**
 * The quartile definition lives in `bench/src/stats/quantile.ts`.
 *
 * It was private here until BENCH-13 needed the same function for bootstrap
 * interval endpoints. Two implementations of a quantile is how two tables in
 * one report come to disagree about the 25th percentile of one sample, and this
 * fleet already carries a ledger row for three primitives that came to exist
 * twice. The definition, and the reason for choosing it, are stated there.
 */

/**
 * What the sample is made of, so a withheld spread names the right noun.
 *
 * The floor is one number for all three, because "three samples before a
 * spread means anything" is a statement about sample size rather than about
 * repetitions specifically. What changes is the sentence: a spread across
 * repetitions measures a backend's non-determinism, one across tasks measures
 * how much the category varies, and calling both "repetitions" would make the
 * second unreadable.
 */
export type SampleUnit = 'repetition' | 'task' | 'category';

/**
 * Median with a spread, over the values that actually exist.
 *
 * `values` are the measured ones. `completed` is how many members of the group
 * produced a result at all, and it decides the floor. The two differ whenever a
 * metric was not applicable to some completed cells (a refusal task carries no
 * gold facts, so its accuracy is not applicable rather than zero), and passing
 * the second separately is what stops a metric that four of five cells could
 * not measure from claiming a five-sample spread.
 *
 * Rejects a non-finite value rather than letting one `NaN` propagate silently
 * through a median and out into a published table.
 */
export function summarise(
  values: readonly number[],
  completed: number,
  unit: SampleUnit = 'repetition',
): SpreadReport | null {
  for (const v of values) {
    if (!Number.isFinite(v)) {
      throw new TypeError(
        `summarise needs finite values; received ${String(v)}. A metric that could not be measured must arrive as null and be filtered out before it reaches here, never as a NaN.`,
      );
    }
  }
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lowerMid = sorted[mid - 1];
  const upperMid = sorted[mid];
  if (upperMid === undefined) throw new TypeError('median indexed outside its own sample');
  const median =
    sorted.length % 2 === 1 ? upperMid : ((lowerMid ?? upperMid) + upperMid) / 2;

  // Eligibility is decided on the completed repetitions, never on how many
  // values happened to be measurable, and never on how many were requested. A
  // batch that asked for five and landed two has two samples.
  const eligibility = spreadEligibility(completed);
  const first = sorted[0];
  const lastValue = sorted[sorted.length - 1];
  if (first === undefined || lastValue === undefined) {
    throw new TypeError('spread indexed outside its own sample');
  }

  if (!eligibility.reportable) {
    return {
      median,
      n: values.length,
      spread: null,
      // Verbatim for the repetition case, which is the one `spreadEligibility`
      // is worded for, so the floor's own sentence reaches the page unaltered.
      // Reworded for the other two around the same floor number, because a
      // spread across tasks described as "completed repetitions" is a sentence
      // nobody can act on.
      spreadWithheld:
        unit === 'repetition'
          ? eligibility.reason
          : `only ${String(completed)} ${unit}${completed === 1 ? '' : 's'} with a result, below the floor of ${String(eligibility.floor)}; reported without a spread`,
      eligibility,
    };
  }

  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  return {
    median,
    n: values.length,
    spread: { q1, q3, iqr: q3 - q1, min: first, max: lastValue },
    spreadWithheld: '',
    eligibility,
  };
}

/**
 * Do two spreads overlap?
 *
 * Used by `rank.ts` to mark two backends as tied rather than ordering them.
 * **This is a descriptive check over observed interquartile ranges and it is
 * not a significance test.** BENCH-13 owns bootstrap intervals and paired
 * differences; this was the cheapest honest thing available before they landed, and rank.ts now prefers them where a comparison exists,
 * and every ranking that uses it says so.
 *
 * A missing spread on either side counts as overlapping, because two values
 * whose uncertainty is unknown cannot be separated.
 */
export function spreadsOverlap(a: SpreadReport, b: SpreadReport): boolean {
  if (a.spread === null || b.spread === null) return true;
  return a.spread.q1 <= b.spread.q3 && b.spread.q1 <= a.spread.q3;
}
