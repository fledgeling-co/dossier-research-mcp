import { describe, expect, it } from 'vitest';
import { NO_MEASURED_DIFFERENCE, pairedDifference, type TaskValue } from './paired.js';

function values(entries: readonly (readonly [string, string, number])[]): TaskValue[] {
  return entries.map(([taskId, cluster, value]) => ({ taskId, cluster, value }));
}

/** Six tasks over three categories, so the cluster bootstrap has something to draw. */
const SIX: readonly (readonly [string, string])[] = [
  ['t1', 'technical'],
  ['t2', 'technical'],
  ['t3', 'contested'],
  ['t4', 'contested'],
  ['t5', 'time-bound'],
  ['t6', 'time-bound'],
];

function side(offsets: readonly number[], base = 0.5): TaskValue[] {
  return values(SIX.map(([id, cluster], i) => [id, cluster, base + (offsets[i] ?? 0)] as const));
}

describe('STAT-01 the comparison is paired, and says what it dropped', () => {
  it('uses only the tasks both backends answered, and names the rest', () => {
    const a = values([
      ['t1', 'technical', 0.9],
      ['t2', 'technical', 0.8],
      ['t3', 'contested', 0.7],
      ['only-a', 'technical', 0.1],
    ]);
    const b = values([
      ['t1', 'technical', 0.5],
      ['t2', 'technical', 0.4],
      ['t3', 'contested', 0.3],
      ['only-b', 'contested', 0.99],
    ]);
    const result = pairedDifference({ a: 'gemini', b: 'openai', aValues: a, bValues: b, direction: 'higher' });
    expect(result.shared.map((s) => s.taskId)).toEqual(['t1', 't2', 't3']);
    expect(result.droppedFromA).toEqual(['only-a']);
    expect(result.droppedFromB).toEqual(['only-b']);
  });

  it('refuses a task the two sides put in different categories', () => {
    const a = values([['t1', 'technical', 0.9]]);
    const b = values([['t1', 'contested', 0.5]]);
    expect(() =>
      pairedDifference({ a: 'x', b: 'y', aValues: a, bValues: b, direction: 'higher' }),
    ).toThrow(/belongs to exactly one category/);
  });

  it('withholds below two shared tasks rather than comparing one point to one point', () => {
    const result = pairedDifference({
      a: 'x',
      b: 'y',
      aValues: values([['t1', 'technical', 1]]),
      bValues: values([['t1', 'technical', 0]]),
      direction: 'higher',
    });
    expect(result.verdict).toBe('too-few-shared-tasks');
    expect(result.pointEstimate).toBeNull();
    expect(result.summary).toContain(NO_MEASURED_DIFFERENCE);
  });

  it('withholds when every shared task sits in one category', () => {
    const result = pairedDifference({
      a: 'x',
      b: 'y',
      aValues: values([
        ['t1', 'technical', 1],
        ['t2', 'technical', 1],
        ['t3', 'technical', 1],
      ]),
      bValues: values([
        ['t1', 'technical', 0],
        ['t2', 'technical', 0],
        ['t3', 'technical', 0],
      ]),
      direction: 'higher',
    });
    // Three tasks, one category. Every draw takes the same category, so the
    // interval would be a point: precision that is an artefact of having
    // nothing to resample.
    expect(result.verdict).toBe('too-few-clusters');
    expect(result.summary).toContain(NO_MEASURED_DIFFERENCE);
    expect(result.error).not.toBeNull();
  });
});

describe('STAT-03 an interval crossing zero is no measured difference, in those words', () => {
  it('says the phrase and states no point estimate in its sentence', () => {
    const a = side([0.3, -0.3, 0.2, -0.25, 0.1, -0.15]);
    const b = side([0, 0, 0, 0, 0, 0]);
    const result = pairedDifference({ a: 'alpha', b: 'beta', aValues: a, bValues: b, direction: 'higher' });
    expect(result.verdict).toBe('no-measured-difference');
    expect(result.summary).toContain(NO_MEASURED_DIFFERENCE);
    expect(result.betterBackend).toBeNull();
    expect(result.interval?.crossesZero).toBe(true);
    // The estimate is on the object for a downstream consumer and out of the
    // sentence a human reads, which is the whole point of the rule.
    expect(result.pointEstimate).not.toBeNull();
    expect(result.summary).not.toContain(String(result.pointEstimate));
  });

  it('reports a real gap as measured, with the interval excluding zero', () => {
    const a = side([0.28, 0.32, 0.3, 0.31, 0.29, 0.33]);
    const b = side([0, 0, 0, 0, 0, 0]);
    const result = pairedDifference({ a: 'alpha', b: 'beta', aValues: a, bValues: b, direction: 'higher' });
    expect(result.verdict).toBe('measured');
    expect(result.betterBackend).toBe('alpha');
    expect(result.interval?.crossesZero).toBe(false);
    expect(result.interval?.lower ?? 0).toBeGreaterThan(0);
    expect(result.summary).not.toContain(NO_MEASURED_DIFFERENCE);
  });

  it('respects the metric direction rather than assuming larger is better', () => {
    // Calibration Brier is the lower-is-better metric in the registry. alpha is
    // 0.3 BELOW beta, which makes alpha the better backend here and would make
    // it the worse one under a hardcoded "higher wins".
    const a = side([-0.28, -0.32, -0.3, -0.31, -0.29, -0.33]);
    const b = side([0, 0, 0, 0, 0, 0]);
    const higher = pairedDifference({ a: 'alpha', b: 'beta', aValues: a, bValues: b, direction: 'higher' });
    const lower = pairedDifference({ a: 'alpha', b: 'beta', aValues: a, bValues: b, direction: 'lower' });
    expect(higher.betterBackend).toBe('beta');
    expect(lower.betterBackend).toBe('alpha');
    expect(lower.pointEstimate).toBeCloseTo(higher.pointEstimate ?? 0, 15);
  });
});

describe('STAT-02 and STAT-06 every difference carries an interval and both errors', () => {
  it('carries the interval, the clustered error and the inflation together', () => {
    const a = side([0.28, 0.32, 0.3, 0.31, 0.29, 0.33]);
    const b = side([0, 0, 0, 0, 0, 0]);
    const result = pairedDifference({ a: 'alpha', b: 'beta', aValues: a, bValues: b, direction: 'higher' });
    expect(result.interval?.resamples).toBe(5000);
    expect(result.interval?.confidence).toBe(0.95);
    expect(result.error?.naive).toBeGreaterThan(0);
    expect(result.error?.clustered).toBeGreaterThan(0);
    expect(result.error?.inflation).not.toBeNull();
    expect(result.error?.clusters).toBe(3);
  });

  it('seeds from the pair, so the same comparison resamples identically', () => {
    const a = side([0.28, 0.32, 0.3, 0.31, 0.29, 0.33]);
    const b = side([0, 0, 0, 0, 0, 0]);
    const one = pairedDifference({ a: 'alpha', b: 'beta', aValues: a, bValues: b, direction: 'higher' });
    const two = pairedDifference({ a: 'alpha', b: 'beta', aValues: a, bValues: b, direction: 'higher' });
    expect(one.interval).toEqual(two.interval);
  });
});
