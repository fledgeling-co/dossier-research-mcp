import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cellKey, type CellRecord } from './cell.js';
import { appendCell, readCells } from './store.js';

/**
 * The raw cell store: the one file in this slice that touches a disk, and the
 * thing resume subtracts from. A cell it loses is a cell bought twice.
 */

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bench-cells-'));
  path = join(dir, 'nested', 'cells.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const okCell = (over: Partial<CellRecord> = {}): CellRecord => ({
  key: cellKey({ taskId: 't1', provider: 'gemini', repeat: 1 }),
  taskId: 't1',
  provider: 'gemini',
  repeat: 1,
  startedAt: '2026-07-27T00:00:00.000Z',
  finishedAt: '2026-07-27T00:10:00.000Z',
  wallClockMs: 600_000,
  estimatedCostUsd: 3,
  runId: 'run_1',
  outcome: 'ok',
  reportPath: 'reports/run_1.md',
  reportChars: 61_234,
  sourceCount: 48,
  ...over,
} as CellRecord);

const failedCell = (over: Partial<CellRecord> = {}): CellRecord =>
  ({
    key: cellKey({ taskId: 't2', provider: 'xai', repeat: 2 }),
    taskId: 't2',
    provider: 'xai',
    repeat: 2,
    startedAt: '2026-07-27T00:00:00.000Z',
    finishedAt: '2026-07-27T00:00:30.000Z',
    wallClockMs: 30_000,
    estimatedCostUsd: 0,
    outcome: 'failed',
    reason: 'HTTP 429: rate limited',
    failureKind: 'quota',
    failureStatus: 429,
    ...over,
  }) as CellRecord;

