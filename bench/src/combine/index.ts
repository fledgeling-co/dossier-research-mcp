/**
 * Combination scoring, in one import.
 *
 * **A combination never has to be run.** `bench/src/run/` stores every cell
 * raw, so a combination of backends is the merge of reports that already exist
 * and all 2^N subsets are evaluated for the cost of the N runs already paid
 * for. Nothing in this directory reaches a network, spends a penny or calls a
 * model, and `combine.test.ts` asserts both, at runtime and by reading the
 * source. Anyone about to build an expensive combination matrix should read
 * `member.ts` first.
 *
 * `member.ts` is the contract and holds the independence invariant the whole
 * approach rests on; `merge.ts` folds members into one report-shaped object;
 * `overlap.ts` measures how much was bought twice, three ways and in no
 * direction; `convergence.ts` is the deliberately separate path for members
 * agreeing on a *conclusion*; `marginal.ts` splits the credit exactly or
 * refuses; `eligibility.ts` carries `bench/src/report/`'s verdicts in and is
 * the only file here that has ever seen a `BenchAggregate`; `frontier.ts` says
 * which combinations are worth their price, and refuses to say it at all where
 * those verdicts do not support the claim; and `evaluate.ts` runs the lattice
 * per category and overall.
 *
 * Nothing here scores a report. `scoreCombination` is injected, for the reason
 * set out at the top of `evaluate.ts`. Nothing here decides what a sample can
 * support either: that is `bench/src/report/aggregate.ts`'s, taken whole.
 */

export {
  assertIndependentMembers,
  memberCostUsd,
  memberRuns,
  PANEL_INDEPENDENCE_INVARIANT,
} from './member.js';
export type { CombinationMember, MemberIndependence, MemberRun } from './member.js';

export type { CombinationIndependenceError, ExactnessRefusedError } from './errors.js';

export { memberUrlSet, mergeCombination, UNION_SEMANTICS } from './merge.js';
export type { MergedCombination } from './merge.js';

/**
 * Named `sourceOverlapProfile` at the barrel rather than `overlapProfile`.
 *
 * `claimConvergence` sits beside it and the two measure different objects: the
 * same *page*, versus the same *conclusion*. Two names one letter apart in one
 * barrel is how a caller silently gets the wrong measure, which already
 * happened once in `bench/src/score/index.ts` with two functions called
 * `containment` and was fixed the same way.
 */
export {
  DEFAULT_OVERLAP_BINS,
  overlapCurve,
  OVERLAP_IS_NOT_AN_OBJECTIVE,
  sourceOverlapProfile,
} from './overlap.js';
export type {
  CentralityProfile,
  MemberCentrality,
  MemberRobustness,
  OverlapBin,
  OverlapPoint,
  OverlapProfile,
  PairOverlap,
  RobustnessProfile,
} from './overlap.js';

export { claimConvergence, CONVERGENCE_IS_NOT_CORROBORATION } from './convergence.js';
export type { ClaimConvergenceReport, ConvergenceCandidate, ProviderClaimSet } from './convergence.js';

export {
  exactnessRefusal,
  exactnessRefusedError,
  marginalContributions,
  MAX_EXACT_MEMBERS,
} from './marginal.js';
export type {
  CoalitionValue,
  MarginalExact,
  MarginalRefused,
  MarginalResult,
  MemberContribution,
} from './marginal.js';

export {
  eligibilityOf,
  paretoFrontier,
  SEPARABILITY_CHECKED,
  SEPARABILITY_MIXED,
  SEPARABILITY_NOT_STATED,
  SEPARABILITY_UNCHECKED,
} from './frontier.js';
export type {
  CandidateEligibility,
  DominatedCandidate,
  FrontierCandidate,
  FrontierOptions,
  FrontierResult,
  FrontierWithheld,
  FrontierWithheldReason,
  MeasureLabel,
  PairCounts,
} from './frontier.js';

/**
 * The seam to `bench/src/report/`, and the only part of this directory that has
 * ever seen a `BenchAggregate`.
 *
 * Exported because a caller cannot build an eligible lattice without it, and
 * because the alternative is every caller hand-rolling the same map from
 * verdicts to members, which is how a floor comes to mean two things.
 */
export { combinationEligibility, eligibilityFromAggregate } from './eligibility.js';
export type {
  CombinationEligibility,
  EligibilityScope,
  MemberEligibility,
  MemberProviders,
} from './eligibility.js';

/**
 * A `SpreadReport` over a combination's per-repetition scores.
 *
 * Exported here from 28 July 2026. It existed before that and was reachable
 * only from a test, which is half of why `spreadsOverlap` was dead on the
 * production path and every real frontier took the unchecked branch.
 */
export { scoreSpread } from './spread-helpers.js';

export { combinationId, evaluateCombinations, evaluateScopes } from './evaluate.js';
export type {
  CombinationEvaluation,
  CombinationReport,
  CombinationScope,
  EvaluateInput,
  ScopedCombinationReport,
} from './evaluate.js';
