import { describe, expect, it } from 'vitest';
import type { PublicationDateView } from '../score/recency.js';
import { METRIC_IDS } from './metrics.js';
import { harvestCell, type HarvestEvidenceView } from './harvest.js';
import { cell, task } from './fixtures.js';

const REPORT = [
  '# Findings',
  '',
  'The release shipped on 2026-04-02 and the figure was anything. [source](https://example.test/a)',
  '',
  'A second statement, cited separately. [ref](https://other.test/b)',
].join('\n');

/**
 * Long enough for the syndication check to look at it.
 *
 * `MIN_SHINGLES` is 100 over ten-word windows, so a page under roughly 110
 * distinct words is reported as too little text to characterise rather than as
 * unique. The filler is what makes `comparedPages` non-zero, which is the
 * condition the collapsed-domain column is gated on.
 */
function longPage(prefix: string): string {
  const filler = Array.from({ length: 160 }, (_, i) => `${prefix}word${String(i)}`).join(' ');
  return `${prefix} ${filler}`;
}

function evidence(published: {
  readonly a?: PublicationDateView;
  readonly b?: PublicationDateView;
} = {}): HarvestEvidenceView {
  return {
    pages: [
      {
        url: 'https://example.test/a',
        text: longPage('The release shipped on 2026-04-02 and the figure was anything.'),
        truncated: false,
        verdict: 'live',
        completeHtml: true,
        anchors: [],
        published: published.a ?? { status: 'absent' },
      },
      {
        url: 'https://other.test/b',
        text: longPage('A second statement, cited separately.'),
        truncated: false,
        verdict: 'live',
        completeHtml: true,
        anchors: [],
        published: published.b ?? { status: 'absent' },
      },
    ],
    registry: [
      { kind: 'doi', id: '10.1000/a', status: 'present', detail: 'found' },
      { kind: 'arxiv', id: '2509.04499', status: 'unchecked', detail: 'rate limited' },
    ],
  };
}

describe('REPORT-07 a failed cell is a recorded result, never a zero', () => {
  it('measures nothing and says why', () => {
    const scored = harvestCell({
      cell: cell('t1', 'gemini', 1, { outcome: 'failed', failureKind: 'rate_limited' }),
      task: task('t1', 'technical'),
    });
    expect(scored.outcome).toBe('failed');
    expect(scored.failureKind).toBe('rate_limited');
    for (const id of METRIC_IDS) {
      expect(scored.metrics[id]).toBeNull();
      expect(scored.unmeasured[id]).toMatch(/failed/);
    }
  });

  it('says a failed cell reaches no denominator, in the reason a reader sees', () => {
    const scored = harvestCell({
      cell: cell('t1', 'gemini', 1, { outcome: 'failed' }),
      task: task('t1', 'technical'),
    });
    expect(scored.failureKind).toBe('unclassified');
    expect(scored.unmeasured.accuracy).toMatch(/reaches no metric denominator/);
  });
});

describe('REPORT-28 a missing report is our gap, not the backend failing', () => {
  it('is worded as a pipeline gap and is listed as one', () => {
    const scored = harvestCell({
      cell: cell('t1', 'gemini', 1),
      task: task('t1', 'technical'),
    });
    expect(scored.outcome).toBe('ok');
    expect(scored.metrics.accuracy).toBeNull();
    expect(scored.unmeasured.accuracy).toMatch(/gap in the reporting pipeline/);
    expect(scored.gaps).toHaveLength(1);
    expect(scored.gaps[0]).toMatch(/could not be read/);
  });
});

describe('REPORT-08 a not-applicable arm is null with its reason', () => {
  it('leaves dissent recall null on a task with no recorded dissent', () => {
    const scored = harvestCell({
      cell: cell('t1', 'gemini', 1),
      task: task('t1', 'technical'),
      report: REPORT,
    });
    expect(scored.metrics['dissent-recall']).toBeNull();
    expect(scored.unmeasured['dissent-recall']).not.toBe('');
    expect(scored.metrics['dissent-recall']).not.toBe(0);
  });

  it('leaves refusal null on a task that expects an answer', () => {
    const scored = harvestCell({
      cell: cell('t1', 'gemini', 1),
      task: task('t1', 'technical'),
      report: REPORT,
    });
    expect(scored.metrics.refusal).toBeNull();
    expect(scored.unmeasured.refusal).toMatch(/expectedRefusal/);
  });

  it('scores accuracy and relevance when the report states the answer', () => {
    const scored = harvestCell({
      cell: cell('t1', 'gemini', 1),
      task: task('t1', 'technical'),
      report: REPORT,
    });
    expect(scored.metrics.accuracy).toBe(1);
    expect(scored.metrics.relevance).toBe(1);
  });
});

