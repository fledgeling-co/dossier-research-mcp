import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import type { CreateRunArgs, DeepResearchClient } from '../src/gemini/client.js';
import type { InteractionSnapshot } from '../src/gemini/types.js';
import { BudgetExceededError, ConcurrencyExceededError, Runner } from '../src/research/runner.js';
import { Store } from '../src/store/store.js';

/**
 * A scripted client: successive `getRun` calls walk a fixed list of snapshots
 * and hold on the last one. No network, fully deterministic.
 */
function scriptedClient(states: InteractionSnapshot[]): DeepResearchClient & { created: CreateRunArgs[] } {
  const calls = new Map<string, number>();
  const created: CreateRunArgs[] = [];
  let seq = 0;
  return {
    created,
    async createRun(args) {
      created.push(args);
      const id = `int_${(seq += 1)}`;
      calls.set(id, 0);
      return { interactionId: id, status: 'in_progress', markdown: '', thoughts: [], images: [] };
    },
    async getRun(interactionId) {
      const i = calls.get(interactionId) ?? 0;
      calls.set(interactionId, i + 1);
      const state = states[Math.min(i, states.length - 1)];
      return { ...(state as InteractionSnapshot), interactionId };
    },
    async cancelRun() {
      /* no-op */
    },
    async followUp() {
      return 'follow-up answer';
    },
  };
}

const snapshot = (over: Partial<InteractionSnapshot>): InteractionSnapshot => ({
  interactionId: 'int_1',
  status: 'in_progress',
  markdown: '',
  thoughts: [],
  images: [],
  ...over,
});

const START = {
  question: 'Who leads the market?',
  prompt: '<core_directive>Answer this decisively: who leads the market?</core_directive>',
  archetype: 'competitive' as const,
  tier: 'fast' as const,
  tools: [{ type: 'google_search' as const }],
  collaborativePlanning: false,
  thinkingSummaries: true,
  visualization: true,
  preEngineered: false,
};

let dir: string;
let store: Store;
let config: Config;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drmcp-'));
  store = new Store(dir);
  await store.init();
  config = { ...loadConfig({ DOSSIER_HERMETIC: '1' }), storeDir: dir };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('start', () => {
  it('persists the run and commits the estimated cost to the ledger', async () => {
    const runner = new Runner(store, config, scriptedClient([snapshot({})]));
    const { run, deduped } = await runner.start(START);

    expect(deduped).toBe(false);
    expect(run.state).toBe('running');
    expect(run.estimatedCostUsd).toBe(2); // fast band $1-3, midpoint

    const reloaded = await store.getRun(run.id);
    expect(reloaded?.id).toBe(run.id);

    const budget = await runner.budget();
    expect(budget.committedUsd).toBe(2);
  });

  it('de-duplicates an identical request onto the existing run', async () => {
    const client = scriptedClient([snapshot({})]);
    const runner = new Runner(store, config, client);
    const first = await runner.start(START);
    const second = await runner.start(START);

    expect(second.deduped).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    // The decisive assertion: only ONE paid interaction was created.
    expect(client.created).toHaveLength(1);
    expect((await runner.budget()).committedUsd).toBe(2);
  });

  it('does not de-duplicate across tiers — they are different purchases', async () => {
    const client = scriptedClient([snapshot({})]);
    const runner = new Runner(store, config, client);
    await runner.start(START);
    const second = await runner.start({ ...START, tier: 'max' });
    expect(second.deduped).toBe(false);
    expect(client.created).toHaveLength(2);
  });

  it('refuses a run that would cross the budget ceiling', async () => {
    const tight = { ...config, budgetUsd: 3 };
    const runner = new Runner(store, tight, scriptedClient([snapshot({})]));
    await runner.start(START);
    await expect(runner.start({ ...START, question: 'a different question', prompt: 'different' })).rejects.toThrow(
      BudgetExceededError,
    );
  });

  it('refuses a run beyond the concurrency cap', async () => {
    const capped = { ...config, maxConcurrent: 1 };
    const runner = new Runner(store, capped, scriptedClient([snapshot({})]));
    await runner.start(START);
    await expect(runner.start({ ...START, question: 'another', prompt: 'another prompt' })).rejects.toThrow(
      ConcurrencyExceededError,
    );
  });

  it('marks the run failed and journals the error when the API rejects it', async () => {
    const failing: DeepResearchClient = {
      async createRun() {
        throw new Error('quota exhausted');
      },
      async getRun() {
        return snapshot({});
      },
      async cancelRun() {},
      async followUp() {
        return '';
      },
    };
    const runner = new Runner(store, config, failing);
    await expect(runner.start(START)).rejects.toThrow('quota exhausted');

    const runs = await store.listRuns();
    expect(runs[0]?.state).toBe('failed');
    expect(runs[0]?.error).toContain('quota exhausted');
  });
});

