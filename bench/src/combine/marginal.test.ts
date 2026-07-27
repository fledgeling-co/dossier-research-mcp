import { describe, expect, it } from 'vitest';
import {
  exactnessRefusal,
  marginalContributions,
  MAX_EXACT_MEMBERS,
  type CoalitionValue,
} from './marginal.js';

/**
 * A value function from an explicit table, so the expected Shapley values can be
 * worked out by hand rather than by running the code being tested.
 */
function tabulated(table: Record<string, number>): CoalitionValue {
  return (ids) => table[[...ids].sort().join('+')] ?? 0;
}

describe('exact Shapley values (COMB-19)', () => {
  // The worked example, computed by hand from the definition:
  //   phi_i = sum over S in N\{i} of |S|!(n-|S|-1)!/n! * (v(S+i) - v(S))
  // with n = 3, so the weights are 1/3 for |S|=0, 1/6 for |S|=1, 1/3 for |S|=2.
  //
  // v: {} = 0, a = 10, b = 20, c = 30,
  //    ab = 40, ac = 50, bc = 60, abc = 70.
  const value = tabulated({
    '': 0,
    a: 10,
    b: 20,
    c: 30,
    'a+b': 40,
    'a+c': 50,
    'b+c': 60,
    'a+b+c': 70,
  });

  const result = marginalContributions(['a', 'b', 'c'], value);
  if (!result.exact) throw new Error('expected an exact result');
  const by = new Map(result.perMember.map((m) => [m.memberId, m]));

  it('matches the hand-computed value for each member', () => {
    // a: 1/3*(10-0) + 1/6*(40-20) + 1/6*(50-30) + 1/3*(70-60)
    //  = 10/3 + 20/6 + 20/6 + 10/3 = 3.3333+3.3333+3.3333+3.3333 = 13.3333
    expect(by.get('a')!.shapley).toBeCloseTo(40 / 3, 6);
    // b: 1/3*(20-0) + 1/6*(40-10) + 1/6*(60-30) + 1/3*(70-50)
    //  = 20/3 + 5 + 5 + 20/3 = 23.3333
    expect(by.get('b')!.shapley).toBeCloseTo(70 / 3, 6);
    // c: 1/3*(30-0) + 1/6*(50-10) + 1/6*(60-20) + 1/3*(70-40)
    //  = 10 + 40/6 + 40/6 + 10 = 33.3333
    expect(by.get('c')!.shapley).toBeCloseTo(100 / 3, 6);
  });

  it('reports the Banzhaf value separately, and it is a different number', () => {
    // Banzhaf weights every subset equally: for a, the four marginals are
    // 10, 20, 20, 10 over 4 subsets = 15. Shapley says 13.333. The brief asks
    // for one in words and names the other, so both ship under their own names.
    expect(by.get('a')!.banzhaf).toBeCloseTo(15, 6);
    expect(by.get('a')!.banzhaf).not.toBeCloseTo(by.get('a')!.shapley, 6);
  });

  it('says how many coalitions each marginal was measured over', () => {
    for (const m of result.perMember) expect(m.measuredOver).toBe(4);
    expect(result.coalitionsEvaluated).toBe(8);
  });
});

