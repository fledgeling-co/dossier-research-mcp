import { describe, expect, it } from 'vitest';
import { armGap, cell, confusionMatrix, scoreArm, type Judgement } from './confusion.js';
import { abstained, decided, type ArmCapability } from './verdicts.js';

/**
 * The arithmetic, checked against a matrix worked out by hand.
 *
 * Deliberately over a toy vocabulary rather than the corpus's. This module holds
 * no detector logic and must be provable without one; a test that drove it
 * through a real arm would be testing two things and would fail for either
 * reason.
 */

type Toy = 'a' | 'b' | 'c';
const LABELS: readonly Toy[] = ['a', 'b', 'c'];

const capability = (expressible: readonly Toy[]): ArmCapability<Toy> => ({
  arm: 'toy',
  expressible,
  why: 'a fixture',
});

function j(caseId: string, trueLabel: Toy, said: Toy | null): Judgement<Toy> {
  return {
    caseId,
    trueLabel,
    decision: said === null ? abstained<Toy>('declined') : decided(said),
  };
}

describe('confusionMatrix (SELF-08)', () => {
  const judgements = [
    j('1', 'a', 'a'),
    j('2', 'a', 'b'),
    j('3', 'a', null),
    j('4', 'b', 'b'),
    j('5', 'c', 'a'),
  ];

  it('puts every case in exactly one cell, and the cells total the corpus', () => {
    const matrix = confusionMatrix(LABELS, judgements);
    const summed = matrix.rows.reduce(
      (total, row) => total + row.cells.reduce((s, c) => s + c.count, 0),
      0,
    );
    expect(summed).toBe(judgements.length);
    expect(matrix.total).toBe(judgements.length);
  });

  it('carries an explicit abstain column rather than dropping a declined case', () => {
    const matrix = confusionMatrix(LABELS, judgements);
    expect(matrix.columns).toEqual(['a', 'b', 'c', 'abstain']);
    expect(cell(matrix, 'a', 'abstain')).toBe(1);
  });

  it('reads the cells the report pulls out by name', () => {
    const matrix = confusionMatrix(LABELS, judgements);
    expect(cell(matrix, 'a', 'a')).toBe(1);
    expect(cell(matrix, 'a', 'b')).toBe(1);
    expect(cell(matrix, 'c', 'a')).toBe(1);
    expect(cell(matrix, 'b', 'c')).toBe(0);
  });

  it('returns zero for a label that is not in the vocabulary rather than throwing', () => {
    const matrix = confusionMatrix(LABELS, judgements);
    expect(cell(matrix, 'z' as Toy, 'a')).toBe(0);
  });
});

