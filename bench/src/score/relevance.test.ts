import { describe, expect, it } from 'vitest';
import type { BenchTaskFile } from '../tasks/schema.js';
import { DEFAULT_DRIFT_WEIGHT, scoreRelevance } from './relevance.js';

function task(
  requiredTerms: readonly string[],
  driftTerms: readonly string[] = [],
): BenchTaskFile {
  return {
    id: 'case',
    category: 'technical',
    question: 'a question long enough to be valid',
    asOf: '2026-07-01',
    reverifiedAt: '2026-07-01',
    goldFacts: [
      {
        id: 'f1',
        kind: 'name',
        value: 'anything',
        aliases: [],
        source: { url: 'https://example.test/a' },
      },
    ],
    requiredTerms,
    driftTerms,
    knownDissent: [],
    conflictingFigures: [],
    fringeClaims: [],
  };
}

const scored = (report: string, t: BenchTaskFile, weight?: number) => {
  const result = scoreRelevance(report, t, weight === undefined ? {} : { driftWeight: weight });
  if (result.status !== 'scored') throw new Error(`expected a scored result, got ${result.status}`);
  return result;
};

describe('coverage minus drift (ACCREL-15)', () => {
  it('is full coverage and no drift for an on-topic report', () => {
    const result = scored(
      'The containerd advisory carries a CVE and a CVSS score.',
      task(['containerd', 'CVE', 'CVSS'], ['Kubernetes CVE-2025']),
    );
    expect(result.coverage).toBe(1);
    expect(result.drift).toBe(0);
    expect(result.score).toBe(1);
    expect(result.requiredMisses).toEqual([]);
  });

  it('reports partial coverage as a share', () => {
    const result = scored('Only containerd is discussed.', task(['containerd', 'CVE', 'CVSS']));
    expect(result.coverage).toBeCloseTo(1 / 3);
    expect(result.requiredHits).toEqual(['containerd']);
    expect(result.requiredMisses).toEqual(['CVE', 'CVSS']);
  });

  it('subtracts drift at the stated weight', () => {
    const result = scored(
      'The containerd advisory, and also Kubernetes CVE-2025.',
      task(['containerd'], ['Kubernetes CVE-2025', 'Docker Swarm']),
    );
    expect(result.coverage).toBe(1);
    expect(result.drift).toBe(0.5);
    expect(result.weight).toBe(DEFAULT_DRIFT_WEIGHT);
    expect(result.score).toBe(0.5);
    expect(result.driftHits).toEqual(['Kubernetes CVE-2025']);
  });

  it('clamps to zero rather than going negative', () => {
    const result = scored(
      'This is entirely about Kubernetes CVE-2025.',
      task(['containerd'], ['Kubernetes CVE-2025']),
    );
    expect(result.coverage).toBe(0);
    expect(result.drift).toBe(1);
    expect(result.score).toBe(0);
    expect(result.notes.join(' ')).toContain('clamped at zero');
  });

  it('scores no penalty when the task records no drift terms', () => {
    const result = scored('All about containerd.', task(['containerd']));
    expect(result.drift).toBe(0);
    expect(result.score).toBe(1);
    expect(result.notes.join(' ')).toContain('no drift terms');
  });

  it('counts each term once however often it appears', () => {
    const once = scored('containerd', task(['containerd']));
    const many = scored('containerd containerd containerd containerd', task(['containerd']));
    expect(many.coverage).toBe(once.coverage);
    expect(many.score).toBe(once.score);
  });

  it('returns coverage and drift separately, so a reader can recompute the score', () => {
    // The prior art is explicit that a collapsed number hides what its
    // components say, which is why both are on the result rather than folded in.
    const result = scored(
      'containerd, and also Kubernetes CVE-2025.',
      task(['containerd'], ['Kubernetes CVE-2025']),
    );
    expect(result.score).toBeCloseTo(result.coverage - result.weight * result.drift);
  });

  it('honours a caller supplied weight', () => {
    const result = scored(
      'containerd, and also Kubernetes CVE-2025.',
      task(['containerd'], ['Kubernetes CVE-2025']),
      0.5,
    );
    expect(result.weight).toBe(0.5);
    expect(result.score).toBe(0.5);
  });
});

describe('matching (ACCREL-16)', () => {
  it('matches over prose, not citation URLs', () => {
    // Without this, every report citing a containerd advisory scores coverage
    // for the word regardless of what it wrote.
    const result = scored(
      'A report about something else entirely ([source](https://github.com/containerd/containerd/security)).',
      task(['containerd']),
    );
    expect(result.coverage).toBe(0);
  });

  it('matches case-insensitively', () => {
    expect(scored('CONTAINERD was patched.', task(['containerd'])).coverage).toBe(1);
  });

  it('matches on word boundaries', () => {
    expect(scored('The metadata was incomplete.', task(['Meta'])).coverage).toBe(0);
    expect(scored('Meta filed the report.', task(['Meta'])).coverage).toBe(1);
  });

  it('matches a multi-word term across a line wrap', () => {
    expect(scored('the citation\naccuracy figure', task(['citation accuracy'])).coverage).toBe(1);
  });

  it('does not apply negation, unlike accuracy', () => {
    // Relevance asks whether the subject was raised. A report saying "this is
    // not about Kubernetes" has raised Kubernetes; polarity changes whether an
    // answer is right, which is accuracy's question rather than this one.
    const result = scored(
      'This report is not about containerd at all.',
      task(['containerd']),
    );
    expect(result.coverage).toBe(1);
  });
});

describe('applicability (ACCREL-14)', () => {
  it('is not applicable when the task records no required terms', () => {
    const result = scoreRelevance('anything', task([]));
    expect(result.status).toBe('not-applicable');
    expect(result).not.toHaveProperty('score');
  });

  it('never returns a zero standing in for an absent measurement', () => {
    const result = scoreRelevance('anything', task([], ['drifted']));
    expect(result.status).toBe('not-applicable');
  });
});

describe('the weight is validated (ACCREL-20)', () => {
  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])('refuses %p', (weight) => {
    expect(() => scoreRelevance('anything', task(['containerd']), { driftWeight: weight })).toThrow(
      TypeError,
    );
  });

  it('accepts zero, which turns the penalty off', () => {
    const result = scored(
      'containerd, and also Kubernetes CVE-2025.',
      task(['containerd'], ['Kubernetes CVE-2025']),
      0,
    );
    expect(result.score).toBe(1);
    expect(result.drift).toBe(1);
  });
});

describe('what this score cannot do', () => {
  it('says plainly that a synonym scores nothing', () => {
    const result = scored('All about the container runtime.', task(['containerd']));
    expect(result.coverage).toBe(0);
    expect(result.notes.join(' ')).toContain('synonym');
  });

  it('stays crude: the gold facts do not change the score', () => {
    // The whole design constraint. If this started deciding whether an answer
    // was correct it would be duplicating accuracy, and the version of that
    // which works needs a model. So a report is scored identically whether the
    // task's answers are the ones it stated or completely different ones.
    const withOneAnswer = task(['containerd']);
    const withAnother: BenchTaskFile = {
      ...withOneAnswer,
      goldFacts: [
        {
          id: 'f1',
          kind: 'number',
          value: 999,
          unit: 'dimensionless',
          tolerance: { kind: 'exact' },
          source: { url: 'https://example.test/a' },
        },
      ],
    };
    const report = 'containerd was patched, and the score was 8.8.';
    expect(scored(report, withOneAnswer).score).toBe(scored(report, withAnother).score);
  });
});
