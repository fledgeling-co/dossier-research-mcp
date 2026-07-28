import { describe, expect, it } from 'vitest';
import {
  METRIC_IDS,
  allMetrics,
  betterFirst,
  isRankable,
  metricDescriptor,
  metricsOfFamily,
} from './metrics.js';

describe('REPORT-10 the registry is what stops a count becoming a leaderboard', () => {
  it('has a descriptor for every id, and no descriptor without an id', () => {
    // A key-set parity check in both directions. A metric added to the tuple
    // and not to the table would render as a blank column with nothing saying
    // it was blank, which is the failure mode this whole slice is against.
    const described = allMetrics().map((m) => m.id);
    expect([...described].sort()).toEqual([...METRIC_IDS].sort());
    for (const id of METRIC_IDS) expect(metricDescriptor(id).id).toBe(id);
  });

  it('refuses to describe an unknown metric rather than returning undefined', () => {
    // @ts-expect-error - deliberately passing an id outside the union
    expect(() => metricDescriptor('made-up')).toThrow(/no descriptor/i);
  });

  it('marks every volume metric unrankable', () => {
    for (const metric of metricsOfFamily('volume')) {
      expect(metric.direction).toBe('none');
      expect(isRankable(metric.id)).toBe(false);
    }
    expect(metricsOfFamily('volume').length).toBeGreaterThan(0);
  });

  it('refuses to build a comparator for an unrankable metric', () => {
    expect(() => betterFirst('citation-sources')).toThrow(/never be ordered/);
    expect(() => betterFirst('citations-per-statement')).toThrow(/never be ordered/);
  });

  it('keeps citation accuracy and citation volume in different families', () => {
    expect(metricDescriptor('citation-accuracy').family).toBe('quality');
    expect(metricDescriptor('citation-sources').family).toBe('volume');
    expect(isRankable('citation-accuracy')).toBe(true);
    expect(isRankable('citation-sources')).toBe(false);
  });
});

describe('REPORT-20 direction', () => {
  it('makes the Brier score the only one where lower is better', () => {
    const lower = allMetrics().filter((m) => m.direction === 'lower');
    expect(lower.map((m) => m.id)).toEqual(['calibration-brier']);
  });

  it('orders a higher-is-better metric descending and the Brier ascending', () => {
    expect([0.2, 0.9, 0.5].sort(betterFirst('accuracy'))).toEqual([0.9, 0.5, 0.2]);
    expect([0.2, 0.9, 0.5].sort(betterFirst('calibration-brier'))).toEqual([0.2, 0.5, 0.9]);
  });
});

describe('every number carries what it cannot mean', () => {
  it('gives each metric a non-empty caveat', () => {
    for (const metric of allMetrics()) {
      expect(metric.caveat.length).toBeGreaterThan(20);
    }
  });

  it('DATE-24 says on the recency metric what the figure is over, not that it is missing', () => {
    // Corrected 28 July 2026 with REPORT-21: the caveat used to say nothing
    // records a publication date, and something now does.
    const caveat = metricDescriptor('recency-fresh-share').caveat;
    expect(caveat).toMatch(/datable/);
    expect(caveat).toMatch(/never counts as fresh/);
    expect(caveat).not.toMatch(/nothing in the stored results records/);
  });
});
