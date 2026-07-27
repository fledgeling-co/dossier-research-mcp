import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { loadCorpus, type BenchTask } from '../../tasks/index.js';
import {
  DUE_WEIGHT_LIMITS,
  FLAGGED_ONLY_CREDIT,
  aggregateDueWeight,
  scoreDueWeight,
} from './index.js';

/**
 * The scorer, driven through the real loader.
 *
 * Fixtures are built as YAML and parsed by `loadCorpus` rather than hand-built
 * as object literals. That costs a few lines per test and buys two things: the
 * scorer is proven against exactly the shape a corpus author writes, and
 * `applicableMetrics` comes from the loader that owns it rather than from a
 * second derivation in a test file, which is the duplication BENCH-01 exists to
 * prevent.
 */

const NOW = new Date('2026-07-27T00:00:00.000Z');

const DISSENT_URL = 'https://example.org/minority-view';
const DISTINGUISHING_TERM = 'overstated by a factor of two';

function buildTask(overrides: Record<string, unknown>): BenchTask {
  const base = {
    id: 'fixture-task',
    category: 'technical',
    question: 'A question comfortably longer than the ten character minimum.',
    asOf: '2026-07-01',
    reverifiedAt: '2026-07-20',
    goldFacts: [
      { id: 'g1', kind: 'name', value: 'Acme', source: { url: 'https://example.gov/a' } },
    ],
    ...overrides,
  };
  const corpus = loadCorpus([{ file: 'fixture.yaml', text: stringify(base) }], { now: NOW });
  const task = corpus.tasks[0];
  if (task === undefined) throw new Error('fixture did not load');
  return task;
}

function contested(overrides: Record<string, unknown> = {}): BenchTask {
  return buildTask({
    category: 'contested',
    knownDissent: [{ url: DISSENT_URL, distinguishingTerm: DISTINGUISHING_TERM }],
    ...overrides,
  });
}

function numericValue(id: string, value: number): Record<string, unknown> {
  return {
    id,
    kind: 'number',
    value,
    unit: 'USD',
    tolerance: { kind: 'exact' },
    source: { url: `https://example.gov/${id}` },
  };
}

/** A task carrying one quantity with two authoritative, clashing figures. */
function withConflict(overrides: Record<string, unknown> = {}): BenchTask {
  return buildTask({
    category: 'contested',
    conflictingFigures: [
      {
        quantity: 'reported revenue',
        values: [numericValue('filing', 1200000000), numericValue('press', 1150000000)],
      },
    ],
    ...overrides,
  });
}

const FRINGE_TERM = 'secret restatement';

function withFringe(rejectionCues: readonly string[] = ['no evidence', 'debunked']): BenchTask {
  return buildTask({
    id: 'settled-fixture',
    category: 'settled-with-fringe',
    fringeClaims: [
      {
        claim: 'The figure was restated downward in secret.',
        distinguishingTerm: FRINGE_TERM,
        source: { url: 'https://example.net/the-claim' },
        rejectionCues,
      },
    ],
  });
}

