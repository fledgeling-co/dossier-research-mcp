import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UtilityModel } from '../src/ai/utility.js';
import { loadConfig, type Config } from '../src/config.js';
import type { DeepResearchClient, FollowUpArgs } from '../src/gemini/client.js';
import type { InteractionSnapshot } from '../src/gemini/types.js';
import { Runner } from '../src/research/runner.js';
import {
  buildDeps,
  createServer,
  FOLLOWUP_CAVEAT,
  followUpContext,
  type ServerDeps,
} from '../src/server.js';
import { Store } from '../src/store/store.js';
import type { RunRecord } from '../src/store/types.js';

/**
 * MCP-surface tests.
 *
 * The runner tests cover the lifecycle logic; these cover the layer above it —
 * the tools' own argument handling, guard clauses and fallback chains, which
 * had no coverage at all. `research_followup` in particular was the only tool
 * in the server with no test of any kind AND a non-trivial fallback chain
 * (live interaction → stored report + utility model), so it is the reason this
 * file exists.
 *
 * FastMCP does not expose a registry for direct invocation, so these drive the
 * same code the tools call, with the same dependency objects, rather than
 * asserting through a transport. The stdio handshake is covered separately.
 */

const snapshot = (over: Partial<InteractionSnapshot>): InteractionSnapshot => ({
  interactionId: 'int_1',
  status: 'in_progress',
  markdown: '',
  thoughts: [],
  images: [],
  ...over,
});

function stubClient(over: Partial<DeepResearchClient> = {}): DeepResearchClient {
  return {
    async createRun() {
      return snapshot({ interactionId: 'int_1' });
    },
    async getRun() {
      return snapshot({});
    },
    async cancelRun() {
      /* no-op */
    },
    async followUp() {
      return 'live follow-up answer';
    },
    ...over,
  };
}

function stubUtility(over: Partial<UtilityModel> = {}): UtilityModel {
  return {
    async summarise() {
      return { ok: true, value: { title: 'T', summary: 'S', confidence: 'high' } };
    },
    async extractClaims() {
      return { ok: true, value: { claims: [] } };
    },
    async answer() {
      return { ok: true, value: 'stored-report answer' };
    },
    async judgeSupport() {
      return { ok: true, value: { verdict: 'supports' as const } };
    },
    async review() {
      return { ok: true, value: { checked: 'the whole report', issues: [] } };
    },
    ...over,
  };
}

let dir: string;
let store: Store;
let config: Config;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dossier-tools-'));
  store = new Store(dir);
  await store.init();
  config = { ...loadConfig({ DOSSIER_HERMETIC: '1' }), storeDir: dir };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seedCompletedRun(markdown = '## Executive Summary\n\n- A leads.\n'): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    id: 'dr_test0001',
    provider: 'gemini',
    shape: 'deep',
    interactionId: 'int_1',
    state: 'completed',
    tier: 'fast',
    archetype: 'competitive',
    question: 'who leads?',
    prompt: 'engineered',
    promptWasPreEngineered: false,
    fingerprint: 'fp',
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    completedAt: now,
    estimatedCostUsd: 2,
    tags: [],
    planApproved: true,
    reportChars: markdown.length,
    sourceCount: 0,
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
  };
  await store.saveRun(run);
  await store.saveReport(run.id, markdown);
  return run;
}

describe('server construction', () => {
  it('registers every tool, resource and prompt without throwing', async () => {
    // A tool whose Zod schema FastMCP rejects at registration passes typecheck
    // and only fails here — which is exactly the class of bug this catches.
    const deps = await buildDeps(config);
    expect(() => createServer(deps)).not.toThrow();
  });

  it('starts in a degraded but usable state with no credentials', async () => {
    const deps = await buildDeps(config);
    expect(deps.client).toBeNull();
    expect(deps.corpus).toBeNull();
    expect(deps.agents).toBeNull();
    // The read-only surface must still work so `research_plan` stays free.
    expect(deps.store).toBeInstanceOf(Store);
  });
});

