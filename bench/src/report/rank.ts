import type { TaskCategory } from '../tasks/schema.js';
import { betterFirst, isRankable, metricDescriptor, type MetricId } from './metrics.js';
import { spreadsOverlap, type SpreadReport } from './spread.js';

/**
 * The ordering, and the four conditions under which there is not one.
 *
 * **This file must never import `node:fs`.** See `metrics.ts`.
 *
 * This is the module the whole slice exists for. A benchmark that produces
 * confident rankings from too little evidence is the exact failure the product
 * argues against, appearing in its own output, so the default here is to
 * withhold and the ranking is what has to earn its way out.
 *
 * The tie rule is the part worth reading twice. Even when all four conditions
 * pass, two adjacent backends whose observed interquartile ranges overlap are
 * reported **tied at this sample size** rather than ordered. That is a
 * descriptive check over observed values and it is not a significance test:
 * BENCH-13 owns bootstrap intervals, paired differences and clustered standard
 * errors. The prior art's finding is that every published deep-research ranking
 * it could find is a point-estimate ordering with unquantified uncertainty, and
 * an overlap check is the cheapest honest thing available until the statistics
 * land. Every ranking carries that sentence, so nobody quotes the order without
 * it.
 */

/** The sentence that rides on every ranking. Exported so tests assert on it. */
export const OVERLAP_NOTE =
  'Two backends are reported tied when their observed interquartile ranges overlap. That is a descriptive check over observed values, not a significance test: bootstrap intervals and paired differences are BENCH-13.';

export type WithheldReason =
  | 'metric-not-rankable'
  | 'scope-not-scorable'
  /**
   * Nobody has a value at all, which is a different statement from nobody
   * having enough of them. Kept apart because "only 0 backends could be
   * compared" reads as a sampling problem when the truth is that the metric was
   * never measured here, and those have different fixes.
   */
  | 'metric-not-measured'
  | 'sample-below-spread-floor'
  | 'too-few-candidates';

export interface RankCandidate {
  readonly provider: string;
  /** The figure being ordered. A candidate with no figure never enters. */
  readonly value: SpreadReport | null;
  /** Whether this backend may be scored in this scope at all. */
  readonly scorable: boolean;
  /** Why not, when it may not. Carried into the withheld reason. */
  readonly why: string;
  /** Printed beside the value, always. */
  readonly completionRate: number | null;
  /**
   * Whether the repetitions underneath the value clear the floor.
   *
   * Separate from the value's own spread, and the separation is the point. A
   * backend run once per task across six tasks has a perfectly good six-task
   * spread and no information at all about how much it varies between runs of
   * the same task. Ranking on the first while ignoring the second is precisely
   * the rank ordering of noise `docs/plan/benchmark.md` warns about, and it is
   * the case the brief names: at one repetition, print the numbers and refuse
   * to rank.
   */
  readonly repetitionsMet: boolean;
  /** Why the repetitions fall short, when they do. */
  readonly repetitionsWhy: string;
}

export interface RankedEntry {
  readonly provider: string;
  readonly median: number;
  readonly n: number;
  readonly spread: SpreadReport['spread'];
  readonly completionRate: number | null;
  /**
   * 1-based, and **shared** with the entry above when their spreads overlap.
   * Two backends at rank 2 means the sample cannot separate them, not that
   * somebody forgot to break the tie.
   */
  readonly rank: number;
  readonly tiedWithPrevious: boolean;
}

export type RankScope =
  | { readonly kind: 'category'; readonly category: TaskCategory }
  | { readonly kind: 'overall' };

export interface Ranking {
  readonly metric: MetricId;
  readonly scope: RankScope;
  /** Null whenever the sample cannot support an ordering. */
  readonly entries: readonly RankedEntry[] | null;
  readonly withheld: WithheldReason | null;
  /** Always populated: either the overlap note, or why there is no ordering. */
  readonly note: string;
  /** Candidates that could not enter, and why. Never silently dropped. */
  readonly excluded: readonly { readonly provider: string; readonly why: string }[];
}

function scopeName(scope: RankScope): string {
  return scope.kind === 'overall' ? 'overall' : `the ${scope.category} category`;
}

/**
 * Order the backends, or say why not.
 *
 * `scopeScorable` is the category's verdict, computed by `aggregate.ts` and
 * passed in rather than re-derived. Two implementations of "is this scorable"
 * eventually disagree about what the rule is, which is the argument this repo
 * already makes for building the benchmark beside the product rather than
 * beyond it.
 */
