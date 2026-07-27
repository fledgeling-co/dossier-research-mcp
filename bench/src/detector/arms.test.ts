import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  alwaysSupportsJudgements,
  containmentJudgements,
  judgedJudgements,
  linkCheckJudgements,
  linkCheckSoundnessJudgements,
  pageEvidence,
  registryDecision,
  registryJudgements,
  scriptedTransport,
  toSoundness,
} from './arms.js';
import { readDetectorCorpus } from './files.js';
import type { LoadedRegistryCase, LoadedSupportCase } from './corpus.js';
import type { JudgedVerdicts } from './schema.js';

/**
 * The arms, driven over the corpus that actually ships plus a few fixtures.
 *
 * The registry arm is the one that matters most here. It drives the **real**
 * `collectCitationEvidence` with a scripted transport rather than a copy of the
 * step loop, so what it tests is the rule BENCH-03 shipped rather than a
 * restatement of it that could agree with the rule today and not tomorrow.
 */

const corpus = readDetectorCorpus();

function supportCase(overrides: Partial<LoadedSupportCase> = {}): LoadedSupportCase {
  return {
    id: 'fixture',
    file: 'fixture.yaml',
    topic: 'a topic',
    claim: 'The limit is 4096 bytes.',
    url: 'https://example.com/spec',
    label: 'supports',
    why: 'a fixture whose reasoning is long enough to satisfy the schema when it is parsed',
    pageText: 'The limit is 4096 bytes.',
    page: {
      provenance: 'captured',
      capturedAt: '2026-07-27',
      verdict: 'live',
      httpStatus: 200,
      truncated: false,
      completeHtml: true,
      textFile: 'fixture.txt',
      textSha256: '0'.repeat(64),
      textChars: 24,
    },
    ...overrides,
  };
}

describe('containmentJudgements', () => {
  it('calls containment unmodified, and answers over every case', () => {
    const judgements = containmentJudgements(corpus.support);
    expect(judgements).toHaveLength(corpus.support.length);
    expect(new Set(judgements.map((j) => j.caseId)).size).toBe(corpus.support.length);
  });

  it('hands the page in the shape containment expects', () => {
    const evidence = pageEvidence(supportCase());
    expect(evidence.verdict).toBe('live');
    expect(evidence.text).toContain('4096');
    // Anchors are deliberately empty: containment never reads them and the
    // corpus does not carry them.
    expect(evidence.anchors).toEqual([]);
  });

  it('abstains on a truncated body rather than accusing a page cut short', () => {
    const [judgement] = containmentJudgements([
      supportCase({
        claim: 'The limit is 8192 bytes.',
        page: { ...supportCase().page, truncated: true },
      }),
    ]);
    expect(judgement?.decision.kind).toBe('abstain');
  });
});

