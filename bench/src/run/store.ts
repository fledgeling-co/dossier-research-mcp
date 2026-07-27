import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CellRecordSchema, type CellRecord } from './cell.js';

/**
 * The raw cell store: one JSON object per line, appended, never rewritten.
 *
 * The only file in this slice that touches a disk, kept apart for the same
 * reason `bench/src/tasks/files.ts` is: the planner and the harness are then
 * testable against values rather than against a filesystem.
 *
 * Append-only is the design, not a shortcut. `docs/plan/benchmark.md` separates
 * the run from the scoring so a metric invented in three months can be applied
 * to research already paid for, and that only works if the raw cell is still
 * there in the shape it arrived in. It is also what makes resume correct: a
 * process killed mid-batch has every finished cell already on disk, because the
 * harness awaits the append before releasing the slot.
 *
 * Synchronous throughout. One append per cell against a cell that took minutes
 * to buy is not a throughput problem, and a synchronous append cannot interleave
 * two half-written lines from this process.
 */

export interface ReadCellsResult {
  readonly cells: readonly CellRecord[];
  /** Keys with any recorded outcome. This is what resume subtracts. */
  readonly completedKeys: ReadonlySet<string>;
  /** Keys whose recorded outcome was a failure. A subset of the above. */
  readonly failedKeys: ReadonlySet<string>;
  /**
   * Lines that could not be read as a cell.
   *
   * Reported rather than thrown, and this is the one place in the benchmark
   * where skip-and-continue is right. The corpus loader fails a whole load
   * because a dropped *task* silently narrows the sample; a damaged *result*
   * line is a cell that will simply be re-run, which is the safe direction. A
   * throw here would mean one torn line at the end of a 4,000-cell file makes
   * the other 3,999 unreadable and un-resumable.
   */
  readonly unreadableLines: readonly { readonly line: number; readonly reason: string }[];
}

const EMPTY: ReadCellsResult = {
  cells: [],
  completedKeys: new Set(),
  failedKeys: new Set(),
  unreadableLines: [],
};

/**
 * Read every cell already recorded at `path`.
 *
 * A missing file is an empty result, not an error: the first run of a batch has
 * no store yet, and making the caller special-case that is how a first run ends
 * up crashing on a path that will exist forever after.
 */
export function readCells(path: string): ReadCellsResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw e;
  }

  const cells: CellRecord[] = [];
  const completedKeys = new Set<string>();
  const failedKeys = new Set<string>();
  const unreadableLines: { line: number; reason: string }[] = [];

  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unreadableLines.push({ line: index + 1, reason: 'not valid JSON' });
      continue;
    }
    const result = CellRecordSchema.safeParse(parsed);
    if (!result.success) {
      unreadableLines.push({
        line: index + 1,
        reason: result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; '),
      });
      continue;
    }
    cells.push(result.data);
    completedKeys.add(result.data.key);
    if (result.data.outcome === 'failed') failedKeys.add(result.data.key);
    else failedKeys.delete(result.data.key);
  }

  return { cells, completedKeys, failedKeys, unreadableLines };
}

/**
 * Append one cell.
 *
 * Validated on the way out as well as on the way back in. Writing a record the
 * reader will later reject would make the cell invisible to resume and buy it a
 * second time, and the cheapest place to catch that is here.
 */
export function appendCell(path: string, cell: CellRecord): void {
  const parsed = CellRecordSchema.parse(cell);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(parsed)}\n`, 'utf8');
}
