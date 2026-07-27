import { describe, expect, it } from 'vitest';
import { taskFileSchema, type BenchTaskFile } from '../tasks/schema.js';
import { DEFAULT_CONFIDENCE_PROBABILITY } from './confidence.js';
import {
  scoreCalibration,
  type CalibrationResult,
  type CalibrationScored,
  type CalibrationUnmeasurable,
} from './calibration.js';

/**
 * Calibration, asserted against tasks built through the real schema.
 *
 * Fixtures go through `taskFileSchema` rather than being hand-typed as object
 * literals, so a test can never assert against a task shape the format would
 * reject. If BENCH-01's contract changes under this item, these fail loudly
 * rather than quietly measuring something the corpus cannot express.
 */

const NOW = new Date('2026-07-27T00:00:00.000Z');
const schema = taskFileSchema(NOW);
const source = { url: 'https://example.gov/filing' };

function task(over: Record<string, unknown> = {}): BenchTaskFile {
  return schema.parse({
    id: 'acme-fy25',
    category: 'technical',
    question: 'What did Acme report for the financial year?',
    asOf: '2026-01-10',
    reverifiedAt: '2026-07-01',
    goldFacts: [
      {
        id: 'revenue',
        label: 'annual revenue',
        kind: 'number',
        value: 1_200_000_000,
        unit: 'USD',
        tolerance: { kind: 'significantFigures', digits: 3 },
        source,
      },
      {
        id: 'headcount',
        label: 'headcount',
        kind: 'number',
        value: 4200,
        unit: 'people',
        tolerance: { kind: 'exact' },
        source,
      },
    ],
    ...over,
  });
}

/** A task of `count` labelled answers, `topic-01` upward. */
function labelledTask(id: string, count: number): BenchTaskFile {
  return schema.parse({
    id,
    category: 'technical',
    question: 'What is the state of each topic under review?',
    asOf: '2026-01-10',
    reverifiedAt: '2026-07-01',
    goldFacts: Array.from({ length: count }, (_unused, i) => {
      const n = String(i + 1).padStart(2, '0');
      return {
        id: `fact-${n}`,
        label: `topic-${n}`,
        kind: 'name',
        value: `answer-${n}`,
        source,
      };
    }),
  });
}

/** One paragraph per answer, each led by the same confidence marker. */
function uniformReport(count: number, level: 'High' | 'Medium' | 'Low'): string {
  return Array.from({ length: count }, (_unused, i) => {
    const n = String(i + 1).padStart(2, '0');
    return `(${level} Confidence) topic-${n} was resolved.`;
  }).join('\n\n');
}

/** Recovery for the first `right` answers of `count`, the rest missed. */
function recoveryFor(count: number, right: number): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (let i = 0; i < count; i += 1) {
    out[`fact-${String(i + 1).padStart(2, '0')}`] = i < right;
  }
  return out;
}

function scored(result: CalibrationResult): CalibrationScored {
  if (result.status !== 'scored') {
    throw new Error(`expected a scored result, got ${result.status}`);
  }
  return result;
}

function unmeasurable(result: CalibrationResult): CalibrationUnmeasurable {
  if (result.status !== 'unmeasurable') {
    throw new Error(`expected an unmeasurable result, got ${result.status}`);
  }
  return result;
}

/** Pool per-task results the way a suite-level figure would. */
function pooledBrier(results: readonly CalibrationScored[]): number {
  const n = results.reduce((sum, r) => sum + r.pairings.length, 0);
  return results.reduce((sum, r) => sum + r.brier * r.pairings.length, 0) / n;
}

function pooledReliability(results: readonly CalibrationScored[]): number {
  const n = results.reduce((sum, r) => sum + r.pairings.length, 0);
  return results.reduce((sum, r) => sum + r.reliability * r.pairings.length, 0) / n;
}

