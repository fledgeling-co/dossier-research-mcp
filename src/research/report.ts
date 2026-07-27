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
    `Report outline: ${sections.length} sections, ~${total} estimated tokens total.`,
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
/**
 * Reject the regex shapes that can hang the process.
 *
 * `grepReport` runs a caller-supplied pattern against every line of a report
 * that can run to tens of thousands of lines. JavaScript's engine backtracks,
 * so `(a+)+$` against a long non-matching line is exponential, and there is one
 * thread: a single grep call can stop the whole MCP server answering. A length
 * cap does not help, because the dangerous patterns are short.
 *
 * This is a conservative structural check, not a decision procedure (that is
 * undecidable in general). It rejects nested quantifiers and quantified
 * alternations containing a quantifier, which covers the classic constructions.
 * False positives are acceptable here: literal search is the default, and a
 * rejected pattern costs a user one retry while an accepted one can cost every
 * user the server.
 */
function assertNoCatastrophicBacktracking(pattern: string): void {
  // Reject a quantified group whose body can match the same text more than one
  // way. That is the property that makes backtracking exponential, and it is
  // broader than "a quantifier inside a quantifier".
  //
  // The earlier version tested for a quantifier or a quantified alternation
  // inside the group, and `(a|aa)+$` has neither: no quantifier in the body, no
  // `+` before the `|`. It sailed through and blocked the event loop for over a
  // second on 38 characters. `(a?)+$` slipped by for the same reason. A
  // blacklist of constructions was the wrong shape; the property is.
  const QUANTIFIED_GROUP = /\((?:\?[:=!<]*)?((?:[^()\\]|\\.)*)\)\s*(?:[+*]|\{\d*,\d*\})/g;
  for (const match of pattern.matchAll(QUANTIFIED_GROUP)) {
    const body = match[1] ?? '';
    // An alternation, or any repetition inside the body, means more than one
    // way to consume the same input. `(ab)+` is fine; `(a|aa)+` and `(a+)+`
    // are not.
    if (/[|+*?]|\{\d*,\d*\}/.test(body.replace(/\\./g, ''))) {
      throw new Error(
        'Pattern rejected: a repeated group that can match the same text in more than one way ' +
          '(an alternation or another quantifier inside it) backtracks exponentially and would block the server. ' +
          'Rewrite it, or drop `regex` to search literally.',
      );
    }
  }
}

export function grepReport(
  markdown: string,
  pattern: string,
  opts: { readonly regex?: boolean; readonly maxHits?: number; readonly context?: number } = {},
): GrepHit[] {
  const maxHits = Math.min(opts.maxHits ?? 40, 200);
  let re: RegExp;
  if (opts.regex) {
    if (pattern.length > 500) throw new Error('Pattern too long (max 500 characters).');
    assertNoCatastrophicBacktracking(pattern);
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
/**
 * Schemes a citation may be rendered as a clickable link in.
 *
 * A citation is model output that was itself reading the open web, so the URL
 * is attacker-influenced. Rendering `javascript:` or `data:` as a markdown link
 * hands a client a clickable payload, and `file:` an exfiltration probe. They
 * also disappear from verification, because `safeFetch` refuses the scheme, so
 * the very citations most worth flagging were the ones that quietly vanished.
 * Anything unsupported is now rendered as inert code, visible but not clickable.
 */
const RENDERABLE_SCHEMES = new Set(['http:', 'https:']);

function renderCitation(url: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `\`${label} (unusable citation URL)\``;
  }
  if (!RENDERABLE_SCHEMES.has(parsed.protocol)) {
    return `\`${label} (${parsed.protocol} citation, not linked)\``;
  }
  return `[${escapeLabel(label)}](${url})`;
}

/**
 * Neutralise markdown metacharacters in a citation's label.
 *
 * The label is model output too, and validating the URL says nothing about it.
 * `<cite url="https://safe.example">x](javascript:alert(1))</cite>` closes the
 * link early and opens a second one the scheme check never saw, so a validated
 * citation renders a `javascript:` link. Escaping the brackets is enough to
 * stop the label ending the construct it sits inside.
 */
function escapeLabel(label: string): string {
  // Removed rather than backslash-escaped. `\]` is correct CommonMark and a
  // conforming renderer handles it, but the result still reads as `](javascript:`
  // to anything less careful, and a citation label is a title or a host name:
  // brackets in it carry nothing worth preserving at that risk.
  return label.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
}

export function normaliseCitations(markdown: string): string {
  return (
    markdown
      // Self-closing first. Run the paired pattern first and a `<cite ... />`
      // followed later by a real `<cite>text</cite>` gets swallowed whole: the
      // paired regex spans from the self-closing tag to the next `</cite>`,
      // taking the intervening prose and a second citation with it.
      .replace(/<cite\s+url="([^"]*)"[^>]*\/>/gi, (_m, url: string) =>
        renderCitation(url, hostLabel(url)),
      )
      .replace(/<cite\s+url="([^"]*)"[^>]*>([\s\S]*?)<\/cite>/gi, (_m, url: string, text: string) =>
        renderCitation(url, text.trim() || hostLabel(url)),
      )
      // Any unpaired opening tag left over.
      .replace(/<cite\s+url="([^"]*)"[^>]*>/gi, (_m, url: string) =>
        renderCitation(url, hostLabel(url)),
      )
  );
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
  // CommonMark autolinks. `<https://example.com>` is a perfectly ordinary
  // citation and was excluded by the bare-URL pattern's `(?<![("<])` guard,
  // which meant a draft could cite a source the local loop never gathered and
  // still pass the registry check.
  for (const m of markdown.matchAll(/<(https?:\/\/[^\s<>]+)>/gi)) push(m[1] ?? '');
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
    text: `${body}\n\n[... truncated at the requested token budget, ~${remaining} estimated tokens remain. Read on with mode "section", or raise maxTokens.]`,
    truncated: true,
  };
}
