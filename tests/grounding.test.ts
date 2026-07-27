import { describe, expect, it, vi } from 'vitest';
import { assessSupport, type ProviderClaim } from '../src/research/corroborate.js';
import { classifySource, countsAsCorroboration } from '../src/research/evidence.js';
import {
  GROUNDING_SUBDIR,
  assertGroundableRunId,
  groundingFileName,
  groundingFrontMatter,
  groundingUri,
  isPriorDossierReport,
  priorReportRunId,
  priorResearchBlock,
  renderGroundingDeclaration,
  renderGroundingDocument,
} from '../src/research/grounding.js';
import { mergeEvidence, type RunEvidence } from '../src/research/synthesise.js';
import type { RunRecord } from '../src/store/types.js';

/**
 * A finished report as an input to the next question, and the rule that has to
 * survive it.
 *
 * The feature is small. The risk is not: a run grounded in an earlier report can
 * launder a claim by repeating it, so a weakly-supported assertion appears in two
 * reports and reads as accumulation. Most of what is asserted here is that the
 * arithmetic refuses to be fooled by that.
 */

function completedRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'dr_alpha',
    interactionId: 'int_1',
    provider: 'gemini',
    shape: 'deep',
    state: 'completed',
    tier: 'fast',
    archetype: 'technical',
    question: 'What is the state of X?',
    prompt: '<core_directive>x</core_directive>',
    promptWasPreEngineered: false,
    fingerprint: 'fp',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T01:00:00.000Z',
    lastProgressAt: '2026-07-01T01:00:00.000Z',
    completedAt: '2026-07-01T01:00:00.000Z',
    estimatedCostUsd: 2.5,
    tags: [],
    planApproved: true,
    title: 'The state of X',
    reportChars: 1000,
    sourceCount: 11,
    imageCount: 0,
    reasoningSteps: 0,
    streamedChars: 0,
    searches: 0,
    urlsFetched: 0,
    corpusQueries: 0,
    codeRuns: 0,
    streamAbandoned: false,
    toolsUsed: ['google_search'],
    corpusStores: [],
    ...overrides,
  };
}

describe('the canonical identifier', () => {
  it('addresses a prior report by URI and by file name, and reads the id back', () => {
    expect(groundingUri('dr_alpha')).toBe('dossier://run/dr_alpha');
    expect(groundingFileName('dr_alpha')).toBe('dossier-run-dr_alpha.md');
    expect(isPriorDossierReport('dossier://run/dr_alpha')).toBe(true);
    expect(isPriorDossierReport('dossier-run-dr_alpha.md')).toBe(true);
    // How a File Search store or `corpus_local_search` hands one back.
    expect(isPriorDossierReport('/Users/me/notes/dossier-grounding/dossier-run-dr_alpha.md')).toBe(true);
    expect(priorReportRunId('dossier://run/dr_alpha')).toBe('dr_alpha');
    expect(priorReportRunId('dossier-run-dr_alpha.md')).toBe('dr_alpha');
  });

  it('does not mistake an ordinary source for one of Dossier’s own reports', () => {
    expect(isPriorDossierReport('https://example.gov/report')).toBe(false);
    expect(isPriorDossierReport('https://example.com/dossier-run-notes.html')).toBe(false);
    expect(isPriorDossierReport('notes.md')).toBe(false);
    expect(isPriorDossierReport('')).toBe(false);
    expect(priorReportRunId('https://example.gov/report')).toBeNull();
  });

  // GROUND-07
  it('refuses a run id that could not safely become a path segment', () => {
    expect(() => assertGroundableRunId('../../etc/passwd')).toThrow(/Invalid run id/);
    expect(() => assertGroundableRunId('dr/alpha')).toThrow(/Invalid run id/);
    expect(() => assertGroundableRunId('')).toThrow(/Invalid run id/);
    expect(() => assertGroundableRunId('a'.repeat(65))).toThrow(/Invalid run id/);
    expect(() => groundingFileName('..')).toThrow(/Invalid run id/);
    expect(assertGroundableRunId('dr_alpha-1')).toBe('dr_alpha-1');
  });

  it('writes into one fixed, greppable subdirectory', () => {
    expect(GROUNDING_SUBDIR).toBe('dossier-grounding');
  });
});

