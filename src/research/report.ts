/**
 * Report reading — the context-window discipline.
 *
 * A Deep Research report is ~60k output tokens. Returning one inline into a
 * coding agent's context is a guaranteed blow-up at the worst possible moment,
 * so this server never does it. `research_read` defaults to an outline with a
 * per-section token estimate, and the caller pulls only the sections it needs.
 *
 * Everything here is pure string work — no I/O, fully unit-testable.
 */

export interface ReportSection {
  /** 1-based index, stable for a given report. */
  readonly index: number;
  /** Heading text, without the leading hashes. */
  readonly title: string;
  /** Heading depth (1 = `#`, 2 = `##`, …). */
  readonly level: number;
  /** Character offset of the section body start (after the heading line). */
  readonly start: number;
  readonly end: number;
  readonly chars: number;
  readonly estimatedTokens: number;
}

/**
 * Token estimate: ~4 characters per token is the well-worn heuristic for
 * English prose and is close enough for a budgeting decision. It is labelled
 * "estimated" everywhere it surfaces so nobody mistakes it for a tokeniser.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*$/gm;

/** Split a markdown report into its headed sections. */
export function outlineReport(markdown: string): ReportSection[] {
  const matches = [...markdown.matchAll(HEADING)];
  if (matches.length === 0) {
    return [
      {
        index: 1,
        title: '(untitled report)',
        level: 1,
        start: 0,
        end: markdown.length,
        chars: markdown.length,
        estimatedTokens: estimateTokens(markdown),
      },
    ];
  }

  const sections: ReportSection[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i];
    if (!m || m.index === undefined) continue;
    const hashes = m[1] ?? '#';
    const title = (m[2] ?? '').trim();
    const start = m.index;
    const next = matches[i + 1];
    const end = next?.index ?? markdown.length;
    const body = markdown.slice(start, end);
    sections.push({
      index: sections.length + 1,
      title,
      level: hashes.length,
      start,
      end,
      chars: body.length,
      estimatedTokens: estimateTokens(body),
    });
  }
  return sections;
}

/** Render the outline as a compact, agent-readable table of contents. */
export function renderOutline(markdown: string): string {
  const sections = outlineReport(markdown);
  const total = estimateTokens(markdown);
  const lines = sections.map((s) => {
    const indent = '  '.repeat(Math.max(0, s.level - 1));
    return `${String(s.index).padStart(3)}. ${indent}${s.title}  (~${s.estimatedTokens} tok)`;
  });
  return [
    `Report outline — ${sections.length} sections, ~${total} estimated tokens total.`,
    'Read one with `research_read { mode: "section", section: <index or title> }`.',
    '',
    ...lines,
  ].join('\n');
}

/** Locate a section by 1-based index or by (case-insensitive) title substring. */
export function findSection(markdown: string, selector: string): ReportSection | null {
  const sections = outlineReport(markdown);
  const asIndex = Number(selector);
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= sections.length) {
    return sections[asIndex - 1] ?? null;
  }
  const needle = selector.trim().toLowerCase();
  if (!needle) return null;
  return (
    sections.find((s) => s.title.toLowerCase() === needle) ??
    sections.find((s) => s.title.toLowerCase().includes(needle)) ??
    null
  );
}

export function readSection(markdown: string, section: ReportSection): string {
  return markdown.slice(section.start, section.end).trimEnd();
}

export interface GrepHit {
  readonly line: number;
  readonly section: string;
  readonly text: string;
}

/**
 * Search the report, returning hits with their containing section so the caller
 * can decide what to read next. The pattern is treated as a literal by default;
 * `regex: true` opts into a pattern, which is length-capped and compiled inside
 * a try so a malformed expression is a user error, not a crash.
 */
export function grepReport(
  markdown: string,
  pattern: string,
  opts: { readonly regex?: boolean; readonly maxHits?: number; readonly context?: number } = {},
): GrepHit[] {
  const maxHits = Math.min(opts.maxHits ?? 40, 200);
  let re: RegExp;
  if (opts.regex) {
    if (pattern.length > 500) throw new Error('Pattern too long (max 500 characters).');
    try {
      re = new RegExp(pattern, 'i');
    } catch (e: unknown) {
      throw new Error(`Invalid regular expression: ${e instanceof Error ? e.message : 'unknown'}`, {
        cause: e,
      });
    }
  } else {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  const sections = outlineReport(markdown);
  const lines = markdown.split('\n');
  const hits: GrepHit[] = [];
  let offset = 0;

  for (let i = 0; i < lines.length && hits.length < maxHits; i += 1) {
    const line = lines[i] ?? '';
    if (re.test(line)) {
      const containing = sections.filter((s) => s.start <= offset).at(-1);
      hits.push({
        line: i + 1,
        section: containing?.title ?? '(preamble)',
        text: line.trim().slice(0, 500),
      });
    }
    offset += line.length + 1;
  }
  return hits;
}

/**
 * Rewrite the inline `<cite url="...">` tags the prompt mandates into markdown
 * links, so the report renders in any markdown viewer. Both the wrapping and
 * the self-closing forms are handled.
 */
export function normaliseCitations(markdown: string): string {
  return markdown
    .replace(/<cite\s+url="([^"]*)"[^>]*>([\s\S]*?)<\/cite>/gi, (_m, url: string, text: string) => {
      const label = text.trim() || hostLabel(url);
      return `[${label}](${url})`;
    })
    .replace(/<cite\s+url="([^"]*)"[^>]*\/?>/gi, (_m, url: string) => `[${hostLabel(url)}](${url})`);
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Every distinct URL the report cites, in first-appearance order. Covers
 * markdown links, raw `<cite url>` tags, and bare URLs in the evidence table.
 */
export function extractCitedUrls(markdown: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string): void => {
    const url = raw.trim().replace(/[).,;]+$/, '');
    if (!url || url === 'UNVERIFIED') return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };

  for (const m of markdown.matchAll(/<cite\s+url="([^"]+)"/gi)) push(m[1] ?? '');
  for (const m of markdown.matchAll(/\]\((https?:\/\/[^\s)]+)\)/gi)) push(m[1] ?? '');
  for (const m of markdown.matchAll(/(?<![("<])\bhttps?:\/\/[^\s<>"'|)\]]+/gi)) push(m[0]);

  return out;
}

/**
 * Truncate to a token budget on a line boundary, appending an explicit marker.
 * Silent truncation reads as "that's the whole report" and is exactly how a
 * caller ends up confidently acting on half a finding.
 */
export function clampToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf('\n');
  const body = lastBreak > maxChars * 0.5 ? cut.slice(0, lastBreak) : cut;
  const remaining = estimateTokens(text) - estimateTokens(body);
  return {
    text: `${body}\n\n[... truncated at the requested token budget — ~${remaining} estimated tokens remain. Read on with mode "section", or raise maxTokens.]`,
    truncated: true,
  };
}
