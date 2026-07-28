import type { RepetitionFloor, ScorableVerdict } from '../report/aggregate.js';
import type { SeparationOracle, WithheldReason } from '../report/rank.js';
import { spreadsOverlap, type SpreadReport } from '../report/spread.js';

/**
 * The Pareto frontier, over three axes rather than two, and the four gates it
 * has to clear before it will state one.
 *
 * A combination is on the frontier when nothing else is at least as good
 * everywhere and better somewhere. Everything not on it is **dominated** and
 * should never be chosen, and saying that plainly is more useful than a ranked
 * list where the reader has to notice for themselves that row nine costs six
 * times row three for a point.
 *
 * ## Why the gates, and where they come from
 *
 * Calling a combination dominated says **nobody should ever buy it**. That is a
 * stronger claim than ordering two backends, and until 28 July 2026 it was made
 * with less evidence than the ranking beside it: no floor of any kind reached
 * this file, and a difference of 0.001 between two single runs produced a
 * dominance verdict.
 *
 * Every gate below is `bench/src/report/`'s, **imported and never restated**.
 * That is the same instruction `bench/src/report/comparison.ts` follows and for
 * the same reason: two different answers to "can this sample support a claim"
 * in one codebase is worse than either, and deriving one here a second time is
 * exactly how the scorecard came to print a backend invalid while the ranking
 * ranked it. So this module adds no floor, computes no threshold and owns no
 * rule about sample size. It reads verdicts BENCH-08 already computed and
 * refuses what they do not support.
 *
 * ## Why three axes
 *
 * Score and cost alone cannot say the thing that matters most about a panel: a
 * combination matching another's score at the same price **while surviving the
 * loss of a member better** is the better buy, and a two-axis frontier reports
 * them as a tie. Robustness is therefore an axis rather than a footnote.
 *
 * ## Why the axis shape is closed, and why that is the enforcement
 *
 * `FrontierCandidate` has exactly three **numeric** fields and there is no way
 * to add a fourth. That is not a simplification; it is how the brief's hardest
 * requirement is enforced rather than merely stated. Overlap must never be
 * collapsed into a single "lower is better" score, and the surest way to
 * guarantee that is to leave it no place to sit: an axis *is* a direction, so
 * admitting overlap as one would decide the very question the brief says is a
 * finding rather than an assumption. Overlap is reported by `overlap.ts` as a
 * distribution and a curve, and nothing here consumes it.
 *
 * The two non-numeric fields, `scoreSpread` and `eligibility`, are not axes and
 * cannot become one: nothing compares them for magnitude, and both exist only
 * to say whether a comparison may be made at all.
 *
 * The third axis is named `robustness` rather than the brief's "redundancy" for
 * a reason worth stating: redundancy has no agreed direction. Redundant members
 * waste money, which argues for less, and redundancy is what stops coverage
 * collapsing when a member is dropped, which argues for more. A frontier cannot
 * be computed without a direction per axis, so the axis is the one with an
 * unambiguous one: the share of the union that survives losing the most
 * load-bearing member, where higher is better.
 *
 * Pure and synchronous.
 */

/**
 * Whether one candidate may enter a frontier at all.
 *
 * Deliberately shaped like `RankCandidate`'s four eligibility fields rather
 * than like anything new, because it carries the same two verdicts from the
 * same place: `ScorableVerdict` and `RepetitionFloor`, both computed by
 * `bench/src/report/aggregate.ts`. `evaluate.ts` folds a combination's members
 * down into one of these; see `combinationEligibility` there for why the fold
 * takes the worst member rather than the average.
 */
export interface CandidateEligibility {
  /** `ScorableVerdict.scorable`, for every member of this combination. */
  readonly scorable: boolean;
  /** The aggregate's own sentence when it is not. Never a paraphrase. */
  readonly why: string;
  /** `RepetitionFloor.met`, for every member of this combination. */
  readonly repetitionsMet: boolean;
  /** `RepetitionFloor.why` when it is not met. */
  readonly repetitionsWhy: string;
}

/**
 * Build one candidate's eligibility from BENCH-08's two verdict objects.
 *
 * A function rather than a shape a caller assembles by hand, so the mapping
 * from `ScorableVerdict` to `scorable` happens once. A caller writing
 * `scorable: true` beside a verdict that says otherwise is the failure this
 * whole item is about, one layer up.
 */