describe('the efficiency property (COMB-20)', () => {
  it('sums the Shapley values to v(all) minus v(none)', () => {
    const value = tabulated({
      '': 0,
      a: 10,
      b: 20,
      c: 30,
      'a+b': 40,
      'a+c': 50,
      'b+c': 60,
      'a+b+c': 70,
    });
    const result = marginalContributions(['a', 'b', 'c'], value);
    if (!result.exact) throw new Error('expected an exact result');
    const total = result.perMember.reduce((s, m) => s + m.shapley, 0);
    expect(total).toBeCloseTo(70, 9);
    expect(total).toBeCloseTo(result.totalValue, 9);
  });

  it('holds at a larger member count too, where a weighting slip would show', () => {
    // Random-ish but deterministic values over six members. Efficiency is the
    // property most sensitive to a wrong coalition-size weight, so it is the
    // cheapest guard against the weights being subtly off.
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const value: CoalitionValue = (chosen) =>
      chosen.reduce((s, id) => s + (id.charCodeAt(0) - 96) ** 2, 0) + chosen.length * 3;
    const result = marginalContributions(ids, value);
    if (!result.exact) throw new Error('expected an exact result');
    const total = result.perMember.reduce((s, m) => s + m.shapley, 0);
    expect(total).toBeCloseTo(value(ids) - value([]), 9);
  });

  it('gives a member that adds nothing a Shapley value of zero', () => {
    const value: CoalitionValue = (ids) => ids.filter((i) => i !== 'freeloader').length;
    const result = marginalContributions(['a', 'b', 'freeloader'], value);
    if (!result.exact) throw new Error('expected an exact result');
    const freeloader = result.perMember.find((m) => m.memberId === 'freeloader');
    expect(freeloader!.shapley).toBeCloseTo(0, 9);
    expect(freeloader!.banzhaf).toBeCloseTo(0, 9);
  });

  it('splits credit equally between two interchangeable members', () => {
    // Symmetry: two members whose contribution is identical in every coalition
    // must receive identical credit. A weighting bug that favours input order
    // shows here and nowhere else.
    const value: CoalitionValue = (ids) => ids.length * 5;
    const result = marginalContributions(['x', 'y', 'z'], value);
    if (!result.exact) throw new Error('expected an exact result');
    const values = result.perMember.map((m) => m.shapley);
    expect(values[0]).toBeCloseTo(values[1]!, 9);
    expect(values[1]).toBeCloseTo(values[2]!, 9);
  });
});

describe('it refuses rather than sampling (COMB-21)', () => {
  const tooMany = Array.from({ length: MAX_EXACT_MEMBERS + 1 }, (_, i) => `m${String(i)}`);

  it('returns a refusal above the ceiling instead of an approximation', () => {
    const result = marginalContributions(tooMany, () => 1);
    expect(result.exact).toBe(false);
    if (result.exact) throw new Error('expected a refusal');
    expect(result.memberCount).toBe(MAX_EXACT_MEMBERS + 1);
    expect(result.ceiling).toBe(MAX_EXACT_MEMBERS);
  });

  it('names the count and says plainly that sampling is not offered', () => {
    const result = marginalContributions(tooMany, () => 1);
    if (result.exact) throw new Error('expected a refusal');
    expect(result.refusal).toContain(String(MAX_EXACT_MEMBERS + 1));
    expect(result.refusal).toMatch(/sampling is deliberately not offered/i);
    // The reason, not just the rule: an approximate value reported as exact is
    // indistinguishable from the real thing once it is a number in a table.
    expect(result.refusal).toMatch(/indistinguishable from an\s+exact one/i);
  });

  it('names both ways back under the ceiling rather than only the problem', () => {
    const result = marginalContributions(tooMany, () => 1);
    if (result.exact) throw new Error('expected a refusal');
    expect(result.refusal).toMatch(/group a backend's repetitions into one/i);
    expect(result.refusal).toMatch(/explicit list of combinations/i);
  });

  it('never calls the value function when it refuses', () => {
    // A refusal that had already walked the lattice would have paid the cost it
    // exists to avoid.
    let calls = 0;
    marginalContributions(tooMany, () => {
      calls += 1;
      return 1;
    });
    expect(calls).toBe(0);
  });

  it('still answers exactly at the ceiling itself', () => {
    const atCeiling = Array.from({ length: 4 }, (_, i) => `m${String(i)}`);
    const result = marginalContributions(atCeiling, (ids) => ids.length, 4);
    expect(result.exact).toBe(true);
  });

  it('uses one wording for the limit, shared with the enumerator', () => {
    const result = marginalContributions(tooMany, () => 1);
    if (result.exact) throw new Error('expected a refusal');
    expect(result.refusal).toBe(exactnessRefusal(MAX_EXACT_MEMBERS + 1, MAX_EXACT_MEMBERS));
  });
});

describe('input guards', () => {
  it('refuses duplicate member ids', () => {
    expect(() => marginalContributions(['a', 'a'], () => 1)).toThrow(/distinct member ids/i);
  });

  it('refuses a value function that returns a non-finite number', () => {
    expect(() => marginalContributions(['a', 'b'], () => Number.NaN)).toThrow(/finite number/i);
  });

  it('returns an empty exact result for no members', () => {
    const result = marginalContributions([], () => 0);
    expect(result).toEqual({ exact: true, perMember: [], totalValue: 0, coalitionsEvaluated: 0 });
  });
});
