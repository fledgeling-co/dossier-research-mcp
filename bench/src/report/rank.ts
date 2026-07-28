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
 * pass, two adjacent backends the sample cannot separate are reported **tied at
 * this sample size** rather than ordered. What decides that is now a paired
 * difference with a cluster-bootstrap interval, supplied by BENCH-13 through
 * the optional `separated` oracle; where no interval can be computed the older
 * check applies, that two observed interquartile ranges overlap, which is
 * descriptive and is not a significance test. The prior art's finding is that
 * every published deep-research ranking it could find is a point-estimate
 * ordering with unquantified uncertainty, so whichever check ran is named on
 * the ranking and its sentence rides along with it.
 */

/**
 * The sentence that rides on a ranking whose ties came from observed spreads.
 *
 * Exported so tests assert on it.
 */
export const OVERLAP_NOTE =
  'Two backends are reported tied when their observed interquartile ranges overlap. That is a descriptive check over observed values and not a significance test; where a paired difference with a bootstrap interval can be computed, BENCH-13\'s comparison supersedes it and this note is replaced.';

/**
 * The sentence that rides on a ranking whose ties came from a paired test.
 *
 * Which one appears is decided by whether a separation oracle was supplied and
 * whether it had an answer, never by which reads better.
 */
export const PAIRED_NOTE =
  'Two backends are separated only where the paired difference between them, over the tasks they both answered, has a bootstrap interval that excludes zero. Categories are resampled as units, so within-category correlation is in the interval\'s width. Where no interval could be computed the tie falls back to an interquartile overlap, which is a descriptive check and not a significance test. Both are BENCH-13\'s.';

/**
 * What a paired comparison says about two adjacent backends.
 *
 * `better` carries which of the two the test put ahead, because the ordering
 * here is by median and the paired difference is a mean over per-task
 * differences. Those two can disagree, and when they do the report may not
 * silently pick the one that happens to be printed first.
 */
export type SeparationVerdict =
  | { readonly separated: true; readonly better: string | null }
  | { readonly separated: false };

/**
 * The oracle `rankBackends` consults before falling back to overlap.
 *
 * Returns null **only** where it has no comparison at all for the pair. A
 * comparison that ran and was refused must come back as not separated rather
 * than as null: falling back to the interquartile check there would answer with
 * the weaker instrument a question the stronger one has already declined, and
 * publish a category ordering out of a check that says on its face it is not a
 * significance test.
 */
export type SeparationOracle = (a: string, b: string) => SeparationVerdict | null;

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
  /** Always populated: either the separation note, or why there is no ordering. */
  readonly note: string;
  /**
   * Which check decided the ties.
   *
   * `paired` when a bootstrap interval answered for at least one adjacent pair,
   * `overlap` when every tie fell back to observed interquartile ranges, and
   * `none` when no ordering was stated. Reported rather than inferred from the
   * note's wording, because a consumer should not have to read prose to find
   * out which test ran.
   */
  readonly separation: 'paired' | 'overlap' | 'none';
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
 *
 * `separated` is the same argument one layer up. It is BENCH-13's paired
 * comparison, injected rather than imported, so this module keeps knowing
 * nothing about bootstraps and the two answers to "can this sample separate
 * these two" stay one answer with one fallback.
 */
export function rankBackends(
  metric: MetricId,
  scope: RankScope,
  candidates: readonly RankCandidate[],
  scopeScorable = true,
  separated?: SeparationOracle,
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
      separation: 'none',
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
      separation: 'none',
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
      separation: 'none',
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
      separation: 'none',
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
      separation: 'none',
    };
  }

  const compare = betterFirst(metric);
  const sorted = [...eligible].sort(
    (a, b) => compare(a.value.median, b.value.median) || a.provider.localeCompare(b.provider),
  );

  const entries: RankedEntry[] = [];
  let rank = 0;
  let usedPaired = false;
  sorted.forEach((entry, index) => {
    const previous = index === 0 ? undefined : sorted[index - 1];
    let tied = false;
    if (previous !== undefined) {
      // The paired test first, where it has an answer. It is the stronger
      // instrument and it is the one this benchmark tells its readers it uses;
      // consulting the overlap check alongside it would be two answers to one
      // question, which is the thing the whole read side is arranged to avoid.
      const verdict = separated?.(previous.provider, entry.provider) ?? null;
      if (verdict === null) {
        tied = spreadsOverlap(previous.value, entry.value);
      } else {
        usedPaired = true;
        // Separated, and the test agrees with the direction the medians put
        // them in. A paired difference is a mean over per-task differences and
        // this ordering is by median, so the two can disagree; when they do,
        // the honest answer is that the sample does not support the ordering
        // rather than whichever instrument was consulted last.
        tied =
          !verdict.separated ||
          (verdict.better !== null && verdict.better !== previous.provider);
      }
    }
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

  return {
    metric,
    scope,
    entries,
    withheld: null,
    note: usedPaired ? PAIRED_NOTE : OVERLAP_NOTE,
    excluded,
    separation: usedPaired ? 'paired' : 'overlap',
  };
}