describe('judgedJudgements (SELF-13, SELF-14)', () => {
  const cases = [supportCase({ id: 'one' }), supportCase({ id: 'two' }), supportCase({ id: 'three' })];
  const judged: JudgedVerdicts = {
    version: 1,
    model: 'a-model',
    judgedAt: '2026-07-27',
    note: '',
    verdicts: [{ caseId: 'one', verdict: 'contradicts' }],
    failures: [{ caseId: 'two', error: 'the CLI exited 1' }],
  };

  it('reads a recorded verdict rather than calling anything', () => {
    const judgements = judgedJudgements(cases, judged);
    expect(judgements[0]?.decision).toEqual({ kind: 'label', label: 'contradicts' });
  });

  it('SELF-14: a recorded failure abstains, and says the pass failed', () => {
    const judgements = judgedJudgements(cases, judged);
    const decision = judgements[1]?.decision;
    expect(decision?.kind).toBe('abstain');
    if (decision?.kind === 'abstain') expect(decision.why).toMatch(/failed on this case/);
  });

  it('a case nobody judged abstains, and is not a wrong answer', () => {
    const judgements = judgedJudgements(cases, judged);
    const decision = judgements[2]?.decision;
    expect(decision?.kind).toBe('abstain');
    if (decision?.kind === 'abstain') expect(decision.why).toMatch(/recorded no verdict/);
  });

  it('with no judged pass at all, every case abstains and says so', () => {
    const judgements = judgedJudgements(cases, null);
    expect(judgements.every((j) => j.decision.kind === 'abstain')).toBe(true);
    const decision = judgements[0]?.decision;
    if (decision?.kind === 'abstain') expect(decision.why).toMatch(/no judged pass/);
  });

  it('SELF-13: the arms module cannot reach a model, so the gate cannot spend', () => {
    const source = readFileSync(new URL('./arms.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('./judge.js');
    expect(source).not.toMatch(/ai\/utility|generateText|@ai-sdk/);
  });
});

describe('linkCheckJudgements (SELF-15)', () => {
  it('abstains on a resolving page, whatever the claim says', () => {
    const [judgement] = linkCheckJudgements([supportCase({ label: 'not_addressed' })]);
    expect(judgement?.decision.kind).toBe('abstain');
  });

  it('answers `unreadable` on a blocked one', () => {
    const [judgement] = linkCheckJudgements([
      supportCase({ label: 'unreadable', page: { ...supportCase().page, verdict: 'blocked' } }),
    ]);
    expect(judgement?.decision).toEqual({ kind: 'label', label: 'unreadable' });
  });
});

describe('the soundness view', () => {
  it('drops `unreadable` cases entirely rather than counting them as unsound', () => {
    const cases = [
      supportCase({ id: 'a', label: 'supports' }),
      supportCase({ id: 'b', label: 'unreadable' }),
    ];
    const collapsed = toSoundness(containmentJudgements(cases));
    expect(collapsed.map((c) => c.caseId)).toEqual(['a']);
  });

  it('scores the link check on the reading a person gives a green link', () => {
    const [judgement] = linkCheckSoundnessJudgements([supportCase({ label: 'not_addressed' })]);
    expect(judgement?.trueLabel).toBe('unsound');
    expect(judgement?.decision).toEqual({ kind: 'label', label: 'sound' });
  });
});

describe('alwaysSupportsJudgements', () => {
  it('answers `supports` to everything, which is the point of it', () => {
    const judgements = alwaysSupportsJudgements(corpus.support);
    expect(
      judgements.every((j) => j.decision.kind === 'label' && j.decision.label === 'supports'),
    ).toBe(true);
  });
});

describe('scriptedTransport', () => {
  it('answers in order, then reports a transport failure rather than repeating', async () => {
    const transport = scriptedTransport([
      { status: 200, body: 'first' },
      { status: 404, body: 'second' },
    ]);
    await expect(transport('https://example.com/1')).resolves.toMatchObject({ body: 'first' });
    await expect(transport('https://example.com/2')).resolves.toMatchObject({ status: 404 });
    // Running off the end is a mis-authored case, and it must surface as a
    // failure so it can never manufacture an `absent`.
    await expect(transport('https://example.com/3')).resolves.toMatchObject({
      error: expect.stringContaining('no further registry response') as unknown as string,
    });
  });
});

function registryCase(overrides: Partial<LoadedRegistryCase>): LoadedRegistryCase {
  return {
    id: 'fixture',
    file: 'fixture.yaml',
    kind: 'doi',
    identifier: '10.1000/example',
    reportSnippet: 'See 10.1000/example for the argument.',
    label: 'present',
    why: 'a fixture whose reasoning is long enough to satisfy the schema when it is parsed',
    provenance: 'constructed',
    observedAt: '2026-07-27',
    responses: [],
    ...overrides,
  };
}

describe('the registry arm (SELF-17)', () => {
  it('every transport failure mode answers `unchecked`, never `absent`', async () => {
    const failures = [
      { name: '429', responses: [{ status: 429, body: 'Rate exceeded' }] },
      { name: '500', responses: [{ status: 500, body: 'oops' }] },
      { name: '503', responses: [{ status: 503, body: '' }] },
      {
        name: 'a thrown timeout',
        responses: [{ status: 0, body: '', error: 'the request timed out' }],
      },
    ];
    for (const failure of failures) {
      // arXiv has a single step, so one scripted response settles it outright.
      const decision = await registryDecision(
        registryCase({
          kind: 'arxiv',
          identifier: '2509.04499',
          reportSnippet: 'See arXiv:2509.04499 for the framework.',
          responses: failure.responses,
        }),
      );
      expect(decision, failure.name).toEqual({ kind: 'label', label: 'unchecked' });
    }
  });

  it('a DOI whose registries are both down is `unchecked`, not a fabrication', async () => {
    const decision = await registryDecision(
      registryCase({
        responses: [
          { status: 503, body: '' },
          { status: 500, body: '' },
        ],
      }),
    );
    expect(decision).toEqual({ kind: 'label', label: 'unchecked' });
  });

  it('SELF-18: Crossref 404 plus a handle 200 is `present`, driven through the real loop', async () => {
    const decision = await registryDecision(
      registryCase({
        identifier: '10.5281/zenodo.3509134',
        reportSnippet: 'The dataset is 10.5281/zenodo.3509134 in the reference list.',
        responses: [
          { status: 404, body: '{"status":"error"}' },
          { status: 200, body: '{"responseCode":1}' },
        ],
      }),
    );
    expect(decision).toEqual({ kind: 'label', label: 'present' });
  });

  it('a handle 404 carrying the directory’s own not-found code is `absent`', async () => {
    const decision = await registryDecision(
      registryCase({
        identifier: '10.9999/nope',
        reportSnippet: 'Cited as 10.9999/nope in the bibliography.',
        responses: [
          { status: 404, body: '{"status":"error"}' },
          { status: 404, body: '{"responseCode":100}' },
        ],
      }),
    );
    expect(decision).toEqual({ kind: 'label', label: 'absent' });
  });

  it('SELF-19: an ISBN whose check digit is wrong is `invalid`, and asks nobody', async () => {
    const decision = await registryDecision(
      registryCase({
        kind: 'isbn',
        identifier: '9780262033849',
        reportSnippet: 'The book is ISBN: 9780262033849 in the bibliography.',
        responses: [],
      }),
    );
    expect(decision).toEqual({ kind: 'label', label: 'invalid' });
  });

  it('an identifier the extractor cannot see abstains rather than being scored', async () => {
    const decision = await registryDecision(
      registryCase({
        kind: 'pmid',
        identifier: '12345678',
        // No context word, so a bare run of digits is not a PMID.
        reportSnippet: 'The study is numbered 12345678 in our own index.',
        responses: [],
      }),
    );
    expect(decision.kind).toBe('abstain');
  });

  it('scores every registry case the corpus ships', async () => {
    const judgements = await registryJudgements(corpus.registry);
    expect(judgements).toHaveLength(corpus.registry.length);
    for (const judgement of judgements) {
      expect(judgement.decision, judgement.caseId).toMatchObject({ kind: 'label' });
    }
  });
});
