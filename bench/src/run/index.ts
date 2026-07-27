/**
 * The benchmark run harness, in one import.
 *
 * `cell.ts` is the contract, `plan.ts` decides whether a batch may run,
 * `harness.ts` runs it, `store.ts` is the only part that reads a disk and
 * `dossier.ts` the only part that can spend. A test of any of the first three
 * needs none of the last two.
 *
 * Nothing here scores anything and nothing here renders anything; that is
 * BENCH-03 through BENCH-08. What this owns is the matrix, the resume key, the
 * spend refusal and one raw record per cell.
 */
export {
  cellKey,
  spreadEligibility,
  CellFailedSchema,
  CellOkSchema,
  CellRecordSchema,
  MAX_REPETITIONS,
  MIN_REPETITIONS_FOR_SPREAD,
} from './cell.js';
export type { CellFailed, CellOk, CellRecord, CellRef, SpreadEligibility } from './cell.js';

export { planBatch } from './plan.js';
export type { BatchPlan, PlanBatchInput } from './plan.js';

export { boundedConcurrency, runBatch, DEFAULT_CONCURRENCY } from './harness.js';
export type { BatchOutcome, ExecuteFailed, ExecuteOk, ExecuteResult, RunBatchOptions } from './harness.js';

export { appendCell, readCells } from './store.js';
export type { ReadCellsResult } from './store.js';

export { createCellExecutor, DEFAULT_CELL_TIMEOUT_MS } from './dossier.js';
export type { CellExecutorOptions } from './dossier.js';
