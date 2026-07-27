import type { Store } from '../../../src/store/store.js';
import type { Runner } from '../../../src/research/runner.js';
import type { RunRecord } from '../../../src/store/types.js';
import { TERMINAL_STATES } from '../../../src/store/types.js';
import type { BenchTask } from '../tasks/index.js';
import type { CellRef } from './cell.js';
import type { ExecuteResult } from './harness.js';

/**
 * The only file in this slice that can spend money.
 *
 * Everything else takes this as an injected `execute`, which is what lets the
 * planner, the harness and the store be tested without a wallet. Kept as thin
 * as it can be for the same reason: the logic that decides anything lives in
 * the pure files, and what is left here is start, wait, read.
 *
 * **It goes through `Runner.start()` and never around it.** That is the brief's
 * requirement and it is not a formality: the runner is where dedupe, the
 * concurrency cap, the per-provider budget, the rolling-window budget and the
 * ledger line all live, in that order, and a benchmark that opened its own path
 * to a provider would be a second admission-control implementation that
 * eventually disagrees with the first about what the ceiling is.
 */

export interface CellExecutorOptions {
  readonly runner: Runner;
  readonly store: Store;
  /** Task lookup by id, so the executor never re-reads the corpus per cell. */
  readonly tasks: ReadonlyMap<string, BenchTask>;
  /** Builds the start arguments for one cell. Supplied by the caller. */
  readonly startArgs: (task: BenchTask, cell: CellRef) => Parameters<Runner['start']>[0];
  /** How long to wait for one cell before giving up on it. */
  readonly cellTimeoutMs?: number;
  /** How often to re-read the run record. */
  readonly pollIntervalMs?: number;
  /** Injected for tests; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * An hour and a half.
 *
 * `CLAUDE.md` puts a run at 4 to 60 minutes, so this is the top of the observed
 * range plus headroom rather than a guess. A cell that outlives it is recorded
 * as failed with the elapsed time named; the run itself is left alone, because
 * it has already been paid for and may still finish, and the operator can find
 * it by the run id on the record.
 */
export const DEFAULT_CELL_TIMEOUT_MS = 90 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 15_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function isTerminal(run: RunRecord): boolean {
  return TERMINAL_STATES.includes(run.state);
}

/**
 * Build the `execute` the harness calls, one cell at a time.
 *
 * The dedupe interaction is the subtle part and is worth stating. Every cell
 * carries its 1-based repetition index into the fingerprint, so five repeats of
 * one task on one backend are five distinct purchases rather than one run
 * returned five times. A cell that *is* reported as deduped is therefore not a
 * repetition collapse; it means this exact cell was already bought inside the
 * dedupe window, which is what should happen when a batch is resumed after a
 * crash that lost the store's last line. It is recorded as ok, because the
 * report exists and was paid for.
 */
export function createCellExecutor(
  options: CellExecutorOptions,
): (ref: CellRef) => Promise<ExecuteResult> {
  const {
    runner,
    store,
    tasks,
    startArgs,
    cellTimeoutMs = DEFAULT_CELL_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    sleep = defaultSleep,
  } = options;

  return async (ref: CellRef): Promise<ExecuteResult> => {
    const task = tasks.get(ref.taskId);
    if (!task) {
      return { outcome: 'failed', reason: `no task in the corpus with id "${ref.taskId}"` };
    }

    let run: RunRecord;
    try {
      const started = await runner.start(startArgs(task, ref));
      run = started.run;
    } catch (e: unknown) {
      // Includes the budget and concurrency refusals. Recorded as a failed
      // cell rather than allowed to end the batch: a run refused because the
      // rolling window is momentarily full is a cell to re-plan later, not a
      // reason to abandon the cells already bought.
      return { outcome: 'failed', reason: e instanceof Error ? e.message : String(e) };
    }

    const deadline = Date.now() + cellTimeoutMs;
    let current: RunRecord = run;
    while (!isTerminal(current)) {
      if (Date.now() >= deadline) {
        return {
          outcome: 'failed',
          runId: run.id,
          estimatedCostUsd: current.estimatedCostUsd,
          reason:
            `the cell was still ${current.state} after ${String(Math.round(cellTimeoutMs / 60_000))} minutes and was abandoned by the harness. ` +
            'The run itself was not cancelled and has already been charged; look it up by this run id.',
        };
      }
      await sleep(pollIntervalMs);
      const fresh = await store.getRun(run.id);
      if (!fresh) {
        return {
          outcome: 'failed',
          runId: run.id,
          estimatedCostUsd: current.estimatedCostUsd,
          reason: 'the run record disappeared from the store while the cell was waiting on it',
        };
      }
      current = fresh;
    }

    if (current.state !== 'completed') {
      return {
        outcome: 'failed',
        runId: current.id,
        estimatedCostUsd: current.estimatedCostUsd,
        // The upstream text first, exactly as the runner records it. It is what
        // distinguishes a quota problem from a broken adapter, and a paraphrase
        // sends the bug report to the wrong person.
        reason: current.error ?? `the run ended ${current.state} with no recorded reason`,
        failureKind: current.failureKind ?? current.state,
        ...(current.failureStatus !== undefined ? { failureStatus: current.failureStatus } : {}),
      };
    }

    if (current.reportPath === undefined) {
      return {
        outcome: 'failed',
        runId: current.id,
        estimatedCostUsd: current.estimatedCostUsd,
        reason: 'the run completed but recorded no report path, so there is nothing to score',
      };
    }

    return {
      outcome: 'ok',
      runId: current.id,
      estimatedCostUsd: current.estimatedCostUsd,
      // Referenced, never inlined. A 60,000-token report per line would make
      // the cell store unopenable at the scale it is designed for.
      reportPath: current.reportPath,
      reportChars: current.reportChars,
      sourceCount: current.sourceCount,
    };
  };
}
