/**
 * What has actually been read, per run.
 *
 * The failure this exists for, observed in a real session: an agent ran a panel
 * of five backends, read one report in full, one executive summary, four
 * sections of another's eighteen, and nothing at all from a fifth, then wrote a
 * confident synthesis as though it had read them all. Asked how, it said it had
 * leaned on the merge tool's claims list as a substitute for reading, a list
 * whose own output says it measures coverage difference rather than agreement.
 *
 * The disclosure was there and it did not work, because a note in the middle of
 * a long output is something a reader in a hurry skims. This repo already knows
 * the answer to that shape of problem. A prompt can ask a model not to invent a
 * supporting reference; a server holding the registry can refuse the draft. The
 * same move applies one level up: a prompt can ask an agent to read the reports,
 * and a server that records what was returned can say plainly how much of it was
 * ever looked at.
 *
 * The critical distinction is that **an outline is not the report**. Reading an
 * outline is precisely what creates the impression of having read, since it
 * gives every heading and no content, so outline reads are recorded and counted
 * separately and never toward coverage.
 */

import { z } from 'zod';

/** One `research_read` call that returned content. */
export const ReadEventSchema = z.object({
  /** `section` and `full` carry content. `outline`, `summary` and `grep` do not. */
  mode: z.enum(['outline', 'section', 'grep', 'summary', 'full']),
  /** Section indexes whose text was returned. Empty for non-section modes. */
  sections: z.array(z.number().int().min(1)).default([]),
  /** Characters of report text actually returned, after any clamp. */
  chars: z.number().int().min(0).default(0),
  at: z.string(),
});
export type ReadEvent = z.infer<typeof ReadEventSchema>;

export const ReadLedgerSchema = z.object({
  runId: z.string(),
  events: z.array(ReadEventSchema).default([]),
});
export type ReadLedger = z.infer<typeof ReadLedgerSchema>;

/** Modes that put report text in front of a reader. */
const SUBSTANTIVE: ReadonlySet<ReadEvent['mode']> = new Set(['section', 'full']);

export interface ReadCoverage {
  /** Distinct sections whose text was returned. */
  readonly sectionsRead: number;
  readonly sectionsTotal: number;
  /** 0 to 1 over sections. */
  readonly fraction: number;
  readonly charsRead: number;
  readonly charsTotal: number;
  /** True when the only reads were outline, summary or grep. */
  readonly outlineOnly: boolean;
  readonly reads: number;
}

/**
 * How much of a report has been read.
 *
 * Counts distinct sections rather than calls, because reading section 3 five
 * times is not five sections, and an agent that re-reads while composing would
 * otherwise show as having covered a report it barely opened.
 */
export function readCoverage(
  ledger: ReadLedger | undefined,
  sectionsTotal: number,
  charsTotal: number,
): ReadCoverage {
  const events = ledger?.events ?? [];
  const substantive = events.filter((e) => SUBSTANTIVE.has(e.mode));
  const distinct = new Set<number>();
  let chars = 0;
  for (const e of substantive) {
    for (const s of e.sections) distinct.add(s);
    chars += e.chars;
    // A `full` read covers everything, however it was clamped. The clamp is
    // reported through chars; pretending a truncated full read covered every
    // section would be the same lie in a different place.
    if (e.mode === 'full' && sectionsTotal > 0) {
      for (let i = 1; i <= sectionsTotal; i += 1) distinct.add(i);
    }
  }
  const sectionsRead = Math.min(distinct.size, sectionsTotal);
  return {
    sectionsRead,
    sectionsTotal,
    fraction: sectionsTotal === 0 ? 0 : sectionsRead / sectionsTotal,
    charsRead: Math.min(chars, charsTotal),
    charsTotal,
    outlineOnly: substantive.length === 0 && events.length > 0,
    reads: events.length,
  };
}

/**
 * One line per member, and a warning when a synthesis is being written over
 * reports nobody opened.
 *
 * Deliberately at the TOP of a merge rather than in a footnote. The disclosure
 * that failed was accurate and buried, and the lesson is that where a caveat
 * sits decides whether it is read.
 */
export function renderReadCoverage(
  rows: readonly { readonly runId: string; readonly label: string; readonly coverage: ReadCoverage }[],
): string {
  if (rows.length === 0) return '';

  const unread = rows.filter((r) => r.coverage.reads === 0);
  const outlineOnly = rows.filter((r) => r.coverage.outlineOnly);
  const thin = rows.filter((r) => !r.coverage.outlineOnly && r.coverage.reads > 0 && r.coverage.fraction < 0.5);

  const lines = rows.map((r) => {
    const c = r.coverage;
    if (c.reads === 0) return `- **${r.label}** (\`${r.runId}\`): **never opened**`;
    if (c.outlineOnly) return `- **${r.label}** (\`${r.runId}\`): outline only, **no section read**`;
    return `- **${r.label}** (\`${r.runId}\`): ${String(c.sectionsRead)} of ${String(c.sectionsTotal)} section(s) read`;
  });

  const problems = unread.length + outlineOnly.length + thin.length;
  const header =
    problems === 0
      ? '### What has been read'
      : '> [!WARNING]\n> **This merge is over reports that have mostly not been read.**';

  const note =
    problems === 0
      ? ''
      : [
          '',
          `> ${String(unread.length)} never opened, ${String(outlineOnly.length)} read as an outline only, ${String(thin.length)} under half read.`,
          '>',
          '> An outline gives every heading and no content, which is exactly what makes it feel like having read. The claims list below is a **coverage difference between reports**, not a summary of them, and it is not a substitute for the reports. A synthesis written from it describes what the backends did not share rather than what they found.',
        ].join('\n');

  return [header, note, '', ...lines, ''].filter((l) => l !== '').join('\n');
}
