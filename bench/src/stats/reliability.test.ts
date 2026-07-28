import { describe, expect, it } from 'vitest';
import { MIN_REPETITIONS_FOR_SPREAD } from '../run/cell.js';
import { DEFAULT_PASS_THRESHOLD, passRates, type TaskAttempts } from './reliability.js';

function attempts(taskId: string, values: readonly number[], metric = 'accuracy'): TaskAttempts {
  return { taskId, metric, values };
}

describe('STAT-09 pass@1 and pass^k side by side', () => {
  it('is 1 and 1 for a backend that passes every attempt', () => {
    const report = passRates({
      provider: 'gemini',
      tasks: [attempts('t1', [1, 1, 1]), attempts('t2', [1, 1, 1])],
    });
    expect(report.passAt1).toBe(1);
    expect(report.passHatK).toBe(1);
    expect(report.k).toBe(3);
    expect(report.metrics).toEqual(['accuracy']);
  });

  it('separates a backend that sometimes works from one that does', () => {
    // The brief's headline case. Two of three attempts pass on every task, so
    // pass@1 is a respectable two thirds and pass^k is zero: it works, and it
    // never works every time, which is the number that matters unattended.
    const report = passRates({
      provider: 'flaky',
      tasks: [attempts('t1', [1, 1, 0]), attempts('t2', [1, 0, 1]), attempts('t3', [0, 1, 1])],
    });
    expect(report.passAt1).toBeCloseTo(2 / 3, 12);
    expect(report.passHatK).toBe(0);
    expect(report.repetitions).toBe(9);
    expect(report.passingRepetitions).toBe(6);
  });

  it('quotes k at the weakest task, not the average', () => {
    // One task run three times and one run five gives a pass^k that is partly a
    // pass^3, so three is the honest number to print. Same rule aggregate.ts
    // uses for the repetition floor, and for the same reason.
    const report = passRates({
      provider: 'x',
      tasks: [attempts('t1', [1, 1, 1]), attempts('t2', [1, 1, 1, 1, 1])],
    });
    expect(report.k).toBe(3);
  });

  it('takes the threshold as a parameter and defaults to full credit', () => {
    expect(DEFAULT_PASS_THRESHOLD).toBe(1);
    const partial = [attempts('t1', [0.9, 0.95, 0.99])];
    expect(passRates({ provider: 'x', tasks: partial }).passAt1).toBe(0);
    expect(passRates({ provider: 'x', tasks: partial, threshold: 0.9 }).passAt1).toBe(1);
    expect(passRates({ provider: 'x', tasks: partial, threshold: 0.9 }).threshold).toBe(0.9);
  });
});

describe('STAT-10 pass^k is withheld below the floor, using the floor that already exists', () => {
  it('withholds at k = 2 and carries the spread rule\'s own sentence', () => {
    const report = passRates({
      provider: 'x',
      tasks: [attempts('t1', [1, 1]), attempts('t2', [1, 1])],
    });
    expect(report.k).toBe(2);
    expect(report.passHatK).toBeNull();
    expect(report.passAt1).toBe(1);
    expect(report.kWithheld).toContain('below the floor of 3');
    expect(report.eligibility.floor).toBe(MIN_REPETITIONS_FOR_SPREAD);
  });

  it('withholds when one task drags the weakest count below the floor', () => {
    const report = passRates({
      provider: 'x',
      tasks: [attempts('t1', [1, 1, 1, 1]), attempts('t2', [1])],
    });
    expect(report.k).toBe(1);
    expect(report.passHatK).toBeNull();
    expect(report.passAt1).toBe(1);
  });

  it('reports both as absent when nothing was measurable at all', () => {
    const report = passRates({ provider: 'x', tasks: [attempts('t1', [])] });
    expect(report.passAt1).toBeNull();
    expect(report.passHatK).toBeNull();
    expect(report.tasksCounted).toBe(0);
    expect(report.tasksExcluded).toHaveLength(1);
    expect(report.kWithheld).toContain('nothing to count');
  });
});

describe('an unmeasured attempt is an absence, never a fail', () => {
  it('excludes a task with no measurable repetition and names why', () => {
    const report = passRates({
      provider: 'x',
      tasks: [attempts('t1', [1, 1, 1]), attempts('refusal-task', [], 'refusal')],
    });
    expect(report.tasksCounted).toBe(1);
    expect(report.passHatK).toBe(1);
    expect(report.tasksExcluded[0]?.why).toContain('not a failed one');
  });

  it('refuses a NaN rather than letting it become a silent fail', () => {
    expect(() => passRates({ provider: 'x', tasks: [attempts('t1', [1, Number.NaN])] })).toThrow(
      /non-finite/,
    );
  });

  it('carries every metric that decided a pass, sorted', () => {
    const report = passRates({
      provider: 'x',
      tasks: [attempts('t1', [1, 1, 1], 'refusal'), attempts('t2', [1, 1, 1], 'accuracy')],
    });
    expect(report.metrics).toEqual(['accuracy', 'refusal']);
  });
});