export function rankBackends(
  metric: MetricId,
  scope: RankScope,
  candidates: readonly RankCandidate[],
  scopeScorable = true,
): Ranking {
  const excluded: { provider: string; why: string }[] = [];

  // 1. The metric must have a direction. A count is not a leaderboard.
  if (!isRankable(metric)) {
    const { family, label } = metricDescriptor(metric);
    return {
      metric,
      scope,
      entries: null,
      withheld: 'metric-not-rankable',
      note: `${label} is a ${family} figure and is never ordered. It says how much a backend did, not how well.`,
      excluded,
    };
  }

  // 2. The scope must be scorable. A category below the task floor cannot
  //    produce an ordering, however many repetitions each backend ran.
  if (!scopeScorable) {
    return {
      metric,
      scope,
      entries: null,
      withheld: 'scope-not-scorable',
      note: `${scopeName(scope)} holds too few tasks to be scored, so there is nothing to rank in it.`,
      excluded,
    };
  }

  // 3. Every candidate must clear the spread floor. At n = 1 this fails for
  //    everyone, which is the brief's headline case: print the numbers, refuse
  //    to rank. A rank ordering without a spread is a rank ordering of noise.
  const eligible: { provider: string; value: SpreadReport; completionRate: number | null }[] = [];
  let belowSpreadFloor = 0;
  let belowRepetitionFloor = 0;
  let floor = 0;
  let withValue = 0;
  for (const candidate of candidates) {
    if (!candidate.scorable) {
      excluded.push({ provider: candidate.provider, why: candidate.why });
      continue;
    }
    if (candidate.value === null) {
      excluded.push({
        provider: candidate.provider,
        why: `${candidate.provider} has no value for this metric in ${scopeName(scope)}`,
      });
      continue;
    }
    withValue += 1;
    if (candidate.value.spread === null) {
      belowSpreadFloor += 1;
      floor = candidate.value.eligibility.floor;
      excluded.push({
        provider: candidate.provider,
        why: `${candidate.provider}: ${candidate.value.spreadWithheld}`,
      });
      continue;
    }
    // The second half of the floor, and the one a two-stage aggregation hides.
    // The value above has a spread across tasks; this asks whether the runs
    // behind those tasks were repeated enough to say anything about the
    // backend's own variation.
    if (!candidate.repetitionsMet) {
      belowRepetitionFloor += 1;
      floor = candidate.value.eligibility.floor;
      excluded.push({
        provider: candidate.provider,
        why: `${candidate.provider}: ${candidate.repetitionsWhy}`,
      });
      continue;
    }
    eligible.push({
      provider: candidate.provider,
      value: candidate.value,
      completionRate: candidate.completionRate,
    });
  }

  // Nobody has a value at all. Said as that, rather than as a comparison of
  // zero backends, because the fix is measuring the metric rather than running
  // more repetitions.
  if (withValue === 0) {
    return {
      metric,
      scope,
      entries: null,
      withheld: 'metric-not-measured',
      note: `no backend has a value for ${metricDescriptor(metric).label} in ${scopeName(scope)}, so there is nothing to order. This is a metric that was never measured here, not a sample too small to separate.`,
      excluded,
    };
  }

  const belowFloor = belowSpreadFloor + belowRepetitionFloor;
  if (belowFloor > 0) {
    // The two shortfalls are named separately because they are different
    // problems with different fixes. Too few results is a sample too small to
    // spread; too few repetitions is a figure that says nothing about how much
    // the backend varies between runs of the same task, however many tasks
    // stand behind it. A two-stage aggregation hides the second one, and
    // hiding it is how a plausible ranking gets assembled out of single runs.
    const causes: string[] = [];
    if (belowSpreadFloor > 0) {
      causes.push(`${String(belowSpreadFloor)} with too few results for a spread`);
    }
    if (belowRepetitionFloor > 0) {
      causes.push(
        `${String(belowRepetitionFloor)} whose tasks were not repeated enough for the spread to say anything about run-to-run variation`,
      );
    }
    return {
      metric,
      scope,
      entries: null,
      withheld: 'sample-below-spread-floor',
      note:
        `Of the ${String(withValue)} backend${withValue === 1 ? '' : 's'} with a value in ${scopeName(scope)}: ${causes.join(', ')}. ` +
        `No ordering is stated. The numbers above are the numbers; the sample is what cannot rank them. ` +
        `The floor is ${String(floor)} results, and this is the point at which a benchmark would otherwise publish a confident ranking it cannot support.`,
      excluded,
    };
  }

  // 4. Two is the smallest ordering that means anything.
  if (eligible.length < 2) {
    return {
      metric,
      scope,
      entries: null,
      withheld: 'too-few-candidates',
      note: `only ${String(eligible.length)} backend${eligible.length === 1 ? '' : 's'} could be scored in ${scopeName(scope)}, which is not a comparison.`,
      excluded,
    };
  }

  const compare = betterFirst(metric);
  const sorted = [...eligible].sort(
    (a, b) => compare(a.value.median, b.value.median) || a.provider.localeCompare(b.provider),
  );

  const entries: RankedEntry[] = [];
  let rank = 0;
  sorted.forEach((entry, index) => {
    const previous = index === 0 ? undefined : sorted[index - 1];
    const tied = previous !== undefined && spreadsOverlap(previous.value, entry.value);
    if (!tied) rank = index + 1;
    entries.push({
      provider: entry.provider,
      median: entry.value.median,
      n: entry.value.n,
      spread: entry.value.spread,
      completionRate: entry.completionRate,
      rank,
      tiedWithPrevious: tied,
    });
  });

  return { metric, scope, entries, withheld: null, note: OVERLAP_NOTE, excluded };
}
