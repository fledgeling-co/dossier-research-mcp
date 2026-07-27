import { describe, expect, it } from 'vitest';
import { MIN_REPETITIONS_FOR_SPREAD, spreadEligibility } from '../run/cell.js';
import { spreadsOverlap, summarise } from './spread.js';

describe('REPORT-16 the median and the quartiles', () => {
  it('takes the middle value on an odd sample', () => {
    expect(summarise([3, 1, 2], 3)?.median).toBe(2);
  });

  it('takes the mean of the two middle values on an even sample', () => {
    expect(summarise([1, 2, 3, 4], 4)?.median).toBe(2.5);
  });

  it('matches a hand-computed R type 7 quartile', () => {
    // Sorted: 1 2 3 4 5. q1 sits at position 0.25 * 4 = 1, exactly on the
    // second value; q3 at 0.75 * 4 = 3, exactly on the fourth. Computed by
    // hand so the definition is pinned rather than asserted against itself.
    const result = summarise([5, 4, 3, 2, 1], 5);
    expect(result?.spread).toEqual({ q1: 2, q3: 4, iqr: 2, min: 1, max: 5 });
  });

  it('interpolates a quartile that falls between two values', () => {
    // Sorted: 1 2 3 4. q1 at 0.25 * 3 = 0.75, so 1 + (2-1) * 0.75 = 1.75.
    // q3 at 0.75 * 3 = 2.25, so 3 + (4-3) * 0.25 = 3.25.
    const result = summarise([4, 3, 2, 1], 4);
    expect(result?.spread?.q1).toBeCloseTo(1.75);
    expect(result?.spread?.q3).toBeCloseTo(3.25);
  });

  it('returns null for an empty sample rather than a zero', () => {
    expect(summarise([], 0)).toBeNull();
  });

  it('refuses a non-finite value rather than propagating a NaN into a table', () => {
    expect(() => summarise([1, Number.NaN], 2)).toThrow(/finite/);
    expect(() => summarise([Number.POSITIVE_INFINITY], 1)).toThrow(/finite/);
  });
});

describe('REPORT-14 the floor is BENCH-02s, not a second one', () => {
  it('withholds a spread at one result, with that function own wording', () => {
    const result = summarise([0.5], 1);
    expect(result?.spread).toBeNull();
    expect(result?.n).toBe(1);
    expect(result?.spreadWithheld).toBe(spreadEligibility(1).reason);
  });

  it('withholds at two, which is the divergence from the brief that is recorded', () => {
    const result = summarise([0.4, 0.6], 2);
    expect(result?.spread).toBeNull();
    expect(result?.median).toBeCloseTo(0.5);
    expect(result?.spreadWithheld).toBe(spreadEligibility(2).reason);
  });

  it('reports one at the floor', () => {
    const result = summarise([0.1, 0.2, 0.3], MIN_REPETITIONS_FOR_SPREAD);
    expect(result?.spread).not.toBeNull();
    expect(result?.spreadWithheld).toBe('');
    expect(result?.eligibility.floor).toBe(MIN_REPETITIONS_FOR_SPREAD);
  });
});

describe('REPORT-15 the floor is judged on completions, not on measurements', () => {
  it('withholds when only two of five completions could be measured', () => {
    // Five cells completed; three of them were a metric the task cannot
    // support, so two values arrived. Two is the sample, and quoting a
    // five-sample spread from it would be the same fabrication as counting a
    // deduped run five times.
    const result = summarise([0.2, 0.8], 2);
    expect(result?.spread).toBeNull();
    expect(result?.n).toBe(2);
  });

  it('reports when the completions clear the floor even where the values differ in count', () => {
    const result = summarise([0.2, 0.4, 0.6, 0.8], 4);
    expect(result?.n).toBe(4);
    expect(result?.spread).not.toBeNull();
  });
});

describe('the sample unit changes the sentence, never the floor', () => {
  it('names tasks rather than repetitions when the sample is tasks', () => {
    const result = summarise([0.5, 0.6], 2, 'task');
    expect(result?.spreadWithheld).toMatch(/2 tasks with a result/);
    expect(result?.spreadWithheld).toContain(String(MIN_REPETITIONS_FOR_SPREAD));
  });

  it('names categories when the sample is categories, and singularises one', () => {
    const result = summarise([0.5], 1, 'category');
    expect(result?.spreadWithheld).toMatch(/1 category with a result/);
  });
});

describe('REPORT-19 overlap is how two backends are called tied', () => {
  it('calls two disjoint spreads separated', () => {
    const a = summarise([0.1, 0.2, 0.3], 3);
    const b = summarise([0.7, 0.8, 0.9], 3);
    if (a === null || b === null) throw new Error('fixture produced no summary');
    expect(spreadsOverlap(a, b)).toBe(false);
  });

  it('calls two overlapping spreads tied', () => {
    const a = summarise([0.1, 0.5, 0.9], 3);
    const b = summarise([0.2, 0.6, 0.95], 3);
    if (a === null || b === null) throw new Error('fixture produced no summary');
    expect(spreadsOverlap(a, b)).toBe(true);
  });

  it('treats a withheld spread as overlapping, because unknown uncertainty cannot separate', () => {
    const a = summarise([0.1], 1);
    const b = summarise([0.9, 0.91, 0.92], 3);
    if (a === null || b === null) throw new Error('fixture produced no summary');
    expect(spreadsOverlap(a, b)).toBe(true);
  });
});
