import type { ExactnessRefusedError } from './errors.js';

/**
 * Which member is actually earning its seat, computed exactly or not at all.
 *
 * The value a member adds is not a property of the member; it depends on who
 * else is in the combination. A backend that finds everything a second backend
 * finds is worth a lot on its own and nearly nothing beside it. The standard
 * answer to that is the Shapley value: a member's contribution averaged over
 * every subset it could join, weighted so every ordering of the members counts
 * once.
 *
 *     phi_i = sum over S in N\{i} of  |S|! (n-|S|-1)! / n!  *  ( v(S+i) - v(S) )
 *
 * With eight backends that is 255 subsets and it is exact. **Above the ceiling
 * it is refused, never sampled.** A sampled Shapley value reported as exact is
 * the kind of quiet lie this whole benchmark exists to avoid, and it is
 * indistinguishable from the real thing once it is a number in a table.
 *
 * ## The value function is injected, and what you pass it decides what this means
 *
 * Pass the combination's **score**. Do not pass its source count.
 *
 * Over a source count, a member that finds fifty pages nobody else found is by
 * construction the most valuable member, whatever those pages are worth. That
 * is exactly the eccentricity the brief forbids rewarding: a metric that pays
 * for unique sources selects for a backend reading obscure material rather than
 * for one that answers the question. Breadth is still measured, separately, as
 * `uniqueUrls` in `overlap.ts`, and it is labelled there as breadth rather than
 * value for the same reason.
 *
 * Pure and synchronous. `value` is called `2^n` times and is expected to be
 * cheap; the caller usually memoises it over an already-computed table.
 */

/**
 * The most members an exact credit split will be computed for.
 *
 * Sixteen, and the arithmetic is written down rather than asserted. The lattice
 * is `2^n` coalitions and evaluating it costs one set union over up to `n`
 * members' URL sets each, so the work is `O(n * 2^n)` insertions:
 *
 * | n  | coalitions | insertions (at ~500 URLs a member) |
 * |----|-----------|------------------------------------|
 * | 8  | 256       | ~1.0 million                        |
 * | 12 | 4,096     | ~25 million                         |
 * | 16 | 65,536    | ~520 million                        |
 * | 20 | 1,048,576 | ~10 billion                         |
 *
 * Sixteen is seconds and twenty is not minutes, it is hours. The brief puts the
 * affordable point at eight and the unaffordable one at sixteen; this sits at
 * the top of that range because a caller with twelve real members should get an
 * answer, and refuses immediately after.
 *
 * **Raising this is not a free parameter.** Anyone tempted to should read the
 * table first, and should reach for grouping repeats into one member instead:
 * that is what the member model in `member.ts` is for.
 */
export const MAX_EXACT_MEMBERS = 16;

/** `v(S)`: what a coalition of these members is worth. */
export type CoalitionValue = (memberIds: readonly string[]) => number;

export interface MemberContribution {
  readonly memberId: string;
  /** The exact Shapley value over the supplied value function. */
  readonly shapley: number;
  /**
   * The plain average of `v(S+i) - v(S)` over every subset, unweighted.
   *
   * Reported beside the Shapley value because it answers the simpler question
   * the brief actually asks ("how much does the combination lose when that
   * member is removed, averaged across every subset it appears in") and because
   * the two diverging is informative: the Shapley weighting leans on the small
   * and large coalitions, so a member whose value is concentrated in the middle
   * sizes reads differently under the two.
   */
  readonly meanDrop: number;
  /** How many coalitions this member's marginal was measured over: `2^(n-1)`. */
  readonly measuredOver: number;
}

export interface MarginalExact {
  readonly exact: true;
  readonly perMember: readonly MemberContribution[];
  /** `v(all) - v(none)`. The Shapley values sum to this; a test pins it. */
  readonly totalValue: number;
  readonly coalitionsEvaluated: number;
}

export interface MarginalRefused {
  readonly exact: false;
  readonly refusal: string;
  readonly memberCount: number;
  readonly ceiling: number;
}

export type MarginalResult = MarginalExact | MarginalRefused;

/**
 * The one wording for the refusal, so the enumerator and the credit split
 * cannot drift into saying different things about the same limit.
 */
