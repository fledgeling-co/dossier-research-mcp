import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIDENCE, DEFAULT_RESAMPLES, clusterBootstrap } from './bootstrap.js';
import type { Observation } from './clustered.js';
import { mulberry32, seedFrom } from './random.js';
import { quantile } from './quantile.js';

function obs(cluster: string, values: readonly number[]): Observation[] {
  return values.map((value) => ({ value, cluster }));
}

describe('STAT-02 the published defaults, echoed rather than assumed', () => {
  it('is 5,000 resamples at 95%, and says so on the result', () => {
    expect(DEFAULT_RESAMPLES).toBe(5000);
    expect(DEFAULT_CONFIDENCE).toBe(0.95);
    const result = clusterBootstrap([...obs('a', [1, 2]), ...obs('b', [3, 4])]);
    expect(result?.resamples).toBe(5000);
    expect(result?.confidence).toBe(0.95);
    expect(result?.clusters).toBe(2);
    expect(result?.n).toBe(4);
  });

  it('refuses a nonsense resample count or confidence level', () => {
    const cells = [...obs('a', [1]), ...obs('b', [2])];
    expect(() => clusterBootstrap(cells, { resamples: 0 })).toThrow(/positive integer/);
    expect(() => clusterBootstrap(cells, { resamples: 2.5 })).toThrow(/positive integer/);
    expect(() => clusterBootstrap(cells, { confidence: 1 })).toThrow(/strictly between/);
    expect(() => clusterBootstrap(cells, { confidence: 0 })).toThrow(/strictly between/);
  });
});

describe('STAT-04 the interval is reproducible', () => {
  it('gives byte-identical endpoints on two runs over the same input', () => {
    const cells = [...obs('a', [0.4, 0.6, 0.5]), ...obs('b', [0.1, 0.2]), ...obs('c', [0.9])];
    const first = clusterBootstrap(cells, { seedParts: ['accuracy', 'overall', 'gemini', 'openai'] });
    const second = clusterBootstrap(cells, { seedParts: ['accuracy', 'overall', 'gemini', 'openai'] });
    expect(first).toEqual(second);
    expect(first?.seed).toBe(seedFrom(['accuracy', 'overall', 'gemini', 'openai']));
  });

  it('resamples differently for a different comparison', () => {
    const cells = [...obs('a', [0.4, 0.6, 0.5]), ...obs('b', [0.1, 0.2]), ...obs('c', [0.9])];
    const one = clusterBootstrap(cells, { seedParts: ['gemini', 'openai'] });
    const other = clusterBootstrap(cells, { seedParts: ['openai', 'gemini'] });
    expect(one?.seed).not.toBe(other?.seed);
  });
});

describe('STAT-05 clusters are drawn as a unit, not tasks', () => {
  it('gives a wider interval on correlated clusters than on the same values spread out', () => {
    // Nine identical values either way. The only difference is whether the
    // three that agree are drawn together. Drawing tasks would make these two
    // intervals the same width, which is the error this test exists to catch.
    const correlated = [...obs('a', [1, 1, 1]), ...obs('b', [0, 0, 0]), ...obs('c', [-1, -1, -1])];
    const spread = [1, 1, 1, 0, 0, 0, -1, -1, -1].map((value, i) => ({
      value,
      cluster: `c${String(i)}`,
    }));
    const seedParts = ['same-seed'];
    const clustered = clusterBootstrap(correlated, { seedParts });
    const independent = clusterBootstrap(spread, { seedParts });
    const clusteredWidth = (clustered?.upper ?? 0) - (clustered?.lower ?? 0);
    const independentWidth = (independent?.upper ?? 0) - (independent?.lower ?? 0);
    expect(clusteredWidth).toBeGreaterThan(independentWidth);
  });

  it('withholds below two clusters, because one cluster resamples onto itself', () => {
    expect(clusterBootstrap(obs('only', [1, 2, 3, 4, 5]))).toBeNull();
    expect(clusterBootstrap([])).toBeNull();
  });
});

describe('crossing zero is decided once, here', () => {
  it('crosses on a sample centred on zero', () => {
    const result = clusterBootstrap([...obs('a', [1, -1]), ...obs('b', [2, -2]), ...obs('c', [0.5, -0.5])]);
    expect(result?.crossesZero).toBe(true);
  });

  it('does not cross on a sample far from zero', () => {
    const result = clusterBootstrap([...obs('a', [5, 5]), ...obs('b', [6, 6]), ...obs('c', [7, 7])]);
    expect(result?.crossesZero).toBe(false);
    expect(result?.lower).toBeGreaterThan(0);
    expect(result?.estimate).toBeCloseTo(6, 12);
  });
});

describe('the quantile, shared with the quartiles', () => {
  it('is R type 7, matching a hand-computed interpolation', () => {
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 12);
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 12);
    expect(quantile([10], 0.9)).toBe(10);
  });

  it('refuses an empty sample or a probability outside [0, 1]', () => {
    expect(() => quantile([], 0.5)).toThrow(/at least one value/);
    expect(() => quantile([1, 2], 1.5)).toThrow(/probability/);
    expect(() => quantile([1, 2], Number.NaN)).toThrow(/probability/);
  });
});

describe('the generator itself', () => {
  it('is stable, in range, and diverges on a different seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
    for (const v of first) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('never seeds from zero, and does not collide on a shifted join', () => {
    expect(seedFrom([''])).not.toBe(0);
    expect(seedFrom(['ab', 'c'])).not.toBe(seedFrom(['a', 'bc']));
  });
});
