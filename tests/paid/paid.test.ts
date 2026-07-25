import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpHarness } from '../acceptance/harness.js';

/**
 * PAID-01..05. Tests that spend real money against the live API.
 *
 * **These never run in the gate and never block a deploy.** They need
 * `DOSSIER_PAID_TESTS=1` and a real `GEMINI_API_KEY`, and without both the
 * whole file skips. That is deliberate: a suite that can spend $7 must be
 * something you opt into on purpose, not something a `git push` triggers.
 *
 * Budget: roughly $2-4 per full run at `fast` tier. The `max`-tier case is
 * skipped unless `DOSSIER_PAID_MAX=1` because it is $3-7 on its own and
 * exercises the same code path with a different agent id.
 *
 * Everything here asserts an OUTCOME the docs promise, not that a call
 * returned. "A run completes" means a report exists with cited sources and a
 * readable structure, because a run that returns an empty report is exactly
 * the failure these are for.
 */

const ENABLED = process.env['DOSSIER_PAID_TESTS'] === '1' && Boolean(process.env['GEMINI_API_KEY']);
const MAX_TIER = process.env['DOSSIER_PAID_MAX'] === '1';

const describePaid = ENABLED ? describe : describe.skip;

/** Poll until terminal. Deep Research takes 4-60 minutes, so this is patient. */
async function waitForTerminal(mcp: McpHarness, runId: string, budgetMs = 25 * 60_000): Promise<string> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const status = await mcp.callTool('research_status', { runId });
    const state = /— (\w+)/.exec(status.text)?.[1] ?? 'unknown';
    if (['completed', 'failed', 'cancelled'].includes(state)) return state;
    if (Date.now() > deadline) return `timeout:${state}`;
    await new Promise((r) => setTimeout(r, 20_000));
  }
}

let mcp: McpHarness;
const started: string[] = [];

beforeAll(async () => {
  if (!ENABLED) return;
  // Not hermetic: this is the one suite that talks to the real API.
  mcp = await McpHarness.create({
    DOSSIER_HERMETIC: '',
    GEMINI_API_KEY: process.env['GEMINI_API_KEY'] ?? '',
    // Its own ceiling, so a bug in the suite cannot drain a real budget.
    DOSSIER_BUDGET_USD: '15',
  });
}, 90_000);

afterAll(async () => {
  if (!ENABLED) return;
  // Leave nothing running: an abandoned run keeps billing.
  for (const runId of started) {
    await mcp.callTool('research_cancel', { runId }).catch(() => undefined);
  }
  await mcp.dispose();
});

