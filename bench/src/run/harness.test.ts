import { describe, expect, it } from 'vitest';
import { cellKey, type CellRecord, type CellRef } from './cell.js';
import { boundedConcurrency, runBatch, type ExecuteResult } from './harness.js';
import { planBatch } from './plan.js';

/**
 * The harness, exercised with an injected executor, so every rule below is
 * checked without a network, a filesystem or a wallet. The cost of a real cell
 * is $1-7 and up to an hour, which is precisely why none of these tests may
 * touch one.
 */

const ok = (over: Partial<Extract<ExecuteResult, { outcome: 'ok' }>> = {}): ExecuteResult => ({
  outcome: 'ok',
  reportPath: 'reports/r.md',
  reportChars: 42,
  sourceCount: 7,
  estimatedCostUsd: 3,
  ...over,
});

/** A clock that advances a fixed step per read, so wall clock is deterministic. */
function steppingClock(stepMs = 1000): () => Date {
  let t = Date.parse('2026-07-27T00:00:00.000Z');
  return () => {
    const at = new Date(t);
    t += stepMs;
    return at;
  };
}

const queueOf = (n: number): CellRef[] =>
  Array.from({ length: n }, (_, i) => ({ taskId: `t${String(i)}`, provider: 'gemini', repeat: 1 }));

describe('boundedConcurrency', () => {
  // BATCH-07. A batch that runs for days must not take every slot from
  // interactive use of the same server.
  it('BATCH-07: clamps to at least one below the server cap, and never below 1', () => {
    expect(boundedConcurrency(3, 10)).toBe(3);
    expect(boundedConcurrency(20, 10)).toBe(9);
    expect(boundedConcurrency(10, 10)).toBe(9);
    // A server capped at 1 gives the batch that 1. A configuration choice this
    // function cannot fix, rather than a clamp to zero that would hang.
    expect(boundedConcurrency(5, 1)).toBe(1);
    expect(boundedConcurrency(1, 2)).toBe(1);
  });

  it('refuses a nonsensical bound rather than silently running unbounded', () => {
    expect(() => boundedConcurrency(0, 10)).toThrow(/positive integer/);
    expect(() => boundedConcurrency(1.5, 10)).toThrow(/positive integer/);
    expect(() => boundedConcurrency(3, 0)).toThrow(/positive integer/);
  });
});