describe('CALIB-04 a report that states no confidence', () => {
  it('is unmeasurable, and carries no Brier score for a caller to read as zero', () => {
    const result = scoreCalibration(
      'Revenue for the year was 1.2 billion USD and headcount was 4200.',
      task(),
      { revenue: true, headcount: true },
    );
    expect(result.status).toBe('unmeasurable');
    expect(unmeasurable(result).reason).toBe('no-markers');
    expect('brier' in result).toBe(false);
  });

  it('says so even when it abstained, since an abstention is not a confidence', () => {
    const result = unmeasurable(
      scoreCalibration(
        '**Sources found: 0.** **Confidence: N/A**, for want of evidence.',
        task(),
        { revenue: false, headcount: false },
      ),
    );
    expect(result.reason).toBe('no-markers');
    expect(result.abstentions).toBe(1);
    expect(result.why).toContain('abstention');
  });
});

describe('CALIB-05 the other two unmeasurable reasons', () => {
  it('separates a report that stated confidence about nothing we asked for', () => {
    const result = unmeasurable(
      scoreCalibration(
        '(High Confidence) The weather in Melbourne was mild all quarter.',
        task(),
        { revenue: true, headcount: true },
      ),
    );
    expect(result.reason).toBe('markers-present-but-unpaired');
    expect(result.markerCount).toBe(1);
  });

  it('separates a report nothing told us the outcome for', () => {
    const result = unmeasurable(
      scoreCalibration('(High Confidence) The annual revenue was 1.2 billion USD.', task(), {}),
    );
    expect(result.reason).toBe('no-recovery-input');
    expect(result.why).toContain('recovery input');
  });
});

describe('CALIB-06 a confidently wrong claim', () => {
  it('pairs through the answer label and is charged against the backend', () => {
    const result = scored(
      scoreCalibration(
        '(High Confidence) The annual revenue was 44 million USD.\n\n(Low Confidence) headcount is not disclosed.',
        task(),
        { revenue: false, headcount: false },
      ),
    );
    const revenue = result.pairings.find((p) => p.factId === 'revenue');
    expect(revenue?.level).toBe('high');
    expect(revenue?.recovered).toBe(false);
    expect(revenue?.pairedBy).toBe('label');
    // High and wrong is the most expensive square in the metric.
    expect(result.brier).toBeCloseTo((0.9 ** 2 + 0.3 ** 2) / 2, 12);
  });
});

describe('CALIB-07 an answer with no label', () => {
  it('falls back to value pairing, says so, and states what the fallback cannot see', () => {
    const unlabelled = task({
      goldFacts: [
        { id: 'issuer', kind: 'name', value: 'Acme Platforms', source },
      ],
    });
    const result = scored(
      scoreCalibration('(Medium Confidence) Acme Platforms filed on time.', unlabelled, {
        issuer: true,
      }),
    );
    expect(result.pairedByValueOnly).toBe(true);
    expect(result.pairings[0]?.pairedBy).toBe('value');
    expect(result.notes.join(' ')).toContain('cannot match one that got it wrong');
  });

  it('matches an alternate wording the task recorded', () => {
    const unlabelled = task({
      goldFacts: [
        { id: 'issuer', kind: 'name', value: 'Acme Platforms, Inc.', aliases: ['Acme'], source },
      ],
    });
    const result = scored(
      scoreCalibration('(High Confidence) Acme filed on time.', unlabelled, { issuer: true }),
    );
    expect(result.pairings).toHaveLength(1);
  });
});

describe('CALIB-08 a missing recovery entry', () => {
  it('is counted unresolved and excluded, never scored as wrong', () => {
    const result = scored(
      scoreCalibration(
        '(High Confidence) The annual revenue was 1.2 billion USD.\n\n(High Confidence) headcount was 4200.',
        task(),
        { revenue: true },
      ),
    );
    expect(result.unresolved).toEqual(['headcount']);
    expect(result.pairings).toHaveLength(1);
    // Scored as wrong it would be 0.405; excluded it is 0.01.
    expect(result.brier).toBeCloseTo(0.01, 12);
    expect(result.notes.join(' ')).toContain('not counted as wrong');
  });
});

describe('CALIB-09 an abstention', () => {
  it('is counted and never enters the score', () => {
    const result = scored(
      scoreCalibration(
        '(High Confidence) The annual revenue was 1.2 billion USD.\n\nConfidence: N/A on headcount.',
        task(),
        { revenue: true, headcount: false },
      ),
    );
    expect(result.abstentions).toBe(1);
    expect(result.pairings).toHaveLength(1);
    expect(result.brier).toBeCloseTo(0.01, 12);
  });
});

