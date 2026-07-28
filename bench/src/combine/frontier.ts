import { spreadsOverlap, type SpreadReport } from '../report/spread.js';

/**
 * The Pareto frontier, over three axes rather than two.
 *
 * A combination is on the frontier when nothing else is at least as good
 * everywhere and better somewhere. Everything not on it is **dominated** and
 * should never be chosen, and saying that plainly is more useful than a ranked
 * list where the reader has to notice for themselves that row nine costs six
 * times row three for a point.
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
 * `FrontierCandidate` has exactly three numeric fields and there is no way to
 * add a fourth. That is not a simplification; it is how the brief's hardest
 * requirement is enforced rather than merely stated. Overlap must never be
 * collapsed into a single "lower is better" score, and the surest way to
 * guarantee that is to leave it no place to sit: an axis *is* a direction, so
 * admitting overlap as one would decide the very question the brief says is a
 * finding rather than an assumption. Overlap is reported by `overlap.ts` as a
 * distribution and a curve, and nothing here consumes it.
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
 * One combination, reduced to the three numbers the frontier compares.
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
   * Omitted, every candidate is treated as separable and the frontier is a
   * point-estimate frontier. That is the honest default for a single run rather
   * than a silent one: the report says so in as many words.
   */
  readonly scoreSpread?: SpreadReport | null | undefined;
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
 * The two sentences a frontier carries about what its ordering rests on.
 *
 * Exported so tests assert on them and so neither can be quietly reworded into
 * a claim the evidence does not support.
 */
export const SEPARABILITY_CHECKED =
  'Two combinations whose observed score spreads overlap are treated as tied on that axis, so neither ' +
  'dominates the other on a score difference this sample cannot establish. That is the same descriptive ' +
  'check bench/src/report/rank.ts applies before ordering two backends, imported rather than restated. ' +
  'It is not a significance test. Bootstrap intervals, paired differences and errors clustered on category ' +
  'now exist in bench/src/stats/ and bench/src/report/rank.ts consumes them, but nothing supplies them here: ' +
  'evaluateCombinations sets no score spread and offers no parameter through which one could arrive, so this ' +
  'frontier is decided by the weaker rule while making the stronger claim.';

export const SEPARABILITY_UNCHECKED =
  'No score spreads were supplied, so this is a point-estimate frontier: every score difference, however ' +
  'small, was taken at face value. Calling a combination dominated says nobody should ever buy it, which ' +
  'is a stronger claim than a ranking, and at one repetition per cell it is a claim about one sample. ' +
  'Supply scoreSpread per candidate to have overlapping spreads treated as ties.';

export interface DominatedCandidate {
  readonly id: string;
  /** The id that beats it. When several do, the first in input order. */
  readonly dominatedBy: string;
  /** Which axes it lost on and by how much. "Dominated" alone is not actionable. */
  readonly why: string;
}

export interface FrontierResult {
  readonly frontier: readonly FrontierCandidate[];
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
   * One of `SEPARABILITY_CHECKED` or `SEPARABILITY_UNCHECKED`. Always present,
   * because "dominated" is a strong claim and a reader has to know whether it
   * rests on a spread or on a single point.
   */
  readonly separability: string;
  /** The direction of each axis, carried so a reader never has to guess. */
  readonly axes: {
    readonly score: 'maximise';
    readonly costUsd: 'minimise';
    readonly robustness: 'maximise';
  };
}

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

/**
 * How the two compare on score, once the sample is allowed to say "cannot tell".
 *
 * Overlapping spreads are `tied`, which is both weaker and stronger than it
 * looks: `a` cannot dominate `b` by out-scoring it, and neither is `a`
 * disqualified for under-scoring it. The pair simply has to be separated on
 * cost or robustness, or not at all.
 */
function compareScore(a: FrontierCandidate, b: FrontierCandidate): 'better' | 'worse' | 'tied' {
  if (a.scoreSpread != null && b.scoreSpread != null && spreadsOverlap(a.scoreSpread, b.scoreSpread)) {
    return 'tied';
  }
  if (a.score > b.score) return 'better';
  if (a.score < b.score) return 'worse';
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
function dominates(a: FrontierCandidate, b: FrontierCandidate): boolean {
  const score = compareScore(a, b);
  if (score === 'worse') return false;
  if (!(a.costUsd <= b.costUsd && a.robustness >= b.robustness)) return false;
  return score === 'better' || a.costUsd < b.costUsd || a.robustness > b.robustness;
}

function explain(a: FrontierCandidate, b: FrontierCandidate, measure: MeasureLabel): string {
  // Scores here are in the flipped comparison space, so they are stated back in
  // the caller's units before anyone reads them.
  const shown = (v: number): string =>
    (measure.direction === 'lower-is-better' ? -v : v).toFixed(4);
  const parts: string[] = [];
  const score = compareScore(a, b);
  if (score === 'better') {
    parts.push(`has ${measure.name} ${shown(a.score)} against ${shown(b.score)}`);
  } else if (score === 'tied') {
    parts.push(
      a.scoreSpread != null && b.scoreSpread != null
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

/**
 * Split candidates into the frontier and the dominated.
 *
 * Quadratic in the candidate count, which is `2^n` and therefore up to 65,535
 * at the member ceiling: about two billion comparisons at the very top, and
 * about 65,000 at the eight-member size the brief actually describes. Left
 * quadratic rather than made clever because the comparison is three numbers and
 * because a three-dimensional skyline algorithm is a well-known source of
 * subtle ordering bugs; if the top of the range ever becomes the ordinary case
 * this is the place to revisit, with a test already pinning the answer.
 */
export function paretoFrontier(
  candidates: readonly FrontierCandidate[],
  measure: MeasureLabel,
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

  // Flipped once, here, rather than left to every caller to remember. A Brier
  // score compared as though higher were better ranks the worst-calibrated
  // combination first, and nothing downstream could tell.
  const oriented: FrontierCandidate[] =
    measure.direction === 'lower-is-better'
      ? candidates.map((c) => ({ ...c, score: -c.score }))
      : [...candidates];

  const frontier: FrontierCandidate[] = [];
  const dominated: DominatedCandidate[] = [];

  // Reported in the caller's own units, so a negated Brier score never reaches
  // a reader; only the comparison happens in the flipped space.
  const asGiven = new Map(candidates.map((c) => [c.id, c]));

  for (const b of oriented) {
    const winner = oriented.find((a) => a.id !== b.id && dominates(a, b));
    if (winner) dominated.push({ id: b.id, dominatedBy: winner.id, why: explain(winner, b, measure) });
    else frontier.push(asGiven.get(b.id)!);
  }

  return {
    frontier,
    dominated,
    measure,
    separability: candidates.some((c) => c.scoreSpread != null)
      ? SEPARABILITY_CHECKED
      : SEPARABILITY_UNCHECKED,
    axes: { score: 'maximise', costUsd: 'minimise', robustness: 'maximise' },
  };
}
