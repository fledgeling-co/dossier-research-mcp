import { describe, expect, it } from 'vitest';
import { readDetectorCorpus } from './files.js';
import { labelCounts } from './corpus.js';
import { scoreRegistry, scoreSupport } from './report.js';
import { REGISTRY_LABELS, SUPPORT_LABELS } from './schema.js';

/**
 * The corpus's own balance, asserted against the corpus that actually ships.
 *
 * This file is the acceptance test for the whole slice. The brief's first
 * acceptance criterion is that a detector answering `supports` to everything
 * scores badly, **asserted by a test** rather than argued for, and the only way
 * to honour that is to run the degenerate strategy over the real cases and
 * check the number. A fixture would prove nothing about what shipped.
 *
 * The thresholds below are floors on the corpus, not tuning knobs on a detector.
 * If a later batch of cases makes one of them fail, the corpus is what has gone
 * wrong.
 */

const corpus = readDetectorCorpus();
const support = scoreSupport(corpus);

/** No label may dominate, or a detector can score well by guessing the mode. */
const MAX_LABEL_SHARE = 0.35;
/** Below this a label is a rumour rather than a measurement. */
const MIN_LABEL_CASES = 3;

describe('SELF-05: the corpus is balanced', () => {
  it('the support family carries every one of the five verdicts, none of them thin', () => {
    const counts = labelCounts(corpus.support);
    for (const label of SUPPORT_LABELS) {
      expect(counts.get(label) ?? 0, label).toBeGreaterThanOrEqual(MIN_LABEL_CASES);
    }
  });

  it('and no support label takes more than a third of it', () => {
    const counts = labelCounts(corpus.support);
    for (const label of SUPPORT_LABELS) {
      const share = (counts.get(label) ?? 0) / corpus.support.length;
      expect(share, `${label} is ${(share * 100).toFixed(1)}% of the corpus`).toBeLessThanOrEqual(
        MAX_LABEL_SHARE,
      );
    }
  });

  it('the registry family carries all four verdicts, on the same terms', () => {
    const counts = labelCounts(corpus.registry);
    for (const label of REGISTRY_LABELS) {
      expect(counts.get(label) ?? 0, label).toBeGreaterThanOrEqual(MIN_LABEL_CASES);
      const share = (counts.get(label) ?? 0) / corpus.registry.length;
      expect(share, label).toBeLessThanOrEqual(MAX_LABEL_SHARE);
    }
  });

  it('SELF-02: every case carries reasoning long enough to argue with', () => {
    for (const supportCase of corpus.support) {
      expect(supportCase.why.length, supportCase.id).toBeGreaterThanOrEqual(40);
    }
    for (const registryCase of corpus.registry) {
      expect(registryCase.why.length, registryCase.id).toBeGreaterThanOrEqual(40);
    }
  });
});

describe('SELF-06 and SELF-07: the degenerate strategy scores badly', () => {
  const degenerate = support.arms.find((a) => a.arm === 'always-supports');

  it('the arm exists, so this is measured rather than asserted', () => {
    expect(degenerate).toBeDefined();
  });

  it('its accuracy is no better than the share of the one label it can say', () => {
    expect(degenerate?.accuracyOverAll ?? 1).toBeLessThanOrEqual(MAX_LABEL_SHARE);
    expect(degenerate?.coverage).toBe(1);
  });

  it('and its macro-F1 is near the floor, which aggregate accuracy would hide', () => {
    expect(degenerate?.macroF1 ?? 1).toBeLessThan(0.25);
  });

  it('SELF-07: it scores recall 0 on `not_addressed`, the failure that matters most', () => {
    const notAddressed = degenerate?.perLabel.find((s) => s.label === 'not_addressed');
    expect(notAddressed?.recallAll).toBe(0);
    expect(notAddressed?.support ?? 0).toBeGreaterThanOrEqual(MIN_LABEL_CASES);
  });

  it('and recall 0 on every other verdict it cannot express', () => {
    for (const label of SUPPORT_LABELS) {
      if (label === 'supports') continue;
      const score = degenerate?.perLabel.find((s) => s.label === label);
      expect(score?.recallAll, label).toBe(0);
      expect(score?.expressible, label).toBe(false);
    }
  });

  it('it is punished in the binary view too, not only in the five-class one', () => {
    const binary = support.soundness.find((a) => a.arm === 'always-supports');
    expect(binary).toBeDefined();
    expect(binary?.macroF1 ?? 1).toBeLessThan(0.45);
    const unsound = binary?.perLabel.find((s) => s.label === 'unsound');
    expect(unsound?.recallAll).toBe(0);
  });
});

