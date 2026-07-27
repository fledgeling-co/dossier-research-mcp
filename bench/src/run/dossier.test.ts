import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../../../src/config.js';
import type { DeepResearchClient } from '../../../src/gemini/client.js';
import type { InteractionSnapshot } from '../../../src/gemini/types.js';
import { Runner, type StartRunArgs } from '../../../src/research/runner.js';
import { Store } from '../../../src/store/store.js';
import type { BenchTask } from '../tasks/index.js';
import { createCellExecutor } from './dossier.js';
import { runBatch } from './harness.js';

/**
 * The executor, wired to a real `Runner` and a real `Store` with a scripted
 * client. Hermetic: no network, no key, no money, exactly like every other
 * runner test in this repo.
 *
 * What this proves that the pure tests cannot: the cell actually goes through
 * `Runner.start()` and therefore through dedupe, the concurrency cap, the
 * budget gates and the ledger, rather than around them.
 */

const snapshot = (over: Partial<InteractionSnapshot> = {}): InteractionSnapshot => ({
  interactionId: 'int_1',
  status: 'in_progress',
  markdown: '',
  thoughts: [],
  images: [],
  ...over,
});

function scriptedClient(states: InteractionSnapshot[]): DeepResearchClient {
  const calls = new Map<string, number>();
  let seq = 0;
  return {
    async createRun() {
      const id = `int_${String((seq += 1))}`;
      calls.set(id, 0);
      return snapshot({ interactionId: id });
    },
    async getRun(interactionId) {
      const i = calls.get(interactionId) ?? 0;
      calls.set(interactionId, i + 1);
      return { ...(states[Math.min(i, states.length - 1)] as InteractionSnapshot), interactionId };
    },
    async cancelRun() {
      /* no-op */
    },
    async followUp() {
      return '';
    },
  };
}

const task = (id: string): BenchTask =>
  ({ id, question: `What about ${id}?` }) as unknown as BenchTask;

const startArgs = (t: BenchTask, cell: { repeat: number }): StartRunArgs => ({
  question: t.question,
  prompt: `<core_directive>${t.question}</core_directive>`,
  archetype: 'technical',
  tier: 'fast',
  tools: [{ type: 'google_search' }],
  collaborativePlanning: false,
  thinkingSummaries: false,
  visualization: false,
  preEngineered: true,
  repeat: cell.repeat,
});