export function exactnessRefusal(memberCount: number, ceiling = MAX_EXACT_MEMBERS): string {
  return (
    `Refusing to compute this exactly: ${String(memberCount)} members means ${String(2 ** Math.min(memberCount, 53))} ` +
    `coalitions, over the ceiling of ${String(ceiling)} members. ` +
    'Sampling is deliberately not offered. An approximate Shapley value is indistinguishable from an ' +
    'exact one once it is a number in a table, and reporting it as exact is the failure this benchmark ' +
    'exists to detect. Two ways under the ceiling, both exact: group a backend\'s repetitions into one ' +
    'member rather than treating each run as its own (a member is a named SET of runs, which is what ' +
    'the repetition axis means), or pass an explicit list of combinations to evaluate, each of which is ' +
    'scored exactly, with the credit split simply not reported rather than approximated.'
  );
}

/** Build the refusal as a throwable, for callers that want to fail hard. */
export function exactnessRefusedError(
  memberCount: number,
  ceiling = MAX_EXACT_MEMBERS,
): ExactnessRefusedError {
  return Object.assign(new Error(exactnessRefusal(memberCount, ceiling)), {
    name: 'ExactnessRefusedError' as const,
    memberCount,
    ceiling,
  });
}

/**
 * Shapley weights by coalition size, computed once per call.
 *
 * `|S|! (n-|S|-1)! / n!` is built multiplicatively rather than from three
 * factorials. `21!` already exceeds the exact-integer range of a double, so
 * computing the numerator and denominator separately would silently lose
 * precision before the division at member counts this function is otherwise
 * happy to accept.
 */
function shapleyWeights(n: number): Float64Array {
  const weights = new Float64Array(n);
  for (let s = 0; s < n; s += 1) {
    // w(s) = s! (n-s-1)! / n! = 1 / ( n * C(n-1, s) )
    let binomial = 1;
    for (let k = 0; k < s; k += 1) binomial = (binomial * (n - 1 - k)) / (k + 1);
    weights[s] = 1 / (n * binomial);
  }
  return weights;
}

/**
 * Split the credit for a combination's value across its members, exactly.
 *
 * Returns a refusal rather than a number above `MAX_EXACT_MEMBERS`.
 */
export function marginalContributions(
  memberIds: readonly string[],
  value: CoalitionValue,
  ceiling: number = MAX_EXACT_MEMBERS,
): MarginalResult {
  const n = memberIds.length;
  if (new Set(memberIds).size !== n) {
    throw new TypeError('marginalContributions needs distinct member ids; a duplicate is a collapsed subset');
  }
  if (n > ceiling) {
    return { exact: false, refusal: exactnessRefusal(n, ceiling), memberCount: n, ceiling };
  }
  if (n === 0) {
    return { exact: true, perMember: [], totalValue: 0, coalitionsEvaluated: 0 };
  }

  const total = 2 ** n;
  // v(S) for every subset, indexed by bitmask, computed once. Without this the
  // work is 2^n per member rather than 2^n overall, which is the difference
  // between seconds and an afternoon at the top of the range.
  const values = new Float64Array(total);
  for (let mask = 0; mask < total; mask += 1) {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) if ((mask & (1 << i)) !== 0) ids.push(memberIds[i]!);
    const v = value(ids);
    if (!Number.isFinite(v)) {
      throw new TypeError(
        `the value function returned ${String(v)} for coalition [${ids.join(', ')}]; ` +
          'a coalition value must be a finite number',
      );
    }
    values[mask] = v;
  }

  const weights = shapleyWeights(n);
  const perMember: MemberContribution[] = [];
  const subsetsWithout = 2 ** (n - 1);

  for (let i = 0; i < n; i += 1) {
    const bit = 1 << i;
    let shapley = 0;
    let dropSum = 0;
    for (let mask = 0; mask < total; mask += 1) {
      if ((mask & bit) !== 0) continue;
      // Popcount of a mask that never exceeds 2^16 here; a loop is clearer than
      // a bit-twiddling trick and is not the cost centre.
      let size = 0;
      for (let k = 0; k < n; k += 1) if ((mask & (1 << k)) !== 0) size += 1;
      const delta = values[mask | bit]! - values[mask]!;
      shapley += weights[size]! * delta;
      dropSum += delta;
    }
    perMember.push({
      memberId: memberIds[i]!,
      shapley,
      meanDrop: dropSum / subsetsWithout,
      measuredOver: subsetsWithout,
    });
  }

  return {
    exact: true,
    perMember,
    totalValue: values[total - 1]! - values[0]!,
    coalitionsEvaluated: total,
  };
}