export function eligibilityOf(
  verdict: ScorableVerdict,
  repetitionFloor: RepetitionFloor,
): CandidateEligibility {
  return {
    scorable: verdict.scorable,
    why: verdict.scorable ? '' : verdict.why,
    repetitionsMet: repetitionFloor.met,
    repetitionsWhy: repetitionFloor.met ? '' : repetitionFloor.why,
  };
}

/**
 * One combination, reduced to the three numbers the frontier compares, plus
 * the two things that decide whether it may be compared at all.
 *
 * Deliberately minimal and deliberately closed. See the note above before
 * adding a field.
 */
export interface FrontierCandidate {
  readonly id: string;
  /**
   * Maximise. Whatever the caller's injected scorer returned.
   *
   * **What this number is has to be declared**, which is why `paretoFrontier`
   * takes a `MeasureLabel` and why `FrontierResult` carries it. The benchmark's
   * scorers deliberately do not expose one common score: source quality refuses
   * to blend, citation accuracy and citation volume are kept as two numbers on
   * purpose, and a Brier score is lower-is-better. A frontier over an unnamed
   * "score" would quietly average incomparable things or silently rank a
   * lower-is-better measure upside down, and the caller would have no way to
   * tell which had happened. So one frontier answers for one named measure, and
   * the caller runs it again for the next one.
   */
  readonly score: number;
  /**
   * Minimise. Metered dollars: the sum of the members' reserved worst cases.
   *
   * Subscription quota and unrecoverable spend are **not** in here. They are
   * counted on the merged object and reported beside the frontier, because
   * folding unmetered quota in as zero puts every subscription combination at
   * the cheap end by construction.
   */
  readonly costUsd: number;
  /** Maximise. `robustness.worstCaseSurvivingShare` from `overlap.ts`. */
  readonly robustness: number;
  /**
   * The spread behind `score`, when the sample has one.
   *
   * Optional, and supplying it changes the answer: two candidates whose score
   * spreads overlap are **tied on that axis**, so neither can dominate the
   * other on the strength of a score difference the sample cannot establish.
   *
   * This is not a second opinion about what a sample can support. It is
   * `spreadsOverlap` from `bench/src/report/spread.ts`, the same rule
   * `rankBackends` uses to report two backends tied rather than ordering them,
   * imported rather than restated. Two answers to that question in one codebase
   * is worse than either, and a frontier is a *stronger* claim than a ranking:
   * saying a combination is dominated says nobody should ever buy it.
   *
   * Omitted on **every** candidate, the frontier is a point-estimate frontier
   * and says so in `SEPARABILITY_UNCHECKED`. Omitted on **some**, the pairs
   * that had one were checked and the pairs that did not were not, which is
   * `SEPARABILITY_MIXED`; that state used to advertise the checked sentence
   * over pairs compared as point estimates, and the candidate carrying the
   * spread was the one it eliminated.
   */
  readonly scoreSpread?: SpreadReport | null | undefined;
  /**
   * Whether this candidate's sample supports being compared at all.
   *
   * Absent is **not** the same as eligible. A candidate with no eligibility is
   * a candidate nobody has said anything about, and a frontier built out of
   * those is the defect this field exists to close, so the whole frontier is
   * withheld as `eligibility-not-supplied` rather than computed on a permissive
   * default. `evaluateCombinations` requires it, so the only way to reach that
   * state is by calling `paretoFrontier` directly.
   */
  readonly eligibility?: CandidateEligibility | undefined;
}

/**
 * What the score axis actually measures, and which way it points.
 *
 * `direction` exists because several of this benchmark's measures are
 * lower-is-better and the frontier maximises. A caller with a Brier score must
 * declare it, and `paretoFrontier` flips it once, here, rather than leaving
 * every caller to remember.
 */
export interface MeasureLabel {
  /** The measure's name, e.g. `accuracy`, `citation-accuracy`, `brier`. */
  readonly name: string;
  readonly direction: 'higher-is-better' | 'lower-is-better';
}

/**
 * Everything a frontier needs that is not a property of one candidate.
 *
 * Required, and `scope` inside it is required, for the same reason
 * `eligibility` is required on the candidate: a scope verdict that defaults to
 * scorable is a floor that defaults to no floor.
 */