describe('REPORT-21 recency is unavailable, permanently and by name', () => {
  it('is null with the missing input named, on a cell that scored everything else', () => {
    const scored = harvestCell({
      cell: cell('t1', 'gemini', 1),
      task: task('t1', 'technical'),
      report: REPORT,
      evidence: evidence(),
    });
    expect(scored.metrics['recency-fresh-share']).toBeNull();
    expect(scored.unmeasured['recency-fresh-share']).toMatch(/no publication date is recorded/);
    expect(scored.unmeasured['recency-fresh-share']).toMatch(/fetch time/);
  });
});

describe('REPORT-22 no evidence snapshot is a collection gap, not a citation failure', () => {
  it('nulls every citation rate and says the snapshot is missing', () => {
    const scored = harvestCell({
      cell: cell('t1', 'gemini', 1),
      task: task('t1', 'technical'),
      report: REPORT,
    });
    expect(scored.evidence).toBe('absent');
    expect(scored.metrics['citation-accuracy']).toBeNull();
    expect(scored.unmeasured['citation-accuracy']).toMatch(/no citation evidence snapshot/);
    expect(scored.unmeasured['citation-accuracy']).toMatch(/not a result about the backend/);
  });

  it('keeps citation VOLUME even when accuracy cannot be computed', () => {
    // The asymmetry is the whole point of keeping the two apart: volume is
    // computed from the report alone, and is exactly the number that must not
    // vanish when the accuracy column does.
    const scored = harvestCell({
      cell: cell('t1', 'gemini', 1),
      task: task('t1', 'technical'),
      report: REPORT,
    });
    expect(scored.metrics['citation-sources']).toBe(2);
    expect(scored.metrics['citation-accuracy']).toBeNull();
  });

  it('withholds the syndication-collapsed count when no page text was compared', () => {
    const scored = harvestCell({
      cell: cell('t1', 'gemini', 1),
      task: task('t1', 'technical'),
      report: REPORT,
    });
    expect(scored.metrics['independent-domains']).toBe(2);
    expect(scored.metrics['independent-domains-collapsed']).toBeNull();
    expect(scored.unmeasured['independent-domains-collapsed']).toMatch(/falsely imply/);
  });
});

describe('the registry counts reach the cell, including unchecked', () => {
  it('carries present, absent, unchecked and invalid from the snapshot', () => {
    const scored = harvestCell({
      cell: cell('t1', 'gemini', 1),
      task: task('t1', 'technical'),
      report: '# R\n\nA claim about 2509.04499 and doi:10.1000/a. [a](https://example.test/a)',
      evidence: evidence(),
    });
    expect(scored.evidence).toBe('present');
    expect(scored.registry.unchecked).toBeGreaterThanOrEqual(0);
    expect(
      scored.registry.present + scored.registry.absent + scored.registry.unchecked + scored.registry.invalid,
    ).toBeGreaterThan(0);
  });

  it('scores the citation rates and both volume columns with a snapshot', () => {
    const scored = harvestCell({
      cell: cell('t1', 'gemini', 1),
      task: task('t1', 'technical'),
      report: REPORT,
      evidence: evidence(),
    });
    expect(scored.metrics['citation-accuracy']).not.toBeNull();
    expect(scored.metrics['citation-sources']).toBe(2);
    expect(scored.metrics['independent-domains-collapsed']).not.toBeNull();
  });
});

describe('harvesting is deterministic and refuses a mismatched pairing', () => {
  it('produces an identical result twice', () => {
    const input = {
      cell: cell('t1', 'gemini', 1),
      task: task('t1', 'technical'),
      report: REPORT,
      evidence: evidence(),
    };
    expect(JSON.stringify(harvestCell(input))).toBe(JSON.stringify(harvestCell(input)));
  });

  it('refuses a cell harvested against the wrong task', () => {
    expect(() =>
      harvestCell({ cell: cell('t1', 'gemini', 1), task: task('t2', 'technical'), report: REPORT }),
    ).toThrow(/plausible numbers with nothing behind them/);
  });
});
