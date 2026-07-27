/**
 * Confidence markers, read out of a report in the shapes this product asks for.
 *
 * Calibration and refusal both need this, so it sits on its own: refusal wants
 * to know whether a report that failed to push back did so *confidently*, and
 * that is the same parse calibration runs, not a second one.
 *
 * **The report's own format, and nothing invented.** Dossier's prompt architect
 * asks for a confidence qualifier on every non-trivial claim
 * (`src/research/prompt.ts`), an executive summary whose bullets are led by
 * `(High Confidence)`, and an epistemic-bounding tag `<CONFIDENCE:LOW>` for a
 * weakly-supported but load-bearing estimate. `src/gemini/agents.ts` says the
 * same to the Managed Agents surface, and the free local loop emits
 * `**Confidence: N/A**` when it found nothing at all. Those are the four forms
 * below. A fifth form invented here would score a shape nobody was asked to
 * produce, and would make a backend look uncalibrated for obeying the brief.
 *
 * Everything here is pure, synchronous and string-only. No model, no network,
 * no filesystem.
 */

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export type ConfidenceProbabilities = Readonly<Record<ConfidenceLevel, number>>;

/**
 * What a stated confidence is taken to mean as a probability.
 *
 * A Brier score is meaningless without the map that produced it, so this is a
 * named constant, it travels on every result, and a caller may replace it. The
 * numbers are a convention rather than a measurement: High is a claim the
 * author expects to survive checking, Low is one they expect to need it, and
 * Medium sits above a coin toss because a researcher who thought a claim was
 * even money would not have written it down as a finding.
 *
 * Ordering between backends is preserved by any monotonic map. The *values*
 * are not, which is exactly why a stored raw cell can be re-scored later
 * against a different map without re-buying the research.
 */
export const DEFAULT_CONFIDENCE_PROBABILITY: ConfidenceProbabilities = {
  high: 0.9,
  medium: 0.6,
  low: 0.3,
};

/** Which written shape a marker was found in. Carried so a parse is arguable. */
export type MarkerForm =
  /** `(High Confidence)`, the executive-summary bullet leader. */
  | 'parenthesised'
  /** `<CONFIDENCE:LOW>...</CONFIDENCE:LOW>`, the epistemic-bounding tag. */
  | 'tag'
  /** `Confidence: High`, including the `N/A` abstention. */
  | 'labelled'
  /** `High Confidence:`, the same thing written the other way round. */
  | 'trailing-label';

export interface ConfidenceMarker {
  /**
   * `null` is an **abstention**, not a low confidence.
   *
   * `Confidence: N/A` is what the free local loop writes when it found no
   * sources at all, and folding that into a number answers a different
   * question from the one asked. The 2026 methodology literature is explicit
   * that abstention handling is not interchangeable preprocessing
   * (`docs/deep-research/benchmark-prior-art.md`), so it is a separate value
   * here and a separate count downstream.
   */
  readonly level: ConfidenceLevel | null;
  readonly form: MarkerForm;
  /** The marker exactly as written, for a scorecard that has to justify itself. */
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** The text this marker governs. See `findConfidenceMarkers` for the rule. */
  readonly span: string;
  readonly spanStart: number;
  readonly spanEnd: number;
}

export interface Range {
  readonly start: number;
  readonly end: number;
}

const TAG = /<CONFIDENCE:(HIGH|MEDIUM|LOW)>([\s\S]*?)<\/CONFIDENCE:(?:HIGH|MEDIUM|LOW)>/gi;
const PARENTHESISED = /\(\s*(high|medium|low)\s+confidence\s*\)/gi;
const LABELLED = /confidence\s*:\s*(high|medium|low|n\/?a)\b/gi;
const TRAILING_LABEL = /\b(high|medium|low)\s+confidence\s*:/gi;

function toLevel(word: string): ConfidenceLevel | null {
  const w = word.toLowerCase();
  if (w === 'high' || w === 'medium' || w === 'low') return w;
  return null;
}

/**
 * Blank-line-delimited blocks, as index ranges.
 *
 * A paragraph is a structural unit of the document rather than a window
 * somebody tuned, which is the whole reason it is used as the fallback span
 * boundary and as the definition of "near" in the refusal scorer. A markdown
 * bullet is one line inside one, so a bullet's span stops where the next
 * bullet's marker begins.
 */
export function paragraphRanges(text: string): Range[] {
  const out: Range[] = [];
  let start = 0;
  for (const m of text.matchAll(/\n[ \t]*\n/g)) {
    out.push({ start, end: m.index });
    start = m.index + m[0].length;
  }
  out.push({ start, end: text.length });
  return out;
}

/** The paragraph containing `index`, or the whole text when there are none. */
export function paragraphAt(ranges: readonly Range[], index: number): Range {
  for (const r of ranges) {
    if (index >= r.start && index <= r.end) return r;
  }
  return { start: 0, end: 0 };
}

interface RawMarker {
  readonly level: ConfidenceLevel | null;
  readonly form: MarkerForm;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** Set only for the tag form, whose span is delimited rather than inferred. */
  readonly delimited?: Range;
}

/**
 * Every confidence marker in the report, in document order, each with the text
 * it governs.
 *
 * **The span rule.** A delimited tag governs exactly its own contents, because
 * a delimiter the author wrote beats anything inferred. An undelimited marker
 * governs from its end to whichever comes first: the start of the next marker,
 * or the end of its paragraph. Both boundaries are structural, so the rule can
 * be stated in one sentence and disputed on the text rather than on a constant.
 *
 * Overlaps are resolved by document order with tags taking precedence: a
 * marker starting inside an already-claimed region is dropped rather than
 * double-counted, which is what stops `**(High Confidence)**:` from parsing as
 * two markers meaning one thing.
 */