describe('a prior Dossier report is the requester’s own document', () => {
  // GROUND-10
  it('classifies as private-user-owned without anyone having to say so', () => {
    const s = classifySource(groundingUri('dr_alpha'));
    expect(s.accessibility).toBe('private-user-owned');
    expect(s.basis).toMatch(/prior Dossier report/);
    expect(countsAsCorroboration(s)).toBe(false);
    // And by the file name, which is what a corpus search hands back.
    expect(countsAsCorroboration(classifySource('dossier-run-dr_alpha.md'))).toBe(false);
  });

  // GROUND-11
  it('counts a claim in both the grounding report and the new one exactly once', () => {
    // Run A found the page. Run B was grounded in A, read the same page, and
    // cited both. Two reports, one source.
    const claims: ProviderClaim[] = [
      { provider: 'run-a', text: 'X grew 12% in 2025.', urls: ['https://example.gov/x'] },
      {
        provider: 'run-b',
        text: 'X grew 12% in 2025.',
        urls: ['https://example.gov/x', groundingUri('dr_alpha')],
      },
    ];
    const verdict = assessSupport(claims);
    expect(verdict.independentDomains).toBe(1);
    expect(verdict.support).toBe('single-source');
    expect(verdict.note).toMatch(/same domain/);
  });

  // GROUND-12
  it('refuses to launder a claim carried in from a prior report', () => {
    // The failure this exists to prevent: A asserted it weakly, B read A and
    // repeated it, and now it appears twice. That is amplification, and the
    // arithmetic has to say so rather than reward it.
    const laundered = assessSupport([
      { provider: 'run-a', text: 'X will double by 2027.', urls: [groundingUri('dr_alpha')] },
      { provider: 'run-b', text: 'X will double by 2027.', urls: [groundingUri('dr_alpha')] },
    ]);
    expect(laundered.independentDomains).toBe(0);
    expect(laundered.support).toBe('unsupported');
    expect(laundered.note).toMatch(/Never present this as a finding/);

    // Two real domains plus the prior report is still two, not three.
    const partly = assessSupport([
      { provider: 'run-a', text: 'X grew.', urls: ['https://a.gov/x'] },
      {
        provider: 'run-b',
        text: 'X grew.',
        urls: ['https://b.gov/x', groundingUri('dr_alpha'), 'dossier-run-dr_beta.md'],
      },
    ]);
    expect(partly.independentDomains).toBe(2);
    expect(partly.support).toBe('weakly-supported');
  });

  // GROUND-13
  it('keeps a prior report out of a merge’s independent-domain count while still listing it', () => {
    const cite = (urls: readonly string[]): string =>
      ['# R', '', ...urls.map((u) => `- A claim <cite url="${u}">1</cite>.`)].join('\n');
    const runs: RunEvidence[] = [
      { runId: 'dr_one', provider: 'gemini', markdown: cite(['https://a.gov/x']) },
      {
        runId: 'dr_two',
        provider: 'perplexity',
        markdown: cite(['https://a.gov/x', groundingUri('dr_alpha')]),
      },
    ];
    const merged = mergeEvidence(runs);
    expect(merged.sources).toHaveLength(2);
    // Listed, because it was genuinely read and the reader should see it.
    expect(merged.sources.some((s) => s.url === groundingUri('dr_alpha'))).toBe(true);
    expect(merged.sources.find((s) => s.url === groundingUri('dr_alpha'))?.countsAsCorroboration).toBe(
      false,
    );
    // But it adds nothing to the breadth.
    expect(merged.independentDomains).toBe(1);
  });
});

describe('the declaration a grounded report carries', () => {
  it('names the prior runs and states the rule', () => {
    const text = renderGroundingDeclaration(['dr_alpha', 'dr_beta']);
    expect(text).toMatch(/Grounded in prior Dossier output/);
    expect(text).toMatch(/dr_alpha/);
    expect(text).toMatch(/dr_beta/);
    expect(text).toMatch(/never independent corroboration/);
  });

  it('is empty when a run was grounded in nothing, so an ordinary report is unchanged', () => {
    expect(renderGroundingDeclaration([])).toBe('');
    expect(groundingFrontMatter([])).toEqual([]);
  });

  it('puts the run ids in the front matter of anything that carries one', () => {
    expect(groundingFrontMatter(['dr_alpha'])[0]).toBe('grounded_in: [dr_alpha]');
  });
});

describe('the grounding document', () => {
  it('leads with what it is, so a later run cannot mistake it for a source', () => {
    const doc = renderGroundingDocument({
      run: completedRun(),
      markdown: '# The state of X\n\nSome findings.',
    });
    expect(doc.startsWith('---\n')).toBe(true);
    expect(doc).toMatch(/dossier_source: dossier:\/\/run\/dr_alpha/);
    expect(doc).toMatch(/dossier_grounding_document: true/);
    expect(doc).toMatch(/This is a Dossier research report, not a source/);
    expect(doc).toMatch(/never independent corroboration/);
    expect(doc).toMatch(/Some findings\./);
  });

  it('carries the chain forward when the run it came from was itself grounded', () => {
    const doc = renderGroundingDocument({
      run: completedRun({ id: 'dr_gamma', groundedIn: ['dr_alpha'] }),
      markdown: '# Later\n\nMore findings.',
    });
    expect(doc).toMatch(/grounded_in: \[dr_alpha\]/);
    expect(doc).toMatch(/Grounded in prior Dossier output/);
  });
});

describe('the prompt block', () => {
  // GROUND-16
  it('states the rule and carries no text from the prior reports', () => {
    const block = priorResearchBlock(2);
    expect(block).toMatch(/2 earlier Dossier research runs/);
    expect(block).toMatch(/never independent corroboration/);
    expect(block).toMatch(/Count support in independent sources, never in reports/);
    // It knows how many. It does not know, and must not carry, what they said:
    // a locally-grounded report has just been promised never to leave the
    // machine, and the next prompt goes to a provider.
    expect(block).not.toMatch(/dr_alpha/);
  });

  it('says "run" rather than "runs" for one', () => {
    expect(priorResearchBlock(1)).toMatch(/1 earlier Dossier research run on/);
  });
});

// GROUND-05
describe('the local path opens no socket', () => {
  it('renders and identifies a grounding document with fetch made fatal', async () => {
    // The acceptance is "sends nothing anywhere", which is a claim about
    // behaviour rather than intent, so the test has to be one that would notice.
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('the local grounding path must not reach the network');
    });
    try {
      const run = completedRun();
      const doc = renderGroundingDocument({ run, markdown: '# X\n\nFindings.' });
      expect(doc).toContain(groundingUri(run.id));
      expect(groundingFileName(run.id)).toBe('dossier-run-dr_alpha.md');
      expect(countsAsCorroboration(classifySource(groundingUri(run.id)))).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    await Promise.resolve();
  });
});