export interface FrontierOptions {
  /**
   * The scope's own verdict, computed by `aggregate.ts` and passed in rather
   * than re-derived. The first gate, and the one that catches the case this
   * item was filed for: `evaluateScopes` runs per task category, which is
   * precisely the scope `MIN_TASKS_PER_CATEGORY` governs, and a category below
   * that floor cannot produce a frontier however many members were run in it.
   */
  readonly scope: ScorableVerdict;
  /**
   * BENCH-13's paired comparison, injected exactly as `rank.ts` takes it.
   *
   * Same type, imported rather than redeclared, so this module keeps knowing
   * nothing about bootstraps and the two answers to "can this sample separate
   * these two" stay one answer with one fallback. Returns null only where it
   * has no comparison at all for the pair; a comparison that ran the gates and
   * was refused comes back as not separated, and the pair is tied.
   *
   * Nothing supplies one today. `bench/src/combine/` has no consumer and the
   * statistics are computed over backends rather than over combinations, so
   * this is the seam a future consumer fills rather than a wire that is live.
   */
  readonly separated?: SeparationOracle | undefined;
}

/**
 * The sentences a frontier carries about what its ordering rests on.
 *
 * Exported so tests assert on them by identity, and so none can be quietly
 * reworded into a claim the evidence does not support.
 */
export const SEPARABILITY_CHECKED =
  'Every pair compared here was checked: two combinations whose observed score spreads overlap are ' +
  'treated as tied on that axis, so neither dominates the other on a score difference this sample ' +
  'cannot establish. That is the same descriptive check bench/src/report/rank.ts applies before ' +
  'ordering two backends, imported rather than restated. It is not a significance test. Where a paired ' +
  'difference with a bootstrap interval was supplied it decided instead, and where it was not, the ' +
  'interquartile overlap did.';

export const SEPARABILITY_MIXED =
  'Some pairs were checked and some were not. Where both combinations carried a score spread, an ' +
  'overlap between them was treated as a tie; where either did not, the pair was compared as two point ' +
  'estimates and any difference was taken at face value. The distinction matters in the direction ' +
  'nobody expects: a candidate that carries a spread can be eliminated by one that does not, so ' +
  'supplying evidence for some combinations and not others penalises the ones you measured. Read a ' +
  'dominance verdict here as checked only for the pairs that had the evidence.';

export const SEPARABILITY_UNCHECKED =
  'No score spreads were supplied, so this is a point-estimate frontier: every score difference, however ' +
  'small, was taken at face value. Calling a combination dominated says nobody should ever buy it, which ' +
  'is a stronger claim than a ranking, and at one repetition per cell it is a claim about one sample. ' +
  'Supply scoreSpread per candidate to have overlapping spreads treated as ties.';

export const SEPARABILITY_NOT_STATED =
  'No frontier was stated, so nothing was separated and nothing was called dominated. The scores, costs ' +
  'and robustness figures are still reported: the numbers are the numbers, and it is the sample that ' +
  'cannot order them.';

/**
 * Why a frontier was not stated.
 *
 * Three of the four words are `rank.ts`'s own, extracted from its type rather
 * than retyped, so a rename there is a compile error here rather than two
 * withheld tables that no longer read side by side. The fourth has no analogue
 * in the ranking, because a ranking candidate cannot arrive without a verdict.
 */
export type FrontierWithheldReason =
  | Extract<WithheldReason, 'scope-not-scorable' | 'sample-below-spread-floor' | 'too-few-candidates'>
  | 'eligibility-not-supplied';

export interface FrontierWithheld {
  readonly reason: FrontierWithheldReason;
  /** The aggregate's own sentence wherever one exists. Never a paraphrase. */
  readonly why: string;
}

export interface DominatedCandidate {
  readonly id: string;
  /** The id that beats it. When several do, the first in input order. */
  readonly dominatedBy: string;
  /** Which axes it lost on and by how much. "Dominated" alone is not actionable. */
  readonly why: string;
}

/** How many pairs were compared, and with which instrument. */
export interface PairCounts {
  readonly total: number;
  /** Decided by the injected paired comparison. */
  readonly paired: number;
  /** Decided by an interquartile overlap between two supplied spreads. */
  readonly spread: number;
  /** Decided on point estimates, because neither instrument was available. */
  readonly point: number;
}

