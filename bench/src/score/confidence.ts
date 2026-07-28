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

/**
 * Refuse a map that cannot produce a Brier score in `[0, 1]`.
 *
 * The whole argument for making the map replaceable is that a stored cell can
 * be re-scored later against a different one. A typo in that later map would
 * otherwise produce a confident out-of-range number rather than an error, and
 * the number is the thing somebody acts on.
 */
export function assertProbabilities(map: ConfidenceProbabilities): void {
  for (const level of CONFIDENCE_LEVELS) {
    const p = map[level];
    if (!Number.isFinite(p) || p < 0 || p > 1) {
      throw new TypeError(
        `confidence probability for "${level}" must be a finite number in [0, 1]; received ${String(p)}`,
      );
    }
  }
}

/** Which written shape a marker was found in. Carried so a parse is arguable. */
export type MarkerForm =
  /** `(High Confidence)`, the executive-summary bullet leader. */
  | 'parenthesised'
  /** `<CONFIDENCE:LOW>...</CONFIDENCE:LOW>`, the epistemic-bounding tag. */
  | 'tag'
  /** `Confidence: High`, including the `N/A` abstention. */
  | 'labelled'
  /** `High Confidence:` at the head of a line. */
  | 'trailing-label';

/** Whether a marker's span was read forward from it or back to the claim before it. */
export type SpanDirection = 'forward' | 'backward' | 'delimited';

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
  readonly direction: SpanDirection;
}

export interface Range {
  readonly start: number;
  readonly end: number;
}

// A mismatched pair, `<CONFIDENCE:LOW>...</CONFIDENCE:HIGH>`, is read as the
// level it opened with rather than rejected. A backreference here would refuse
// the whole tag, and the labelled pattern would then read BOTH halves of it as
// markers: one malformed tag would become two phantom claims, which is a worse
// answer than taking the author at their opening word.
const TAG = /<CONFIDENCE:(HIGH|MEDIUM|LOW)>([\s\S]*?)<\/CONFIDENCE:(?:HIGH|MEDIUM|LOW)>/gi;
const PARENTHESISED = /\(\s*(high|medium|low)\s+confidence\s*\)/gi;
const LABELLED = /confidence\s*:\s*(high|medium|low|n\/?a)\b/gi;
// Anchored to the head of a line, optionally behind a list bullet or bold
// markers. Unanchored it fired on ordinary prose: "the authors express high
// confidence: the method is sound" is not a confidence qualifier, and reading
// it as one invented a High marker that then governed the rest of the sentence.
const TRAILING_LABEL = /(?:^|\n)[ \t]*(?:[-*+]\s+)?\**(high|medium|low)\s+confidence\s*:/gi;

function toLevel(word: string): ConfidenceLevel | null {
  const w = word.toLowerCase();
  if (w === 'high' || w === 'medium' || w === 'low') return w;
  return null;
}

/**
 * Blank-line-delimited blocks, as index ranges.
 *
 * A paragraph is a structural unit of the document rather than a window
 * somebody tuned, which is the whole reason it is used as the span boundary and
 * as the definition of "near" in the refusal scorer. A markdown bullet is one
 * line inside one, so a bullet's span stops where the next bullet's marker
 * begins.
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

/**
 * The paragraph an index belongs to.
 *
 * An index inside a blank-line separator belongs to the paragraph before it,
 * which is why this returns the last range that starts at or before the index
 * rather than only a range that contains it. The earlier version returned
 * `{ start: 0, end: 0 }` for a separator index, which collided with the genuine
 * first paragraph's key wherever a caller uses `start` as an identity.
 */