describe('SELF-22: the hard cases the brief names are actually in the corpus', () => {
  it('a page about the right topic that resolves and does not contain the claim', () => {
    const cases = corpus.support.filter(
      (c) => c.label === 'not_addressed' && c.page.verdict === 'live',
    );
    expect(cases.length).toBeGreaterThanOrEqual(MIN_LABEL_CASES);
    // The one link checking is blindest to: the URL resolves perfectly.
    expect(cases.every((c) => c.page.httpStatus === 200)).toBe(true);
  });

  it('a page that contradicts the claim', () => {
    const cases = corpus.support.filter((c) => c.label === 'contradicts');
    expect(cases.length).toBeGreaterThanOrEqual(MIN_LABEL_CASES);
  });

  it('a page behind a wall, including one served with HTTP 200', () => {
    const walls = corpus.support.filter((c) => c.label === 'unreadable');
    expect(walls.length).toBeGreaterThanOrEqual(MIN_LABEL_CASES);
    // The blocked one a status code can catch.
    expect(walls.some((c) => c.page.verdict === 'blocked')).toBe(true);
    // And the ones it cannot: a login wall, a script wall and a consent wall,
    // every one of them HTTP 200 with a body carrying none of the content.
    expect(walls.filter((c) => c.page.verdict === 'live').length).toBeGreaterThanOrEqual(2);
  });

  it('a page cut short at the byte cap, where absence proves nothing', () => {
    expect(corpus.support.some((c) => c.page.truncated)).toBe(true);
  });

  it('real captured pages, not only written ones, and the split is visible', () => {
    const captured = corpus.support.filter((c) => c.page.provenance === 'captured');
    expect(captured.length).toBeGreaterThan(corpus.support.length / 2);
    for (const constructed of corpus.support.filter((c) => c.page.provenance === 'constructed')) {
      expect(constructed.page.note, constructed.id).toBeDefined();
    }
  });

  it('several claims are written against one page, so recognising the page is not enough', () => {
    const perPage = new Map<string, number>();
    for (const c of corpus.support) {
      perPage.set(c.page.textFile, (perPage.get(c.page.textFile) ?? 0) + 1);
    }
    const shared = [...perPage.values()].filter((n) => n > 1);
    expect(shared.length).toBeGreaterThanOrEqual(4);
    // And at least one page carries claims with different labels.
    const labelsByPage = new Map<string, Set<string>>();
    for (const c of corpus.support) {
      const set = labelsByPage.get(c.page.textFile) ?? new Set<string>();
      set.add(c.label);
      labelsByPage.set(c.page.textFile, set);
    }
    expect([...labelsByPage.values()].some((s) => s.size >= 3)).toBe(true);
  });
});

describe('SELF-17: the registry family never turns an outage into an accusation', () => {
  it('no case whose registries would not answer is scored `absent`', async () => {
    const registry = await scoreRegistry(corpus);
    expect(registry.uncheckedScoredAbsent).toBe(0);
  });

  it('and every `unchecked` case is recognised as one', async () => {
    const registry = await scoreRegistry(corpus);
    const unchecked = registry.arm.perLabel.find((s) => s.label === 'unchecked');
    expect(unchecked?.recallAll).toBe(1);
  });
});