describe('dissent recall', () => {
  // DUEWT-01
  it('scores recall for citing the dissenting URL even with the term absent', () => {
    const score = scoreDueWeight(contested(), {
      text: `The consensus holds. See also [a dissenting reading](${DISSENT_URL}).`,
    });
    expect(score.dissentRecall.measured).toBe(true);
    if (!score.dissentRecall.measured) return;
    expect(score.dissentRecall.score).toBe(1);
    expect(score.dissentRecall.findings[0]?.reachedBy).toBe('url');
  });

  it('scores recall for the literal term with the URL absent, and reports both together', () => {
    const byTerm = scoreDueWeight(contested(), {
      text: `Some analysts consider it ${DISTINGUISHING_TERM}.`,
    });
    if (!byTerm.dissentRecall.measured) throw new Error('expected a measured metric');
    expect(byTerm.dissentRecall.findings[0]?.reachedBy).toBe('term');

    const both = scoreDueWeight(contested(), {
      text: `Some call it ${DISTINGUISHING_TERM} — see ${DISSENT_URL}.`,
    });
    if (!both.dissentRecall.measured) throw new Error('expected a measured metric');
    expect(both.dissentRecall.findings[0]?.reachedBy).toBe('url-and-term');
  });

  // DUEWT-02
  it('does not score recall for a synonym, and states that limit in the output', () => {
    const score = scoreDueWeight(contested(), {
      text: 'Some analysts consider it exaggerated twofold, citing https://example.org/unrelated.',
    });
    if (!score.dissentRecall.measured) throw new Error('expected a measured metric');
    expect(score.dissentRecall.score).toBe(0);
    expect(score.dissentRecall.findings[0]?.reachedBy).toBe('missed');
    // The brief requires this limit to be stated in the output, not hidden.
    expect(score.limits).toContain(DUE_WEIGHT_LIMITS.literalTerm);
    expect(score.limits.join(' ')).toContain('synonym');
  });

  // DUEWT-03
  it('matches the dissenting source through the dressings canonicalisation removes', () => {
    const equivalent = [
      'http://example.org/minority-view',
      'https://www.example.org/minority-view/',
      'https://example.org/minority-view?utm_source=newsletter',
      'https://example.org/minority-view#section-3',
    ];
    for (const url of equivalent) {
      const score = scoreDueWeight(contested(), { text: 'A report.', citedUrls: [url] });
      if (!score.dissentRecall.measured) throw new Error('expected a measured metric');
      expect(score.dissentRecall.score, url).toBe(1);
    }
  });

  // DUEWT-03
  it('does not match a different page on the same host, or a significant query parameter', () => {
    for (const url of ['https://example.org/majority-view', 'https://example.org/minority-view?id=7']) {
      const score = scoreDueWeight(contested(), { text: 'A report.', citedUrls: [url] });
      if (!score.dissentRecall.measured) throw new Error('expected a measured metric');
      expect(score.dissentRecall.score, url).toBe(0);
    }
  });

  // DUEWT-05
  it('scores partial recall over several dissents and names the one that was missed', () => {
    const task = contested({
      knownDissent: [
        { url: DISSENT_URL, distinguishingTerm: DISTINGUISHING_TERM },
        { url: 'https://example.net/second-view', distinguishingTerm: 'measurement artefact' },
      ],
    });
    const score = scoreDueWeight(task, { text: `They call it ${DISTINGUISHING_TERM}.` });
    if (!score.dissentRecall.measured) throw new Error('expected a measured metric');
    expect(score.dissentRecall.score).toBe(0.5);
    expect(score.dissentRecall.reached).toBe(1);
    expect(score.dissentRecall.total).toBe(2);
    const missed = score.dissentRecall.findings.filter((f) => f.reachedBy === 'missed');
    expect(missed).toHaveLength(1);
    expect(missed[0]?.distinguishingTerm).toBe('measurement artefact');
  });

  // DUEWT-19
  it('derives cited URLs from the report text when the caller omits them', () => {
    const derived = scoreDueWeight(contested(), { text: `Background. <${DISSENT_URL}>` });
    if (!derived.dissentRecall.measured) throw new Error('expected a measured metric');
    expect(derived.dissentRecall.score).toBe(1);
  });

  // DUEWT-19
  it('uses an explicitly supplied citation list unchanged, ignoring URLs only in the prose', () => {
    const supplied = scoreDueWeight(contested(), {
      text: `Background mentioning ${DISSENT_URL} in passing.`,
      citedUrls: ['https://example.com/something-else'],
    });
    if (!supplied.dissentRecall.measured) throw new Error('expected a measured metric');
    expect(supplied.dissentRecall.score).toBe(0);
  });
});

