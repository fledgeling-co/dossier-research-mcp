import { cellKey, type CellRecord, type CellRef } from './cell.js';

/**
 * Executing a planned batch, at bounded concurrency, recording every cell.
 *
 * **This file must never import `node:fs`.** The thing that spends money is
 * injected as `execute`, and the thing that persists is injected as `record`,
 * so every rule below — the concurrency bound, the failure capture, the wall
 * clock, the record-before-continue ordering — is testable with no filesystem,
 * no network and no wallet.
 */

/** What an executor returns for a cell that produced a report. */
export interface ExecuteOk {
  readonly outcome: 'ok';
  readonly reportPath: string;
  readonly reportChars: number;
  readonly sourceCount: number;
  readonly estimatedCostUsd: number;
  readonly runId?: string;
}

/** What it returns for one that did not. Returning is preferred to throwing. */
export interface ExecuteFailed {
  readonly outcome: 'failed';
  readonly reason: string;
  readonly estimatedCostUsd?: number;
  readonly runId?: string;
  readonly failureKind?: string;
  readonly failureStatus?: number;
}

export type ExecuteResult = ExecuteOk | ExecuteFailed;

export interface RunBatchOptions {
  readonly queue: readonly CellRef[];
  /**
   * Runs one cell. May throw; a throw is recorded as a failed cell rather than
   * ending the batch, because 3,999 completed cells must not be lost to the
   * 4,000th backend having a bad afternoon.
   */
  readonly execute: (ref: CellRef) => Promise<ExecuteResult>;
  /**
   * Persist one cell record. Awaited **before** the slot is released, so a
   * process killed mid-batch has every finished cell already on disk. The
   * reverse ordering loses exactly the cells that cost the most to buy.
   */
  readonly record: (cell: CellRecord) => Promise<void>;
  /** Maximum cells in flight. See `DEFAULT_CONCURRENCY`. */
  readonly concurrency: number;
  /** Injected so wall clock is measurable without waiting for it. */
  readonly now?: () => Date;
  /** Called after each cell settles, for progress reporting. */
  readonly onCell?: (cell: CellRecord, done: number, total: number) => void;
}

/**
 * Cells in flight at once, by default.
 *
 * Well below `DOSSIER_MAX_CONCURRENT`, which defaults to 10. This is a batch
 * job that will run for days and it must not starve the interactive use of the
 * same server; taking three of ten leaves seven for a person.
 */
export const DEFAULT_CONCURRENCY = 3;

/**
 * Clamp a requested concurrency so a batch can never take every slot.
 *
 * At least one below the server's own cap, and never below 1. A server
 * configured with a cap of 1 gives the batch that 1 and blocks interactive use
 * while it runs, which is a configuration choice rather than something this
 * function can fix.
 */
export function boundedConcurrency(requested: number, serverMaxConcurrent: number): number {
  if (!Number.isInteger(requested) || requested < 1) {
    throw new TypeError(`concurrency must be a positive integer; received ${String(requested)}`);
  }
  if (!Number.isInteger(serverMaxConcurrent) || serverMaxConcurrent < 1) {
    throw new TypeError(
      `serverMaxConcurrent must be a positive integer; received ${String(serverMaxConcurrent)}`,
    );
  }
  return Math.max(1, Math.min(requested, serverMaxConcurrent - 1, serverMaxConcurrent));
}

export interface BatchOutcome {
  readonly attempted: number;
  readonly ok: number;
  readonly failed: number;
  /** The highest number of cells observed in flight at once. */
  readonly peakInFlight: number;
  readonly records: readonly CellRecord[];
}

function isoOf(date: Date): string {
  return date.toISOString();
}

/**
 * Run the queue.
 *
 * A fixed pool of workers pulling from a shared cursor, rather than
 * `Promise.all` over chunks: chunking makes every worker wait for the slowest
 * cell in its chunk, and cells here range from four minutes to an hour, so a
 * chunked pool would idle most of its slots most of the time.
 */
export async function runBatch(options: RunBatchOptions): Promise<BatchOutcome> {
  const { queue, execute, record } = options;
  const concurrency = options.concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError(`concurrency must be a positive integer; received ${String(concurrency)}`);
  }
  const now = options.now ?? ((): Date => new Date());

  const records: CellRecord[] = [];
  let cursor = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  let ok = 0;
  let failed = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const ref = queue[index];
      if (!ref) return;

      inFlight += 1;
      if (inFlight > peakInFlight) peakInFlight = inFlight;

      const startedAt = now();
      let result: ExecuteResult;
      try {
        result = await execute(ref);
      } catch (e: unknown) {
        // A throw is a failed cell, never a lost one. The upstream message is
        // kept verbatim first: it is what tells a reader whether this was a
        // quota problem or a broken adapter, and paraphrasing it hides that.
        result = {
          outcome: 'failed',
          reason: e instanceof Error ? e.message : String(e),
        };
      }
      const finishedAt = now();

      const base = {
        key: cellKey(ref),
        taskId: ref.taskId,
        provider: ref.provider,
        repeat: ref.repeat,
        startedAt: isoOf(startedAt),
        finishedAt: isoOf(finishedAt),
        wallClockMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      };

      const cell: CellRecord =
        result.outcome === 'ok'
          ? {
              ...base,
              outcome: 'ok',
              estimatedCostUsd: result.estimatedCostUsd,
              reportPath: result.reportPath,
              reportChars: result.reportChars,
              sourceCount: result.sourceCount,
              ...(result.runId !== undefined ? { runId: result.runId } : {}),
            }
          : {
              ...base,
              outcome: 'failed',
              estimatedCostUsd: result.estimatedCostUsd ?? 0,
              reason: result.reason.slice(0, 4000),
              ...(result.runId !== undefined ? { runId: result.runId } : {}),
              ...(result.failureKind !== undefined ? { failureKind: result.failureKind } : {}),
              ...(result.failureStatus !== undefined
                ? { failureStatus: result.failureStatus }
                : {}),
            };

      // Persisted before the slot is released. A cell that finished and was not
      // written is a cell the resume will buy again.
      //
      // A failure to *execute* is caught above and recorded; a failure to
      // *record* is deliberately not caught, and ends the batch. They are
      // opposite situations: one backend having a bad afternoon must not lose
      // the cells already bought, whereas a store that cannot be written to
      // means every further cell is money spent that no resume can find.
      await record(cell);
      records.push(cell);
      if (cell.outcome === 'ok') ok += 1;
      else failed += 1;
      inFlight -= 1;
      options.onCell?.(cell, records.length, queue.length);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
  await Promise.all(workers);

  return { attempted: queue.length, ok, failed, peakInFlight, records };
}