export function paragraphAt(ranges: readonly Range[], index: number): Range {
  let best = ranges[0] ?? { start: 0, end: 0 };
  for (const r of ranges) {
    if (r.start > index) break;
    best = r;
  }
  return best;
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

const HAS_CONTENT = /[\p{L}\p{N}]/u;

/**
 * Every confidence marker in the report, in document order, each with the text
 * it governs.
 *
 * **The span rule.** A delimited tag governs exactly its own contents, because
 * a delimiter the author wrote beats anything inferred. An undelimited marker
 * governs forward from its end to whichever comes first: the start of the next
 * marker, or the end of its paragraph.
 *
 * **And backward when there is nothing forward.** `prompt.ts` specifies a
 * *leading* qualifier for executive-summary bullets, and asks for "a confidence
 * qualifier on every non-trivial claim" everywhere else without saying where it
 * goes. The natural shape in prose is trailing: `Revenue reached 1.2 billion.
 * (High Confidence)`. Reading only forward gave that marker an empty span, so
 * the claim it qualified was never paired with anything and the report was
 * scored over the subset that happened to lead. A marker whose forward span
 * holds no letters or digits therefore reads back to the start of its paragraph
 * instead, stopping at whatever the previous marker already governs so one
 * sentence is never counted twice.
 *
 * Overlaps are resolved by document order with tags taking precedence: a
 * marker starting inside an already-claimed region is dropped rather than
 * double-counted.
 */
export function findConfidenceMarkers(report: string): ConfidenceMarker[] {
  const raw: RawMarker[] = [];

  for (const m of report.matchAll(TAG)) {
    const body = m[2] ?? '';
    const bodyStart = m.index + m[0].indexOf('>') + 1;
    raw.push({
      level: toLevel(m[1] ?? ''),
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
    // The leading newline is part of the match but not part of the marker.
    const lead = m[0].startsWith('\n') ? 1 : 0;
    raw.push({
      level: toLevel(m[1] ?? ''),
      form: 'trailing-label',
      text: m[0].slice(lead),
      start: m.index + lead,
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
    // A tag claims its **whole** match, closing tag included. Claiming only as
    // far as the body left `</CONFIDENCE:LOW>` unclaimed, and the labelled
    // pattern reads `CONFIDENCE:LOW` inside it, so every tagged claim was
    // counted twice and every tagged report's Brier score was computed over a
    // doubled sample. Found by the test, not by reading.
    claimedTo = marker.end;
  }

  const paragraphs = paragraphRanges(report);
  const out: ConfidenceMarker[] = [];
  for (let i = 0; i < kept.length; i += 1) {
    const marker = kept[i];
    if (!marker) continue;
    if (marker.delimited) {
      out.push({
        level: marker.level,
        form: marker.form,
        text: marker.text,
        start: marker.start,
        end: marker.end,
        span: report.slice(marker.delimited.start, marker.delimited.end),
        spanStart: marker.delimited.start,
        spanEnd: marker.delimited.end,
        direction: 'delimited',
      });
      continue;
    }

    const next = kept[i + 1];
    const paragraph = paragraphAt(paragraphs, marker.end);
    const forwardEnd = Math.max(
      marker.end,
      Math.min(next ? next.start : report.length, paragraph.end),
    );
    const forward = report.slice(marker.end, forwardEnd);
    if (HAS_CONTENT.test(forward)) {
      out.push({
        level: marker.level,
        form: marker.form,
        text: marker.text,
        start: marker.start,
        end: marker.end,
        span: forward,
        spanStart: marker.end,
        spanEnd: forwardEnd,
        direction: 'forward',
      });
      continue;
    }

    const previous = out[out.length - 1];
    const floor =
      previous && previous.spanEnd > paragraph.start ? previous.spanEnd : paragraph.start;
    const backStart = Math.min(Math.max(floor, paragraph.start), marker.start);
    out.push({
      level: marker.level,
      form: marker.form,
      text: marker.text,
      start: marker.start,
      end: marker.end,
      span: report.slice(backStart, marker.start),
      spanStart: backStart,
      spanEnd: marker.start,
      direction: 'backward',
    });
  }
  return out;
}

/**
 * Lower-cased and Unicode-normalised, for locating a subject in prose.
 *
 * **Idempotent, and that is load-bearing.** `NFKC` then `toLowerCase` is not a
 * fixed point: an uppercase `J` with a combining caron has no precomposed form,
 * so the first pass leaves it two characters and lower-casing it lets the
 * second pass compose it to one. Any caller that normalised a haystack and then
 * passed it to a helper that normalised again would be comparing indices from
 * two different coordinate systems, and a mention could be attributed to the
 * wrong paragraph. Re-normalising after the case fold closes it.
 *
 * Deliberately **not** the accuracy scorer's matcher. That one decides whether
 * a value is correct and has to understand that `1.2 billion`, `1,200,000,000`
 * and `1.2B` are one number; this one decides whether a subject is being
 * discussed here, and widening it toward numeric equivalence would start
 * pairing confidence markers to answers the report never made.
 */
export function normaliseForSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase().normalize('NFKC');
}

const ALPHANUMERIC = /[\p{L}\p{N}]/u;

function isAlphanumeric(ch: string | undefined): boolean {
  return ch !== undefined && ALPHANUMERIC.test(ch);
}

/**
 * The whole code point ending just before `at`, not the code unit.
 *
 * Indexing a string gives a UTF-16 code unit, so beside a supplementary-plane
 * letter it returns a lone surrogate, which `\p{L}` does not match. The boundary
 * rule then reads "letter" as "not a letter" and a term matches inside a word:
 * against the previous version, `mentions('a\u{10400}AI\u{10400}b', 'AI')`
 * answered `true` while the plain `mentions('saidAIsaid', 'AI')` correctly
 * answered `false`.
 *
 * NFKC folds the mathematical alphanumerics (`𝐀` to `a`, `𝟏` to `1`) before this
 * runs, so the trigger is not those. What survives it is script text: CJK
 * Extension B and beyond, Deseret, Gothic, Osage, Adlam. A report citing Chinese
 * or Japanese sources carries them as a matter of course.
 *
 * **Deliberately a copy of `due-weight/text.ts`, not an extraction.** That module
 * fixed the same defect on its own side first, after an out-of-family reviewer
 * demonstrated a match inside `a\u{10400}b`. BENCH-15 is the queued item that
 * owns pulling shared primitives out of these modules; moving one here, on a
 * branch that is not its, would restructure a file it is about to. The
 * duplication is named on both sides so it is a recorded debt.
 */
function codePointBefore(s: string, at: number): string | undefined {
  if (at <= 0) return undefined;
  const low = s.charCodeAt(at - 1);
  if (low >= 0xdc00 && low <= 0xdfff && at >= 2) {
    const high = s.charCodeAt(at - 2);
    if (high >= 0xd800 && high <= 0xdbff) return s.slice(at - 2, at);
  }
  return s[at - 1];
}

/** The whole code point starting at `at`. See `codePointBefore`. */
function codePointAt(s: string, at: number): string | undefined {
  if (at < 0 || at >= s.length) return undefined;
  const cp = s.codePointAt(at);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a match at `at` sits on word boundaries.
 *
 * Both neighbours are read as whole code points rather than as code units. The
 * right-hand side matters as much as the left: `h[at + length]` beside a
 * supplementary-plane letter returns that letter's lone *high* surrogate, which
 * `\p{L}` does not match either, so the defect was on both sides of the boundary
 * rather than only on the `h[at - 1]` an audit named.
 */
function boundaryOk(h: string, at: number, length: number, needle: string): boolean {
  const guardLeft = isAlphanumeric(codePointAt(needle, 0));
  const guardRight = isAlphanumeric(codePointBefore(needle, needle.length));
  const before = codePointBefore(h, at);
  const after = codePointAt(h, at + length);
  return (!guardLeft || !isAlphanumeric(before)) && (!guardRight || !isAlphanumeric(after));
}


/**
 * Search from an index, in one already-normalised coordinate system.
 *
 * A needle containing whitespace is matched with `\s+` between its words rather
 * than literally, because markdown wraps prose and a label that lands on a line
 * break would otherwise never pair. The indices returned are still positions in
 * the haystack exactly as passed, which a whitespace-collapsing normaliser
 * could not have preserved and which the paragraph arithmetic depends on.
 */
function searchFrom(h: string, n: string, from: number): { at: number; length: number } {
  if (!/\s/.test(n)) {
    let at = h.indexOf(n, from);
    while (at !== -1) {
      if (boundaryOk(h, at, n.length, n)) return { at, length: n.length };
      at = h.indexOf(n, at + 1);
    }
    return { at: -1, length: 0 };
  }

  // `escapeRegExp` leaves whitespace alone, so this rewrites the real runs.
  const pattern = escapeRegExp(n).replace(/\s+/g, '\\s+');
  const re = new RegExp(pattern, 'gu');
  re.lastIndex = from;
  let m = re.exec(h);
  while (m !== null) {
    if (boundaryOk(h, m.index, m[0].length, n)) return { at: m.index, length: m[0].length };
    re.lastIndex = m.index + 1;
    m = re.exec(h);
  }
  return { at: -1, length: 0 };
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
  return searchFrom(normaliseForSearch(haystack), n, 0).at;
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
  let hit = searchFrom(h, n, from);
  while (hit.at !== -1) {
    out.push(hit.at);
    from = hit.at + Math.max(1, hit.length);
    hit = searchFrom(h, n, from);
  }
  return out;
}
