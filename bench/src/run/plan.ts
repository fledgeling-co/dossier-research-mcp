import { cellKey, MAX_REPETITIONS, spreadEligibility, type CellRef, type SpreadEligibility } from './cell.js';

/**
 * Planning a batch, before a batch can spend anything.
 *
 * **This file must never import `node:fs`.** It takes the task ids, the
 * backends, the repetition count, the keys already recorded and a per-cell cost
 * estimate, and returns either a refusal or a queue. Nothing here reaches a
 * network, a disk or a wallet, which is what makes the refusal testable.
 *
 * The ordering is the same one `src/research/runner.ts` uses and for the same
 * reason: everything free happens before anything paid. Subtract the completed
 * cells first, because they change the projection; total the *remainder*, not
 * the matrix; then refuse on the total before a single cell starts.
 */

export interface PlanBatchInput {
  /** Task ids, in corpus order. */
  readonly taskIds: readonly string[];
  /** Backends to run each task on. */
  readonly providers: readonly string[];
  /** Repetitions per pair. `1` is allowed; see `spreadEligibility`. */
  readonly repetitions: number;
  /**
   * Backend configuration this batch runs under, when it is not the default.
   *
   * Batch-wide rather than per-provider: a run comparing search on against
   * search off is two batches into one store, not one batch that silently
   * configures some backends differently from others.
   */
  readonly variant?: string;
  /** Cell keys already carrying a recorded outcome, from the cell store. */
  readonly completedKeys?: Iterable<string>;
  /** Cell keys whose recorded outcome was a failure. A subset of the above. */
  readonly failedKeys?: Iterable<string>;
  /**
   * Re-queue cells that failed.
   *
   * Off by default. A failed cell has a recorded outcome, and the brief's rule
   * is that it stays recorded rather than being retried into invisibility;
   * beyond that, a retry buys a second report whenever the first one was
   * actually charged. An operator who knows the failure was free turns this on.
   */
  readonly includeFailed?: boolean;
  /**
   * Worst-case cost of one cell, in dollars, for a given backend.
   *
   * Injected rather than computed, so this file needs nothing from `src/`, and
   * so the caller is forced to pass the same estimate the runner will reserve.
   */
  readonly estimateCellUsd: (provider: string) => number;
  /** The batch ceiling. The plan refuses above it. `0` disables the gate. */
  readonly ceilingUsd: number;
  /**
   * Headroom left in the server's rolling spend window, when the caller knows
   * it. Reported, never refused on: that window rolls while a multi-day batch
   * runs, so refusing on it would be wrong more often than right.
   */
  readonly rollingRemainingUsd?: number;
}

export interface BatchPlan {
  readonly totalCells: number;
  readonly alreadyDone: number;
  readonly queue: readonly CellRef[];
  /** Sum of the worst cases of the queued cells only. */
  readonly projectedUsd: number;
  readonly ceilingUsd: number;
  readonly rollingRemainingUsd?: number;
  /** True when the projection exceeds the ceiling. Nothing may start. */
  readonly refused: boolean;
  /** Why it was refused, naming the total it needed. Empty when it was not. */
  readonly refusal: string;
  /**
   * Whether the rolling window looks too small for the remainder. Advisory: the
   * batch is allowed to start and the runner enforces the window per cell.
   */
  readonly rollingWindowWarning: string;
  readonly repetitions: number;
  /** What a spread would be allowed to say if every queued cell succeeded. */
  readonly spreadIfComplete: SpreadEligibility;
}

const round2 = (n: number): number => Number(n.toFixed(2));

/**
 * Build the matrix, subtract what is done, and decide whether it may run.
 *
 * Cell order is task-major, then backend, then repetition. Deterministic on
 * purpose: two planners over the same inputs must queue the same cells in the
 * same order, or a resumed batch is not the same batch.
 */
export function planBatch(input: PlanBatchInput): BatchPlan {
  const { repetitions } = input;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > MAX_REPETITIONS) {
    throw new TypeError(
      `planBatch needs an integer repetitions between 1 and ${String(MAX_REPETITIONS)}; received ${String(repetitions)}`,
    );
  }
  if (!Number.isFinite(input.ceilingUsd) || input.ceilingUsd < 0) {
    throw new TypeError(
      `planBatch needs a non-negative ceiling; received ${String(input.ceilingUsd)}`,
    );
  }

  const completed = new Set(input.completedKeys ?? []);
  const failed = new Set(input.failedKeys ?? []);
  // A failed key that was never recorded as completed would silently widen the
  // queue on a re-plan, so the two sets are reconciled rather than trusted.
  const skip = new Set(completed);
  if (input.includeFailed === true) for (const key of failed) skip.delete(key);

  const queue: CellRef[] = [];
  let totalCells = 0;
  let projected = 0;

  for (const taskId of input.taskIds) {
    for (const provider of input.providers) {
      const perCell = input.estimateCellUsd(provider);
      if (!Number.isFinite(perCell) || perCell < 0) {
        throw new TypeError(
          `planBatch: estimateCellUsd(${provider}) returned ${String(perCell)}; a cost estimate must be a non-negative finite number`,
        );
      }
      for (let repeat = 1; repeat <= repetitions; repeat += 1) {
        totalCells += 1;
        const ref: CellRef =
          input.variant === undefined
            ? { taskId, provider, repeat }
            : { taskId, provider, repeat, variant: input.variant };
        if (skip.has(cellKey(ref))) continue;
        queue.push(ref);
        projected += perCell;
      }
    }
  }

  projected = round2(projected);
  const refused = input.ceilingUsd > 0 && projected > input.ceilingUsd;

  const rollingWindowWarning =
    input.rollingRemainingUsd !== undefined && projected > input.rollingRemainingUsd
      ? `The remaining ${String(queue.length)} cells project to $${projected.toFixed(2)} and only ` +
        `$${input.rollingRemainingUsd.toFixed(2)} is left in the server's rolling spend window. ` +
        'The batch may start, because that window rolls while it runs, but expect cells to be refused ' +
        'by the runner until it does.'
      : '';

  return {
    totalCells,
    alreadyDone: totalCells - queue.length,
    queue,
    projectedUsd: projected,
    ceilingUsd: input.ceilingUsd,
    ...(input.rollingRemainingUsd !== undefined
      ? { rollingRemainingUsd: input.rollingRemainingUsd }
      : {}),
    refused,
    refusal: refused
      ? `Batch refused before starting: ${String(queue.length)} remaining cells project to ` +
        `$${projected.toFixed(2)} at worst case, over the ceiling of $${input.ceilingUsd.toFixed(2)}. ` +
        'Nothing has been started and nothing has been charged. Raise the ceiling, narrow the task set, ' +
        'reduce the backends, or lower the repetition count.'
      : '',
    rollingWindowWarning,
    repetitions,
    spreadIfComplete: spreadEligibility(repetitions),
  };
}