describe('conflict acknowledgement', () => {
  // DUEWT-06
  it('gives full credit when both figures are present, in any of the forms a report writes', () => {
    const forms = [
      'Reported revenue was 1,200,000,000 in the filing and 1,150,000,000 in the release.',
      'Reported revenue was 1.2 billion in the filing and 1.15 billion in the release.',
      'Reported revenue was $1.2bn in the filing and $1.15bn in the release.',
    ];
    for (const text of forms) {
      const score = scoreDueWeight(withConflict(), { text });
      if (!score.conflictAcknowledgement.measured) throw new Error('expected a measured metric');
      expect(score.conflictAcknowledgement.score, text).toBe(1);
      expect(score.conflictAcknowledgement.findings[0]?.outcome).toBe('both-figures');
    }
  });

  // DUEWT-07
  it('reports one figure with no cue as one-sided, which is the named failure', () => {
    const score = scoreDueWeight(withConflict(), {
      text: 'Reported revenue was 1,200,000,000 for the year.',
    });
    if (!score.conflictAcknowledgement.measured) throw new Error('expected a measured metric');
    expect(score.conflictAcknowledgement.score).toBe(0);
    const finding = score.conflictAcknowledgement.findings[0];
    expect(finding?.outcome).toBe('one-sided');
    expect(finding?.values.filter((v) => v.found)).toHaveLength(1);
  });

  // DUEWT-08
  it('reports neither figure as unaddressed, distinctly from one-sided', () => {
    const score = scoreDueWeight(withConflict(), {
      text: 'The company had a strong year across every segment.',
    });
    if (!score.conflictAcknowledgement.measured) throw new Error('expected a measured metric');
    expect(score.conflictAcknowledgement.score).toBe(0);
    expect(score.conflictAcknowledgement.findings[0]?.outcome).toBe('unaddressed');
  });

  // DUEWT-09
  it('gives half credit for flagging the disagreement without carrying both figures', () => {
    const score = scoreDueWeight(withConflict(), {
      text: 'Reported revenue was 1,200,000,000, though sources differ on the exact number.',
    });
    if (!score.conflictAcknowledgement.measured) throw new Error('expected a measured metric');
    expect(score.conflictAcknowledgement.score).toBe(FLAGGED_ONLY_CREDIT);
    const finding = score.conflictAcknowledgement.findings[0];
    expect(finding?.outcome).toBe('flagged-only');
    expect(finding?.disagreementFlagged).toBe(true);
    expect(finding?.matchedCue).toBeTruthy();
  });

  // DUEWT-09
  it('does not count a cue that sits beyond the proximity window', () => {
    const score = scoreDueWeight(withConflict(), {
      text: `Reported revenue was 1,200,000,000 for the year. ${'filler word '.repeat(80)} Elsewhere, sources differ.`,
    });
    if (!score.conflictAcknowledgement.measured) throw new Error('expected a measured metric');
    expect(score.conflictAcknowledgement.findings[0]?.outcome).toBe('one-sided');
  });

  it('does not let one stated number satisfy two gold values whose tolerances overlap', () => {
    // Without a claim rule, a report stating a single figure would be scored as
    // having disclosed a disagreement it never mentioned — a score over a check
    // that did not happen, which is the worst failure this scorer can have.
    const task = buildTask({
      category: 'contested',
      conflictingFigures: [
        {
          quantity: 'reported revenue',
          values: [
            { ...numericValue('a', 1200000000), tolerance: { kind: 'relative', fraction: 0.1 } },
            { ...numericValue('b', 1150000000), tolerance: { kind: 'relative', fraction: 0.1 } },
          ],
        },
      ],
    });
    const score = scoreDueWeight(task, { text: 'Reported revenue was 1.18 billion.' });
    if (!score.conflictAcknowledgement.measured) throw new Error('expected a measured metric');
    expect(score.conflictAcknowledgement.findings[0]?.outcome).toBe('one-sided');
    expect(score.conflictAcknowledgement.findings[0]?.values.filter((v) => v.found)).toHaveLength(1);
  });

  // DUEWT-20
  it('reports the declared unit where it sits beside the figure, and never gates on it', () => {
    const withUnit = scoreDueWeight(withConflict(), {
      text: 'Reported revenue was USD 1,200,000,000 and USD 1,150,000,000.',
    });
    if (!withUnit.conflictAcknowledgement.measured) throw new Error('expected a measured metric');
    expect(withUnit.conflictAcknowledgement.findings[0]?.values.every((v) => v.unitNearby)).toBe(true);

    const withSymbol = scoreDueWeight(withConflict(), {
      text: 'Reported revenue was $1,200,000,000 and $1,150,000,000.',
    });
    if (!withSymbol.conflictAcknowledgement.measured) throw new Error('expected a measured metric');
    // No `USD` token anywhere, and the match still stands: the unit is reported,
    // not required. Requiring it would miss every figure written with a symbol.
    expect(withSymbol.conflictAcknowledgement.score).toBe(1);
    expect(withSymbol.conflictAcknowledgement.findings[0]?.values.some((v) => v.unitNearby)).toBe(false);
    expect(withSymbol.limits).toContain(DUE_WEIGHT_LIMITS.unitNotGating);
  });

  it('quotes what the report wrote for each figure it found', () => {
    const score = scoreDueWeight(withConflict(), {
      text: 'Reported revenue was $1.2bn against a press figure of 1,150,000,000.',
    });
    if (!score.conflictAcknowledgement.measured) throw new Error('expected a measured metric');
    const values = score.conflictAcknowledgement.findings[0]?.values ?? [];
    expect(values[0]?.matchedText).toBe('1.2bn');
    expect(values[1]?.matchedText).toBe('1,150,000,000');
  });
});