describePaid('PAID-01: a real fast-tier run completes and produces a usable report', () => {
  let runId = '';

  it('starts from a plan and returns a handle', async () => {
    const question =
      'What are the documented context window sizes and output token limits for the Gemini 3 model family?';
    const plan = await mcp.callTool('research_plan', { question, tier: 'fast' });
    const fingerprint = /fingerprint.*?`([a-f0-9]+)`/.exec(plan.text)?.[1];
    expect(fingerprint).toBeDefined();

    const start = await mcp.callTool('research_start', {
      question,
      tier: 'fast',
      contractFingerprint: fingerprint,
      label: 'paid acceptance',
    });
    expect(start.isError).toBe(false);
    runId = /`(dr_[a-f0-9]+)`/.exec(start.text)?.[1] ?? '';
    expect(runId).toMatch(/^dr_/);
    started.push(runId);
  }, 120_000);

  it('de-duplicates an identical request instead of paying twice', async () => {
    const question =
      'What are the documented context window sizes and output token limits for the Gemini 3 model family?';
    const again = await mcp.callTool('research_start', { question, tier: 'fast' });
    expect(again.text).toMatch(/De-duplicated/i);
    // The decisive assertion: still one run, not two.
    const budget = await mcp.callTool('research_budget');
    expect(budget.text).toMatch(/Runs in window: 1\b/);
  }, 120_000);

  it('completes, and the report has real structure and cited sources', async () => {
    const state = await waitForTerminal(mcp, runId);
    expect(state).toBe('completed');

    const status = await mcp.callTool('research_status', { runId });
    const sources = Number(/(\d+) cited sources/.exec(status.text)?.[1] ?? '0');
    // A completed run with no sources is a failed run wearing a green badge.
    expect(sources).toBeGreaterThan(3);

    const outline = await mcp.callTool('research_read', { runId });
    expect(outline.text).toMatch(/Executive Summary/i);
    const sections = [...outline.text.matchAll(/\(~(\d+) tok\)/g)];
    expect(sections.length).toBeGreaterThan(3);

    const exec = await mcp.callTool('research_read', {
      runId,
      mode: 'section',
      section: 'Executive Summary',
    });
    // The prompt mandates confidence qualifiers; assert they actually appear.
    expect(exec.text).toMatch(/\((High|Medium|Low) Confidence\)/);
  }, 30 * 60_000);

  it('verifies its own citations, and most of them resolve', async () => {
    const verified = await mcp.callTool('research_verify_citations', { runId, onlyProblems: true });
    expect(verified.isError).toBe(false);
    const resolved = /(\d+)\/(\d+) resolved/.exec(verified.text);
    expect(resolved).not.toBeNull();
    const [, live, total] = resolved!;
    expect(Number(total)).toBeGreaterThan(3);
    // Fabricated-citation guard: a genuinely researched report resolves most
    // of its sources. Well below this and something is wrong with the report,
    // not with the checker.
    expect(Number(live) / Number(total)).toBeGreaterThan(0.5);
  }, 5 * 60_000);

  it('answers a follow-up from the report rather than from the model', async () => {
    const answer = await mcp.callTool('research_followup', {
      runId,
      question: 'Name the single largest context window figure this report gives, and its source.',
    });
    expect(answer.isError).toBe(false);
    expect(answer.text.length).toBeGreaterThan(40);
  }, 5 * 60_000);

  it('extracts claim cards with the report’s own confidence levels', async () => {
    const claims = await mcp.callTool('research_claims', { runId, limit: 5 });
    expect(claims.isError).toBe(false);
    const structured = claims.structured as { claims?: { claim: string; confidence: string }[] } | undefined;
    expect(structured?.claims?.length).toBeGreaterThan(0);
    for (const c of structured?.claims ?? []) {
      expect(['high', 'medium', 'low']).toContain(c.confidence);
      expect(c.claim.length).toBeGreaterThan(10);
    }
  }, 5 * 60_000);
});

describePaid('PAID-02: collaborative planning, end to end', () => {
  it('returns a reviewable plan, not the submitted prompt back', async () => {
    const question = 'What transport mechanisms does the Model Context Protocol specification define?';
    const start = await mcp.callTool('research_start', {
      question,
      tier: 'fast',
      collaborativePlanning: true,
      label: 'paid plan review',
    });
    const runId = /`(dr_[a-f0-9]+)`/.exec(start.text)?.[1] ?? '';
    started.push(runId);
    expect(runId).toMatch(/^dr_/);

    // Wait for the plan turn.
    const deadline = Date.now() + 5 * 60_000;
    let planText = '';
    for (;;) {
      const status = await mcp.callTool('research_status', { runId });
      if (/Proposed plan/.test(status.text)) {
        planText = status.text.slice(status.text.indexOf('### Proposed plan'));
        break;
      }
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 15_000));
    }

    expect(planText).not.toBe('');
    // The regression this exists for: the API wraps the plan behind an echo of
    // the submitted prompt, ~6,700 of 8,000 characters. A caller must see the
    // plan, not their own brief.
    expect(planText).not.toContain('You are a senior research analyst');
    expect(planText.length).toBeLessThan(4000);

    const approved = await mcp.callTool('research_approve_plan', {
      runId,
      amendment: 'Also enumerate every transport the specification has deprecated, and when.',
    });
    expect(approved.isError).toBe(false);
    expect(approved.text).toMatch(/approved with your amendment/i);
  }, 12 * 60_000);
});