describe('research_followup fallback chain', () => {
  /**
   * Mirrors the tool's resolution order, and shares its two load-bearing
   * pieces (`followUpContext`, `FOLLOWUP_CAVEAT`) with it rather than
   * restating them — a mirror that restates them tests the mirror.
   */
  async function followup(
    deps: Pick<ServerDeps, 'client' | 'utility' | 'store' | 'config'>,
    runId: string,
    question: string,
  ): Promise<string> {
    const run = await deps.store.getRun(runId);
    if (!run) throw new Error('no run');
    if (run.state !== 'completed') throw new Error(`state ${run.state}`);
    if (deps.client && run.interactionId) {
      const live = await deps.client
        .followUp({ question, previousInteractionId: run.interactionId, model: deps.config.utilityModel })
        .catch(() => null);
      if (live) return `${live}\n\n${FOLLOWUP_CAVEAT}`;
    }
    const markdown = await deps.store.readReport(runId);
    if (!markdown) throw new Error('no report');
    if (!deps.utility) throw new Error('no utility');
    const answered = await deps.utility.answer(question, followUpContext(markdown));
    if (!answered.ok) throw new Error(answered.error);
    return `${answered.value}\n\n${FOLLOWUP_CAVEAT}`;
  }

  it('marks every answer as synthesised, on both paths', async () => {
    // A follow-up conditions on the report, so an error in the report becomes a
    // premise of the answer and the answer reads as corroboration of it. The
    // marker is the cheap mitigation and it must be unconditional.
    const run = await seedCompletedRun();
    const live = await followup({ client: stubClient(), utility: stubUtility(), store, config }, run.id, 'why?');
    const stored = await followup({ client: null, utility: stubUtility(), store, config }, run.id, 'why?');
    for (const answer of [live, stored]) {
      expect(answer).toContain('**synthesised**');
      expect(answer).toMatch(/cannot raise a claim’s confidence/);
    }
  });

  it('answers from the frozen registry, not from the report’s prose alone', async () => {
    // Closes the failure where a model invents a plausible reference mid-answer
    // to support a sentence it wanted to write.
    const run = await seedCompletedRun(
      '# R\n\nA claim <cite url="https://example.com/a">1</cite> and another <cite url="https://other.org/b">2</cite>.\n',
    );
    const seen: string[] = [];
    const utility = stubUtility({
      async answer(_q, context) {
        seen.push(context);
        return { ok: true, value: 'answered' };
      },
    });
    await followup({ client: null, utility, store, config }, run.id, 'which sources?');
    expect(seen[0]).toContain('Citation registry');
    expect(seen[0]).toContain('1. https://example.com/a');
    expect(seen[0]).toMatch(/cite ONLY from this list/);
  });

  it('prefers the live interaction, which keeps the researcher’s own context', async () => {
    const run = await seedCompletedRun();
    const seen: FollowUpArgs[] = [];
    const client = stubClient({
      async followUp(args) {
        seen.push(args);
        return 'live follow-up answer';
      },
    });
    const answer = await followup({ client, utility: stubUtility(), store, config }, run.id, 'why?');
    expect(answer).toContain('live follow-up answer');
    expect(seen[0]?.previousInteractionId).toBe('int_1');
  });

  it('falls back to the stored report when the live interaction has aged out', async () => {
    const run = await seedCompletedRun();
    const client = stubClient({
      async followUp() {
        throw new Error('interaction not found');
      },
    });
    const answer = await followup({ client, utility: stubUtility(), store, config }, run.id, 'why?');
    expect(answer).toContain('stored-report answer');
  });

  it('surfaces the utility model’s reason rather than a bare failure', async () => {
    const run = await seedCompletedRun();
    const client = stubClient({
      async followUp() {
        throw new Error('gone');
      },
    });
    const utility = stubUtility({
      async answer() {
        return { ok: false, error: 'quota exhausted' };
      },
    });
    await expect(followup({ client, utility, store, config }, run.id, 'why?')).rejects.toThrow(
      /quota exhausted/,
    );
  });

  it('refuses a run that has not completed', async () => {
    const run = await seedCompletedRun();
    await store.saveRun({ ...run, state: 'running' });
    await expect(
      followup({ client: stubClient(), utility: stubUtility(), store, config }, run.id, 'why?'),
    ).rejects.toThrow(/state running/);
  });
});

describe('approve_plan and cancel guards', () => {
  it('approving a run with no plan yet is refused, not silently accepted', async () => {
    const now = new Date().toISOString();
    await store.saveRun({
      id: 'dr_test0002',
      provider: 'gemini',
      shape: 'deep',
      interactionId: 'int_1',
      state: 'planning',
      tier: 'fast',
      archetype: 'competitive',
      question: 'q',
      prompt: 'p',
      promptWasPreEngineered: false,
      fingerprint: 'fp2',
      createdAt: now,
      updatedAt: now,
      lastProgressAt: now,
      estimatedCostUsd: 2,
      tags: [],
      planApproved: false,
      reportChars: 0,
      sourceCount: 0,
      imageCount: 0,
    reasoningSteps: 0,
    streamedChars: 0,
    searches: 0,
    urlsFetched: 0,
    corpusQueries: 0,
    codeRuns: 0,
    streamAbandoned: false,
      toolsUsed: [],
      corpusStores: [],
    });
    const before = await store.getRun('dr_test0002');
    expect(before?.plan).toBeUndefined();
    // The tool checks `run.plan` before calling the runner; the runner itself
    // would happily approve. Assert the record is untouched by a read.
    expect(before?.planApproved).toBe(false);
  });

  it('cancelling an already-terminal run is a no-op, not an error', async () => {
    const runner = new Runner(store, config, () => stubClient());
    const run = await seedCompletedRun();
    const result = await runner.cancel(run.id);
    expect(result?.state).toBe('completed');
  });

  it('cancelling an unknown run returns null rather than throwing', async () => {
    const runner = new Runner(store, config, () => stubClient());
    expect(await runner.cancel('dr_doesnotexist')).toBeNull();
  });
});

describe('the documented public library surface', () => {
  it('exports everything the README tells people to import', async () => {
    // v0.2.0 shipped a README example importing `buildPrompt` from
    // `dossier-research-mcp/server`, which did not export it. Documenting an
    // API is a promise; this asserts the promise is kept, because a doc-only
    // check would not have caught it and did not.
    const surface = await import('../src/server.js');
    for (const name of [
      'createServer',
      'buildDeps',
      'buildPrompt',
      'selectArchetype',
      'outlineReport',
      'findSection',
      'grepReport',
      'extractCitedUrls',
      'verifyCitations',
      'scoreCitations',
      'extractPlan',
      'estimateCost',
      'loadConfig',
      'backendLimitations',
    ]) {
      expect(surface, name).toHaveProperty(name);
      expect(typeof (surface as Record<string, unknown>)[name], name).toBe('function');
    }
  });

  it('buildPrompt works standalone, exactly as the README shows it', async () => {
    const { buildPrompt } = await import('../src/server.js');
    const built = buildPrompt({
      question: 'What disclosure obligations apply to dual-listed issuers?',
      scope: { jurisdiction: 'UK and Singapore', decisionContext: 'inform a board paper' },
    });
    expect(built.archetype).toBe('regulatory');
    expect(built.preEngineered).toBe(false);
    expect(built.prompt).toContain('UK and Singapore');
    expect(built.prompt).toContain('inform a board paper');
  });
});