describe('the false-balance guard', () => {
  // DUEWT-10
  it('gives full credit for not surfacing the fringe claim at all', () => {
    const score = scoreDueWeight(withFringe(), {
      text: 'The figure is settled and has been confirmed by the regulator.',
    });
    if (!score.falseBalance.measured) throw new Error('expected a measured metric');
    expect(score.falseBalance.score).toBe(1);
    expect(score.falseBalance.findings[0]?.outcome).toBe('not-surfaced');
  });

  // DUEWT-10
  it('gives full credit for surfacing it in order to dismiss it', () => {
    const score = scoreDueWeight(withFringe(), {
      text: 'A claim of a secret restatement circulates online, but there is no evidence for it.',
    });
    if (!score.falseBalance.measured) throw new Error('expected a measured metric');
    expect(score.falseBalance.score).toBe(1);
    expect(score.falseBalance.findings[0]?.outcome).toBe('surfaced-and-rejected');
    expect(score.falseBalance.findings[0]?.matchedCue).toBe('no evidence');
  });

  // DUEWT-10
  it('scores zero for surfacing it as though the question were open', () => {
    const score = scoreDueWeight(withFringe(), {
      text: 'Analysts are split: some point to a secret restatement, others to the audited filing.',
    });
    if (!score.falseBalance.measured) throw new Error('expected a measured metric');
    expect(score.falseBalance.score).toBe(0);
    expect(score.falseBalance.findings[0]?.outcome).toBe('surfaced-as-contested');
  });

  it('accepts one rejected mention rather than demanding every mention be covered', () => {
    // A report that dismissed the claim properly and then listed its source
    // again must not be penalised: the guard exists to catch hedging, not
    // thoroughness.
    const score = scoreDueWeight(withFringe(), {
      text: `The secret restatement claim has been debunked. ${'padding text '.repeat(60)} Further reading on the secret restatement claim is linked below.`,
    });
    if (!score.falseBalance.measured) throw new Error('expected a measured metric');
    expect(score.falseBalance.score).toBe(1);
  });

  it('does not count a rejection cue that sits beyond the proximity window', () => {
    const score = scoreDueWeight(withFringe(), {
      text: `Some point to a secret restatement. ${'padding text '.repeat(80)} Separately, there is no evidence of a governance failure.`,
    });
    if (!score.falseBalance.measured) throw new Error('expected a measured metric');
    expect(score.falseBalance.findings[0]?.outcome).toBe('surfaced-as-contested');
  });

  // DUEWT-11
  it('scores zero on any mention when no rejection cues were recorded, and says so', () => {
    const score = scoreDueWeight(withFringe([]), {
      text: 'The secret restatement claim is untrue and unsupported by anything.',
    });
    if (!score.falseBalance.measured) throw new Error('expected a measured metric');
    expect(score.falseBalance.score).toBe(0);
    const stated = score.limits.filter((l) => l.includes('records no rejectionCues'));
    expect(stated).toHaveLength(1);
    expect(stated[0]).toContain('settled-fixture');
    expect(stated[0]).toContain(FRINGE_TERM);
  });
});

