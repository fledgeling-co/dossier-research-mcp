/**
 * The text primitives the due-weight scorer matches with.
 *
 * Everything downstream works on **normalised** text and normalised offsets.
 * That is a deliberate single coordinate system: term positions, numeric-mention
 * positions and proximity windows are all measured in the same string, so a
 * distance can never silently mean two different things depending on which
 * function produced the offset.
 *
 * What "literal" means here, precisely, because the whole due-weight metric
 * rests on it. A distinguishing term is matched literally: the same words, not
 * a synonym and not a paraphrase. Case, whitespace and typographic dress are
 * folded first, because `Don’t` and `don't` are the same term wearing different
 * costumes, whereas `overstated` and `exaggerated` are different claims and only
 * the task author can say whether the second one counts. Folding the costume is
 * what keeps the check from producing false negatives; refusing to fold meaning
 * is what keeps it honest. The scorer states both halves in its output.
 */

/**
 * How far apart two things may sit and still count as being in the same passage.
 *
 * Measured in normalised characters, which is roughly a paragraph. One constant
 * for both the disagreement-cue check and the rejection-cue check, so "nearby"
 * means one thing in this scorer rather than two.
 */
export const PROXIMITY_CHARS = 500;

/**
 * Characters that are the same character in a different costume.
 *
 * One entry per code point, mapping to what a person typing on a plain keyboard
 * would have written. A markdown report that has been through a smart-quotes
 * pass would otherwise miss a term an author wrote with a straight apostrophe.
 */
const TYPOGRAPHIC_FOLDS = new Map<string, string>([
  ['‘', "'"],
  ['’', "'"],
  ['‚', "'"],
  ['‛', "'"],
  ['′', "'"],
  ['“', '"'],
  ['”', '"'],
  ['„', '"'],
  ['‟', '"'],
  ['″', '"'],
  ['‐', '-'],
  ['‑', '-'],
  ['‒', '-'],
  ['–', '-'],
  ['—', '-'],
  ['―', '-'],
  ['−', '-'],
  ['…', '...'],
]);

/**
 * Characters that carry no meaning and would otherwise break a match.
 *
 * A soft hyphen sits inside a word at a line-break opportunity and is invisible;
 * the zero-width set is used for shaping and by copy-paste artefacts. Dropped
 * outright rather than folded to a space, because turning them into whitespace
 * would split a word in two and lose the match this fold exists to keep.
 */
const INVISIBLE = new Set([
  '\u00ad', // soft hyphen
  '\u200b', // zero-width space
  '\u200c', // zero-width non-joiner
  '\u200d', // zero-width joiner
  '\ufeff', // byte-order mark
  // Bidi controls. Same class as the zero-width set: invisible, and dropped
  // rather than folded to a space, because a space would split a word in two.
  '\u200e',
  '\u200f',
  '\u202a',
  '\u202b',
  '\u202c',
  '\u202d',
  '\u202e',
  '\u2066',
  '\u2067',
  '\u2068',
  '\u2069',
]);

const WHITESPACE = /\s/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Fold case, whitespace and typography, so a literal term survives formatting.
 *
 * Whitespace runs collapse to one space, which is what lets a term match across
 * the line break a markdown report wraps it at. Lower-casing is done per code
 * point and is **not** length-preserving — `İ` lower-cases to two code units —
 * which is exactly why nothing here tries to map back to the original string.
 */