describe('runBatch', () => {
  // BATCH-07
  it('BATCH-07: never exceeds the concurrency bound, and does use it', async () => {
    let inFlight = 0;
    let peak = 0;
    const outcome = await runBatch({
      queue: queueOf(20),
      concurrency: 4,
      execute: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return ok();
      },
      record: async () => undefined,
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBe(4);
    expect(outcome.peakInFlight).toBe(4);
    expect(outcome.ok).toBe(20);
  });

  it('BATCH-07: a queue shorter than the bound runs without idle workers hanging', async () => {
    const outcome = await runBatch({
      queue: queueOf(2),
      concurrency: 8,
      execute: async () => ok(),
      record: async () => undefined,
    });
    expect(outcome.attempted).toBe(2);
    expect(outcome.ok).toBe(2);
  });

  it('an empty queue is a no-op rather than a hang', async () => {
    const outcome = await runBatch({
      queue: [],
      concurrency: 3,
      execute: async () => ok(),
      record: async () => undefined,
    });
    expect(outcome).toMatchObject({ attempted: 0, ok: 0, failed: 0 });
  });

  // BATCH-08. An omitted failure silently improves the backend's score, which
  // is the same defect as a throttled search counting as an established
  // absence. It is also what makes completion rate computable at all.
  it('BATCH-08: an executor that throws is recorded as failed and the batch continues', async () => {
    const written: CellRecord[] = [];
    const outcome = await runBatch({
      queue: queueOf(5),
      concurrency: 2,
      execute: async (ref) => {
        if (ref.taskId === 't2') throw new Error('HTTP 429: rate limited, retry in 1.236s');
        return ok();
      },
      record: async (c) => {
        written.push(c);
      },
      now: steppingClock(),
    });

    expect(outcome.attempted).toBe(5);
    expect(outcome.ok).toBe(4);
    expect(outcome.failed).toBe(1);
    expect(written).toHaveLength(5);

    const failed = written.find((c) => c.outcome === 'failed');
    expect(failed).toBeDefined();
    // The upstream text verbatim: it is what tells a reader whether this was a
    // quota problem or a broken adapter.
    expect(failed?.outcome === 'failed' && failed.reason).toContain('429');
  });

  it('BATCH-08: an executor that RETURNS a failure keeps its kind and status', async () => {
    const written: CellRecord[] = [];
    await runBatch({
      queue: queueOf(1),
      concurrency: 1,
      execute: async () => ({
        outcome: 'failed' as const,
        reason: 'quota exhausted',
        failureKind: 'quota',
        failureStatus: 429,
        runId: 'run_x',
        estimatedCostUsd: 3,
      }),
      record: async (c) => {
        written.push(c);
      },
      now: steppingClock(),
    });
    expect(written[0]).toMatchObject({
      outcome: 'failed',
      failureKind: 'quota',
      failureStatus: 429,
      runId: 'run_x',
      estimatedCostUsd: 3,
    });
  });

  it('BATCH-08: a thrown non-Error is still recorded rather than losing the cell', async () => {
    const written: CellRecord[] = [];
    await runBatch({
      queue: queueOf(1),
      concurrency: 1,
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- deliberately hostile input: a non-Error throw must still be recorded, not lose the cell
      execute: async () => Promise.reject('a bare string'),
      record: async (c) => {
        written.push(c);
      },
      now: steppingClock(),
    });
    expect(written[0]?.outcome).toBe('failed');
    expect(written[0]?.outcome === 'failed' && written[0].reason).toBe('a bare string');
  });

  // BATCH-09. A backend that scores two points higher for six times the money
  // or six times the time is a finding rather than a winner, and neither is
  // recoverable after the fact.
  it('BATCH-09: every cell records wall clock, estimated cost and its run id', async () => {
    const written: CellRecord[] = [];
    await runBatch({
      queue: queueOf(3),
      concurrency: 1,
      execute: async () => ok({ runId: 'run_1', estimatedCostUsd: 6.5 }),
      record: async (c) => {
        written.push(c);
      },
      now: steppingClock(2500),
    });
    for (const cell of written) {
      expect(cell.wallClockMs).toBe(2500);
      expect(cell.estimatedCostUsd).toBe(6.5);
      expect(cell.runId).toBe('run_1');
      expect(cell.startedAt).toMatch(/^2026-07-27T/);
      expect(Date.parse(cell.finishedAt)).toBeGreaterThan(Date.parse(cell.startedAt));
    }
  });

  it('BATCH-09: the cell carries its own key, task, backend and repetition', async () => {
    const written: CellRecord[] = [];
    await runBatch({
      queue: [{ taskId: 'legal-04', provider: 'perplexity', repeat: 3 }],
      concurrency: 1,
      execute: async () => ok(),
      record: async (c) => {
        written.push(c);
      },
      now: steppingClock(),
    });
    expect(written[0]).toMatchObject({
      key: 'legal-04/perplexity/3',
      taskId: 'legal-04',
      provider: 'perplexity',
      repeat: 3,
    });
  });

  // BATCH-10. The ordering that makes resume correct. A cell that finished and
  // was not written is a cell the resume will buy again, at $1-7.
  it('BATCH-10: a cell is persisted before its slot is released', async () => {
    const events: string[] = [];
    let released = 0;
    await runBatch({
      queue: queueOf(4),
      concurrency: 1,
      execute: async (ref) => {
        events.push(`start:${ref.taskId}`);
        return ok();
      },
      record: async (c) => {
        // Anything the next cell could observe must already see this write.
        await new Promise((r) => setTimeout(r, 1));
        released += 1;
        events.push(`record:${c.taskId}`);
      },
    });
    expect(released).toBe(4);
    // Strictly interleaved at concurrency 1: no start follows another start.
    expect(events).toEqual([
      'start:t0',
      'record:t0',
      'start:t1',
      'record:t1',
      'start:t2',
      'record:t2',
      'start:t3',
      'record:t3',
    ]);
  });

  it('reports progress per settled cell, in order of settlement', async () => {
    const seen: number[] = [];
    await runBatch({
      queue: queueOf(3),
      concurrency: 1,
      execute: async () => ok(),
      record: async () => undefined,
      onCell: (_cell, done, total) => {
        expect(total).toBe(3);
        seen.push(done);
      },
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  // BATCH-14. The brief's headline acceptance criterion, end to end against the
  // planner: kill the process mid-batch, re-plan from what was recorded, and
  // run exactly the cells that never finished. This is the behaviour promptfoo
  // 0.121.19 was measured NOT to have; see docs/bench/run-harness.md.
  it('BATCH-14: killing a batch and re-planning runs exactly the remaining cells', async () => {
    const spec = {
      taskIds: ['t1', 't2', 't3', 't4'],
      providers: ['gemini', 'perplexity'],
      repetitions: 3,
      estimateCellUsd: () => 3,
      ceilingUsd: 0,
    };

    const first = planBatch(spec);
    expect(first.queue).toHaveLength(24);

    // A "process death" after 9 cells: the tenth executes and never records.
    const recorded: CellRecord[] = [];
    let executed = 0;
    const boom = new Error('killed');
    await expect(
      runBatch({
        queue: first.queue,
        concurrency: 1,
        execute: async () => {
          executed += 1;
          return ok();
        },
        record: async (c) => {
          if (recorded.length === 9) throw boom;
          recorded.push(c);
        },
      }),
    ).rejects.toThrow('killed');
    expect(recorded).toHaveLength(9);
    expect(executed).toBe(10);

    // Resume: plan again from exactly what reached the store.
    const second = planBatch({ ...spec, completedKeys: recorded.map((c) => c.key) });
    expect(second.alreadyDone).toBe(9);
    expect(second.queue).toHaveLength(15);
    expect(second.projectedUsd).toBe(45);

    const resumed: CellRecord[] = [];
    await runBatch({
      queue: second.queue,
      concurrency: 3,
      execute: async () => {
        executed += 1;
        return ok();
      },
      record: async (c) => {
        resumed.push(c);
      },
    });

    // Every cell of the matrix is recorded exactly once, and none is skipped.
    const all = [...recorded, ...resumed].map((c) => c.key);
    expect(all).toHaveLength(24);
    expect(new Set(all).size).toBe(24);
    expect(new Set(all)).toEqual(new Set(first.queue.map(cellKey)));

    // And a third plan has nothing left to do.
    expect(planBatch({ ...spec, completedKeys: all }).queue).toHaveLength(0);

    // The honest part, asserted rather than glossed: 25 executions for a
    // 24-cell matrix. The cell that finished and did not reach the store is
    // executed a second time on resume, and NO at-least-once system can avoid
    // that, because buying a report and recording it cannot be one atomic act.
    //
    // An earlier version of this test counted only the recorded cells and so
    // asserted the opposite of what it proved. What bounds the damage is not
    // the harness: it is Dossier's own fingerprint dedupe, which returns the
    // existing run for free when the re-executed cell carries the same task,
    // backend and repetition, inside the dedupe window. That is measured in
    // `dossier.test.ts`; here it is named so nobody reads this as exactly-once.
    expect(executed).toBe(25);
  });

  // BATCH-10. The other half of a persistence failure: siblings must stop
  // claiming cells, and must be awaited rather than left running detached while
  // the caller believes the batch has ended and starts its cleanup.
  it('BATCH-10: a persistence failure stops the batch instead of leaving paid cells in flight', async () => {
    let started = 0;
    let settled = 0;
    await expect(
      runBatch({
        queue: queueOf(30),
        concurrency: 4,
        execute: async () => {
          started += 1;
          await new Promise((r) => setTimeout(r, 5));
          settled += 1;
          return ok();
        },
        record: async () => {
          throw new Error('disk full');
        },
      }),
    ).rejects.toThrow('disk full');

    // Nothing is still running when the caller regains control.
    expect(settled).toBe(started);
    // And it stopped near the first failure rather than working through 30.
    expect(started).toBeLessThanOrEqual(8);
  });

  // BATCH-16. The defect the abort fix itself introduced, found by the same
  // out-of-family review a round later: `allSettled` swallows, so a worker that
  // threw anywhere other than `record` stopped silently and the batch reported
  // success with `attempted === queue.length` having run a fraction of it. A
  // batch that quietly ran one cell of thirty and called itself done is worse
  // than one that failed.
  it('BATCH-16: a worker that throws outside record still fails the batch', async () => {
    let executed = 0;
    await expect(
      runBatch({
        queue: queueOf(30),
        concurrency: 1,
        execute: async () => {
          executed += 1;
          return ok();
        },
        record: async () => undefined,
        onCell: () => {
          throw new Error('progress callback blew up');
        },
      }),
    ).rejects.toThrow('progress callback blew up');
    expect(executed).toBe(1);
  });

  it('refuses a nonsensical concurrency rather than running unbounded', async () => {
    await expect(
      runBatch({ queue: queueOf(1), concurrency: 0, execute: async () => ok(), record: async () => undefined }),
    ).rejects.toThrow(/positive integer/);
  });
});