describe('applicability', () => {
  // DUEWT-12
  it('returns a reason rather than a zero for a metric the task cannot support', () => {
    const score = scoreDueWeight(contested(), { text: 'Anything.' });
    expect(score.conflictAcknowledgement.measured).toBe(false);
    expect(score.falseBalance.measured).toBe(false);
    if (score.conflictAcknowledgement.measured) return;
    expect(score.conflictAcknowledgement.reason).toContain('conflictingFigures');
  });

  // DUEWT-12
  it('keeps an unsupported metric out of that metric denominator entirely', () => {
    const summary = aggregateDueWeight([
      scoreDueWeight(contested(), { text: `See ${DISSENT_URL}.` }),
      scoreDueWeight(withFringe(), { text: 'Settled, and nothing fringe is raised.' }),
    ]);
    // Two tasks, but only one of them could carry each of these.
    expect(summary.tasks).toBe(2);
    expect(summary.dissentRecall).toEqual({ mean: 1, tasks: 1 });
    expect(summary.falseBalance).toEqual({ mean: 1, tasks: 1 });
    expect(summary.conflictAcknowledgement).toEqual({ mean: null, tasks: 0 });
  });

  it('carries the task category and id onto the result for a scorecard to group by', () => {
    const score = scoreDueWeight(withFringe(), { text: 'Settled.' });
    expect(score.taskId).toBe('settled-fixture');
    expect(score.category).toBe('settled-with-fringe');
  });
});

describe('aggregateDueWeight', () => {
  // DUEWT-15
  it('returns three unmeasured means and no overall for an empty set', () => {
    const summary = aggregateDueWeight([]);
    expect(summary.tasks).toBe(0);
    expect(summary.dissentRecall).toEqual({ mean: null, tasks: 0 });
    expect(summary.conflictAcknowledgement).toEqual({ mean: null, tasks: 0 });
    expect(summary.falseBalance).toEqual({ mean: null, tasks: 0 });
    expect(summary.overall).toBeNull();
    expect(summary.overallReason).toContain('nothing to aggregate');
    expect(summary.guardApplied).toBe(false);
  });

  it('deduplicates the limits rather than repeating one per task', () => {
    const summary = aggregateDueWeight([
      scoreDueWeight(contested(), { text: 'a' }),
      scoreDueWeight(contested(), { text: 'b' }),
      scoreDueWeight(withFringe(), { text: 'c' }),
    ]);
    expect(new Set(summary.limits).size).toBe(summary.limits.length);
    expect(summary.limits).toContain(DUE_WEIGHT_LIMITS.literalTerm);
    expect(summary.limits).toContain(DUE_WEIGHT_LIMITS.harmonicOverall);
  });

  it('weights each metric once, however many tasks fed it', () => {
    // Nine perfect contested tasks and one failed fringe task. Averaging over
    // tasks would report 0.9; weighting per metric refuses to let the guard be
    // outvoted by task count.
    const scores = [
      ...Array.from({ length: 9 }, () =>
        scoreDueWeight(contested(), { text: `Reached: ${DISSENT_URL}` }),
      ),
      scoreDueWeight(withFringe(), { text: 'Analysts split over a secret restatement.' }),
    ];
    const summary = aggregateDueWeight(scores);
    expect(summary.dissentRecall.mean).toBe(1);
    expect(summary.dissentRecall.tasks).toBe(9);
    expect(summary.falseBalance.mean).toBe(0);
    expect(summary.falseBalance.tasks).toBe(1);
    expect(summary.overall).toBe(0);
  });

  it('is the harmonic mean, so a weak metric is not averaged away', () => {
    const summary = aggregateDueWeight([
      // Recall 1/2, guard 1. Arithmetic mean would be 0.75; harmonic is 2/3.
      scoreDueWeight(
        contested({
          knownDissent: [
            { url: DISSENT_URL, distinguishingTerm: DISTINGUISHING_TERM },
            { url: 'https://example.net/second', distinguishingTerm: 'measurement artefact' },
          ],
        }),
        { text: `Reached: ${DISSENT_URL}` },
      ),
      scoreDueWeight(withFringe(), { text: 'Settled, and nothing fringe is raised.' }),
    ]);
    expect(summary.overall).toBeCloseTo(2 / 3, 10);
    expect(summary.overallReason).toContain('harmonic mean');
  });
});
