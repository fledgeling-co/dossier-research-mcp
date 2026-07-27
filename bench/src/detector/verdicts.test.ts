import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PAGE_VERDICTS, REGISTRY_LABELS, SUPPORT_LABELS } from './schema.js';
import {
  ALWAYS_SUPPORTS_CAPABILITY,
  CANNOT_MEAN,
  CONTAINMENT_CAPABILITY,
  JUDGED_CAPABILITY,
  LINK_CHECK_CAPABILITY,
  SOUNDNESS_LABELS,
  collapseDecision,
  collapseLabel,
  decided,
  abstained,
  projectContainment,
  projectLinkCheck,
  projectLinkCheckSoundness,
} from './verdicts.js';

/**
 * The projections, and the two mirrors that must not drift.
 *
 * A vocabulary copied rather than imported is a fact about two files that agree
 * today. The parity tests below are what make it a fact about two files that
 * cannot silently stop agreeing, which is the posture BENCH-06 arrived at when
 * it built a second implementation of `assessStaleness` and diffed the two.
 */

describe('the label vocabulary is the product’s (SELF-11)', () => {
  const utility = readFileSync(
    new URL('../../../src/ai/utility.ts', import.meta.url),
    'utf8',
  );

  it('the five support verdicts are the ones `research_verify_claims` asks for', () => {
    // The enum as the product declares it, read out of its own source rather
    // than imported: that module reaches the AI SDK at load and the benchmark's
    // pure half must not. Anchored on `SupportSchema` rather than on the first
    // enum in the file, which belongs to the confidence qualifier.
    const schema = utility.slice(utility.indexOf('const SupportSchema'));
    expect(schema, 'SupportSchema was not found in src/ai/utility.ts').not.toBe(utility);
    const match = /\.enum\(\[([^\]]*)\]\)/.exec(schema);
    expect(match, 'the support enum was not found in src/ai/utility.ts').not.toBeNull();
    const declared = (match?.[1] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter((s) => s !== '');
    expect(declared).toEqual([...SUPPORT_LABELS]);
  });

  it('the page verdicts are the ones `judgeCitationStatus` reaches', () => {
    const citations = readFileSync(
      new URL('../../../src/store/types.ts', import.meta.url),
      'utf8',
    );
    for (const verdict of PAGE_VERDICTS) {
      expect(citations, verdict).toContain(`'${verdict}'`);
    }
  });
});

describe('projectContainment', () => {
  it('maps supported to supports and unsupported to not_addressed', () => {
    expect(projectContainment('supported')).toEqual({ kind: 'label', label: 'supports' });
    expect(projectContainment('unsupported')).toEqual({ kind: 'label', label: 'not_addressed' });
  });

  it('SELF-11: `unchecked` abstains rather than becoming an accusation', () => {
    const decision = projectContainment('unchecked');
    expect(decision.kind).toBe('abstain');
    if (decision.kind === 'abstain') expect(decision.why).toMatch(/could not decide/);
  });

  it('SELF-10: declares it cannot express a contradiction or a partial', () => {
    expect(CONTAINMENT_CAPABILITY.expressible).toEqual(['supports', 'not_addressed']);
    expect(CONTAINMENT_CAPABILITY.expressible).not.toContain('contradicts');
    expect(CONTAINMENT_CAPABILITY.expressible).not.toContain('partially_supports');
    expect(CONTAINMENT_CAPABILITY.expressible).not.toContain('unreadable');
  });
});

describe('projectLinkCheck (SELF-15)', () => {
  it('a resolving URL abstains, because it claims nothing about support', () => {
    const decision = projectLinkCheck('live');
    expect(decision.kind).toBe('abstain');
    if (decision.kind === 'abstain') expect(decision.why).toMatch(/says nothing about/);
  });

  it('a blocked page is the one support verdict a status code can reach', () => {
    expect(projectLinkCheck('blocked')).toEqual({ kind: 'label', label: 'unreadable' });
    expect(LINK_CHECK_CAPABILITY.expressible).toEqual(['unreadable']);
  });

  it('every other verdict abstains, and the union is covered exhaustively', () => {
    for (const verdict of PAGE_VERDICTS) {
      const decision = projectLinkCheck(verdict);
      if (verdict === 'blocked') expect(decision.kind).toBe('label');
      else expect(decision.kind).toBe('abstain');
    }
  });
});

describe('the soundness collapse (SELF-20)', () => {
  it('collapses by the declared rule', () => {
    expect(collapseLabel('supports')).toBe('sound');
    expect(collapseLabel('partially_supports')).toBe('unsound');
    expect(collapseLabel('contradicts')).toBe('unsound');
    expect(collapseLabel('not_addressed')).toBe('unsound');
  });

  it('`unreadable` leaves the view rather than being counted as a failed citation', () => {
    expect(collapseLabel('unreadable')).toBeNull();
    expect(collapseDecision(decided('unreadable'))).toBeNull();
  });

  it('an abstention stays an abstention through the collapse', () => {
    const collapsed = collapseDecision(abstained<'supports'>('nothing to say'));
    expect(collapsed?.kind).toBe('abstain');
  });

  it('the as-read mapping scores the inference a reader draws from a green link', () => {
    expect(projectLinkCheckSoundness('live')).toEqual({ kind: 'label', label: 'sound' });
    for (const verdict of PAGE_VERDICTS) {
      if (verdict === 'live') continue;
      expect(projectLinkCheckSoundness(verdict), verdict).toEqual({
        kind: 'label',
        label: 'unsound',
      });
    }
  });

  it('the binary vocabulary is two labels and no more', () => {
    expect(SOUNDNESS_LABELS).toEqual(['sound', 'unsound']);
  });
});

describe('the capability declarations', () => {
  it('every arm declares what it can say, and says why', () => {
    for (const capability of [
      CONTAINMENT_CAPABILITY,
      JUDGED_CAPABILITY,
      LINK_CHECK_CAPABILITY,
      ALWAYS_SUPPORTS_CAPABILITY,
    ]) {
      expect(capability.arm.length, capability.arm).toBeGreaterThan(0);
      expect(capability.why.length, capability.arm).toBeGreaterThan(40);
      for (const label of capability.expressible) {
        expect(SUPPORT_LABELS, capability.arm).toContain(label);
      }
    }
  });

  it('the judged arm can reach all five, which is what makes it the comparison', () => {
    expect([...JUDGED_CAPABILITY.expressible]).toEqual([...SUPPORT_LABELS]);
  });
});

describe('SELF-21: what the numbers cannot mean rides with them', () => {
  it('names containment, the link check, the sample size and the labels', () => {
    const joined = CANNOT_MEAN.join(' ');
    expect(joined).toMatch(/[Cc]ontainment is not entailment/);
    expect(joined).toMatch(/does not mean the citation is sound/);
    expect(joined).toMatch(/thousand/);
    expect(joined).toMatch(/reasoning/);
  });
});

describe('the registry vocabulary', () => {
  it('carries `unchecked` as a label rather than as a missing answer', () => {
    expect(REGISTRY_LABELS).toContain('unchecked');
    expect(REGISTRY_LABELS).toEqual(['present', 'absent', 'unchecked', 'invalid']);
  });
});
