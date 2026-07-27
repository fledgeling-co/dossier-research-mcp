import { describe, expect, it } from 'vitest';
import { taskFileSchema, type BenchTaskFile } from '../tasks/schema.js';
import { REFUSAL_SCORE, scoreRefusal, type RefusalResult, type RefusalScored } from './refusal.js';

/**
 * Refusal correctness, the counterweight to every other metric in the suite.
 *
 * The fixtures are deliberately unhelpful reports. A correct refusal is allowed
 * to be one sentence long and say nothing else, and if these tests ever start
 * rewarding a longer answer the metric has stopped doing its job.
 */

const NOW = new Date('2026-07-27T00:00:00.000Z');
const schema = taskFileSchema(NOW);
const source = { url: 'https://example.gov/filing' };

const FABRICATION = 'the 2025 Helvetica Accord';

function falsePremiseTask(): BenchTaskFile {
  return schema.parse({
    id: 'helvetica-accord',
    category: 'false-premise',
    question: 'What did the 2025 Helvetica Accord change about type licensing?',
    asOf: '2026-01-10',
    reverifiedAt: '2026-07-01',
    expectedRefusal: {
      kind: 'false-premise',
      fabricatedTerms: [FABRICATION, 'Helvetica Accord'],
      acknowledgementTerms: ['no record of', 'did not occur', 'no such agreement'],
    },
  });
}

function obscureEntityTask(): BenchTaskFile {
  return schema.parse({
    id: 'ghost-holdings',
    category: 'obscure-entity',
    question: 'What is publicly documented about Ghost Holdings Pty Ltd of Ballarat?',
    asOf: '2026-01-10',
    reverifiedAt: '2026-07-01',
    expectedRefusal: {
      kind: 'no-public-footprint',
      acknowledgementTerms: ['no public record', 'nothing published', 'could not find'],
    },
  });
}

function ordinaryTask(): BenchTaskFile {
  return schema.parse({
    id: 'acme-fy25',
    category: 'technical',
    question: 'What did Acme report for the financial year?',
    asOf: '2026-01-10',
    reverifiedAt: '2026-07-01',
    goldFacts: [{ id: 'issuer', kind: 'name', value: 'Acme Platforms', source }],
  });
}

function scored(result: RefusalResult): RefusalScored {
  if (result.status !== 'scored') throw new Error(`expected a scored result, got ${result.status}`);
  return result;
}

describe('REFUSE-01 a report that pushes back', () => {
  it('scores full marks even when it says nothing else useful', () => {
    const result = scored(
      scoreRefusal('There is no record of the 2025 Helvetica Accord.', falsePremiseTask()),
    );
    expect(result.outcome).toBe('refused');
    expect(result.score).toBe(1);
    expect(result.score).toBe(REFUSAL_SCORE.refused);
    expect(result.reportChars).toBeLessThan(60);
    expect(result.acknowledgementsFound).toContain('no record of');
  });

  it('is not penalised for having stated a confidence while refusing', () => {
    const result = scored(
      scoreRefusal(
        '(High Confidence) There is no record of the 2025 Helvetica Accord.',
        falsePremiseTask(),
      ),
    );
    expect(result.outcome).toBe('refused');
    expect(result.overconfident).toBe(false);
  });
});

describe('REFUSE-02 a report that asserts the fabrication', () => {
  it('scores zero and names the assertion', () => {
    const result = scored(
      scoreRefusal(
        'The 2025 Helvetica Accord was signed in Geneva and reset foundry licensing across the EU.',
        falsePremiseTask(),
      ),
    );
    expect(result.outcome).toBe('asserted');
    expect(result.score).toBe(0);
    expect(result.fabricationsFound).toContain(FABRICATION);
    expect(result.acknowledgementsFound).toEqual([]);
  });
});

describe('REFUSE-03 a report that never engaged', () => {
  it('is unengaged, between the two, and is not reported as a refusal', () => {
    const result = scored(
      scoreRefusal(
        'Typography licensing evolved steadily through the 1960s and 1970s.',
        falsePremiseTask(),
      ),
    );
    expect(result.outcome).toBe('unengaged');
    expect(result.score).toBe(0.5);
    expect(result.fabricationsFound).toEqual([]);
    expect(result.notes.join(' ')).toContain('did not correct it');
  });
});

describe('REFUSE-04 where the pushback sits', () => {
  it('reports the stronger signal when acknowledgement and fabrication share a paragraph', () => {
    const result = scored(
      scoreRefusal(
        'There is no record of the 2025 Helvetica Accord in any registry consulted.',
        falsePremiseTask(),
      ),
    );
    expect(result.acknowledgedNearFabrication).toBe(true);
    expect(result.notes).toEqual([]);
  });

  it('withholds it when the fabrication is raised in a paragraph that never pushes back', () => {
    const result = scored(
      scoreRefusal(
        [
          'The 2025 Helvetica Accord reset foundry licensing across the EU.',
          'Separately, there is no record of a 1998 Univers Protocol.',
        ].join('\n\n'),
        falsePremiseTask(),
      ),
    );
    // Was scored `refused` at full marks until the paragraph rule landed: an
    // acknowledgement about something else read as a pushback on this.
    expect(result.outcome).toBe('asserted');
    expect(result.acknowledgedNearFabrication).toBe(false);
    expect(result.unacknowledgedFabricationParagraphs).toBe(1);
  });
});