describePaid('PAID-03: corpus grounding produces the contradictions section', () => {
  it('reads the attached corpus and contradicts it where the web disagrees', async () => {
    const store = await mcp.callTool('corpus_create', { displayName: 'paid-acceptance' });
    const storeName = /`(fileSearchStores\/[^`]+)`/.exec(store.text)?.[1] ?? '';
    expect(storeName).toMatch(/^fileSearchStores\//);

    const { writeFileSync } = await import('node:fs');
    const path = `${mcp.storeDir}/internal-claims.md`;
    // Deliberately wrong, so a working grounding pass has something to find.
    writeFileSync(
      path,
      [
        '# Internal engineering standard',
        '',
        '1. MCP servers MUST use stdio only; HTTP transports are experimental.',
        '2. MCP has no specification for authorization.',
        '3. Tool annotations are not part of the specification.',
      ].join('\n'),
    );
    const uploaded = await mcp.callTool('corpus_add_file', { storeName, filePath: path });
    expect(uploaded.isError).toBe(false);

    try {
      const start = await mcp.callTool('research_start', {
        question:
          'What transports and authorization model does the Model Context Protocol specification currently define?',
        tier: 'fast',
        corpusStores: [storeName],
        label: 'paid corpus grounding',
      });
      const runId = /`(dr_[a-f0-9]+)`/.exec(start.text)?.[1] ?? '';
      started.push(runId);

      const state = await waitForTerminal(mcp, runId);
      expect(state).toBe('completed');

      // The outcome the feature promises, and the one that silently failed
      // once when the grounding block was appended after the re-anchor.
      const outline = await mcp.callTool('research_read', { runId });
      expect(outline.text).toMatch(/Contradictions with the [Aa]ttached [Cc]orpus/);

      const section = await mcp.callTool('research_read', {
        runId,
        mode: 'section',
        section: 'Contradictions',
      });
      expect(section.isError).toBe(false);
      expect(section.text.length).toBeGreaterThan(200);
    } finally {
      await mcp.callTool('corpus_delete', { storeName }).catch(() => undefined);
    }
  }, 30 * 60_000);
});

describePaid('PAID-04: multimodal attachments', () => {
  it('accepts a document URI and researches against it', async () => {
    const start = await mcp.callTool('research_start', {
      question: 'Summarise the core architectural contribution of the attached paper and who authored it.',
      tier: 'fast',
      label: 'paid attachments',
      attachments: [
        { kind: 'document', uri: 'https://arxiv.org/pdf/1706.03762', mimeType: 'application/pdf' },
      ],
    });
    expect(start.isError).toBe(false);
    const runId = /`(dr_[a-f0-9]+)`/.exec(start.text)?.[1] ?? '';
    started.push(runId);

    const state = await waitForTerminal(mcp, runId);
    expect(state).toBe('completed');
    const report = await mcp.callTool('research_read', { runId, mode: 'full', maxTokens: 4000 });
    // It read the attachment rather than ignoring it.
    expect(report.text).toMatch(/attention|transformer/i);
  }, 30 * 60_000);
});

describePaid('PAID-05: the max tier', () => {
  it.skipIf(!MAX_TIER)(
    'runs on the max agent and commits the higher cost band',
    async () => {
      const start = await mcp.callTool('research_start', {
        question: 'Compare the operational trade-offs of the major open-source vector databases at scale.',
        tier: 'max',
        label: 'paid max tier',
      });
      expect(start.isError).toBe(false);
      const runId = /`(dr_[a-f0-9]+)`/.exec(start.text)?.[1] ?? '';
      started.push(runId);
      // The band, not just the run: a max run commits ~$5, not ~$2.
      expect(start.text).toMatch(/\$5\.00|\$3\.00-\$7\.00/);

      const state = await waitForTerminal(mcp, runId, 60 * 60_000);
      expect(state).toBe('completed');
    },
    65 * 60_000,
  );
});
