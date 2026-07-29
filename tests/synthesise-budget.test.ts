import { describe, expect, it } from 'vitest';
import { takeWithin } from '../src/research/report.js';

describe('synthesise output budget', () => {
  it('takes whole lines and reports the remainder', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `- claim number ${String(i)}`);
    const r = takeWithin(lines, 100);
    expect(r.taken.length + r.dropped).toBe(100);
    expect(r.taken.join('\n').length).toBeLessThanOrEqual(100);
    // Whole lines only: a half-written claim reads as a complete finding.
    for (const l of r.taken) expect(lines).toContain(l);
  });

  it('drops nothing when everything fits', () => {
    const lines = ['- a', '- b'];
    expect(takeWithin(lines, 10_000)).toEqual({ taken: ['- a', '- b'], dropped: 0 });
  });

  it('reports every line dropped rather than emitting a partial one', () => {
    // The budget cannot fit even the first line. The failure mode being guarded
    // is returning a truncated claim that looks whole.
    const r = takeWithin(['- a very long claim indeed'], 5);
    expect(r.taken).toEqual([]);
    expect(r.dropped).toBe(1);
  });
});