export function findConfidenceMarkers(report: string): ConfidenceMarker[] {
  const raw: RawMarker[] = [];

  for (const m of report.matchAll(TAG)) {
    const word = m[1] ?? '';
    const body = m[2] ?? '';
    const bodyStart = m.index + m[0].indexOf('>') + 1;
    raw.push({
      level: toLevel(word),
      form: 'tag',
      text: m[0],
      start: m.index,
      end: m.index + m[0].length,
      delimited: { start: bodyStart, end: bodyStart + body.length },
    });
  }
  for (const m of report.matchAll(PARENTHESISED)) {
    raw.push({
      level: toLevel(m[1] ?? ''),
      form: 'parenthesised',
      text: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  for (const m of report.matchAll(LABELLED)) {
    raw.push({
      level: toLevel(m[1] ?? ''),
      form: 'labelled',
      text: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  for (const m of report.matchAll(TRAILING_LABEL)) {
    raw.push({
      level: toLevel(m[1] ?? ''),
      form: 'trailing-label',
      text: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  // Tags first at an equal start, so a tag wins the overlap it shares with a
  // form written inside it.
  const formRank: Record<MarkerForm, number> = {
    tag: 0,
    parenthesised: 1,
    labelled: 2,
    'trailing-label': 3,
  };
  raw.sort((a, b) => a.start - b.start || formRank[a.form] - formRank[b.form]);

  const kept: RawMarker[] = [];
  let claimedTo = -1;
  for (const marker of raw) {
    if (marker.start < claimedTo) continue;
    kept.push(marker);
    claimedTo = marker.delimited ? marker.delimited.end : marker.end;
  }

  const paragraphs = paragraphRanges(report);
  return kept.map((marker, i) => {
    if (marker.delimited) {
      return {
        level: marker.level,
        form: marker.form,
        text: marker.text,
        start: marker.start,
        end: marker.end,
        span: report.slice(marker.delimited.start, marker.delimited.end),
        spanStart: marker.delimited.start,
        spanEnd: marker.delimited.end,
      };
    }
    const next = kept[i + 1];
    const paragraphEnd = paragraphAt(paragraphs, marker.end).end;
    const spanEnd = Math.max(
      marker.end,
      Math.min(next ? next.start : report.length, paragraphEnd),
    );
    return {
      level: marker.level,
      form: marker.form,
      text: marker.text,
      start: marker.start,
      end: marker.end,
      span: report.slice(marker.end, spanEnd),
      spanStart: marker.end,
      spanEnd,
    };
  });
}

/**
 * Lower-cased and Unicode-normalised, for locating a subject in prose.
 *
 * Deliberately **not** the accuracy scorer's matcher. That one decides whether
 * a value is correct and has to understand that `1.2 billion`, `1,200,000,000`
 * and `1.2B` are one number; this one decides whether a subject is being
 * discussed here, and widening it toward numeric equivalence would start
 * pairing confidence markers to answers the report never made.
 */
export function normaliseForSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

const ALPHANUMERIC = /[\p{L}\p{N}]/u;

function isAlphanumeric(ch: string | undefined): boolean {
  return ch !== undefined && ALPHANUMERIC.test(ch);
}

/**
 * Search from an index, in one already-normalised coordinate system.
 *
 * The offsets returned are indices into the **normalised** haystack. Unicode
 * normalisation can change a string's length (a ligature becomes two
 * characters), so an index taken here must never be compared against one taken
 * from the raw text. Every caller that needs indices normalises once and stays
 * in that coordinate system, which is why this is private and the public
 * helpers are the only way in.
 */
function searchFrom(h: string, n: string, from: number): number {
  const guardLeft = isAlphanumeric(n[0]);
  const guardRight = isAlphanumeric(n[n.length - 1]);
  let at = h.indexOf(n, from);
  while (at !== -1) {
    const before = at === 0 ? undefined : h[at - 1];
    const after = h[at + n.length];
    if ((!guardLeft || !isAlphanumeric(before)) && (!guardRight || !isAlphanumeric(after))) {
      return at;
    }
    at = h.indexOf(n, at + 1);
  }
  return -1;
}

/**
 * The first index at which `needle` appears in `haystack` on word boundaries,
 * or `-1`.
 *
 * A boundary is only demanded on a side where the needle itself ends in an
 * alphanumeric character, so a term like `$1.2bn` or `(2019)` still matches
 * against the punctuation around it while `AI` does not match inside `said`.
 * A bare substring search is how a two-letter distinguishing term silently
 * scores a hit on every page.
 */
export function findMention(haystack: string, needle: string): number {
  const n = normaliseForSearch(needle).trim();
  if (n === '') return -1;
  return searchFrom(normaliseForSearch(haystack), n, 0);
}

/** Whether `needle` appears in `haystack` on word boundaries. */
export function mentions(haystack: string, needle: string): boolean {
  return findMention(haystack, needle) !== -1;
}

/** Every boundary-respecting index of `needle` in `haystack`, ascending. */
export function findAllMentions(haystack: string, needle: string): number[] {
  const out: number[] = [];
  const h = normaliseForSearch(haystack);
  const n = normaliseForSearch(needle).trim();
  if (n === '') return out;
  let from = 0;
  let at = searchFrom(h, n, from);
  while (at !== -1) {
    out.push(at);
    from = at + n.length;
    at = searchFrom(h, n, from);
  }
  return out;
}
