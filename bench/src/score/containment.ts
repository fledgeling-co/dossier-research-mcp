import { normalise, numberForms } from '../verify/match.js';
import { extractIdentifiers } from './identifiers.js';

/**
 * Token containment, and the anchor check.
 *
 * **This file must never import `node:fs` and must never reach a network.** It
 * is handed page text that somebody else fetched.
 *
 * What this is, stated once here and repeated wherever a number leaves the
 * module: **containment is not entailment.** A page can contain "28.6%" while
 * saying something else entirely about it, and this check cannot tell the
 * difference. It is deliberately weaker than a reader's judgement and
 * deliberately exact, repeatable and free, which for a regression suite that
 * would otherwise be run once is the better bargain. BENCH-10 measures the gap
 * between this and a model judge against the same labelled corpus, so the
 * weakness becomes a number rather than an assumption.
 *
 * The matching primitives come from `bench/src/verify/match.ts` rather than
 * being written again here. That module's own comment gives the reason: a
 * second regex that "finds numbers" would have to decide what a thousands
 * separator is in a document whose locale it does not know, and would quietly
 * disagree with the first. A disagreement between two implementations of one
 * rule is invisible until it changes a score.
 */

export type SupportVerdict = 'supported' | 'unsupported' | 'unchecked';

export const TOKEN_CLASSES = ['percentage', 'number', 'year', 'identifier', 'proper-noun'] as const;
export type TokenClass = (typeof TOKEN_CLASSES)[number];

/** One thing a statement asserts that a page can be searched for. */
export interface CheckableToken {
  readonly cls: TokenClass;
  /** As it appeared in the statement, for a human reading a failure. */
  readonly text: string;
  /** Alternative spellings, any one of which counts as present. */
  readonly forms: readonly string[];
}

/**
 * The shape of a fetched page this module needs.
 *
 * Declared structurally rather than imported from `bench/src/citations/`, so
 * the scorers stay independent of the collector and a test can hand in an
 * object literal.
 */
export interface SourceEvidence {
  readonly url: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly verdict: string;
  readonly completeHtml: boolean;
  readonly anchors: readonly string[];
}

/**
 * Capitalised words that begin an ordinary English sentence.
 *
 * A statement's first word is skipped outright, and these are skipped anywhere,
 * because treating "However" as a proper noun would require the cited page to
 * contain the word "however" before it could support anything.
 */
const NOT_PROPER_NOUNS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'it', 'its', 'they', 'their', 'there',
  'and', 'but', 'or', 'nor', 'so', 'yet', 'for', 'if', 'when', 'while', 'although', 'though',
  'because', 'however', 'moreover', 'therefore', 'meanwhile', 'both', 'each', 'every', 'in',
  'on', 'at', 'by', 'from', 'to', 'with', 'without', 'as', 'per', 'we', 'i', 'he', 'she', 'his',
  'her', 'our', 'no', 'not', 'all', 'any', 'some', 'most', 'more', 'less', 'one', 'two', 'three',
  'first', 'second', 'third', 'about', 'after', 'before', 'between', 'during', 'over', 'under',
  'since', 'until', 'unlike', 'despite', 'across', 'within', 'among', 'against', 'via',
]);

const SCALE_WORDS: Readonly<Record<string, number>> = {
  thousand: 1e3,
  million: 1e6,
  billion: 1e9,
  trillion: 1e12,
};