let dir: string;
let store: Store;
let config: Config;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bench-dossier-'));
  store = new Store(dir);
  await store.init();
  config = { ...loadConfig({ DOSSIER_HERMETIC: '1' }), storeDir: dir, budgetUsd: 1000 };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the live cell executor', () => {
  it('drives one cell to a completed run and reports the stored report path', async () => {
    const runner = new Runner(store, config, () =>
      scriptedClient([snapshot({ status: 'completed', markdown: '# Report\n\nBody.' })]),
    );
    const execute = createCellExecutor({
      runner,
      store,
      tasks: new Map([['t1', task('t1')]]),
      startArgs,
      pollIntervalMs: 0,
      sleep: async () => {
        // The runner's poller is what advances the record, so the executor's
        // wait has to give it a turn. Driving `tick()` here rather than waiting
        // on a timer keeps the test deterministic and instant.
        await runner.tick();
      },
    });

    const result = await execute({ taskId: 't1', provider: 'gemini', repeat: 1 });
    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.reportPath).toMatch(/^reports\//);
    expect(result.reportChars).toBeGreaterThan(0);
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
    expect(result.runId).toBeTruthy();
  });

  it('records a failed run as a failed cell carrying the upstream reason verbatim', async () => {
    const refusing: DeepResearchClient = {
      async createRun() {
        throw new Error('quota exhausted for project 12345');
      },
      async getRun() {
        return snapshot();
      },
      async cancelRun() {},
      async followUp() {
        return '';
      },
    };
    const runner = new Runner(store, config, () => refusing);
    const execute = createCellExecutor({
      runner,
      store,
      tasks: new Map([['t1', task('t1')]]),
      startArgs,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });

    const result = await execute({ taskId: 't1', provider: 'gemini', repeat: 1 });
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.reason).toContain('quota exhausted for project 12345');
  });

  it('records a task the corpus does not carry, rather than throwing past the batch', async () => {
    const runner = new Runner(store, config, () => scriptedClient([snapshot()]));
    const execute = createCellExecutor({
      runner,
      store,
      tasks: new Map(),
      startArgs,
      sleep: async () => undefined,
    });
    const result = await execute({ taskId: 'missing', provider: 'gemini', repeat: 1 });
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(result.outcome === 'failed' && result.reason).toContain('no task in the corpus');
  });

  it('abandons a cell that outlives its timeout without cancelling the paid run', async () => {
    // The run has already been charged and may still finish, so the harness
    // gives up on the cell and leaves the run alone, naming the run id.
    const runner = new Runner(store, config, () => scriptedClient([snapshot()]));
    const execute = createCellExecutor({
      runner,
      store,
      tasks: new Map([['t1', task('t1')]]),
      startArgs,
      cellTimeoutMs: 0,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
    const result = await execute({ taskId: 't1', provider: 'gemini', repeat: 1 });
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.reason).toContain('was abandoned by the harness');
    expect(result.reason).toContain('has already been charged');
    expect(result.runId).toBeTruthy();

    const stored = await store.getRun(result.runId as string);
    expect(stored?.state).not.toBe('cancelled');
  });

  // The whole point of the fingerprint fix, exercised through the real path:
  // three repeats of one task on one backend are three runs and three ledger
  // lines, not one run counted three times.
  it('buys one run per repetition, and one ledger line per run', async () => {
    const runner = new Runner(store, config, () =>
      scriptedClient([snapshot({ status: 'completed', markdown: '# R' })]),
    );
    const execute = createCellExecutor({
      runner,
      store,
      tasks: new Map([['t1', task('t1')]]),
      startArgs,
      pollIntervalMs: 0,
      sleep: async () => {
        await runner.tick();
      },
    });

    const outcome = await runBatch({
      queue: [1, 2, 3].map((repeat) => ({ taskId: 't1', provider: 'gemini', repeat })),
      concurrency: 1,
      execute,
      record: async () => undefined,
    });

    expect(outcome.ok).toBe(3);
    const runIds = new Set(outcome.records.map((c) => c.runId));
    expect(runIds.size).toBe(3);

    const runs = await store.listRuns();
    expect(runs).toHaveLength(3);
    expect(new Set(runs.map((r) => r.fingerprint)).size).toBe(3);
    expect(runs.map((r) => r.repeat).sort()).toEqual([1, 2, 3]);

    // And the budget machinery saw all three, because the executor went
    // through `Runner.start()` rather than around it.
    const budget = await runner.budget();
    expect(budget.runsInWindow).toBe(3);
    expect(budget.committedUsd).toBeGreaterThan(0);
  });

  // The claim `harness.test.ts` makes about the crash window, measured rather
  // than asserted in a comment. A cell that finished and did not reach the
  // store is executed again on resume, because buying a report and recording it
  // cannot be one atomic act. What bounds the damage is Dossier's own
  // fingerprint dedupe: the re-executed cell carries the same task, backend and
  // repetition, so it returns the run already bought and costs nothing more.
  it('a re-executed cell returns the run already bought rather than buying a second', async () => {
    let created = 0;
    const client: DeepResearchClient = {
      ...scriptedClient([snapshot({ status: 'completed', markdown: '# R' })]),
      async createRun() {
        created += 1;
        return snapshot({ interactionId: `int_${String(created)}` });
      },
    };
    const runner = new Runner(store, config, () => client);
    const execute = createCellExecutor({
      runner,
      store,
      tasks: new Map([['t1', task('t1')]]),
      startArgs,
      pollIntervalMs: 0,
      sleep: async () => {
        await runner.tick();
      },
    });

    const cell = { taskId: 't1', provider: 'gemini' as const, repeat: 2 };
    const first = await execute(cell);
    const again = await execute(cell);

    expect(first.outcome).toBe('ok');
    expect(again.outcome).toBe('ok');
    expect(first.runId).toBe(again.runId);
    // One paid creation for two executions of the same cell.
    expect(created).toBe(1);
    expect((await store.listRuns())).toHaveLength(1);
  });

  // The cell's backend and repetition are not the caller's to choose. A
  // `startArgs` that omitted `repeat` would collapse five cell keys onto one
  // report; one that named another backend would run one the planner never
  // costed. Both corrupt the matrix silently rather than failing it.
  it('binds the cell own backend and repetition over whatever startArgs returned', async () => {
    const runner = new Runner(store, config, () =>
      scriptedClient([snapshot({ status: 'completed', markdown: '# R' })]),
    );
    const execute = createCellExecutor({
      runner,
      store,
      tasks: new Map([['t1', task('t1')]]),
      // Deliberately wrong on both axes.
      startArgs: (t) => ({ ...startArgs(t, { repeat: 1 }), provider: 'perplexity', repeat: 1 }),
      pollIntervalMs: 0,
      sleep: async () => {
        await runner.tick();
      },
    });

    const result = await execute({ taskId: 't1', provider: 'gemini', repeat: 4 });
    expect(result.outcome).toBe('ok');
    const run = await store.getRun(result.runId as string);
    expect(run?.provider).toBe('gemini');
    expect(run?.repeat).toBe(4);
  });
});