export function normaliseForMatch(text: string): string {
  let out = '';
  let lastWasSpace = false;
  // Compose first. `Gödel` typed on one machine and `Go\u0308del` copied from a web
  // page are the same word and, without this, never match: an out-of-family
  // reviewer demonstrated the miss. NFKC would also fold `ﬁ` and fullwidth
  // digits, and is deliberately not used, because it additionally rewrites
  // characters that change what a figure says.
  for (const ch of text.normalize('NFC')) {
    if (INVISIBLE.has(ch)) continue;
    if (WHITESPACE.test(ch)) {
      if (!lastWasSpace) {
        out += ' ';
        lastWasSpace = true;
      }
      continue;
    }
    lastWasSpace = false;
    out += (TYPOGRAPHIC_FOLDS.get(ch) ?? ch).toLowerCase();
  }
  return out;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/**
 * The whole code point ending just before `at`, not the code unit.
 *
 * Indexing a string gives a UTF-16 code unit, so beside a supplementary-plane
 * letter it returns a lone surrogate, which `\p{L}` does not match. The boundary
 * rule then reads "letter" as "not a letter" and a term matches inside a word.
 * Found by an out-of-family reviewer, who demonstrated a match inside `a\u{10400}b`.
 *
 * `score/confidence.ts` carried the same defect on both sides of its own
 * boundary until BENCH-18, and now holds a copy of this pair. Two copies of four
 * lines is a recorded debt rather than an accident: BENCH-15 is the queued item
 * that owns pulling shared primitives out of these modules.
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

/** The whole code point starting at `at`. */
function codePointAt(s: string, at: number): string | undefined {
  if (at < 0 || at >= s.length) return undefined;
  const cp = s.codePointAt(at);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

/**
 * Every position in already-normalised text where a term occurs, ascending.
 *
 * Both ends must sit on a word boundary when the term's own end is a letter or
 * a digit. Without that rule a short term matches inside a longer word and the
 * scorer reports recall that is not there: a two-letter acronym would be found
 * in half the report.
 *
 * `term` is normalised here rather than by the caller, so a term and the text it
 * is searched in can never have been folded by two different rules.
 */
export function findTermPositions(normalisedText: string, term: string): number[] {
  const needle = normaliseForMatch(term).trim();
  if (needle === '') return [];

  const startIsWord = isWordChar(codePointAt(needle, 0));
  const endIsWord = isWordChar(codePointBefore(needle, needle.length));

  const positions: number[] = [];
  let from = 0;
  for (;;) {
    const at = normalisedText.indexOf(needle, from);
    if (at === -1) return positions;
    from = at + 1;
    if (startIsWord && isWordChar(codePointBefore(normalisedText, at))) continue;
    if (endIsWord && isWordChar(codePointAt(normalisedText, at + needle.length))) continue;
    positions.push(at);
  }
}

/** Whether a term occurs at all. */
export function containsTerm(normalisedText: string, term: string): boolean {
  return findTermPositions(normalisedText, term).length > 0;
}

/**
 * The smallest gap between any position in `a` and any position in `b`.
 *
 * Both inputs are ascending, so this is a linear merge rather than the product
 * of the two lists. `null` when either side is empty, which is a different
 * answer from "far apart" and is treated as one by every caller.
 */
export function nearestDistance(a: readonly number[], b: readonly number[]): number | null {
  if (a.length === 0 || b.length === 0) return null;
  let i = 0;
  let j = 0;
  let best = Number.POSITIVE_INFINITY;
  while (i < a.length && j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left === undefined || right === undefined) break;
    const gap = Math.abs(left - right);
    if (gap < best) best = gap;
    if (best === 0) return 0;
    if (left < right) i += 1;
    else j += 1;
  }
  return Number.isFinite(best) ? best : null;
}

/**
 * Which of `cues` appears within `window` of any position in `anchors`.
 *
 * Returns the cue that matched, so the finding can name it rather than only
 * asserting that something matched. `null` when none did.
 */
export function findNearbyCue(
  normalisedText: string,
  anchors: readonly number[],
  cues: readonly string[],
  window: number = PROXIMITY_CHARS,
): string | null {
  if (anchors.length === 0) return null;
  for (const cue of cues) {
    const gap = nearestDistance(anchors, findTermPositions(normalisedText, cue));
    if (gap !== null && gap <= window) return cue;
  }
  return null;
}
