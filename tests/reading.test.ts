import { describe, expect, it } from 'vitest';
import { readCoverage, renderReadCoverage, type ReadLedger } from '../src/research/reading.js';

const ledger = (events: ReadLedger['events']): ReadLedger => ({ runId: 'dr_x', events });
const at = '2026-07-27T00:00:00Z';

describe('READ-01: an outline is not the report', () => {
  // The whole point. An outline gives every heading and no content, which is
  // exactly what produced a confident synthesis over unread material.
  it('counts an outline read as no coverage at all', () => {
    const c = readCoverage(ledger([{ mode: 'outline', sections: [], chars: 0, at }]), 18, 60_000);
    expect(c.sectionsRead).toBe(0);
    expect(c.outlineOnly).toBe(true);
  });

  it('counts grep and summary the same way', () => {
    for (const mode of ['grep', 'summary'] as const) {
      const c = readCoverage(ledger([{ mode, sections: [], chars: 400, at }]), 18, 60_000);
      expect(c.sectionsRead, mode).toBe(0);
      expect(c.outlineOnly, mode).toBe(true);
    }
  });
});

describe('READ-02: coverage is distinct sections, not calls', () => {
  it('does not count re-reading one section as reading several', () => {
    const c = readCoverage(
      ledger([
        { mode: 'section', sections: [3], chars: 900, at },
        { mode: 'section', sections: [3], chars: 900, at },
        { mode: 'section', sections: [3], chars: 900, at },
      ]),
      18,
      60_000,
    );
    expect(c.sectionsRead, 'three reads of section 3 is one section').toBe(1);
    expect(c.reads).toBe(3);
  });

  it('treats a full read as covering every section', () => {
    const c = readCoverage(ledger([{ mode: 'full', sections: [], chars: 60_000, at }]), 18, 60_000);
    expect(c.sectionsRead).toBe(18);
    expect(c.fraction).toBe(1);
  });
});

describe('READ-03: the warning fires on the shape that actually happened', () => {
  // One report read in full, one summary only, four of eighteen sections, one
  // never opened. That was the real distribution.
  const rows = [
    { runId: 'dr_a', label: 'Grok', coverage: readCoverage(ledger([{ mode: 'full', sections: [], chars: 40_000, at }]), 12, 40_000) },
    { runId: 'dr_b', label: 'Claude Code', coverage: readCoverage(ledger([{ mode: 'summary', sections: [], chars: 800, at }]), 20, 60_000) },
    { runId: 'dr_c', label: 'Gemini', coverage: readCoverage(ledger([{ mode: 'section', sections: [1, 2, 3, 4], chars: 5_000, at }]), 18, 60_000) },
    { runId: 'dr_d', label: 'Cursor', coverage: readCoverage(undefined, 15, 50_000) },
  ];

  it('leads with a warning rather than burying it', () => {
    const out = renderReadCoverage(rows);
    expect(out.startsWith('> [!WARNING]'), 'the caveat that failed was accurate and buried').toBe(true);
  });

  it('names the report nobody opened', () => {
    expect(renderReadCoverage(rows)).toMatch(/Cursor.*never opened/s);
  });

  it('says an outline-only read is not a read', () => {
    expect(renderReadCoverage(rows)).toMatch(/Claude Code.*no section read/s);
  });

  it('says plainly that the claims list is not a substitute for the reports', () => {
    // This is the specific substitution that was made.
    expect(renderReadCoverage(rows)).toMatch(/not a substitute for the reports/);
  });

  it('stays quiet when everything was actually read', () => {
    const full = [
      { runId: 'dr_a', label: 'A', coverage: readCoverage(ledger([{ mode: 'full', sections: [], chars: 10, at }]), 5, 10) },
      { runId: 'dr_b', label: 'B', coverage: readCoverage(ledger([{ mode: 'full', sections: [], chars: 10, at }]), 5, 10) },
    ];
    const out = renderReadCoverage(full);
    expect(out).not.toMatch(/WARNING/);
    expect(out).toMatch(/What has been read/);
  });
});