describe('cell store', () => {
  // BATCH-11
  it('BATCH-11: a missing file reads as empty rather than throwing', () => {
    const result = readCells(path);
    expect(result.cells).toHaveLength(0);
    expect(result.completedKeys.size).toBe(0);
    expect(result.unreadableLines).toHaveLength(0);
  });

  it('BATCH-11: round-trips a cell through the file, creating the directory', () => {
    appendCell(path, okCell());
    const result = readCells(path);
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]).toEqual(okCell());
    expect([...result.completedKeys]).toEqual(['t1/gemini/1']);
    expect(result.failedKeys.size).toBe(0);
  });

  it('BATCH-11: appends rather than rewriting, so earlier cells survive', () => {
    appendCell(path, okCell());
    appendCell(path, failedCell());
    appendCell(path, okCell({ key: 't3/gemini/1', taskId: 't3' }));

    const raw = readFileSync(path, 'utf8');
    expect(raw.trimEnd().split('\n')).toHaveLength(3);

    const result = readCells(path);
    expect(result.cells).toHaveLength(3);
    expect([...result.completedKeys].sort()).toEqual(['t1/gemini/1', 't2/xai/2', 't3/gemini/1']);
    // A failure is completed AND failed; resume subtracts the first set.
    expect([...result.failedKeys]).toEqual(['t2/xai/2']);
  });

  it('BATCH-11: a failed cell is readable with its reason intact, never omitted', () => {
    appendCell(path, failedCell());
    const [cell] = readCells(path).cells;
    expect(cell?.outcome).toBe('failed');
    expect(cell?.outcome === 'failed' && cell.reason).toBe('HTTP 429: rate limited');
    expect(cell?.outcome === 'failed' && cell.failureStatus).toBe(429);
  });

  it('a cell later retried successfully stops counting as failed', () => {
    appendCell(path, failedCell());
    appendCell(path, okCell({ key: 't2/xai/2', taskId: 't2', provider: 'xai', repeat: 2 }));
    const result = readCells(path);
    expect(result.completedKeys.has('t2/xai/2')).toBe(true);
    expect(result.failedKeys.size).toBe(0);
  });

  // BATCH-12. The one place in this benchmark where skip-and-continue is right.
  // The corpus loader fails a whole load because a dropped TASK narrows the
  // sample; a damaged RESULT line is a cell that will simply be re-run.
  it('BATCH-12: a torn last line is reported and skipped, and the rest still read', () => {
    appendCell(path, okCell());
    appendCell(path, okCell({ key: 't9/gemini/1', taskId: 't9' }));
    // A process killed mid-append leaves exactly this.
    appendFileSync(path, '{"key":"t5/gemini/1","taskId":"t5","prov');

    const result = readCells(path);
    expect(result.cells).toHaveLength(2);
    expect(result.unreadableLines).toHaveLength(1);
    expect(result.unreadableLines[0]).toMatchObject({ line: 3, reason: 'not valid JSON' });
    // The decisive part: the two good cells are still subtractable, so the
    // resume does not re-buy them because of one torn line.
    expect(result.completedKeys.size).toBe(2);
  });

  it('BATCH-12: a line that is valid JSON but not a cell is reported with its field path', () => {
    appendCell(path, okCell());
    appendFileSync(path, `${JSON.stringify({ ...okCell(), repeat: 0 })}\n`);
    appendFileSync(path, `${JSON.stringify({ hello: 'world' })}\n`);

    const result = readCells(path);
    expect(result.cells).toHaveLength(1);
    expect(result.unreadableLines).toHaveLength(2);
    expect(result.unreadableLines[0]?.reason).toContain('repeat');
  });

  it('BATCH-12: blank lines and trailing whitespace are not mistaken for damage', () => {
    appendCell(path, okCell());
    appendFileSync(path, '\n   \n');
    appendCell(path, okCell({ key: 't7/gemini/1', taskId: 't7' }));
    const result = readCells(path);
    expect(result.cells).toHaveLength(2);
    expect(result.unreadableLines).toHaveLength(0);
  });

  // BATCH-13. Writing a record the reader will later reject makes the cell
  // invisible to resume and buys it a second time. The cheapest place to catch
  // that is at the write.
  it('BATCH-13: a record the reader would reject is refused at write time', () => {
    expect(() => appendCell(path, okCell({ repeat: 0 }))).toThrow();
    expect(() => appendCell(path, okCell({ repeat: 1.5 }))).toThrow();
    expect(() => appendCell(path, okCell({ estimatedCostUsd: -1 }))).toThrow();
    expect(() => appendCell(path, failedCell({ reason: '' }))).toThrow();
    // Nothing reached the file, so a refused write cannot leave a torn line.
    expect(readCells(path).cells).toHaveLength(0);
  });

  it('BATCH-13: an unknown field is rejected rather than silently stored', () => {
    // Same posture as the task schema: a field nothing reads is a field
    // somebody believed was being recorded.
    expect(() => appendCell(path, { ...okCell(), surprise: 1 } as unknown as CellRecord)).toThrow();
  });

  // BATCH-13. A schema-valid line whose key belongs to a different cell would
  // mark that cell completed even though it was never bought, and it would then
  // never be bought. The key is derived and checked rather than trusted.
  it('BATCH-13: a key that disagrees with its own coordinates is refused', () => {
    expect(() => appendCell(path, okCell({ key: 'somewhere-else/gemini/1' }))).toThrow();
    expect(() => appendCell(path, okCell({ key: 't1/gemini/2' }))).toThrow();
    expect(readCells(path).cells).toHaveLength(0);
  });

  // Two rows can legitimately share a key: a retry after a failure, or two
  // batches over one store where the second collapses onto the first through
  // Dossier's fingerprint dedupe. Double-counting them in every downstream
  // average is the exact defect measured in promptfoo's resume.
  it('BATCH-11: two rows for one cell collapse to the later one, and the fact is reported', () => {
    appendCell(path, failedCell());
    appendCell(path, okCell({ key: 't2/xai/2', taskId: 't2', provider: 'xai', repeat: 2 }));
    appendCell(path, okCell());

    const result = readCells(path);
    expect(result.cells).toHaveLength(2);
    expect(result.supersededRows).toBe(1);
    expect(result.completedKeys.size).toBe(2);
    // Last write wins, so the retry's success is what counts.
    expect(result.cells.find((c) => c.key === 't2/xai/2')?.outcome).toBe('ok');
    // And the record list and the completed set can never disagree.
    expect(new Set(result.cells.map((c) => c.key))).toEqual(result.completedKeys);
  });

  it('BATCH-13: a report is referenced, never inlined', () => {
    appendCell(path, okCell());
    // 4,000 cells at ~60k tokens each would make the store unopenable, so the
    // schema has no field a report body could be written into.
    expect(readFileSync(path, 'utf8').length).toBeLessThan(1000);
    expect(readCells(path).cells[0]).toMatchObject({ reportPath: 'reports/run_1.md' });
  });
});