export interface FrontierResult {
  /**
   * The undominated combinations, or **null** when no frontier was stated.
   *
   * Null rather than an empty array, and rather than every candidate, because
   * "nothing is dominated" and "the sample cannot say what is dominated" are
   * different claims and an empty list reads as the first.
   */
  readonly frontier: readonly FrontierCandidate[] | null;
  /** Always empty when `frontier` is null. Domination is the withheld claim. */
  readonly dominated: readonly DominatedCandidate[];
  /**
   * What the score axis measured, and which way the caller declared it points.
   *
   * A frontier answers for one named measure. Reading a frontier without
   * knowing whether its score was accuracy, citation accuracy or a Brier score
   * is reading a ranking of an unknown quantity.
   */
  readonly measure: MeasureLabel;
  /**
   * Whether the sample was allowed to say two combinations cannot be separated.
   *
   * One of the four `SEPARABILITY_*` constants. Always present, because
   * "dominated" is a strong claim and a reader has to know whether it rests on
   * a spread, on a paired interval, or on a single point.
   */
  readonly separability: string;
  /**
   * The same fact machine-readable, so a consumer never parses prose.
   *
   * `checked` when every compared pair had an instrument, `point` when none
   * did, `mixed` when some did, and `none` when no frontier was stated.
   */
  readonly separation: 'checked' | 'mixed' | 'point' | 'none';
  readonly pairs: PairCounts;
  /** Null when a frontier was stated. */
  readonly withheld: FrontierWithheld | null;
  /** Candidates that could not enter, and why. Never silently dropped. */
  readonly excluded: readonly { readonly id: string; readonly why: string }[];
  /** The direction of each axis, carried so a reader never has to guess. */
  readonly axes: {
    readonly score: 'maximise';
    readonly costUsd: 'minimise';
    readonly robustness: 'maximise';
  };
}

const NO_PAIRS: PairCounts = { total: 0, paired: 0, spread: 0, point: 0 };

function assertFinite(c: FrontierCandidate): void {
  for (const [field, v] of [
    ['score', c.score],
    ['costUsd', c.costUsd],
    ['robustness', c.robustness],
  ] as const) {
    if (!Number.isFinite(v)) {
      throw new TypeError(
        `frontier candidate "${c.id}" has a ${field} of ${String(v)}; every axis must be a finite number. ` +
          'A NaN silently compares false against everything, so a candidate carrying one would be ' +
          'reported as undominated no matter how bad it is.',
      );
    }
  }
}

type ScoreVerdict = 'better' | 'worse' | 'tied';

/** Which check decided a pair. `point` means neither was available. */
type Instrument = 'paired' | 'spread' | 'point';

interface ScoreComparison {
  readonly verdict: ScoreVerdict;
  readonly instrument: Instrument;
}

function byPoint(a: FrontierCandidate, b: FrontierCandidate): ScoreVerdict {
  if (a.score > b.score) return 'better';
  if (a.score < b.score) return 'worse';
  return 'tied';
}

/**
 * How the two compare on score, once the sample is allowed to say "cannot tell".
 *
 * Overlapping spreads are `tied`, which is both weaker and stronger than it
 * looks: `a` cannot dominate `b` by out-scoring it, and neither is `a`
 * disqualified for under-scoring it. The pair simply has to be separated on
 * cost or robustness, or not at all.
 *
 * Precedence is `rank.ts`'s, in the same order: the paired difference where it
 * has an answer, the interquartile overlap where it does not, and the observed
 * values where neither is available. Consulting more than one for a pair would
 * be two answers to one question.
 *
 * The spreads are compared in the caller's own orientation rather than the
 * flipped one, which is safe because overlap is symmetric under negation: two
 * ranges overlap exactly when their negations do.
 */
