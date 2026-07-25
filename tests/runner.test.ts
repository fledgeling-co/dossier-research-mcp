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
    const runner = new Runner(store, config, () => scriptedClient([snapshot({})]));
    const { run, deduped } = await runner.start(START);

    expect(deduped).toBe(false);
    expect(run.state).toBe('running');
    // Reserves the worst case, not the midpoint: a ceiling that reserves an
    // average lets the expensive tail overshoot it.
    expect(run.estimatedCostUsd).toBe(3); // fast band $1-3, high end

    const reloaded = await store.getRun(run.id);
    expect(reloaded?.id).toBe(run.id);

    const budget = await runner.budget();
    expect(budget.committedUsd).toBe(3);
  });

  it('de-duplicates an identical request onto the existing run', async () => {
    const client = scriptedClient([snapshot({})]);
    const runner = new Runner(store, config, () => client);
    const first = await runner.start(START);
    const second = await runner.start(START);

    expect(second.deduped).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    // The decisive assertion: only ONE paid interaction was created.
    expect(client.created).toHaveLength(1);
    expect((await runner.budget()).committedUsd).toBe(3);
  });

  it('does not de-duplicate across tiers — they are different purchases', async () => {
    const client = scriptedClient([snapshot({})]);
    const runner = new Runner(store, config, () => client);
    await runner.start(START);
    const second = await runner.start({ ...START, tier: 'max' });
    expect(second.deduped).toBe(false);
    expect(client.created).toHaveLength(2);
  });

  it('refuses a run that would cross the budget ceiling', async () => {
    const tight = { ...config, budgetUsd: 3 };
    const runner = new Runner(store, tight, () => scriptedClient([snapshot({})]));
    await runner.start(START);
    await expect(runner.start({ ...START, question: 'a different question', prompt: 'different' })).rejects.toThrow(
      BudgetExceededError,
    );
  });

  it('refuses a run beyond the concurrency cap', async () => {
    const capped = { ...config, maxConcurrent: 1 };
    const runner = new Runner(store, capped, () => scriptedClient([snapshot({})]));
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
    const runner = new Runner(store, config, () => failing);
    await expect(runner.start(START)).rejects.toThrow('quota exhausted');

    const runs = await store.listRuns();
    expect(runs[0]?.state).toBe('failed');
    expect(runs[0]?.error).toContain('quota exhausted');
  });
});

describe('lifecycle', () => {
  it('completes: writes the report, counts sources, journals it', async () => {
    const markdown = '## Executive Summary\n\n- A leads. <cite url="https://a.test/x">src</cite>\n';
    const runner = new Runner(store, config, () => scriptedClient([snapshot({ status: 'completed', markdown })]));
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
    const runner = new Runner(store, config, () => scriptedClient([snapshot({ status: 'completed', markdown: '# R' })]));
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
    const runner = new Runner(store, config, () => scriptedClient([snapshot({ status: 'failed', error: 'upstream 500' })]));
    const { run } = await runner.start(START);
    const advanced = await runner.refresh(run.id);
    expect(advanced?.state).toBe('failed');
    expect(advanced?.error).toBe('upstream 500');
  });

  it('holds a collaborative-planning run for approval, then releases it', async () => {
    const client = scriptedClient([snapshot({ status: 'completed', markdown: 'Proposed plan: 3 subtopics.' })]);
    const runner = new Runner(store, config, () => client);
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
    const runner = new Runner(store, impatient, () => scriptedClient([snapshot({}), snapshot({ thoughts: ['still going'] })]));
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
    const runner = new Runner(store, config, () => scriptedClient([snapshot({})]));
    const { run } = await runner.start(START);
    const cancelled = await runner.cancel(run.id);
    expect(cancelled?.state).toBe('cancelled');
    expect((await runner.budget()).committedUsd).toBe(3);
  });
});

describe('durability', () => {
  it('a new Runner over the same store resumes an in-flight run', async () => {
    const first = new Runner(store, config, () => scriptedClient([snapshot({})]));
    const { run } = await first.start(START);

    // Simulate a process restart: fresh Store + Runner, same directory.
    const reopened = new Store(dir);
    const second = new Runner(
      reopened,
      config,
      () => scriptedClient([snapshot({ status: 'completed', markdown: '# Recovered' })]),
    );
    const active = await reopened.activeRuns();
    expect(active.map((r) => r.id)).toContain(run.id);

    await second.tick();
    expect((await reopened.getRun(run.id))?.state).toBe('completed');
  });

  it('replays the journal by cursor', async () => {
    const runner = new Runner(store, config, () => scriptedClient([snapshot({ thoughts: ['searching'] })]));
    const { run } = await runner.start(START);
    await runner.refresh(run.id);

    const all = await store.readJournal(run.id);
    expect(all.length).toBeGreaterThan(1);
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i));

    const tail = await store.readJournal(run.id, all[0]!.seq);
    expect(tail).toHaveLength(all.length - 1);
  });

  it('skips a corrupt record instead of failing the whole listing', async () => {
    const runner = new Runner(store, config, () => scriptedClient([snapshot({})]));
    const { run } = await runner.start(START);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'runs', 'corrupt.json'), '{ not json', 'utf8');

    const runs = await store.listRuns();
    expect(runs.map((r) => r.id)).toEqual([run.id]);
  });
});

