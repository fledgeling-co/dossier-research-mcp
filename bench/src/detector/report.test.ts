import { describe, expect, it } from 'vitest';
import { readDetectorCorpus } from './files.js';
import { renderReport, scoreDetector, scoreSupport } from './report.js';
import { SUPPORT_LABELS } from './schema.js';

/**
 * The assembled result, over the corpus that ships.
 *
 * Two things are checked here that no single arm can check: that the two modes
 * were scored over **the same cases**, which is the whole basis of the
 * comparison, and that the caveats travel with the numbers rather than living
 * in a document somebody may not have open.
 */

const corpus = readDetectorCorpus();
const support = scoreSupport(corpus);

describe('SELF-12: both modes, one corpus', () => {
  const containment = support.arms.find((a) => a.arm === 'containment');
  const judged = support.arms.find((a) => a.arm === 'judged');

  it('every arm scores the same number of cases', () => {
    for (const arm of support.arms) {
      expect(arm.total, arm.arm).toBe(corpus.support.length);
    }
  });

  it('containment and the judged mode are paired case by case', () => {
    const gap = support.containmentVersusJudged;
    const paired =
      gap.bothRight + gap.onlyARight + gap.onlyBRight + gap.bothWrong;
    expect(paired).toBe(corpus.support.length);
    expect(gap.a).toBe('containment');
    expect(gap.b).toBe('judged');
  });

  it('the gap names the cases where they differ, so a reader can check them', () => {
    for (const c of support.containmentVersusJudged.cases) {
      expect(corpus.support.some((s) => s.id === c.caseId), c.caseId).toBe(true);
      expect(SUPPORT_LABELS).toContain(c.trueLabel);
    }
  });

  it('SELF-10: containment reports the three verdicts it cannot express as such', () => {
    for (const label of ['partially_supports', 'contradicts', 'unreadable'] as const) {
      expect(containment?.perLabel.find((s) => s.label === label)?.expressible, label).toBe(false);
    }
    expect(judged?.perLabel.every((s) => s.expressible)).toBe(true);
  });
});

describe('SELF-16: the counts aggregate accuracy hides', () => {
  it('counts the citations that resolve and do not support their claim', () => {
    const expected = corpus.support.filter(
      (c) => c.page.verdict === 'live' && c.label !== 'supports',
    ).length;
    expect(support.headline.liveButUnsound).toBe(expected);
    expect(support.headline.liveButUnsound).toBeGreaterThan(0);
    expect(support.headline.liveButUnsoundShare ?? 0).toBeGreaterThan(0.5);
  });

  it('pulls `not_addressed` scored as `supports` out of the judged matrix by name', () => {
    // The number itself depends on whether a judged pass has been run; the
    // contract is that it is a count of that one cell and never a rate.
    expect(Number.isInteger(support.headline.notAddressedScoredSupports)).toBe(true);
    expect(support.headline.notAddressedScoredSupports).toBeGreaterThanOrEqual(0);
    expect(support.headline.contradictsScoredSupports).toBeGreaterThanOrEqual(0);
    expect(support.headline.unreadableScoredSupports).toBeGreaterThanOrEqual(0);
  });
});

describe('the soundness view', () => {
  it('drops the unreadable cases from every arm, by the same rule', () => {
    const inView = corpus.support.filter((c) => c.label !== 'unreadable').length;
    for (const arm of support.soundness) {
      expect(arm.total, arm.arm).toBe(inView);
    }
  });

  it('carries the link check under a name that says what was scored', () => {
    expect(support.soundness.some((a) => a.arm === 'link-check-as-read')).toBe(true);
  });
});

describe('SELF-21: the report renders, and says what it cannot mean', () => {
  it('renders both families and every arm', async () => {
    const text = renderReport(await scoreDetector(corpus));
    for (const arm of ['containment', 'judged', 'link-check', 'always-supports']) {
      expect(text).toContain(`## ${arm}`);
    }
    expect(text).toContain('# The support family');
    expect(text).toContain('# The registry family');
    expect(text).toContain('# The soundness view');
  });

  it('prints the caveats beside the numbers', async () => {
    const text = renderReport(await scoreDetector(corpus));
    expect(text).toContain('# What none of these numbers can mean');
    expect(text).toMatch(/[Cc]ontainment is not entailment/);
  });

  it('names the model that answered, or says plainly that nobody did', async () => {
    const text = renderReport(await scoreDetector(corpus));
    expect(text).toMatch(/judged pass: /);
  });

  it('the registry section reports the accusation count that must stay zero', async () => {
    const report = await scoreDetector(corpus);
    const text = renderReport(report);
    expect(text).toContain('scored as a fabricated reference: 0');
    expect(report.registry.uncheckedScoredAbsent).toBe(0);
  });
});
