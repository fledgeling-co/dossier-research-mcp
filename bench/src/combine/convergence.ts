import {
  findConvergence,
  type ConvergenceCandidate,
  type ProviderClaimSet,
} from '../../../src/research/corroborate.js';

/**
 * Claim convergence: several members reaching the same **conclusion**.
 *
 * A deliberately separate module, over deliberately different objects, reached
 * through deliberately different code from `overlap.ts`. The distinction is not
 * pedantry and merging the two would make both meaningless:
 *
 * - Two backends citing the same **source** is a fact about the web. It says
 *   the page is findable and, when several independent searchers reach it,
 *   that it is central. It says nothing about whether either backend concluded
 *   anything from it, or whether they concluded the *same* thing. That is
 *   `sourceOverlapProfile` in `overlap.ts`.
 * - Two backends stating the same **conclusion** is the corroboration trap.
 *   Agreement is not corroboration: three research agents all citing one vendor
 *   press release is one source wearing three hats, and the product already
 *   counts support in independent registrable domains rather than in providers
 *   for exactly that reason. That is this module.
 *
 * The enforcement is structural rather than a convention a caller can bypass.
 * `sourceOverlapProfile` takes `CombinationMember[]` and reads URL sets;
 * `claimConvergence` takes `ProviderClaimSet[]` and reads claim text. Neither
 * function's input satisfies the other's signature and neither's output is
 * accepted by the other, so the two cannot be swapped by accident. They are
 * also reported under two names that cannot be confused, following the
 * precedent in `bench/src/score/index.ts` where two functions called
 * `containment` had to be disambiguated at the barrel because a caller was
 * otherwise one import away from silently getting the wrong measure.
 *
 * The matcher itself is the product's `findConvergence`, not a copy. It exists
 * because exact-wording matching reported zero every time, and the zero was
 * then rendered as "these reports do not overlap", which is a confident
 * negative produced by a test with no power to find a positive. Reimplementing
 * it here would give the benchmark and the product two definitions of the same
 * idea.
 *
 * Pure, synchronous, and it reaches nothing.
 */

/**
 * Rides on every report, for the same reason `OVERLAP_IS_NOT_AN_OBJECTIVE`
 * does: the number travels further than the caveat.
 */
export const CONVERGENCE_IS_NOT_CORROBORATION =
  'Claim convergence counts members that appear to have stated the same conclusion. It is a candidate ' +
  'list, never a verdict, and it is never evidence a conclusion is right: agreement between backends ' +
  'is not corroboration, because they may all be reading one source. Corroboration is counted in ' +
  'independent registrable domains by assessSupport. Convergence is also a different measurement from ' +
  'source overlap, over different objects: two members can cite every one of the same pages and ' +
  'converge on nothing, or cite no page in common and converge completely.';

export interface ClaimConvergenceReport {
  /** The pairs and groups that look like one claim, with the evidence for each. */
  readonly candidates: readonly ConvergenceCandidate[];
  /** How many members contributed claims. */
  readonly memberCount: number;
  /** The overlap threshold used, so a reader can re-run it at another value. */
  readonly threshold: number;
  /** Always `CONVERGENCE_IS_NOT_CORROBORATION`. */
  readonly caution: string;
}

/**
 * Find the conclusions several members appear to share.
 *
 * The threshold is passed straight through to `findConvergence` and defaults to
 * its default, so this module holds no second opinion about what counts as the
 * same claim.
 */
export function claimConvergence(
  sets: readonly ProviderClaimSet[],
  threshold?: number,
): ClaimConvergenceReport {
  const candidates =
    threshold === undefined ? findConvergence(sets) : findConvergence(sets, threshold);
  return {
    candidates,
    memberCount: sets.length,
    threshold: threshold ?? 0.2,
    caution: CONVERGENCE_IS_NOT_CORROBORATION,
  };
}

export type { ConvergenceCandidate, ProviderClaimSet };