function parseNumeric(text: string): number | null {
  const cleaned = text.replace(/,/g, '');
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Everything in a statement that a page can be searched for.
 *
 * The classes are the brief's own list. The order matters only in that a
 * percentage is claimed before the bare number inside it, so `28.6%` does not
 * also produce a loose `28.6` that a page mentioning "28.6 million" would
 * satisfy. A percentage keeps its sign attached in every spelling for exactly
 * that reason.
 */
export function checkableTokens(statement: string): CheckableToken[] {
  const tokens: CheckableToken[] = [];
  const consumed: { start: number; end: number }[] = [];
  const overlaps = (start: number, end: number): boolean =>
    consumed.some((r) => start < r.end && end > r.start);
  const claim = (start: number, end: number): void => {
    consumed.push({ start, end });
  };

  for (const m of statement.matchAll(/\b(\d[\d,]*(?:\.\d+)?)\s*(?:%|per\s?cent\b|percent\b)/gi)) {
    const value = parseNumeric(m[1] ?? '');
    if (value === null) continue;
    claim(m.index, m.index + m[0].length);
    const bases = numberForms(value);
    tokens.push({
      cls: 'percentage',
      text: m[0].trim(),
      forms: [
        ...bases.map((f) => `${f}%`),
        ...bases.map((f) => `${f} %`),
        ...bases.map((f) => `${f} percent`),
        ...bases.map((f) => `${f} per cent`),
      ],
    });
  }

  for (const m of statement.matchAll(
    /\b(\d[\d,]*(?:\.\d+)?)\s*(thousand|million|billion|trillion)\b/gi,
  )) {
    const value = parseNumeric(m[1] ?? '');
    const scale = SCALE_WORDS[(m[2] ?? '').toLowerCase()];
    if (value === null || scale === undefined) continue;
    if (overlaps(m.index, m.index + m[0].length)) continue;
    claim(m.index, m.index + m[0].length);
    tokens.push({
      cls: 'number',
      text: m[0].trim(),
      // Both spellings of the same figure: the page may print "1.2 billion" or
      // it may print "1,200,000,000", and they are one fact written two ways.
      forms: [
        ...numberForms(value).map((f) => `${f} ${(m[2] ?? '').toLowerCase()}`),
        ...numberForms(value * scale),
      ],
    });
  }

  for (const m of statement.matchAll(/\b(1\d{3}|2\d{3})\b/g)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    claim(m.index, m.index + m[0].length);
    tokens.push({ cls: 'year', text: m[0], forms: [m[0]] });
  }

  for (const m of statement.matchAll(/\b\d[\d,]*(?:\.\d+)?\b/g)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const value = parseNumeric(m[0]);
    if (value === null) continue;
    claim(m.index, m.index + m[0].length);
    tokens.push({ cls: 'number', text: m[0], forms: numberForms(value) });
  }

  for (const identifier of extractIdentifiers(statement)) {
    tokens.push({
      cls: 'identifier',
      text: identifier.raw,
      forms: [identifier.id, identifier.raw],
    });
  }

  // Proper nouns last, and runs of them joined, so "Meta Platforms" is one
  // token rather than two that must each appear separately.
  const words = [...statement.matchAll(/[A-Za-z][A-Za-z'’-]*/g)];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length > 0) {
      const text = run.join(' ');
      tokens.push({ cls: 'proper-noun', text, forms: [text] });
      run = [];
    }
  };
  for (const [index, word] of words.entries()) {
    const text = word[0];
    const isCapitalised = /^[A-Z]/.test(text);
    const isFirstWord = index === 0;
    if (isCapitalised && !isFirstWord && !NOT_PROPER_NOUNS.has(text.toLowerCase())) {
      run.push(text);
      continue;
    }
    flush();
  }
  flush();

  return tokens;
}

export interface ContainmentResult {
  readonly verdict: SupportVerdict;
  readonly tokens: readonly CheckableToken[];
  /** Tokens the page did not contain, which is what makes a failure legible. */
  readonly missing: readonly string[];
  readonly why: string;
}

/**
 * Whether a page contains everything a statement asserts.
 *
 * Three cases answer `unchecked` rather than `unsupported`, and every one of
 * them is the difference between a measurement and an accusation:
 *
 * - the statement yields no checkable token, so there was nothing to look for;
 * - the page was not fetched, or did not resolve, so there was nowhere to look;
 * - the page body was cut short and nothing matched, so absence is unproven.
 *
 * The third is the subtle one and it is why the truncation flag is carried all
 * the way through collection. A number sitting past the byte cap reads exactly
 * like a number that was never there, and scoring the two the same is how a
 * true citation gets reported as unsupported.
 */
export function containment(
  statement: string,
  page: SourceEvidence | undefined,
): ContainmentResult {
  const tokens = checkableTokens(statement);

  if (page === undefined) {
    return { verdict: 'unchecked', tokens, missing: [], why: 'the cited page was never fetched' };
  }
  if (page.verdict !== 'live') {
    return {
      verdict: 'unchecked',
      tokens,
      missing: [],
      why: `the cited page did not resolve (${page.verdict}), so there was nowhere to look`,
    };
  }
  if (tokens.length === 0) {
    return {
      verdict: 'unchecked',
      tokens,
      missing: [],
      why: 'the statement carries no number, year, identifier or name to look for',
    };
  }

  const haystack = normalise(page.text);
  const missing: string[] = [];
  for (const token of tokens) {
    const present = token.forms.some((form) => haystack.includes(normalise(form)));
    if (!present) missing.push(token.text);
  }

  if (missing.length === 0) {
    return {
      verdict: 'supported',
      tokens,
      missing: [],
      why: 'every checkable token in the statement appears on the page; containment, not entailment',
    };
  }
  if (page.truncated) {
    return {
      verdict: 'unchecked',
      tokens,
      missing,
      why: 'the page body was cut short before it was read to the end, so a missing token proves nothing',
    };
  }
  return {
    verdict: 'unsupported',
    tokens,
    missing,
    why: `the page does not contain ${String(missing.length)} of the statement's checkable tokens`,
  };
}

export type AnchorVerdict = 'honest' | 'missing' | 'not-applicable' | 'unchecked';

export interface AnchorResult {
  readonly verdict: AnchorVerdict;
  readonly fragment: string | null;
  readonly why: string;
}

/**
 * Whether a cited URL's fragment actually names something on the page.
 *
 * Scoped hard on purpose, to decoded `id` and `name` anchors on a complete,
 * readable HTML response. A text fragment, a PDF page number, a body that is
 * not HTML, a body that was cut short and a page that did not resolve are all
 * `not-applicable` or `unchecked`. Treating every non-match as dishonest would
 * manufacture accusations at scale from fragment forms this check was never
 * able to read, which is the failure the whole slice is built to avoid.
 */
export function anchorHonesty(citedUrl: string, page: SourceEvidence | undefined): AnchorResult {
  let fragment: string;
  try {
    fragment = new URL(citedUrl).hash.replace(/^#/, '');
  } catch {
    return { verdict: 'not-applicable', fragment: null, why: 'the cited address is not a URL' };
  }
  if (fragment === '') {
    return { verdict: 'not-applicable', fragment: null, why: 'the citation carries no fragment' };
  }
  if (fragment.startsWith(':~:')) {
    return {
      verdict: 'not-applicable',
      fragment,
      why: 'a text fragment names a passage rather than an anchor, and is not checkable here',
    };
  }
  if (/^(page=)?\d+$/i.test(fragment)) {
    return {
      verdict: 'not-applicable',
      fragment,
      why: 'a page-number fragment addresses a document position rather than an anchor',
    };
  }

  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    // A fragment that is not valid percent-encoding is compared as written.
  }

  if (page === undefined || page.verdict !== 'live') {
    return { verdict: 'unchecked', fragment: decoded, why: 'the cited page did not resolve' };
  }
  if (!page.completeHtml) {
    return {
      verdict: 'unchecked',
      fragment: decoded,
      why: 'the response was not complete, readable HTML, so its anchors could not be listed',
    };
  }
  const has = page.anchors.some((a) => a === decoded || a === fragment);
  return has
    ? { verdict: 'honest', fragment: decoded, why: 'the page declares this anchor' }
    : { verdict: 'missing', fragment: decoded, why: 'the page declares no anchor with this name' };
}