describe('scoreArm (SELF-09)', () => {
  /*
   * Worked by hand, so the assertions below are a second opinion rather than a
   * transcription of whatever the code happens to produce.
   *
   *   truth a: said a, said b, declined      support 3, answered 2
   *   truth b: said b                        support 1, answered 1
   *   truth c: said a                        support 1, answered 1
   *
   *   label a: tp 1, said 2  -> precision 1/2
   *            answered-with-truth-a 2 -> recall(answered) 1/2
   *            support 3               -> recall(all) 1/3
   *   label b: tp 1, said 2  -> precision 1/2, recall(answered) 1/1, recall(all) 1/1
   *   label c: tp 0, said 0  -> precision null, recall 0
   */
  const judgements = [
    j('1', 'a', 'a'),
    j('2', 'a', 'b'),
    j('3', 'a', null),
    j('4', 'b', 'b'),
    j('5', 'c', 'a'),
  ];
  const score = scoreArm({ labels: LABELS, capability: capability(LABELS), judgements });
  const byLabel = (label: Toy): (typeof score.perLabel)[number] => {
    const found = score.perLabel.find((s) => s.label === label);
    if (found === undefined) throw new Error(`no score for ${label}`);
    return found;
  };

  it('counts coverage, and the two accuracies separately', () => {
    expect(score.total).toBe(5);
    expect(score.committed).toBe(4);
    expect(score.abstentions).toBe(1);
    expect(score.coverage).toBeCloseTo(4 / 5, 10);
    expect(score.correct).toBe(2);
    expect(score.accuracyOverCommitted).toBeCloseTo(2 / 4, 10);
    expect(score.accuracyOverAll).toBeCloseTo(2 / 5, 10);
  });

  it('computes precision and both recalls, and they are different numbers', () => {
    const a = byLabel('a');
    expect(a.support).toBe(3);
    expect(a.predicted).toBe(2);
    expect(a.truePositives).toBe(1);
    expect(a.falsePositives).toBe(1);
    expect(a.falseNegatives).toBe(1);
    expect(a.abstentions).toBe(1);
    expect(a.precision).toBeCloseTo(1 / 2, 10);
    expect(a.recallCommitted).toBeCloseTo(1 / 2, 10);
    expect(a.recallAll).toBeCloseTo(1 / 3, 10);
    expect(a.recallCommitted).not.toBeCloseTo(a.recallAll ?? 0, 5);
  });

  it('reports null rather than zero where there is no denominator', () => {
    const c = byLabel('c');
    expect(c.predicted).toBe(0);
    expect(c.precision).toBeNull();
    expect(c.recallAll).toBe(0);
    expect(c.f1All).toBeNull();
  });

  it('SELF-10: marks a label the arm cannot express, so recall 0 reads as a ceiling', () => {
    const narrow = scoreArm({
      labels: LABELS,
      capability: capability(['a']),
      judgements,
    });
    expect(narrow.perLabel.find((s) => s.label === 'a')?.expressible).toBe(true);
    expect(narrow.perLabel.find((s) => s.label === 'b')?.expressible).toBe(false);
    expect(narrow.perLabel.find((s) => s.label === 'c')?.expressible).toBe(false);
  });

  it('macro-F1 over the vocabulary punishes abstaining; the expressible one does not', () => {
    // An arm that answers one case correctly and declines the rest.
    const lazy = [j('1', 'a', 'a'), j('2', 'b', null), j('3', 'c', null)];
    const strict = scoreArm({ labels: LABELS, capability: capability(LABELS), judgements: lazy });
    expect(strict.macroF1).toBeCloseTo(1 / 3, 10);

    const narrow = scoreArm({ labels: LABELS, capability: capability(['a']), judgements: lazy });
    // Over what it claims to be able to say, it is perfect. Over the whole
    // vocabulary it is not. Both are true and both are reported.
    expect(narrow.macroF1Expressible).toBeCloseTo(1, 10);
    expect(narrow.macroF1).toBeCloseTo(1 / 3, 10);
  });

  it('an arm that declines everything scores zero rather than throwing', () => {
    const silent = scoreArm({
      labels: LABELS,
      capability: capability(LABELS),
      judgements: [j('1', 'a', null), j('2', 'b', null)],
    });
    expect(silent.coverage).toBe(0);
    expect(silent.accuracyOverCommitted).toBeNull();
    expect(silent.accuracyOverAll).toBe(0);
    expect(silent.macroF1).toBe(0);
  });

  it('an empty corpus produces nulls rather than NaN', () => {
    const empty = scoreArm({ labels: LABELS, capability: capability(LABELS), judgements: [] });
    expect(empty.coverage).toBeNull();
    expect(empty.accuracyOverAll).toBeNull();
    expect(empty.macroF1).toBe(0);
  });
});

describe('armGap', () => {
  it('pairs two arms over the same cases and names where they differ', () => {
    const a = [j('1', 'a', 'a'), j('2', 'b', 'a'), j('3', 'c', null)];
    const b = [j('1', 'a', 'a'), j('2', 'b', 'b'), j('3', 'c', 'c')];
    const gap = armGap({ arm: 'a', judgements: a }, { arm: 'b', judgements: b });
    expect(gap.bothRight).toBe(1);
    expect(gap.onlyBRight).toBe(2);
    expect(gap.onlyARight).toBe(0);
    expect(gap.aAbstainedBAnswered).toBe(1);
    expect(gap.bAbstainedAAnswered).toBe(0);
    expect(gap.cases.map((c) => c.caseId)).toEqual(['2', '3']);
    expect(gap.cases[1]).toMatchObject({ a: 'abstain', b: 'c' });
  });

  it('ignores a case the second arm never saw rather than counting it as a miss', () => {
    const gap = armGap(
      { arm: 'a', judgements: [j('1', 'a', 'a'), j('2', 'b', 'b')] },
      { arm: 'b', judgements: [j('1', 'a', 'a')] },
    );
    expect(gap.bothRight).toBe(1);
    expect(gap.onlyARight).toBe(0);
  });
});