function compareScore(
  a: FrontierCandidate,
  b: FrontierCandidate,
  separated: SeparationOracle | undefined,
): ScoreComparison {
  const paired = separated?.(a.id, b.id) ?? null;
  if (paired !== null) {
    if (!paired.separated) return { verdict: 'tied', instrument: 'paired' };
    const point = byPoint(a, b);
    // Separated, but the test did not say which way. The observed values keep
    // the ordering, exactly as `rank.ts` keeps its median ordering.
    if (paired.better === null) return { verdict: point, instrument: 'paired' };
    const pairedVerdict: ScoreVerdict | null =
      paired.better === a.id ? 'better' : paired.better === b.id ? 'worse' : null;
    // A verdict naming neither of these two is a caller mistake rather than a
    // finding, and the safe reading of a verdict about somebody else is that it
    // says nothing about this pair.
    if (pairedVerdict === null) return { verdict: 'tied', instrument: 'paired' };
    // A paired difference is a mean over per-task differences and the score
    // axis is whatever the injected scorer returned, so the two can disagree.
    // When they do, the honest answer is that the sample does not support a
    // dominance claim rather than whichever instrument was consulted last.
    // `rank.ts` ties on exactly this disagreement.
    return { verdict: pairedVerdict === point ? pairedVerdict : 'tied', instrument: 'paired' };
  }
  if (a.scoreSpread != null && b.scoreSpread != null) {
    return {
      verdict: spreadsOverlap(a.scoreSpread, b.scoreSpread) ? 'tied' : byPoint(a, b),
      instrument: 'spread',
    };
  }
  return { verdict: byPoint(a, b), instrument: 'point' };
}

/** The mirror of a comparison, so one pair is evaluated once and read twice. */
function flip(verdict: ScoreVerdict): ScoreVerdict {
  if (verdict === 'better') return 'worse';
  if (verdict === 'worse') return 'better';
  return 'tied';
}

/**
 * Does `a` dominate `b`?
 *
 * At least as good on all three, strictly better on at least one. Ties on all
 * three keep both: two genuinely identical purchases are two options, not one
 * option and one loser, and picking a winner between them would be an ordering
 * imposed by input order rather than by evidence.
 *
 * A score difference the sample cannot establish counts as a tie, so it can
 * neither disqualify a candidate nor promote one. Domination is a claim that
 * nobody should ever buy the loser, and that claim has to rest on a difference
 * the evidence actually carries.
 */
function dominates(a: FrontierCandidate, b: FrontierCandidate, score: ScoreVerdict): boolean {
  if (score === 'worse') return false;
  if (!(a.costUsd <= b.costUsd && a.robustness >= b.robustness)) return false;
  return score === 'better' || a.costUsd < b.costUsd || a.robustness > b.robustness;
}

function explain(
  a: FrontierCandidate,
  b: FrontierCandidate,
  measure: MeasureLabel,
  comparison: ScoreComparison,
): string {
  // Scores here are in the flipped comparison space, so they are stated back in
  // the caller's units before anyone reads them.
  const shown = (v: number): string => (measure.direction === 'lower-is-better' ? -v : v).toFixed(4);
  const parts: string[] = [];
  if (comparison.verdict === 'better') {
    parts.push(`has ${measure.name} ${shown(a.score)} against ${shown(b.score)}`);
  } else if (comparison.verdict === 'tied') {
    parts.push(
      comparison.instrument === 'paired'
        ? `cannot be separated on ${measure.name} by the paired difference between them`
        : comparison.instrument === 'spread'
          ? `cannot be separated on ${measure.name} at this sample size`
          : `matches on ${measure.name}`,
    );
  }
  if (a.costUsd < b.costUsd) parts.push(`costs $${a.costUsd.toFixed(2)} against $${b.costUsd.toFixed(2)}`);
  else if (a.costUsd === b.costUsd) parts.push('costs the same');
  if (a.robustness > b.robustness) {
    parts.push(
      `survives losing a member with ${(a.robustness * 100).toFixed(1)}% of its sources against ${(b.robustness * 100).toFixed(1)}%`,
    );
  } else if (a.robustness === b.robustness) parts.push('is equally robust');
  return `"${a.id}" ${parts.join(', ')}, and is no worse on any axis.`;
}

function withheldResult(
  measure: MeasureLabel,
  withheld: FrontierWithheld,
  excluded: readonly { readonly id: string; readonly why: string }[],
): FrontierResult {
  return {
    frontier: null,
    dominated: [],
    measure,
    separability: SEPARABILITY_NOT_STATED,
    separation: 'none',
    pairs: NO_PAIRS,
    withheld,
    excluded,
    axes: { score: 'maximise', costUsd: 'minimise', robustness: 'maximise' },
  };
}

