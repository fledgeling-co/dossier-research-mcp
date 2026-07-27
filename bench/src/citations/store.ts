import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEvidence, type CitationEvidence } from './evidence.js';

/**
 * Writing an evidence snapshot down, and finding it again.
 *
 * Without this the split between collection and scoring is a promise rather
 * than a mechanism: the collector would return a snapshot that lives only as
 * long as the process, and a scorer run three months later against a stored
 * report would have nothing to score it with. The design of record keeps raw
 * reports precisely so a metric added later can be applied to research already
 * paid for, and the evidence is half of what "later" needs.
 *
 * The path is derived from the cell key rather than recorded on the cell
 * record. `CellOkSchema` belongs to BENCH-02 and changing another slice's
 * contract to carry a field this one wants is the kind of cross-slice reach
 * that turns two merges into a conflict; a deterministic path costs nothing and
 * needs no agreement.
 */

/**
 * Where one cell's snapshot lives, under a directory the caller owns.
 *
 * The key is hashed. A cell key is a task id, a provider id and a repetition
 * index joined by a slash, and a slash is a directory separator: building a
 * path out of it directly would scatter snapshots across a tree shaped by
 * whatever a task was called.
 */
export function evidencePath(dir: string, cellKey: string): string {
  const digest = createHash('sha256').update(cellKey).digest('hex').slice(0, 40);
  return join(dir, `${digest}.json`);
}

/**
 * Write a snapshot atomically.
 *
 * Temp file then rename, the same pattern as `src/store/store.ts`, so a crash
 * or a concurrent reader never sees half a document. A half-written snapshot
 * that still parsed would be the worst outcome available here: it would score,
 * quietly, over whichever citations happened to be flushed.
 */
export function writeEvidence(dir: string, cellKey: string, evidence: CitationEvidence): string {
  const target = evidencePath(dir, cellKey);
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(evidence)}\n`, 'utf8');
  renameSync(temp, target);
  return target;
}

/**
 * Read a snapshot back, as a trust boundary.
 *
 * Zod-parsed, and a malformed one throws rather than being partially used.
 * Deliberately fatal, and the opposite of the store's skip-the-bad-record rule
 * for a listing: a listing that drops a row still shows the rest, while a score
 * computed over evidence nobody can vouch for is a number about a sample nobody
 * chose. `undefined` is returned only when there is no snapshot at all, which
 * is an honest absence and reaches the scorer as `unmeasurable / no-evidence`.
 */
export function readEvidence(dir: string, cellKey: string): CitationEvidence | undefined {
  let raw: string;
  try {
    raw = readFileSync(evidencePath(dir, cellKey), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new TypeError(
      `the citation evidence snapshot for ${cellKey} is not valid JSON, so it was not scored against`,
    );
  }
  return parseEvidence(parsed);
}

/**
 * Whether a snapshot was collected for the report it is about to score.
 *
 * A snapshot carries the hash of the report it was collected from. Scoring one
 * report against another's evidence would produce a full set of plausible
 * numbers with nothing behind them, and the mismatch is silent unless somebody
 * checks. The caller decides what to do about a mismatch; this only reports it.
 */
export function evidenceMatchesReport(evidence: CitationEvidence, report: string): boolean {
  if (evidence.reportSha256 === undefined) return true;
  return evidence.reportSha256 === createHash('sha256').update(report).digest('hex');
}