describe('lifecycle', () => {
  it('completes: writes the report, counts sources, journals it', async () => {
    const markdown = '## Executive Summary\n\n- A leads. <cite url="https://a.test/x">src</cite>\n';
    const runner = new Runner(store, config, scriptedClient([snapshot({ status: 'completed', markdown })]));
    const { run } = await runner.start(START);
    const advanced = await runner.refresh(run.id);

    expect(advanced?.state).toBe('completed');
    expect(advanced?.sourceCount).toBe(1);
    expect(advanced?.completedAt).toBeTruthy();

    const stored = await store.readReport(run.id);
    // Citation tags are normalised to markdown links on the way to disk.
    expect(stored).toContain('[src](https://a.test/x)');

    const journal = await store.readJournal(run.id);
    expect(journal.some((e) => e.kind === 'completed')).toBe(true);
  });

  it('is idempotent — refreshing a completed run does not re-finalise it', async () => {
    const runner = new Runner(store, config, scriptedClient([snapshot({ status: 'completed', markdown: '# R' })]));
    const { run } = await runner.start(START);
    await runner.refresh(run.id);
    const before = await store.readJournal(run.id);
    await runner.refresh(run.id);
    const after = await store.readJournal(run.id);
    expect(after.filter((e) => e.kind === 'completed')).toHaveLength(
      before.filter((e) => e.kind === 'completed').length,
    );
  });

  it('records failure with the reported reason', async () => {
    const runner = new Runner(store, config, scriptedClient([snapshot({ status: 'failed', error: 'upstream 500' })]));
    const { run } = await runner.start(START);
    const advanced = await runner.refresh(run.id);
    expect(advanced?.state).toBe('failed');
    expect(advanced?.error).toBe('upstream 500');
  });

  it('holds a collaborative-planning run for approval, then releases it', async () => {
    const client = scriptedClient([snapshot({ status: 'completed', markdown: 'Proposed plan: 3 subtopics.' })]);
    const runner = new Runner(store, config, client);
    const { run } = await runner.start({ ...START, collaborativePlanning: true });
    expect(run.state).toBe('planning');

    const planned = await runner.refresh(run.id);
    expect(planned?.plan).toContain('Proposed plan');
    expect(planned?.planApproved).toBe(false);

    // A tick must not advance an unapproved plan — that is the spend gate.
    await runner.tick();
    expect((await store.getRun(run.id))?.state).toBe('planning');

    const approved = await runner.approvePlan(run.id, 'Also cover pricing.');
    expect(approved?.planApproved).toBe(true);
    const journal = await store.readJournal(run.id);
    expect(journal.some((e) => e.message.includes('Also cover pricing.'))).toBe(true);
  });

  it('marks a silent run stalled, and recovers it on the next delta', async () => {
    const impatient = { ...config, stallMinutes: 1 };
    const runner = new Runner(store, impatient, scriptedClient([snapshot({}), snapshot({ thoughts: ['still going'] })]));
    const { run } = await runner.start(START);

    // Backdate progress past the watchdog window.
    const stale = await store.getRun(run.id);
    expect(stale).not.toBeNull();
    await store.saveRun({
      ...stale!,
      lastProgressAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });

    const stalled = await runner.refresh(run.id);
    expect(stalled?.state).toBe('stalled');

    const recovered = await runner.refresh(run.id);
    expect(recovered?.state).toBe('running');
  });

  it('cancels an in-flight run and keeps the committed spend on the ledger', async () => {
    const runner = new Runner(store, config, scriptedClient([snapshot({})]));
    const { run } = await runner.start(START);
    const cancelled = await runner.cancel(run.id);
    expect(cancelled?.state).toBe('cancelled');
    expect((await runner.budget()).committedUsd).toBe(2);
  });
});

describe('durability', () => {
  it('a new Runner over the same store resumes an in-flight run', async () => {
    const first = new Runner(store, config, scriptedClient([snapshot({})]));
    const { run } = await first.start(START);

    // Simulate a process restart: fresh Store + Runner, same directory.
    const reopened = new Store(dir);
    const second = new Runner(
      reopened,
      config,
      scriptedClient([snapshot({ status: 'completed', markdown: '# Recovered' })]),
    );
    const active = await reopened.activeRuns();
    expect(active.map((r) => r.id)).toContain(run.id);

    await second.tick();
    expect((await reopened.getRun(run.id))?.state).toBe('completed');
  });

  it('replays the journal by cursor', async () => {
    const runner = new Runner(store, config, scriptedClient([snapshot({ thoughts: ['searching'] })]));
    const { run } = await runner.start(START);
    await runner.refresh(run.id);

    const all = await store.readJournal(run.id);
    expect(all.length).toBeGreaterThan(1);
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i));

    const tail = await store.readJournal(run.id, all[0]!.seq);
    expect(tail).toHaveLength(all.length - 1);
  });

  it('skips a corrupt record instead of failing the whole listing', async () => {
    const runner = new Runner(store, config, scriptedClient([snapshot({})]));
    const { run } = await runner.start(START);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'runs', 'corrupt.json'), '{ not json', 'utf8');

    const runs = await store.listRuns();
    expect(runs.map((r) => r.id)).toEqual([run.id]);
  });
});