/**
 * Split candidates into the frontier and the dominated, or say why neither.
 *
 * Quadratic in the candidate count, which is `2^n` and therefore up to 65,535
 * at the member ceiling: about two billion comparisons at the very top, and
 * about 32,000 at the eight-member size the brief actually describes. Each
 * unordered pair is evaluated **once** and read in both directions, which is
 * half the work the earlier per-candidate `find` did on an undominated set and
 * is what makes the pair accounting behind the separability sentence
 * order-independent rather than a function of which pairs a short circuit
 * happened to visit. Left quadratic rather than made clever because the
 * comparison is three numbers and because a three-dimensional skyline algorithm
 * is a well-known source of subtle ordering bugs; if the top of the range ever
 * becomes the ordinary case this is the place to revisit, with a test already
 * pinning the answer.
 */
export function paretoFrontier(
  candidates: readonly FrontierCandidate[],
  measure: MeasureLabel,
  options: FrontierOptions,
): FrontierResult {
  if (measure.name.trim() === '') {
    throw new TypeError(
      'a frontier needs a named measure. The benchmark deliberately has no single "score": source ' +
        'quality refuses to blend, citation accuracy and volume are two numbers on purpose, and a ' +
        'Brier score is lower-is-better. An unnamed axis is a ranking of an unknown quantity.',
    );
  }
  const seen = new Set<string>();
  for (const c of candidates) {
    assertFinite(c);
    if (seen.has(c.id)) {
      throw new TypeError(`two frontier candidates share the id "${c.id}"`);
    }
    seen.add(c.id);
  }

  // Gate 1, the scope. A category below the task floor cannot produce a
  // frontier, however many members ran in it and however many repetitions each
  // of them managed. `rank.ts` refuses an ordering here; a frontier is the
  // stronger claim, so it refuses at least as early.
  if (!options.scope.scorable) {
    return withheldResult(measure, { reason: 'scope-not-scorable', why: options.scope.why }, []);
  }

  const excluded: { id: string; why: string }[] = [];
  const eligible: FrontierCandidate[] = [];
  let belowRepetitionFloor = 0;
  for (const c of candidates) {
    // Gate 2, and it fails closed. A candidate nobody has said anything about
    // is not a candidate that passed; treating an absent verdict as a
    // permissive one is how this module came to publish a frontier with no
    // floor at all.
    if (c.eligibility === undefined) {
      return withheldResult(
        measure,
        {
          reason: 'eligibility-not-supplied',
          why:
            `candidate "${c.id}" carries no eligibility, so nothing is known about whether its sample ` +
            'supports a comparison. A frontier calls the combinations it leaves off dominated, which says ' +
            'nobody should ever buy them, and that claim is refused rather than made on a permissive ' +
            'default. Supply each candidate the ScorableVerdict and RepetitionFloor that ' +
            'bench/src/report/aggregate.ts already computed for it.',
        },
        excluded,
      );
    }
    if (!c.eligibility.scorable) {
      excluded.push({ id: c.id, why: c.eligibility.why });
      continue;
    }
    // Gate 3's input. Counted here and acted on below, because one thin
    // candidate withholds the whole frontier rather than being dropped from it.
    if (!c.eligibility.repetitionsMet) {
      belowRepetitionFloor += 1;
      excluded.push({ id: c.id, why: c.eligibility.repetitionsWhy });
      continue;
    }
    eligible.push(c);
  }

  // Gate 3. The whole frontier, not a frontier over whichever candidates
  // cleared the floor. A frontier over a subset of the lattice is not the
  // frontier: every subset containing the thin member is affected, so the
  // survivors would be compared against a set with holes in it and the holes
  // would read as combinations nobody should buy. `rank.ts` withholds the whole
  // ordering on the same shortfall for the same reason.
  if (belowRepetitionFloor > 0) {
    return withheldResult(
      measure,
      {
        reason: 'sample-below-spread-floor',
        why:
          `${String(belowRepetitionFloor)} of ${String(candidates.length)} combination${candidates.length === 1 ? '' : 's'} ` +
          'rest on runs that were not repeated enough for a figure over them to say anything about ' +
          'run-to-run variation. No frontier is stated, because calling a combination dominated on single ' +
          'runs is a rank ordering of noise wearing the strongest claim this benchmark can make. ' +
          excluded.map((e) => e.why).join(' '),
      },
      excluded,
    );
  }

  // Gate 4. Two is the smallest frontier that says anything, and a blocked
  // candidate is folded in here rather than given its own word: the scope was
  // fine and a candidate could not enter it, which is exactly what `rank.ts`
  // and `comparison.ts` both call too few candidates. Naming it the same way is
  // what makes the withheld tables readable side by side.
  if (eligible.length < 2) {
    return withheldResult(
      measure,
      {
        reason: 'too-few-candidates',
        why:
          `only ${String(eligible.length)} combination${eligible.length === 1 ? '' : 's'} could be scored here, ` +
          'which is not a frontier. ' +
          excluded.map((e) => e.why).join(' '),
      },
      excluded,
    );
  }

  // Flipped once, here, rather than left to every caller to remember. A Brier
  // score compared as though higher were better ranks the worst-calibrated
  // combination first, and nothing downstream could tell.
  const oriented: FrontierCandidate[] =
    measure.direction === 'lower-is-better'
      ? eligible.map((c) => ({ ...c, score: -c.score }))
      : [...eligible];

  const dominatedBy = new Map<string, { winner: FrontierCandidate; comparison: ScoreComparison }>();
  let paired = 0;
  let spread = 0;
  let point = 0;

  for (let i = 0; i < oriented.length; i += 1) {
    for (let j = i + 1; j < oriented.length; j += 1) {
      const a = oriented[i];
      const b = oriented[j];
      if (a === undefined || b === undefined) continue;
      const forward = compareScore(a, b, options.separated);
      if (forward.instrument === 'paired') paired += 1;
      else if (forward.instrument === 'spread') spread += 1;
      else point += 1;

      // `i` ascends outermost, so the potential dominators of the candidate at
      // index k are visited as 0, 1, ..., k-1, k+1, ...: input order, which is
      // what "when several do, the first in input order" means.
      if (!dominatedBy.has(b.id) && dominates(a, b, forward.verdict)) {
        dominatedBy.set(b.id, { winner: a, comparison: forward });
      }
      const backward: ScoreComparison = {
        verdict: flip(forward.verdict),
        instrument: forward.instrument,
      };
      if (!dominatedBy.has(a.id) && dominates(b, a, backward.verdict)) {
        dominatedBy.set(a.id, { winner: b, comparison: backward });
      }
    }
  }

  // Reported in the caller's own units, so a negated Brier score never reaches
  // a reader; only the comparison happens in the flipped space.
  const asGiven = new Map(eligible.map((c) => [c.id, c]));
  const frontier: FrontierCandidate[] = [];
  const dominated: DominatedCandidate[] = [];
  for (const c of oriented) {
    const beaten = dominatedBy.get(c.id);
    if (beaten === undefined) {
      frontier.push(asGiven.get(c.id)!);
      continue;
    }
    dominated.push({
      id: c.id,
      dominatedBy: beaten.winner.id,
      why: explain(beaten.winner, c, measure, beaten.comparison),
    });
  }

  const total = paired + spread + point;
  const checked = paired + spread;
  const separation: FrontierResult['separation'] =
    checked === total ? 'checked' : checked === 0 ? 'point' : 'mixed';

  return {
    frontier,
    dominated,
    measure,
    // Decided on the pairs actually compared rather than on whether *some*
    // candidate happened to carry a spread. That older rule advertised the
    // checked sentence over a mixed set, and the candidate carrying the spread
    // was the one it eliminated: `spreadsOverlap` needs both sides, so a pair
    // with one spread and one bare point estimate fell through to a raw
    // comparison while the result said the sample had been asked.
    separability:
      separation === 'checked'
        ? SEPARABILITY_CHECKED
        : separation === 'point'
          ? SEPARABILITY_UNCHECKED
          : SEPARABILITY_MIXED,
    separation,
    pairs: { total, paired, spread, point },
    withheld: null,
    excluded,
    axes: { score: 'maximise', costUsd: 'minimise', robustness: 'maximise' },
  };
}
