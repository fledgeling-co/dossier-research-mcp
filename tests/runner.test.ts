import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import type { CreateRunArgs, DeepResearchClient } from '../src/gemini/client.js';
import type { InteractionSnapshot } from '../src/gemini/types.js';
import { AmbiguousSpendError } from '../src/net/retry.js';
import {
  BudgetExceededError,
  ConcurrencyExceededError,
  describeRun,
  Runner,
  stateHint,
} from '../src/research/runner.js';
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

  // REPEAT-05. The end-to-end form of the defect BENCH-01 found: five repeats
  // of one task on one backend must be five paid interactions, and the
  // protection dedupe exists for must survive intact beside it.
  it('REPEAT-05: n repeats are n paid runs, while an identical request still dedupes', async () => {
    const client = scriptedClient([snapshot({})]);
    const runner = new Runner(store, { ...config, budgetUsd: 1000 }, () => client);

    for (const repeat of [1, 2, 3, 4, 5]) {
      const result = await runner.start({ ...START, repeat });
      expect(result.deduped, `repeat ${String(repeat)}`).toBe(false);
    }
    expect(client.created).toHaveLength(5);

    // An agent stuck in a retry loop passes the same arguments every time,
    // including this one, and must still collapse onto the run it already
    // bought. This is why the fix is an expressible index and not a nonce.
    const again = await runner.start({ ...START, repeat: 3 });
    expect(again.deduped).toBe(true);
    expect(client.created).toHaveLength(5);

    // And a bench cell never collides with an ordinary ad-hoc run of the same
    // question, because the bench counts from 1 and an ordinary run sends none.
    const adhoc = await runner.start(START);
    expect(adhoc.deduped).toBe(false);
    expect(client.created).toHaveLength(6);
  });

  // REPEAT-06. Hashing it is not enough: a resumed batch has to be able to tell
  // which of five repetitions a stored run was, an hour later.
  it('REPEAT-06: the repetition index is stored on the run record', async () => {
    const runner = new Runner(store, config, () => scriptedClient([snapshot({})]));
    const { run } = await runner.start({ ...START, repeat: 4 });
    expect(run.repeat).toBe(4);

    const reread = await store.getRun(run.id);
    expect(reread?.repeat).toBe(4);

    // Absent on an ordinary run, so nothing already stored gains a field.
    const plain = await runner.start({ ...START, tier: 'max' });
    expect(plain.run.repeat).toBeUndefined();
  });

  // REPEAT-07. `NaN` is falsy, so the first version of this threading used a
  // truthiness test and SILENTLY DROPPED a malformed repetition index, letting
  // it dedupe onto the no-repeat purchase. That is the exact collapse the field
  // exists to prevent, arriving through the guard meant to stop it. Found by an
  // out-of-family review.
  it('REPEAT-07: a malformed repetition index is refused at the runner, not dropped', async () => {
    const client = scriptedClient([snapshot({})]);
    const runner = new Runner(store, config, () => client);
    await runner.start(START);
    expect(client.created).toHaveLength(1);

    for (const bad of [Number.NaN, -1, 1.5]) {
      await expect(runner.start({ ...START, repeat: bad }), String(bad)).rejects.toThrow(
        /repeat must be a non-negative integer/,
      );
    }
    // Nothing was bought by any of them.
    expect(client.created).toHaveLength(1);
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

  it('records failure with the reported reason, and says which kind of failure it was', async () => {
    const runner = new Runner(store, config, () => scriptedClient([snapshot({ status: 'failed', error: 'upstream 500' })]));
    const { run } = await runner.start(START);
    const advanced = await runner.refresh(run.id);
    expect(advanced?.state).toBe('failed');
    // The upstream text first and verbatim, then what it means. A run that
    // started and then failed is failed research, not a broken adapter.
    expect(advanced?.error).toContain('upstream 500');
    expect(advanced?.failureKind).toBe('research');
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

  // CLI-20, the store half. Every CLI got its own provider id, so `local` stopped
  // being the id of anything. Records and ledger lines written before that carry
  // it, and dropping it from the enum would make each of them fail its parse and
  // then vanish, which is the same silent history loss as above.
  it('still parses a record and a ledger line that carry the pre-split `local` id', async () => {
    const { writeFile, mkdir, appendFile } = await import('node:fs/promises');
    await mkdir(join(dir, 'runs'), { recursive: true });
    const legacy = {
      id: 'dr_legacylocal',
      interactionId: 'loc_old',
      provider: 'local',
      state: 'completed',
      tier: 'fast',
      archetype: 'technical',
      question: 'q',
      prompt: 'p',
      promptWasPreEngineered: false,
      fingerprint: 'fp2',
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
      lastProgressAt: '2026-07-25T00:00:00.000Z',
      estimatedCostUsd: 0,
      tags: [],
      planApproved: true,
      reportChars: 10,
      sourceCount: 0,
      imageCount: 0,
      toolsUsed: [],
      corpusStores: [],
    };
    await writeFile(join(dir, 'runs', 'dr_legacylocal.json'), JSON.stringify(legacy));
    await appendFile(
      join(dir, 'ledger.jsonl'),
      `${JSON.stringify({
        runId: 'dr_legacylocal',
        provider: 'local',
        tier: 'fast',
        estimatedCostUsd: 0,
        at: '2026-07-25T00:00:00.000Z',
      })}\n`,
    );

    expect((await store.getRun('dr_legacylocal'))?.provider, 'a pre-split record must still parse').toBe('local');
    expect((await store.listRuns()).map((r) => r.id)).toContain('dr_legacylocal');
    // The ledger is read for the spend gate, so a line that fails to parse is
    // counted at worst case rather than skipped. It has to still be readable.
    expect((await store.readLedger()).map((e) => e.runId)).toContain('dr_legacylocal');
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

/**
 * Failure kinds, and giving money back for a request that never reached a model.
 *
 * Two shipped defects meet here. Every failure rendered as the single word
 * `failed`, so a `local-codex` adapter that could never have worked looked
 * exactly like a hard research question. And the budget commitment, written
 * before the paid call on purpose so a crash over-counts, was held even when
 * the provider had answered "no": two of the owner's OpenAI runs held $9 each
 * against 429s that were refused in about a second.
 */
describe('failure classification and the compensating release', () => {
  /** A client whose create throws whatever it is handed. */
  const refusing = (thrown: unknown): DeepResearchClient => ({
    createRun() {
      throw thrown;
    },
    async getRun(interactionId) {
      return { interactionId, status: 'in_progress', markdown: '', thoughts: [], images: [] };
    },
    async cancelRun() {
      /* no-op */
    },
    async followUp() {
      return '';
    },
  });

  const httpError = (status: number, message: string): unknown =>
    Object.assign(new Error(message), { status });

  it('FAIL-03/BUDGET-04: a 429 is labelled rate-limited and its commitment is released', async () => {
    const upstream =
      'OpenAI 429: Rate limit reached for gpt-5.6-sol on tokens per min (TPM): Limit 1000000, Used 923902, Requested 96709. Please try again in 1.236s.';
    const runner = new Runner(store, config, () => refusing(httpError(429, upstream)));
    await expect(runner.start(START)).rejects.toThrow(/429/);

    const runs = await store.listRuns();
    const failed = runs[0];
    expect(failed?.state).toBe('failed');
    expect(failed?.failureKind).toBe('rate-limited');
    expect(failed?.failureStatus).toBe(429);
    // FAIL-02: the provider's own words, kept verbatim on the record rather
    // than replaced by a paraphrase.
    expect(failed?.error).toContain('Used 923902');
    expect(failed?.error).toContain('Rate limited by the provider');

    // The money is back. $9 held against a call that never reached a model was
    // the whole cost of this bug.
    expect(failed?.budgetReleased).toBe(true);
    expect((await runner.budget()).committedUsd).toBe(0);
  });

  it('BUDGET-04: releases by APPENDING a compensating line, never by editing history', async () => {
    const runner = new Runner(store, config, () => refusing(httpError(429, 'OpenAI 429: slow down')));
    await expect(runner.start(START)).rejects.toThrow();

    const entries = await store.readLedger();
    // Both lines are there: what we reserved, and what we gave back. A ledger
    // that quietly loses the reservation cannot answer "what happened".
    expect(entries).toHaveLength(2);
    expect(entries[0]?.kind).toBeUndefined(); // a reservation, written as it always was
    expect(entries[0]?.estimatedCostUsd).toBe(3);
    expect(entries[1]?.kind).toBe('release');
    expect(entries[1]?.estimatedCostUsd).toBe(3);
    expect(entries[1]?.runId).toBe(entries[0]?.runId);
    expect(entries[1]?.reason).toMatch(/refused/);
  });

  it('BUDGET-04: 400, 401 and 403 release too, since nothing was created', async () => {
    for (const status of [400, 401, 403]) {
      const fresh = await mkdtemp(join(tmpdir(), 'drmcp-'));
      const s = new Store(fresh);
      await s.init();
      const runner = new Runner(s, { ...config, storeDir: fresh }, () =>
        refusing(httpError(status, `refused ${String(status)}`)),
      );
      await expect(runner.start(START)).rejects.toThrow();
      const failed = (await s.listRuns())[0];
      expect(failed?.failureKind, String(status)).toBe('provider-rejected');
      expect((await runner.budget()).committedUsd, String(status)).toBe(0);
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it('BUDGET-05: an ambiguous failure KEEPS its commitment', async () => {
    // The provider may have accepted this and may be billing for it right now.
    // Releasing here would under-count spend, which is the one direction a
    // ceiling must never fail.
    const runner = new Runner(store, config, () =>
      refusing(new AmbiguousSpendError('OpenAI', new Error('socket hang up'))),
    );
    await expect(runner.start(START)).rejects.toThrow(AmbiguousSpendError);

    const failed = (await store.listRuns())[0];
    expect(failed?.failureKind).toBe('ambiguous');
    expect(failed?.budgetReleased).toBeFalsy();
    expect((await runner.budget()).committedUsd).toBe(3);
    expect(failed?.error).toContain('may have accepted');
  });

  it('BUDGET-05: a 5xx and a timeout keep it too', async () => {
    for (const thrown of [httpError(503, 'upstream boom'), Object.assign(new Error('t'), { name: 'TimeoutError' })]) {
      const fresh = await mkdtemp(join(tmpdir(), 'drmcp-'));
      const s = new Store(fresh);
      await s.init();
      const runner = new Runner(s, { ...config, storeDir: fresh }, () => refusing(thrown));
      await expect(runner.start(START)).rejects.toThrow();
      expect((await runner.budget()).committedUsd, String(thrown)).toBe(3);
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it('BUDGET-06: a release can never give back more than its run reserved', async () => {
    // The reason releases are a separate KIND rather than a negative amount:
    // a negative amount has no natural ceiling, so one hand-edited ledger line
    // would hand anyone an unlimited budget.
    const entries = [
      { at: 'a', runId: 'r1', tier: 'fast' as const, estimatedCostUsd: 3, provider: 'openai' as const },
      { at: 'b', runId: 'r1', tier: 'fast' as const, estimatedCostUsd: 3, provider: 'openai' as const, kind: 'release' as const },
      // Forged, duplicated, or replayed. None of them may lower the total.
      { at: 'c', runId: 'r1', tier: 'fast' as const, estimatedCostUsd: 9999, provider: 'openai' as const, kind: 'release' as const },
      { at: 'd', runId: 'r2', tier: 'max' as const, estimatedCostUsd: 7, provider: 'gemini' as const },
      { at: 'e', runId: 'ghost', tier: 'max' as const, estimatedCostUsd: 500, provider: 'gemini' as const, kind: 'release' as const },
    ];
    expect(Store.netCommittedUsd(entries)).toBe(7);
    // And an absent `kind` is a reservation, which is what every line written
    // before releases existed is.
    expect(Store.netCommittedUsd([entries[0]!])).toBe(3);
  });

  it('BUDGET-04: releasing is idempotent, so a repeat cannot give the money back twice', async () => {
    const runner = new Runner(store, config, () => refusing(httpError(429, 'OpenAI 429: slow down')));
    await expect(runner.start(START)).rejects.toThrow();
    const failed = (await store.listRuns())[0];
    expect(failed?.budgetReleased).toBe(true);

    // A second identical request is a new run with its own reservation; the
    // first run's release must not compound onto it.
    await expect(runner.start({ ...START, question: 'another', prompt: 'another' })).rejects.toThrow();
    expect((await runner.budget()).committedUsd).toBe(0);
    const releases = (await store.readLedger()).filter((e) => e.kind === 'release');
    expect(releases).toHaveLength(2);
    expect(new Set(releases.map((r) => r.runId)).size).toBe(2);
  });

  it('BUDGET-04: a release is a correction, not a second run in the window', async () => {
    // `runsInWindow` counts what ran. A release line is a correction to a
    // reservation already counted, so counting it would report two runs for
    // one refused request, and `research_budget` would list a refunded $3 as
    // a $3 commitment.
    const runner = new Runner(store, config, () => refusing(httpError(429, 'OpenAI 429: slow down')));
    await expect(runner.start(START)).rejects.toThrow();
    const budget = await runner.budget();
    expect(budget.runsInWindow).toBe(1);
    expect(budget.committedUsd).toBe(0);
    expect(budget.remainingUsd).toBe(budget.budgetUsd);
  });

  it('FAIL-01: an argument-parse refusal from a CLI is a broken adapter, not failed research', async () => {
    // Exactly the shipped `local-codex` failure, arriving the way the local
    // backend reports it: the run started, the binary refused the argv, and the
    // transcript is the parser's complaint.
    const runner = new Runner(store, config, () =>
      scriptedClient([
        snapshot({
          status: 'failed',
          error: "`codex` refused the invocation Dossier built: error: unexpected argument '--search' found",
        }),
      ]),
    );
    const { run } = await runner.start(START);
    const advanced = await runner.refresh(run.id);
    expect(advanced?.failureKind).toBe('adapter-rejected');
    expect(advanced?.error).toContain('THE ADAPTER IS BROKEN');
    expect(describeRun(advanced!)).toContain('BROKEN ADAPTER');
  });

  it('FAIL-01: the adapter’s own verdict is honoured over text matching', async () => {
    const runner = new Runner(store, config, () =>
      scriptedClient([snapshot({ status: 'failed', error: 'ran out of context', failureKind: 'adapter-rejected' })]),
    );
    const { run } = await runner.start(START);
    expect((await runner.refresh(run.id))?.failureKind).toBe('adapter-rejected');
  });

  it('FAIL-01: stateHint says what to do, and it differs by kind', () => {
    expect(stateHint('failed', 'adapter-rejected')).toMatch(/ADAPTER IS BROKEN/);
    expect(stateHint('failed', 'rate-limited', 429)).toMatch(/HTTP 429/);
    expect(stateHint('failed', 'ambiguous')).toMatch(/UNKNOWN/);
    // An unclassified failure keeps exactly the wording it always had, rather
    // than being labelled with a guess.
    expect(stateHint('failed')).toMatch(/The error is on the record/);
  });

  describe('titling is paid for once', () => {
    it('marks a run terminal before the summariser runs, not after', async () => {
      // A real money defect, found by auditing a real ledger: one run was
      // titled 23 times in 64 seconds, 49 of 67 runs more than once, and $17
      // of $22 of utility spend was this.
      //
      // The cause was ordering. `onFinalise` reserves and then waits on a
      // model, and the record was saved only afterwards, so for those seconds
      // the run was still `running` on disk. `refresh` guards terminal runs
      // correctly — it just had nothing to read yet, so every concurrent poll
      // re-entered and re-reserved.
      //
      // Asserted by holding the summariser open and polling underneath it,
      // which is exactly what a second MCP client does.
      let release: (() => void) | undefined;
      const held = new Promise<void>((r) => {
        release = r;
      });
      let calls = 0;

      const client = scriptedClient([snapshot({ status: 'completed', markdown: '# Title\n\nBody.' })]);
      const runner = new Runner(store, config, () => client, async () => {
        calls += 1;
        await held;
      });
      const { run } = await runner.start(START);

      const first = runner.refresh(run.id);
      // Let the first poll reach the held summariser.
      await new Promise((r) => setTimeout(r, 20));
      // Three more polls while it is still in there.
      await Promise.all([runner.refresh(run.id), runner.refresh(run.id), runner.refresh(run.id)]);
      release?.();
      await first;

      expect(calls, 'the summariser must be entered once, not once per concurrent poll').toBe(1);
      expect((await store.getRun(run.id))?.state).toBe('completed');
    });
  });

  describe('a run cancelled upstream', () => {
    it('is terminal, not stalled', async () => {
      // The live API returns `cancelled` and the status enum did not contain
      // it, so it fell through `.catch('unknown')` and the run was marked
      // stalled with "may still be executing and billing". Observed on a real
      // $7 run that had been over for hours: the watchdog kept polling it and
      // the caller was told it might still recover.
      const client = scriptedClient([snapshot({ status: 'cancelled' })]);
      const runner = new Runner(store, config, () => client);
      const { run } = await runner.start(START);
      const after = await runner.refresh(run.id);
      expect(after?.state).toBe('cancelled');
      expect(after?.error).toMatch(/cancelled/i);
    });

    it('is not polled again once it is cancelled', async () => {
      const client = scriptedClient([snapshot({ status: 'cancelled' })]);
      const runner = new Runner(store, config, () => client);
      const { run } = await runner.start(START);
      await runner.refresh(run.id);
      const again = await runner.refresh(run.id);
      expect(again?.state).toBe('cancelled');
    });
  });
});
