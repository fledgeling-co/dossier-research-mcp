import { z } from 'zod';

/**
 * What one cell of the benchmark matrix is, and what it leaves behind.
 *
 * **This file must never import `node:fs`.** Same rule, and the same reason, as
 * `bench/src/tasks/corpus.ts`: everything that decides anything is testable
 * without a filesystem, a network or a wallet. `store.ts` is the only part of
 * this slice that reads a disk and `dossier.ts` the only part that can spend.
 *
 * A cell is one task, on one backend, at one repetition index. The matrix is
 * the cross product of those three, and the reason the third axis exists at all
 * is that deep research is non-deterministic: a single run per pair is a rank
 * ordering of noise, so `docs/plan/benchmark.md` runs every task `n` times and
 * reports a median with a spread.
 */

/** Repetition indices are 1-based and this is the ceiling, matching the store. */
export const MAX_REPETITIONS = 1000;

/**
 * How many completed repetitions a spread needs before it means anything.
 *
 * Three, taken from `docs/plan/benchmark.md` ("`n = 5` is the target; `n = 3`
 * is the floor at which a spread is reported at all") rather than re-decided
 * here. The brief allows `n = 1`; what it forbids is quoting a spread from it.
 */
export const MIN_REPETITIONS_FOR_SPREAD = 3;

/**
 * Separator for the cell key.
 *
 * A task id is a slug and a provider id is an enum member, so neither can
 * contain a `/`. That matters more than it looks: the key is what resume
 * subtracts, and a key two different cells can collide on is a cell silently
 * bought twice or a cell silently never bought at all.
 */
const KEY_SEPARATOR = '/';

export interface CellRef {
  readonly taskId: string;
  /** A `ProviderId`, kept as a string here so this file stays free of `src/`. */
  readonly provider: string;
  /** 1-based. Never 0: see `FingerprintInput.repeat` in `src/research/contract.ts`. */
  readonly repeat: number;
}

/** The stable identity of a cell, used as the resume key and stored on the record. */
export function cellKey(ref: CellRef): string {
  return [ref.taskId, ref.provider, String(ref.repeat)].join(KEY_SEPARATOR);
}

const isoTimestamp = z.string().min(1).max(40);

const cellBase = {
  key: z.string().min(1).max(300),
  taskId: z.string().min(1).max(120),
  provider: z.string().min(1).max(60),
  repeat: z.number().int().min(1).max(MAX_REPETITIONS),
  startedAt: isoTimestamp,
  finishedAt: isoTimestamp,
  /**
   * Wall clock, recorded per cell because a backend that scores two points
   * higher for six times the time is a finding rather than a winner.
   */
  wallClockMs: z.number().int().nonnegative(),
  /**
   * What the run reserved, which is the worst case of its band rather than a
   * quote. `CLAUDE.md`: cost figures are estimate bands, never quotes.
   */
  estimatedCostUsd: z.number().nonnegative(),
  /** The Dossier run id, so the ledger line and the report are recoverable. */
  runId: z.string().max(64).optional(),
};

/**
 * A cell that produced a report.
 *
 * The report is referenced, not inlined: a Deep Research report is roughly
 * 60,000 tokens and 4,000 of them in one JSONL file is a store nothing can
 * open. `reportPath` is relative to the Dossier store directory, exactly as
 * `RunRecord.reportPath` is.
 */
export const CellOkSchema = z.strictObject({
  ...cellBase,
  outcome: z.literal('ok'),
  reportPath: z.string().min(1).max(500),
  reportChars: z.number().int().nonnegative(),
  sourceCount: z.number().int().nonnegative(),
});

/**
 * A cell that did not.
 *
 * Recorded rather than omitted, and this is the whole point of the arm: an
 * omitted failure silently improves the backend's score, which is the same
 * defect as a throttled search counting as an established absence. The 2026
 * prior art makes the same case from the other end and promotes completion rate
 * to a validity metric, which is only computable if the failures are here.
 */
export const CellFailedSchema = z.strictObject({
  ...cellBase,
  outcome: z.literal('failed'),
  reason: z.string().min(1).max(4000),
  /** The runner's own classification, when there was one. */
  failureKind: z.string().max(60).optional(),
  failureStatus: z.number().int().optional(),
});

/**
 * A cell record, with its key checked against the coordinates it claims.
 *
 * The refinement is the load-bearing part. Validating `key`, `taskId`,
 * `provider` and `repeat` independently leaves a schema-valid line whose key
 * belongs to a different cell, and `readCells` trusts the key: a resume would
 * then mark a cell completed that was never bought, and it would never be
 * bought. Derived here rather than trusted, so the two can never disagree.
 */
export const CellRecordSchema = z
  .discriminatedUnion('outcome', [CellOkSchema, CellFailedSchema])
  .refine((c) => c.key === cellKey(c), {
    message: 'key does not match its own taskId, provider and repeat',
    path: ['key'],
  });

export type CellOk = z.infer<typeof CellOkSchema>;
export type CellFailed = z.infer<typeof CellFailedSchema>;
export type CellRecord = z.infer<typeof CellRecordSchema>;

export interface SpreadEligibility {
  readonly reportable: boolean;
  readonly completed: number;
  readonly floor: number;
  readonly reason: string;
}

/**
 * May a spread be stated over this many completed repetitions?
 *
 * Counted over cells that actually produced a report, never over the `n` that
 * was asked for. A batch that requested five and landed two has two samples,
 * and a spread quoted from the request rather than the result is the same
 * fabrication as counting a deduped run five times.
 *
 * The rule lives here, once, so the reporting item and the statistics item
 * cannot end up disagreeing about what the floor is.
 */
export function spreadEligibility(completed: number): SpreadEligibility {
  const floor = MIN_REPETITIONS_FOR_SPREAD;
  if (!Number.isInteger(completed) || completed < 0) {
    throw new TypeError(
      `spreadEligibility needs a non-negative integer count; received ${String(completed)}`,
    );
  }
  if (completed >= floor) {
    return {
      reportable: true,
      completed,
      floor,
      reason: `${String(completed)} completed repetitions, at or above the floor of ${String(floor)}`,
    };
  }
  return {
    reportable: false,
    completed,
    floor,
    reason:
      completed === 0
        ? 'no repetition completed, so there is nothing to spread'
        : `only ${String(completed)} completed repetition${completed === 1 ? '' : 's'}, below the floor of ${String(floor)}; report the value without a spread`,
  };
}