describe('CALIB-10 an answer discussed at two levels', () => {
  it('takes the more confident one and reports the ambiguity', () => {
    const result = scored(
      scoreCalibration(
        '(Low Confidence) The annual revenue may be unclear.\n\n(High Confidence) The annual revenue was 1.2 billion USD.',
        task({ goldFacts: [
          {
            id: 'revenue',
            label: 'annual revenue',
            kind: 'number',
            value: 1_200_000_000,
            unit: 'USD',
            tolerance: { kind: 'significantFigures', digits: 3 },
            source,
          },
        ] }),
        { revenue: false },
      ),
    );
    expect(result.ambiguousPairings).toBe(1);
    expect(result.pairings[0]?.level).toBe('high');
    expect(result.pairings[0]?.ambiguous).toBe(true);
  });
});

describe('CALIB-11 the comparison the brief exists to make', () => {
  const alwaysHigh = [
    scored(
      scoreCalibration(uniformReport(10, 'High'), labelledTask('alpha-a', 10), recoveryFor(10, 6)),
    ),
    scored(
      scoreCalibration(uniformReport(10, 'High'), labelledTask('alpha-b', 10), recoveryFor(10, 6)),
    ),
  ];
  const separating = [
    scored(
      scoreCalibration(uniformReport(10, 'High'), labelledTask('beta-a', 10), recoveryFor(10, 9)),
    ),
    scored(
      scoreCalibration(uniformReport(10, 'Low'), labelledTask('beta-b', 10), recoveryFor(10, 2)),
    ),
  ];

  it('scores the 60%-always-High backend worse than the 55%-well-separated one', () => {
    // 12 of 20 against 11 of 20: the less accurate backend is the better one to
    // act on, and nothing else in the suite can say that.
    expect(pooledBrier(alwaysHigh)).toBeCloseTo(0.33, 12);
    expect(pooledBrier(separating)).toBeCloseTo(0.13, 12);
    expect(pooledBrier(separating)).toBeLessThan(pooledBrier(alwaysHigh));
  });

  it('puts the difference in the reliability term, which is the actionable half', () => {
    expect(pooledReliability(alwaysHigh)).toBeCloseTo(0.09, 12);
    expect(pooledReliability(separating)).toBeCloseTo(0.005, 12);
    expect(pooledReliability(separating)).toBeLessThan(pooledReliability(alwaysHigh));
  });
});

describe('CALIB-12 the reliability table', () => {
  it('reports count, mean predicted and observed frequency per level', () => {
    const result = scored(
      scoreCalibration(uniformReport(10, 'High'), labelledTask('bins', 10), recoveryFor(10, 6)),
    );
    expect(result.bins).toHaveLength(1);
    expect(result.bins[0]).toMatchObject({ level: 'high', count: 10, predicted: 0.9 });
    expect(result.bins[0]?.observed).toBeCloseTo(0.6, 12);
  });

  it('decomposes so that reliability minus resolution plus uncertainty is the Brier score', () => {
    const mixed = scoreCalibration(
      [
        '(High Confidence) topic-01 was resolved.',
        '(High Confidence) topic-02 was resolved.',
        '(Low Confidence) topic-03 was resolved.',
        '(Medium Confidence) topic-04 was resolved.',
      ].join('\n\n'),
      labelledTask('decomp', 4),
      { 'fact-01': true, 'fact-02': false, 'fact-03': false, 'fact-04': true },
    );
    const r = scored(mixed);
    expect(r.reliability - r.resolution + r.uncertainty).toBeCloseTo(r.brier, 12);
    expect(r.bins.map((b) => b.level).sort()).toEqual(['high', 'low', 'medium']);
  });
});