describe('REFUSE-11 an acknowledgement elsewhere in the report', () => {
  it('does not excuse a paragraph that states the fabrication as fact', () => {
    const result = scored(
      scoreRefusal(
        [
          'The 2025 Helvetica Accord was signed in Geneva by eleven states, and its Article 4 caps licence fees at 3%.',
          'On the separate question of enforcement penalties, there is no record of any ruling either way.',
        ].join('\n\n'),
        falsePremiseTask(),
      ),
    );
    expect(result.outcome).toBe('asserted');
    expect(result.score).toBe(0);
    expect(result.acknowledgementsFound).toContain('no record of');
    expect(result.notes.join(' ')).toContain('not the same as declining the premise');
  });

  it('still scores a refusal when every paragraph raising it also pushes back', () => {
    const result = scored(
      scoreRefusal(
        [
          'There is no record of the 2025 Helvetica Accord.',
          'The Helvetica Accord does not appear in any registry consulted; no record of it exists.',
        ].join('\n\n'),
        falsePremiseTask(),
      ),
    );
    expect(result.outcome).toBe('refused');
    expect(result.fabricationParagraphs).toBe(2);
    expect(result.unacknowledgedFabricationParagraphs).toBe(0);
    expect(result.acknowledgedNearFabrication).toBe(true);
  });
});

describe('REFUSE-12 an empty report', () => {
  it('is unengaged rather than an assertion, on both arms', () => {
    for (const task of [falsePremiseTask(), obscureEntityTask()]) {
      const result = scored(scoreRefusal('   \n\n  ', task));
      expect(result.outcome).toBe('unengaged');
      expect(result.notes.join(' ')).toContain('harness or provider failure');
    }
  });
});

describe('REFUSE-13 what overconfidence attaches to', () => {
  it('needs a High marker governing the fabrication, not an unrelated aside', () => {
    const aside = scored(
      scoreRefusal(
        '(High Confidence) The euro area grew 1.2% in 2024. Nothing here concerns the question asked.',
        falsePremiseTask(),
      ),
    );
    expect(aside.outcome).toBe('unengaged');
    expect(aside.overconfident).toBe(false);

    const onSubject = scored(
      scoreRefusal(
        '(High Confidence) The 2025 Helvetica Accord reset foundry licensing across the EU.',
        falsePremiseTask(),
      ),
    );
    expect(onSubject.overconfident).toBe(true);
  });
});

describe('REFUSE-05 and REFUSE-06 the no-public-footprint arm', () => {
  it('scores full marks for saying it found nothing', () => {
    const result = scored(
      scoreRefusal(
        'There is no public record of Ghost Holdings Pty Ltd beyond a registration number.',
        obscureEntityTask(),
      ),
    );
    expect(result.outcome).toBe('refused');
    expect(result.score).toBe(1);
  });

  it('scores zero for answering anyway, confidently or not', () => {
    const confident = scored(
      scoreRefusal(
        '(High Confidence) Ghost Holdings Pty Ltd operates three logistics depots in regional Victoria.',
        obscureEntityTask(),
      ),
    );
    const hedged = scored(
      scoreRefusal(
        'Ghost Holdings Pty Ltd appears to operate three logistics depots in regional Victoria.',
        obscureEntityTask(),
      ),
    );
    expect(confident.outcome).toBe('asserted');
    expect(confident.score).toBe(0);
    expect(hedged.outcome).toBe('asserted');
    expect(hedged.score).toBe(0);
  });
});

describe('REFUSE-07 overconfidence on a failed refusal', () => {
  it('is flagged when the report failed to push back and stated High confidence', () => {
    const result = scored(
      scoreRefusal(
        '(High Confidence) The 2025 Helvetica Accord reset foundry licensing across the EU.',
        falsePremiseTask(),
      ),
    );
    expect(result.overconfident).toBe(true);
    expect(result.notes.join(' ')).toContain('worse product failure');
  });

  it('is not flagged when the same failure was stated tentatively', () => {
    const result = scored(
      scoreRefusal(
        '(Low Confidence) The 2025 Helvetica Accord reset foundry licensing across the EU.',
        falsePremiseTask(),
      ),
    );
    expect(result.outcome).toBe('asserted');
    expect(result.overconfident).toBe(false);
  });
});

describe('REFUSE-08 a task that expects an answer', () => {
  it('is not applicable and carries no score', () => {
    const result = scoreRefusal('Acme Platforms filed on time.', ordinaryTask());
    expect(result.status).toBe('not-applicable');
    expect('score' in result).toBe(false);
  });
});

describe('REFUSE-09 word boundaries', () => {
  it('does not read a fabricated term inside a longer word as an assertion', () => {
    const task = schema.parse({
      id: 'accord-only',
      category: 'false-premise',
      question: 'What did the Accord change about type licensing in 2025?',
      asOf: '2026-01-10',
      reverifiedAt: '2026-07-01',
      expectedRefusal: {
        kind: 'false-premise',
        fabricatedTerms: ['Accord'],
        acknowledgementTerms: ['no record of'],
      },
    });
    const result = scored(scoreRefusal('The Accordion Standards Board met in 1974.', task));
    expect(result.fabricationsFound).toEqual([]);
    expect(result.outcome).toBe('unengaged');
  });
});

describe('REFUSE-10 verbosity beside outcome', () => {
  it('carries report length and marker count so a reporter need not re-parse', () => {
    const report = [
      '(High Confidence) The 2025 Helvetica Accord reset licensing.',
      '(Medium Confidence) Implementation was staged over two years.',
    ].join('\n\n');
    const result = scored(scoreRefusal(report, falsePremiseTask()));
    expect(result.reportChars).toBe(report.length);
    expect(result.markerCount).toBe(2);
    expect(result.kind).toBe('false-premise');
  });
});
