/**
 * Whether a finished report is actually a report.
 *
 * Two pathologies from one real session, both of which the caller had to
 * diagnose by reading:
 *
 * 1. **A run that echoed its prompt instead of researching.** It completed, it
 *    had length, and the agent's first read was "the UI run failed, it echoed the
 *    prompt". Nothing in Dossier noticed. A backend handed a long brief and no
 *    working search will sometimes restate the brief, which produces a report
 *    whose character count and section headings look entirely normal.
 *
 * 2. **A report delivered twice in one body.** The same session: "the
 *    auto-summary was wrong, the report is complete, just duplicated". The
 *    duplication is what made the summary wrong, because the summariser read a
 *    body that says everything twice.
 *
 * Both are cheap to detect and neither was being detected. Both are reported
 * rather than acted on: a duplicated report still contains a complete report,
 * and refusing to hand it back would destroy something already paid for. The
 * caller is told, and decides.
 *
 * Pure string work, no model call. `sourceCount` already catches the third
 * pathology in this family, a report that cites nothing.
 */

/** Shingle a string into overlapping word n-grams for overlap comparison. */
function shingles(text: string, n = 8): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i += 1) out.add(words.slice(i, i + n).join(' '));
  return out;
}

/**
 * How much of the prompt reappears verbatim in the report.
 *
 * Measured as the share of the PROMPT's phrases found in the report, not the
 * reverse. A long report that happens to restate the question scores low, which
 * is correct; a report that is mostly the brief scores high, which is the case
 * worth catching.
 *
 * Eight-word shingles because a research brief and its report legitimately share
 * short phrases (the subject, the entity names, "power limit"), and anything
 * shorter would flag every honest report on a narrow topic.
 */
export function promptEchoRatio(markdown: string, prompt: string): number {
  const promptShingles = shingles(prompt);
  if (promptShingles.size < 5) return 0;
  const reportShingles = shingles(markdown);
  let hits = 0;
  for (const s of promptShingles) if (reportShingles.has(s)) hits += 1;
  return hits / promptShingles.size;
}

/**
 * How much of the report is a repeat of another part of the report.
 *
 * Counts duplicated shingles rather than looking for one big repeated block, so
 * it catches both a body pasted twice and a report that says the same three
 * paragraphs in four sections.
 */
export function selfDuplicationRatio(markdown: string): number {
  const words = markdown
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const n = 8;
  if (words.length < n * 4) return 0;
  const seen = new Set<string>();
  let total = 0;
  let repeats = 0;
  for (let i = 0; i + n <= words.length; i += 1) {
    const key = words.slice(i, i + n).join(' ');
    total += 1;
    if (seen.has(key)) repeats += 1;
    else seen.add(key);
  }
  return total === 0 ? 0 : repeats / total;
}

/**
 * The thresholds, and where they come from.
 *
 * Both are judgement rather than measurement, set from the two observed cases and
 * deliberately loose. A false positive here costs a sentence of warning the
 * reader can dismiss; a false negative is a caller reporting a brief back to a
 * user as findings, which is what happened. So they are set to catch, and the
 * warning says it is a signal rather than a verdict.
 */
export const ECHO_THRESHOLD = 0.5;
export const DUPLICATION_THRESHOLD = 0.35;

export interface ReportQa {
  readonly echoRatio: number;
  readonly duplicationRatio: number;
  readonly echoesPrompt: boolean;
  readonly heavilyDuplicated: boolean;
}

export function assessReport(markdown: string, prompt: string): ReportQa {
  const echoRatio = promptEchoRatio(markdown, prompt);
  const duplicationRatio = selfDuplicationRatio(markdown);
  return {
    echoRatio,
    duplicationRatio,
    echoesPrompt: echoRatio >= ECHO_THRESHOLD,
    heavilyDuplicated: duplicationRatio >= DUPLICATION_THRESHOLD,
  };
}

/** What to say about a suspicious report. Empty when it looks fine. */
export function renderReportQa(qa: ReportQa): string[] {
  const lines: string[] = [];
  if (qa.echoesPrompt) {
    lines.push(
      `> [!WARNING]`,
      `> **${String(Math.round(qa.echoRatio * 100))}% of the brief reappears verbatim in this report.** A backend with no working web search will sometimes restate the brief instead of researching it, which produces a report of entirely normal length and structure. Read a section before treating any of this as findings, and check \`research_doctor { probeSearch: true }\` for that backend.`,
    );
  }
  if (qa.heavilyDuplicated) {
    lines.push(
      `> [!WARNING]`,
      `> **${String(Math.round(qa.duplicationRatio * 100))}% of this report repeats itself.** The report is probably complete and delivered twice rather than truncated, so nothing is missing, but any summary of it was written from a body that says everything twice and should not be trusted. Read it by section.`,
    );
  }
  return lines;
}