describe('store schema backward compatibility', () => {
  it('reads a record written by an older version, defaulting the new fields', async () => {
    // The store is on disk and survives upgrades, so every field added to
    // RunRecordSchema is a migration. A record written before the streaming
    // fields existed must still parse, or an upgrade silently loses a user's
    // whole run history: `getRun` returns null on a parse failure and
    // `listRuns` skips it, so the failure mode is disappearance, not an error.
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'runs'), { recursive: true });
    const legacy = {
      id: 'dr_legacy00001',
      interactionId: 'int_old',
      state: 'completed',
      tier: 'fast',
      archetype: 'technical',
      question: 'q',
      prompt: 'p',
      promptWasPreEngineered: false,
      fingerprint: 'fp',
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
      lastProgressAt: '2026-07-25T00:00:00.000Z',
      completedAt: '2026-07-25T00:10:00.000Z',
      estimatedCostUsd: 2,
      tags: [],
      planApproved: true,
      reportChars: 1200,
      sourceCount: 30,
      imageCount: 0,
      toolsUsed: ['google_search'],
      corpusStores: [],
    };
    await writeFile(join(dir, 'runs', 'dr_legacy00001.json'), JSON.stringify(legacy));

    const read = await store.getRun('dr_legacy00001');
    expect(read, 'a pre-upgrade record must still parse').not.toBeNull();
    expect(read?.sourceCount).toBe(30);
    // Fields added since default rather than failing the parse.
    expect(read?.reasoningSteps).toBe(0);
    expect(read?.streamedChars).toBe(0);
    expect(read?.streamAbandoned).toBe(false);
    // And it is still visible in the index, which is where disappearance shows.
    expect((await store.listRuns()).map((r) => r.id)).toContain('dr_legacy00001');
  });
});

describe('spend gate hardening', () => {
  it('closes the concurrent-start race: parallel calls cannot all pass the gate', async () => {
    // The original gate was a sequence of awaited disk reads with nothing
    // serialising them, so N concurrent starts each read headroom before any
    // wrote its ledger entry and all N proceeded. Agents make parallel tool
    // calls routinely, so this was a real over-spend hole.
    const capped = { ...config, maxConcurrent: 2, budgetUsd: 1000 };
    const client = scriptedClient([snapshot({})]);
    const runner = new Runner(store, capped, () => client);

    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        runner.start({ ...START, question: `distinct question ${i}`, prompt: `distinct prompt ${i}` }),
      ),
    );
    const started = attempts.filter((a) => a.status === 'fulfilled').length;

    // Exactly the cap, not the cap plus whatever slipped through.
    expect(started).toBe(2);
    expect(client.created).toHaveLength(2);
    expect((await store.activeRuns()).length).toBe(2);
  });

  it('closes the budget race too: parallel calls cannot overshoot the ceiling', async () => {
    // Budget for exactly two fast runs at the reserved (worst-case) $3.
    const tight = { ...config, maxConcurrent: 64, budgetUsd: 6 };
    const client = scriptedClient([snapshot({})]);
    const runner = new Runner(store, tight, () => client);

    await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        runner.start({ ...START, question: `q${i}`, prompt: `p${i}` }),
      ),
    );

    const budget = await runner.budget();
    expect(budget.committedUsd).toBeLessThanOrEqual(6);
    expect(client.created.length).toBeLessThanOrEqual(2);
  });

  it('reserves the worst case, not the midpoint', async () => {
    const runner = new Runner(store, config, () => scriptedClient([snapshot({})]));
    const { run } = await runner.start({ ...START, tier: 'max' });
    // A max run is $3-7. Reserving the $5 midpoint would let a run that costs
    // $7 overshoot; a ceiling that overshoots is not a ceiling.
    expect(run.estimatedCostUsd).toBe(7);
    expect((await runner.budget()).committedUsd).toBe(7);
  });

  it('gates a non-research spend against the same ceiling', async () => {
    const tight = { ...config, budgetUsd: 1 };
    const runner = new Runner(store, tight, () => scriptedClient([snapshot({})]));
    // agent_run was previously ungated entirely: no check, no ledger, no cap.
    await expect(runner.reserveNonResearchSpend('agent_run:x')).rejects.toThrow(BudgetExceededError);
  });

  it('counts a non-research spend on the ledger so it is visible', async () => {
    const runner = new Runner(store, config, () => scriptedClient([snapshot({})]));
    await runner.reserveNonResearchSpend('agent_run:analyst');
    const budget = await runner.budget();
    expect(budget.committedUsd).toBeGreaterThan(0);
    expect(budget.runsInWindow).toBe(1);
  });

  it('a failed reservation does not wedge the queue for later callers', async () => {
    const tight = { ...config, budgetUsd: 3 };
    const runner = new Runner(store, tight, () => scriptedClient([snapshot({})]));
    await runner.start(START);
    // Second one is refused...
    await expect(runner.start({ ...START, question: 'another', prompt: 'another' })).rejects.toThrow(
      BudgetExceededError,
    );
    // ...and the lock still works afterwards, rather than deadlocking.
    expect((await runner.budget()).committedUsd).toBe(3);
  });
});