describe('CALIB-13 the probability map', () => {
  it('travels on every result, including the unmeasurable ones', () => {
    const unscored = scoreCalibration('nothing stated here', task(), {});
    expect(unscored.probabilities).toEqual(DEFAULT_CONFIDENCE_PROBABILITY);
  });

  it('changes the score when the caller supplies a different one', () => {
    const report = '(High Confidence) The annual revenue was 1.2 billion USD.';
    const withDefault = scored(scoreCalibration(report, task(), { revenue: true }));
    const withOther = scored(
      scoreCalibration(report, task(), { revenue: true }, {
        probabilities: { high: 0.75, medium: 0.5, low: 0.25 },
      }),
    );
    expect(withOther.brier).not.toBeCloseTo(withDefault.brier, 6);
    expect(withOther.probabilities.high).toBe(0.75);
  });
});

describe('CALIB-15 a qualifier written after its claim', () => {
  it('pairs the claim it followed, instead of scoring nothing', () => {
    const result = scored(
      scoreCalibration(
        [
          '- (High Confidence) topic-01 was resolved.',
          'topic-02 was delayed by two quarters. (Low Confidence)',
          'topic-03 was cancelled outright. (Low Confidence)',
        ].join('\n\n'),
        labelledTask('trailing', 3),
        { 'fact-01': true, 'fact-02': false, 'fact-03': false },
      ),
    );
    // All three stated confidences are collected. Read forward only, the two
    // Lows governed an empty span and the well-calibrated half of the report
    // was silently dropped from the sample.
    expect(result.scoredAnswers).toBe(3);
    expect(result.coverage).toBe(1);
    expect(result.brier).toBeCloseTo((0.01 + 0.09 + 0.09) / 3, 12);
  });
});

describe('CALIB-17 a label broken across a line', () => {
  it('still pairs, because a report wraps and a label does not', () => {
    const unlabelled = task({
      goldFacts: [{ id: 'issuer', label: 'Acme Platforms', kind: 'name', value: 'x', source }],
    });
    const result = scored(
      scoreCalibration('(High Confidence) Acme\nPlatforms filed on time.', unlabelled, {
        issuer: true,
      }),
    );
    expect(result.pairings).toHaveLength(1);
    expect(result.pairings[0]?.pairedBy).toBe('label');
  });
});

describe('CALIB-19 the denominator and the map', () => {
  it('states how much of the task the score actually covers', () => {
    const partial = scored(
      scoreCalibration('(High Confidence) topic-01 was resolved.', labelledTask('partial', 3), {
        'fact-01': true,
        'fact-02': false,
        'fact-03': false,
      }),
    );
    // Silence about the two it got wrong is worth an order of magnitude on the
    // headline number, so the denominator has to travel with it.
    expect(partial.brier).toBeCloseTo(0.01, 12);
    expect(partial.scoredAnswers).toBe(1);
    expect(partial.goldFacts).toBe(3);
    expect(partial.coverage).toBeCloseTo(1 / 3, 12);
    expect(partial.notes.join(' ')).toContain('read the score against its coverage');
  });

  it('counts every marker the same way the refusal scorer does', () => {
    const result = scored(
      scoreCalibration(
        '(High Confidence) The annual revenue was 1.2 billion USD.\n\nConfidence: N/A on headcount.',
        task(),
        { revenue: true },
      ),
    );
    expect(result.markerCount).toBe(2);
    expect(result.gradedMarkers).toBe(1);
    expect(result.abstentions).toBe(1);
  });

  it('refuses a probability map that cannot produce a score in range', () => {
    expect(() =>
      scoreCalibration('(High Confidence) The annual revenue was 1.2 billion USD.', task(), {
        revenue: true,
      }, { probabilities: { high: 5, medium: -3, low: 0.3 } }),
    ).toThrow(TypeError);
  });
});

describe('CALIB-14 a task with no answers', () => {
  it('is not applicable rather than zero, agreeing with the corpus loader', () => {
    const refusalTask = schema.parse({
      id: 'ghost-ltd',
      category: 'obscure-entity',
      question: 'What is publicly documented about Ghost Holdings Pty Ltd?',
      asOf: '2026-01-10',
      reverifiedAt: '2026-07-01',
      expectedRefusal: {
        kind: 'no-public-footprint',
        acknowledgementTerms: ['no public record'],
      },
    });
    const result = scoreCalibration('(High Confidence) Something.', refusalTask, {});
    expect(result.status).toBe('not-applicable');
    expect('brier' in result).toBe(false);
  });
});
