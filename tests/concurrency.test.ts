import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Runner } from '../src/research/runner.js';
import { FileLock, LockTimeoutError } from '../src/store/file-lock.js';
import { Store } from '../src/store/store.js';
import type { RunRecord } from '../src/store/types.js';

/**
 * The gates that stop Dossier spending money it was told not to.
 *
 * These are the highest-consequence invariants in the codebase and were the
 * least covered: the existing suite proved the in-process mutex worked, which
 * was never the interesting case. Two MCP clients configured with Dossier are
 * two processes on one store, and each used to observe headroom the other had
 * already claimed. The multi-process test at the bottom is the one that matters;
 * it fails against the pre-lock implementation.
 */

let root: string;

/** A client that accepts a run and reports it still going. */
const scripted = () => ({
  async createRun() {
    return { interactionId: 'int_1', status: 'in_progress' as const, markdown: '', thoughts: [], images: [] };
  },
  async getRun() {
    return { interactionId: 'int_1', status: 'in_progress' as const, markdown: '', thoughts: [], images: [] };
  },
  async cancelRun() {
    /* no-op */
  },
  async followUp() {
    return '';
  },
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dossier-conc-'));
});

afterEach(async () => {
  // Subprocesses may still be flushing; retry rather than fail the suite on a
  // cleanup race.
  for (let i = 0; i < 5; i += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

describe('FileLock', () => {
  it('grants to exactly one holder at a time', async () => {
    const path = join(root, 'l');
    let inside = 0;
    let maxInside = 0;
    const body = async (): Promise<void> => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      await new Promise((r) => setTimeout(r, 5));
      inside -= 1;
    };
    await Promise.all(
      Array.from({ length: 8 }, () => new FileLock(path, { timeoutMs: 5_000 }).run(body)),
    );
    expect(maxInside).toBe(1);
  });

  it('publishes the lock file complete, never empty then filled', async () => {
    // The bug this locks down: creating the lock path and *then* writing the
    // holder record leaves a window where the file exists and is empty. A
    // contender reading it there parses nothing, concludes the lock is
    // abandoned, deletes it and takes it — two holders inside a gate whose one
    // job is to admit one.
    //
    // This half is deterministic: whenever the lock exists it must already name
    // its holder. The probabilistic contention test below is what actually
    // caught the defect, and it caught it about one run in eight, which is
    // exactly why this assertion is here too.
    const path = join(root, 'l');
    const lock = new FileLock(path);
    await lock.run(async () => {
      const holder: unknown = JSON.parse(await readFile(path, 'utf8'));
      expect(holder).toMatchObject({ pid: process.pid });
    });
    // And the temporary name it was written under does not survive.
    const leftovers = (await readdir(root)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('refuses to break a lock file that is mid-write', async () => {
    // The deterministic half of the half-written-lock defect. An empty lock
    // file is what a create-then-fill implementation publishes for an instant,
    // and breaking it on sight put two holders inside a gate that exists to
    // admit one. It must be waited out, then broken — in that order.
    const path = join(root, 'l');
    await writeFile(path, '');
    const began = Date.now();
    await expect(
      new FileLock(path, { timeoutMs: 3_000, graceMs: 400 }).run(async () => 'taken'),
    ).resolves.toBe('taken');
    const waited = Date.now() - began;
    expect(waited).toBeGreaterThanOrEqual(350);
    // But not forever: a genuinely damaged lock still has to be recoverable.
    expect(waited).toBeLessThan(2_000);
  });

  it('holds exclusivity under heavy contention', async () => {
    // Repeated rounds with the retry sleep stubbed out, so contenders spin
    // rather than back off. This is the test that found the half-written-lock
    // defect, and it is worth being honest about it: against the broken
    // implementation it fails roughly one run in three rather than every time.
    // The deterministic guard is the test above; this one is the net that
    // catches the class of defect nobody thought to write a guard for.
    const path = join(root, 'l');
    // Both five-second deadlines here were wrong, and the first fix picked the
    // wrong one. The failure is `Test timed out in 5000ms` — VITEST's per-test
    // default, not the lock's — because 96 spinning acquisitions inside a
    // 105-file parallel suite are CPU-starved rather than deadlocked. The
    // signature was there to read: 6 of 6 in isolation, 2 of 6 under load.
    // The lock's own deadline is raised too, for the same reason and because a
    // starved contender should not report a scheduling delay as a lock defect.
    //
    // Neither raise weakens the test: it finishes when the work finishes, and a
    // real deadlock still fails, just later and unambiguously. This flake has
    // cost four separate investigations, one of them today, and each of the
    // first three moved the wrong number.
    const spin = { sleep: async (): Promise<void> => undefined, timeoutMs: 120_000 };
    const bad: string[] = [];
    let stop = false;
    // Several readers, not one. A contender only breaks a half-written lock if
    // it happens to read inside the window; independent watchers observe the
    // same window without having to win a race to prove it exists.
    const watchers = Array.from({ length: 6 }, async () => {
      while (!stop) {
        try {
          JSON.parse(await readFile(path, 'utf8'));
        } catch (e: unknown) {
          // Absent is fine; present-but-unparseable is the defect.
          if ((e as { code?: string }).code !== 'ENOENT') bad.push(String(e));
        }
        await new Promise((r) => setImmediate(r));
      }
    });

    let maxInside = 0;
    for (let round = 0; round < 8; round += 1) {
      let inside = 0;
      await Promise.all(
        Array.from({ length: 12 }, () =>
          new FileLock(path, spin).run(async () => {
            inside += 1;
            maxInside = Math.max(maxInside, inside);
            await new Promise((r) => setImmediate(r));
            inside -= 1;
          }),
        ),
      );
    }
    stop = true;
    await Promise.all(watchers);
    expect(bad).toEqual([]);
    expect(maxInside).toBe(1);
    // The timeout that was actually firing.
  }, 120_000);

  it('releases even when the task throws, so one error cannot wedge the store', async () => {
    const path = join(root, 'l');
    await expect(
      new FileLock(path).run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // The next acquirer gets it immediately rather than waiting out staleness.
    await expect(new FileLock(path, { timeoutMs: 200 }).run(async () => 'ok')).resolves.toBe('ok');
  });

  it('breaks a lock whose holder process is gone', async () => {
    const path = join(root, 'l');
    // A live-looking lock from a pid that no longer exists.
    await writeFile(path, JSON.stringify({ pid: 999_999, host: (await import('node:os')).hostname(), at: Date.now() }));
    await expect(
      new FileLock(path, { timeoutMs: 1_000, isAlive: () => false }).run(async () => 'taken'),
    ).resolves.toBe('taken');
  });

  it('breaks a lock older than the staleness window even if the pid is alive', async () => {
    const path = join(root, 'l');
    await writeFile(
      path,
      JSON.stringify({ pid: process.pid, host: 'somewhere-else', at: Date.now() - 120_000 }),
    );
    await expect(
      new FileLock(path, { timeoutMs: 1_000, staleMs: 60_000 }).run(async () => 'taken'),
    ).resolves.toBe('taken');
  });

  it('treats an unparseable lock file as abandoned rather than immortal', async () => {
    const path = join(root, 'l');
    await writeFile(path, 'not json at all');
    await expect(new FileLock(path, { timeoutMs: 1_000 }).run(async () => 'taken')).resolves.toBe(
      'taken',
    );
  });

  it('times out with a message naming the holder rather than hanging', async () => {
    const path = join(root, 'l');
    await writeFile(path, JSON.stringify({ pid: process.pid, host: (await import('node:os')).hostname(), at: Date.now() }));
    const err = await new FileLock(path, { timeoutMs: 120, staleMs: 60_000 })
      .run(async () => 'never')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockTimeoutError);
    expect((err as Error).message).toContain(String(process.pid));
  });
});

describe('the concurrency cap counts provider slots, not records', () => {
  it('does not let open local-loop sessions refuse a paid run', async () => {
    // A local loop is an open notebook: nothing is executing anywhere while
    // its host searches, and that can take an hour. Counting those against the
    // cap meant ten free sessions refused every paid run with "10 runs already
    // in flight", which is both wrong and baffling to diagnose.
    const store = new Store(root);
    await store.init();
    const config = { ...loadConfig({ DOSSIER_STORE_DIR: root }), storeDir: root, maxConcurrent: 3 };
    const runner = new Runner(store, config, () => scripted());

    for (let i = 0; i < 5; i += 1) {
      await runner.openLoop({ question: `open notebook ${String(i)}`, archetype: 'technical' });
    }
    const snapshot = await runner.budget();
    expect(snapshot.activeRuns).toBe(0);

    // The cap still applies to work that IS in flight.
    await expect(
      runner.start({
        question: 'a real run',
        prompt: 'p',
        archetype: 'technical',
        tier: 'fast',
        tools: [],
        collaborativePlanning: false,
        thinkingSummaries: false,
        visualization: false,
        preEngineered: false,
      }),
    ).resolves.toMatchObject({ deduped: false });
  });
});

describe('the spend gate fails closed on damaged state', () => {
  it('charges an unreadable ledger line rather than ignoring it', async () => {
    const store = new Store(root);
    await store.init();
    await store.appendLedger({
      at: new Date().toISOString(),
      runId: 'a',
      tier: 'fast',
      estimatedCostUsd: 2,
      provider: 'gemini',
    });
    // Corrupt the file the way a partial write or a hand-edit would.
    const ledger = join(root, 'ledger.jsonl');
    await writeFile(ledger, `${await readFile(ledger, 'utf8')}{"at":"broken`);

    const { entries, unreadableLines } = await store.readLedgerStrict();
    expect(entries).toHaveLength(1);
    // The damaged line is counted, not silently dropped. Dropping it would mean
    // corrupting the ledger raised the ceiling.
    expect(unreadableLines).toBe(1);
  });

  it('refuses to read an unreadable ledger as zero spend', async () => {
    const store = new Store(root);
    await store.init();
    // A directory where the ledger should be: readFile fails with EISDIR, which
    // must not be mistaken for "no spend yet".
    await rm(join(root, 'ledger.jsonl'), { force: true });
    await (await import('node:fs/promises')).mkdir(join(root, 'ledger.jsonl'));
    await expect(store.readLedgerStrict()).rejects.toThrow(/Refusing to treat an unreadable ledger/);
  });

  it('counts unparseable run records as occupied concurrency slots', async () => {
    const store = new Store(root);
    await store.init();
    await writeFile(join(root, 'runs', 'dr_broken.json'), '{ not valid json');
    expect(await store.unreadableRunCount()).toBe(1);
    // And it does not appear as a readable run, which is exactly why it used to
    // vanish from the concurrency count.
    expect(await store.listRuns()).toHaveLength(0);
  });
});

describe('the store is private on disk', () => {
  it('writes reports, prompts and the ledger 0600 and directories 0700', async () => {
    const { statSync } = await import('node:fs');
    const store = new Store(root);
    await store.init();
    await store.saveReport('r1', '# confidential');
    await store.appendLedger({
      at: new Date().toISOString(),
      runId: 'r1',
      tier: 'fast',
      estimatedCostUsd: 1,
      provider: 'gemini',
    });
    const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8);
    expect(mode(join(root, 'reports', 'r1.md'))).toBe('600');
    expect(mode(join(root, 'ledger.jsonl'))).toBe('600');
    expect(mode(join(root, 'reports'))).toBe('700');
  });
});

describe('journal sequence allocation', () => {
  it('never issues a duplicate cursor under concurrent appends', async () => {
    const store = new Store(root);
    await store.init();
    // The poller and the stream supervisor both append. Read-then-append could
    // hand both the same seq, and `research_tail` pages by cursor, so a
    // duplicate silently hides an event from replay.
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.appendJournal('dr_x', 'progress', `event ${i}`)),
    );
    const events = await store.readJournal('dr_x', -1);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toHaveLength(25);
    expect(new Set(seqs).size).toBe(25);
    expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });
});

/**
 * The test that actually proves the fix.
 *
 * Real OS processes, one shared store, a budget with room for exactly two runs.
 * Worker threads would not do: they share the in-process mutex, which is the
 * mechanism that was already working. This fails without the file lock.
 */
describe('cross-process admission control', () => {
  it('holds one budget ceiling across several server processes', async () => {
    const worker = join(root, 'worker.mts');
    const src = fileURLToPath(new URL('../src', import.meta.url));
    await writeFile(
      worker,
      `
import { Store } from '${src}/store/store.ts';
import { Runner } from '${src}/research/runner.ts';
import { loadConfig } from '${src}/config.ts';

const config = loadConfig({
  DOSSIER_STORE_DIR: process.argv[2],
  DOSSIER_BUDGET_USD: '15',      // room for exactly two $7 max runs
  DOSSIER_MAX_CONCURRENT: '64',  // concurrency must not be what limits us
  GEMINI_API_KEY: 'x',
});
const store = new Store(config.storeDir);
await store.init();

// A client that "succeeds" instantly, so the only thing under test is the gate.
const snap = (id) => ({ interactionId: id, status: 'in_progress', markdown: '', thoughts: [], images: [] });
const client = {
  createRun: async () => snap('int_' + Math.random().toString(36).slice(2)),
  getRun: async (id) => snap(id),
  cancelRun: async () => undefined,
};
const runner = new Runner(store, config, () => client as never);

let admitted = 0;
let firstError = '';
for (let i = 0; i < 6; i += 1) {
  try {
    await runner.start({
      question: 'q' + process.pid + '-' + i,
      prompt: 'p' + process.pid + '-' + i,   // unique, so dedupe never masks the gate
      archetype: 'technical',
      tier: 'max',
      tools: [{ type: 'google_search' }],
      collaborativePlanning: false,
      thinkingSummaries: false,
      visualization: false,
      preEngineered: false,
    });
    admitted += 1;
  } catch (e) {
    // Budget refusal is expected; anything else is a broken test harness and
    // must be visible rather than silently counted as a refusal.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/Budget gate|already in flight/.test(msg)) { firstError ||= msg; }
  }
}
process.stdout.write(JSON.stringify({ admitted, firstError }));
`,
      'utf8',
    );

    const runWorker = (): Promise<number> =>
      new Promise((resolve, reject) => {
        const p = spawn('npx', ['tsx', worker, root], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        p.stdout.on('data', (d: Buffer) => (out += d.toString()));
        p.stderr.on('data', (d: Buffer) => (err += d.toString()));
        p.on('close', (code) => {
          if (code !== 0) return reject(new Error(`worker exited ${code}: ${err.slice(-400)}`));
          try {
            const parsed = JSON.parse(out) as { admitted: number; firstError?: string };
            if (parsed.firstError) return reject(new Error(`worker error: ${parsed.firstError}`));
            resolve(parsed.admitted);
          } catch {
            reject(new Error(`unparseable worker output: ${out.slice(0, 200)} ${err.slice(-200)}`));
          }
        });
      });

    const results = await Promise.all([runWorker(), runWorker(), runWorker()]);
    const totalAdmitted = results.reduce((a, b) => a + b, 0);

    // $15 ceiling, $7 reserved per max run: two fit, a third would reach $21.
    expect(totalAdmitted).toBe(2);

    // And the ledger agrees with what was admitted.
    const store = new Store(root);
    const { entries } = await store.readLedgerStrict();
    const committed = entries.reduce((sum, e) => sum + e.estimatedCostUsd, 0);
    expect(entries).toHaveLength(2);
    expect(committed).toBeLessThanOrEqual(15);
  }, 120_000);
});

/**
 * Lifecycle transitions that spend money or claim something finished.
 *
 * Each of these was a real defect found by external review, and each was fixed
 * without a test until now. A race you cannot reproduce is a race you will
 * reintroduce.
 */
describe('paid lifecycle transitions', () => {
  const snapshot = (id: string) =>
    ({ interactionId: id, status: 'in_progress', markdown: '', thoughts: [], images: [] }) as never;

  const makeRunner = async (
    over: Partial<{ createRun: () => Promise<unknown>; cancelRun: () => Promise<void> }> = {},
  ) => {
    const { Runner } = await import('../src/research/runner.js');
    const { loadConfig } = await import('../src/config.js');
    const store = new Store(root);
    await store.init();
    let creates = 0;
    const client = {
      createRun: over.createRun ?? (async () => (creates += 1, snapshot(`int_${creates}`))),
      getRun: async (id: string) => snapshot(id),
      cancelRun: over.cancelRun ?? (async () => undefined),
    };
    const config = loadConfig({ DOSSIER_STORE_DIR: root, GEMINI_API_KEY: 'x' });
    return { store, runner: new Runner(store, config, () => client as never), creates: () => creates };
  };

  const startPlanning = async (runner: {
    start: (a: never) => Promise<{ run: RunRecord }>;
  }) =>
    (
      await runner.start({
        question: 'q',
        prompt: 'p',
        archetype: 'technical',
        tier: 'fast',
        tools: [{ type: 'google_search' }],
        collaborativePlanning: true,
        thinkingSummaries: false,
        visualization: false,
        preEngineered: false,
      } as never)
    ).run;

  it('starts exactly one paid continuation when a plan is approved concurrently', async () => {
    const { runner, creates } = await makeRunner();
    const run = await startPlanning(runner);
    const before = creates();

    // Five callers race to approve. Without per-run serialisation all five
    // observe planApproved === false and all five buy a continuation; only one
    // interaction id survives the write and the rest bill unobserved.
    await Promise.all(Array.from({ length: 5 }, () => runner.approvePlan(run.id)));

    expect(creates() - before).toBe(1);
  });

  it('refuses to approve a cancelled run back into a paid run', async () => {
    const { runner, creates } = await makeRunner();
    const run = await startPlanning(runner);
    await runner.cancel(run.id);
    const before = creates();

    await expect(runner.approvePlan(run.id)).rejects.toThrow(/cancelled and cannot be approved/);
    expect(creates() - before).toBe(0); // nothing was bought
  });

  it('does not claim a cancellation the provider never confirmed', async () => {
    const { runner, store } = await makeRunner({
      cancelRun: async () => {
        throw Object.assign(new Error('upstream 503'), { status: 503 });
      },
    });
    const run = await startPlanning(runner);

    const cancelled = await runner.cancel(run.id);
    expect(cancelled?.state).toBe('cancelled');
    // The important part: it says the provider may still be running and billing
    // rather than reporting a clean stop.
    expect(cancelled?.error).toMatch(/may still be executing and billing/);
    const events = await store.readJournal(run.id, -1);
    expect(events.at(-1)?.message).toMatch(/NOT confirmed upstream/);
  });

  it('fails loudly when a paid call returns nothing pollable', async () => {
    // Billed, but no interaction id: the run can never be polled or cancelled.
    // Polling forever would hide a charge; failing points at the console.
    const { runner } = await makeRunner({
      createRun: async () =>
        ({ interactionId: '', status: 'in_progress', markdown: '', thoughts: [], images: [] }),
    });
    const run = await startPlanning(runner);
    expect(run.state).toBe('failed');
    expect(run.error).toMatch(/no interaction id/);
    expect(run.error).toMatch(/charged against your budget/);
  });
});

describe('the lock knows who holds it', () => {
  it('does not delete a lock that was taken from it', async () => {
    // Release used to be "delete the path", which deletes whoever holds it NOW
    // rather than whoever held it when we acquired. If B breaks A's lock and A
    // then releases, A deletes B's lock and C walks in beside B: two processes
    // in the spend gate, from a release that looked perfectly correct.
    const path = join(root, 'l');
    const a = new FileLock(path, { timeoutMs: 1_000 });
    let bHolds = false;
    await a.run(async () => {
      // Simulate B breaking the lock and taking it while A works.
      await rm(path, { force: true });
      await writeFile(
        path,
        JSON.stringify({ pid: process.pid, host: (await import('node:os')).hostname(), at: Date.now(), token: 'B' }),
      );
      bHolds = true;
    });
    expect(bHolds).toBe(true);
    // A's release must have left B's lock alone.
    const after: unknown = JSON.parse(await readFile(path, 'utf8'));
    expect((after as { token?: string }).token).toBe('B');
  });

  it('never breaks a live local holder on age alone', async () => {
    // The critical section reads the ledger and the run directory off disk, so
    // a slow-but-healthy holder is normal. Stealing its lock puts two processes
    // inside the gate, which is worse than waiting.
    const path = join(root, 'l');
    await writeFile(
      path,
      JSON.stringify({
        pid: process.pid,
        host: (await import('node:os')).hostname(),
        at: Date.now() - 10 * 60_000,
        token: 'live-and-working',
      }),
    );
    await expect(
      new FileLock(path, { timeoutMs: 200, staleMs: 1_000 }).run(async () => 'stolen'),
    ).rejects.toBeInstanceOf(LockTimeoutError);
  });

  it('still breaks an old lock from a host it cannot check', async () => {
    // Liveness is only knowable locally, so age remains the only recourse for
    // another machine's lock. Otherwise a crashed peer wedges the store forever.
    const path = join(root, 'l');
    await writeFile(
      path,
      JSON.stringify({ pid: 1, host: 'some-other-machine', at: Date.now() - 10 * 60_000, token: 'x' }),
    );
    await expect(
      new FileLock(path, { timeoutMs: 1_000, staleMs: 60_000 }).run(async () => 'taken'),
    ).resolves.toBe('taken');
  });
});

describe('per-provider sub-ceilings', () => {
  // `DOSSIER_CONCURRENCY_OPENAI: '0'` disables the per-backend slot cap for
  // these cases. That cap defaults to 1 for OpenAI and is checked BEFORE the
  // budget, following the documented order (dedupe, concurrency, budget,
  // ledger, call) — so without this the second run here is refused for a slot
  // and never reaches the ceiling these tests exist to prove.
  const config = (over: Record<string, string>) => ({
    ...loadConfig({ DOSSIER_STORE_DIR: root, DOSSIER_CONCURRENCY_OPENAI: '0', ...over }),
    storeDir: root,
  });

  it('stops one backend consuming the whole global ceiling', async () => {
    // The docs advertised `DOSSIER_BUDGET_USD_OPENAI` as a guardrail and Zod
    // stripped it, so it did nothing at all: any backend could spend the lot.
    const store = new Store(root);
    await store.init();
    const runner = new Runner(store, config({ DOSSIER_BUDGET_USD: '100', DOSSIER_BUDGET_USD_OPENAI: '3' }), () =>
      scripted(),
    );
    const start = (provider: 'openai' | 'gemini') =>
      runner.start({
        question: `q-${provider}-${String(Math.random())}`,
        prompt: `p-${provider}-${String(Date.now())}-${String(Math.random())}`,
        archetype: 'technical',
        tier: 'fast',
        tools: [],
        collaborativePlanning: false,
        thinkingSummaries: false,
        visualization: false,
        preEngineered: false,
        provider,
      });

    await expect(start('openai')).resolves.toMatchObject({ deduped: false });
    // The OpenAI sub-ceiling is spent; the global one is nowhere near.
    await expect(start('openai')).rejects.toThrow(/Budget gate/);
    // And another backend is unaffected, which is the point of a sub-ceiling.
    await expect(start('gemini')).resolves.toMatchObject({ deduped: false });
  });

  it('records utility spend even when the ceiling is disabled', async () => {
    // `DOSSIER_BUDGET_USD=0` used to return before appending, so disabling the
    // limit also erased the history for utility calls while research starts
    // kept recording theirs. Partial spend reporting is worse than none.
    const store = new Store(root);
    await store.init();
    const runner = new Runner(store, config({ DOSSIER_BUDGET_USD: '0' }), () => scripted());
    await runner.reserveUtilitySpend('title:dr_x');
    const entries = await store.readLedger();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe('title:dr_x');
  });
});

describe('an unreadable run directory closes the gate', () => {
  it('throws rather than reporting no runs in flight', async () => {
    // `listRuns` and `unreadableRunCount` turned every readdir error into
    // zero, and zero is the answer that opens the gate: dedupe sees no existing
    // work and concurrency sees nothing in flight. Only ENOENT means empty.
    const store = new Store(root);
    await store.init();
    const { chmodSync } = await import('node:fs');
    const runsDir = join(root, 'runs');
    chmodSync(runsDir, 0o000);
    try {
      await expect(store.listRuns()).rejects.toThrow();
      await expect(store.unreadableRunCount()).rejects.toThrow();
    } finally {
      chmodSync(runsDir, 0o700);
    }
  });

  it('still treats a genuinely absent directory as empty', async () => {
    const store = new Store(join(root, 'never-created'));
    await expect(store.listRuns()).resolves.toEqual([]);
  });
});
