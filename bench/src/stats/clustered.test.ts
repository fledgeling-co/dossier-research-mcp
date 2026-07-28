import { describe, expect, it } from 'vitest';
import { byCluster, clusteredError, millerClusteredVariance, type Observation } from './clustered.js';

/**
 * The clustering tests, and the one that decides whether this slice is real.
 *
 * The brief's instruction is blunt: a test must prove the clustered and naive
 * figures differ on a fixture built to have within-category correlation, and if
 * they never differ the clustering is not wired up and the module is a
 * decoration. So the two fixtures below are the poles. Perfect within-cluster
 * correlation has a closed-form answer, `sqrt(m)`, and singleton clusters have
 * the other closed-form answer, exactly 1.
 */

function obs(cluster: string, values: readonly number[]): Observation[] {
  return values.map((value) => ({ value, cluster }));
}

describe('STAT-07 within-category correlation inflates the standard error', () => {
  it('inflates by exactly sqrt(m) when every task in a category agrees', () => {
    // Three categories, three identical tasks each. Perfect intracluster
    // correlation, so the design effect `1 + (m - 1) * rho` is exactly m and
    // the ratio of the standard errors is exactly sqrt(m).
    const cells = [...obs('a', [1, 1, 1]), ...obs('b', [4, 4, 4]), ...obs('c', [7, 7, 7])];
    const result = clusteredError(cells);
    expect(result).not.toBeNull();
    expect(result?.clustered).toBeGreaterThan(result?.naive ?? 0);
    expect(result?.inflation).toBeCloseTo(Math.sqrt(3), 12);
    expect(result?.designEffect).toBeCloseTo(3, 12);
  });

  it('reaches the literature\'s threefold at nine tasks a category', () => {
    // Miller measures 3.05x on DROP and the ICLR blogpost puts realistic
    // inflation at two to three. Nine perfectly correlated tasks a category is
    // where that number comes from, and this asserts the arithmetic rather
    // than the anecdote.
    const nine = (v: number): number[] => Array.from({ length: 9 }, () => v);
    const cells = [...obs('a', nine(0)), ...obs('b', nine(1)), ...obs('c', nine(2))];
    expect(clusteredError(cells)?.inflation).toBeCloseTo(3, 12);
  });

  it('is not merely larger: the naive figure understates by a factor a reader can see', () => {
    const cells = [...obs('a', [0.9, 0.95, 0.92]), ...obs('b', [0.2, 0.18, 0.25])];
    const result = clusteredError(cells);
    // Two tight, far-apart clusters: almost all the variance is between them,
    // so the naive error, which treats six observations as six independent
    // draws, is the one that would make a difference look measurable.
    expect(result?.inflation ?? 0).toBeGreaterThan(1.5);
  });
});

describe('STAT-08 with nothing to share, clustering may not change the answer', () => {
  it('is exactly 1 when every category holds one task', () => {
    const cells = [...obs('a', [1]), ...obs('b', [5]), ...obs('c', [2]), ...obs('d', [9])];
    const result = clusteredError(cells);
    expect(result?.clusters).toBe(4);
    expect(result?.clustered).toBeCloseTo(result?.naive ?? -1, 15);
    expect(result?.inflation).toBeCloseTo(1, 15);
  });
});

describe('STAT-06 both errors and the ratio between them', () => {
  it('matches a hand-computed sample', () => {
    // Values 1, 2, 6 in one cluster each. mean = 3.
    // deviations -2, -1, 3; squares 4 + 1 + 9 = 14; naive = sqrt(14)/3.
    const cells = [...obs('a', [1]), ...obs('b', [2]), ...obs('c', [6])];
    const result = clusteredError(cells);
    expect(result?.mean).toBeCloseTo(3, 12);
    expect(result?.naive).toBeCloseTo(Math.sqrt(14) / 3, 12);
  });

  it('returns null below two observations, because one value has no error', () => {
    expect(clusteredError([])).toBeNull();
    expect(clusteredError(obs('a', [1]))).toBeNull();
  });

  it('reports a zero error and no ratio when every value is identical', () => {
    const result = clusteredError([...obs('a', [2, 2]), ...obs('b', [2, 2])]);
    expect(result?.naive).toBe(0);
    expect(result?.clustered).toBe(0);
    expect(result?.inflation).toBeNull();
    expect(result?.designEffect).toBeNull();
  });

  it('carries the cluster shape, sorted, so the reader can see it', () => {
    const result = clusteredError([...obs('zeta', [1, 2]), ...obs('alpha', [3])]);
    expect(result?.clusterSizes).toEqual([
      { cluster: 'alpha', size: 1 },
      { cluster: 'zeta', size: 2 },
    ]);
  });

  it('refuses a non-finite value rather than propagating a NaN into a published table', () => {
    expect(() => clusteredError([...obs('a', [Number.NaN, 1]), ...obs('b', [2])])).toThrow(
      /finite values/,
    );
  });
});

describe('the sum-of-squares form agrees with Miller\'s additive one', () => {
  it('agrees on a positively correlated fixture', () => {
    const cells = [...obs('a', [1, 1.2, 0.9]), ...obs('b', [5, 4.8, 5.3])];
    const result = clusteredError(cells);
    expect((result?.clustered ?? 0) ** 2).toBeCloseTo(millerClusteredVariance(cells), 15);
  });

  it('agrees where the within-cluster covariance is negative', () => {
    // The case the additive form can hand a negative radicand to. The
    // sum-of-squares form cannot go negative, which is why it is the one that
    // ships; this proves it is not a different answer.
    const cells = [...obs('a', [10, -10]), ...obs('b', [1, -1])];
    const variance = millerClusteredVariance(cells);
    expect(variance).toBeCloseTo(0, 12);
    expect(clusteredError(cells)?.clustered).toBeCloseTo(Math.sqrt(Math.max(variance, 0)), 6);
  });
});

describe('byCluster is deterministic', () => {
  it('sorts clusters so a resample drawn from it is reproducible', () => {
    const grouped = byCluster([...obs('m', [1]), ...obs('a', [2]), ...obs('z', [3])]);
    expect(grouped.map((g) => g.cluster)).toEqual(['a', 'm', 'z']);
  });
});
