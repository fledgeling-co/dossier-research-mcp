import type { Tolerance } from '../../tasks/schema.js';
import { maskDateShapes } from '../noise-shapes.js';
import { withinTolerance } from '../numbers.js';
import { SCALE_WORDS } from '../units.js';

/**
 * Finding a figure in prose, and deciding whether it is the figure the gold set
 * recorded.
 *
 * This exists for the conflict-acknowledgement metric, whose whole check is
 * "does the report contain the second number as well as the first". Two things
 * make that harder than `text.includes`.
 *
 * **A report writes one number a dozen ways.** `1200000000`, `1,200,000,000`,
 * `1.2 billion` and `$1.2bn` are one figure. A scorer matching only the digit
 * string would report a backend as one-sided for writing the number the way a
 * person writes it, and a false negative here makes every backend look worse
 * than it is.
 *
 * **A number in prose is often not a number.** `2026-07-27` is a date, `v1.2.3`
 * is a version, `3rd` is an ordinal and `1980s` is a decade. Each contains digit
 * runs a naive scan happily reports as figures, and a spurious match is the
 * worse error here: it credits a report for acknowledging a disagreement it
 * never mentioned.
 *
 * Dates are removed by **masking the whole date-shaped run before scanning**
 * rather than by a rule about the character after a number. The local rule was
 * tried first and cannot work: `2026-07-27` and `50-60%` have the same shape at
 * the hyphen, so any rule sharp enough to drop the date also drops the range,
 * and a range is exactly how a report writes two figures that disagree.
 *
 * **The primitives are shared, and where they are not is a decision.** BENCH-15
 * merged the duplicate halves: the mask is `../noise-shapes.js`, the magnitude
 * vocabulary is `SCALE_WORDS` in `../units.js`, and the tolerance comparator is
 * `withinTolerance` in `../numbers.js`. What stays local is the *attachment
 * policy* below, and it stays local because this scorer has no unit model and
 * the accuracy scorer does. See `MAGNITUDE_ATTACHED_EXCLUSIONS`.
 */

/**
 * The numeric core: digits with optional thousands grouping, an optional decimal
 * part and an optional exponent. **No sign**, which is handled at the boundary
 * instead: a hyphen between two digits is a range far more often than it is a
 * minus, and consuming it inside the pattern loses the number on its right.
 *
 * The grouped alternative comes first so `1,200,000` is one match rather than
 * three, and grouping is only accepted in exact runs of three digits, because
 * `12,34` is either a typo or a European decimal and guessing would change a
 * score.
 */
const NUMERIC_CORE = /(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?/;

/**
 * The magnitude spellings this scorer refuses to read attached to a figure.
 *
 * The vocabulary is shared with the accuracy scorer; the *policy* is not, and
 * this constant is where BENCH-15 put the disagreement rather than splitting it.
 *
 * Accuracy has a unit model. An ambiguous suffix there produces two readings,
 * `450m` as both 450 million and 450 metres, and the gold fact's own unit
 * decides between them, so admitting a word costs nothing. This scorer produces
 * one reading and has no unit to decide with, and its own header states the
 * opposite error preference: a spurious match credits a report for
 * acknowledging a disagreement it never mentioned.
 *
 * `5mm` is millimetres far more often than five million, and nothing here can
 * tell. Its present answer is to yield no figure at all, which is the
 * conservative one; admitting the word would make it yield five million.
 */
export const MAGNITUDE_ATTACHED_EXCLUSIONS: ReadonlySet<string> = new Set(['mm']);

/**
 * The magnitude spellings that may sit after a space and still be a magnitude.
 *
 * The abbreviations are accepted **only** attached, never after a space: `5 m`
 * is metres far more often than five million, while `$1.2bn` is never anything
 * else. `mn`, `bn` and `tn` are the exception because they name no unit, so
 * `1.2 bn` cannot be read any other way. That asymmetry is the reason there are
 * two patterns rather than one.
 */
export const SPACED_MAGNITUDES: ReadonlySet<string> = new Set([
  'thousand',
  'thousands',
  'million',
  'millions',
  'billion',
  'billions',
  'trillion',
  'trillions',
  'mn',
  'bn',
  'tn',
]);

/** Longest first, because an alternation takes the first branch that matches. */
const longestFirst = (words: Iterable<string>): string =>
  [...words].sort((a, b) => b.length - a.length || a.localeCompare(b)).join('|');

const ATTACHED_WORDS = [...SCALE_WORDS.keys()].filter(
  (w) => !MAGNITUDE_ATTACHED_EXCLUSIONS.has(w),
);

/** Magnitude written attached to the number, as in `1.2bn` or `5m`. */
const ATTACHED_MAGNITUDE = new RegExp(
  `^(${longestFirst(ATTACHED_WORDS)})(?![\\p{L}\\p{N}])`,
  'u',
);

/** Magnitude written as a whole word after a space. See `SPACED_MAGNITUDES`. */
const SPACED_MAGNITUDE = new RegExp(
  `^ (${longestFirst(SPACED_MAGNITUDES)})(?![\\p{L}\\p{N}])`,
  'u',
);

/**
 * A character before a digit run meaning the run is part of something else: a
 * fragment of a longer token, or the second component of a version, a grouped
 * number or a path. A hyphen is deliberately absent and handled separately.
 */
const REJECT_BEFORE = /[\p{L}\p{N}._,/]/u;
/** `1.2.3` — a version, not the number `1.2` followed by the number `3`. */
const VERSION_TAIL = /^\.\d/;
/** `12,34` — grouping that is not in threes, so its meaning is not decidable. */
const AMBIGUOUS_GROUP_TAIL = /^,\d/;
/** `1/3` — a fraction or a path component, not the figure one. */
const FRACTION_TAIL = /^\/\d/;
const LETTER = /\p{L}/u;
/** Where a minus sign can legitimately begin a number. */
const OPENS_A_NUMBER = /[\s([{<"']/u;
/** The magnitude words, longest first, for looking backwards from a hyphen. */
const MAGNITUDE_TAIL = new RegExp(`(${longestFirst(ATTACHED_WORDS)})$`);

/**
 * Whether the letters immediately before `at` spell a magnitude.
 *
 * `$1.15bn-1.2bn` is a range of two figures; `COVID-19` is one token. Both are
 * letters then a hyphen then digits, and only the letters tell them apart.
 */
function endsWithMagnitude(text: string, at: number): boolean {
  const run = /[\p{L}]+$/u.exec(text.slice(Math.max(0, at - 12), at));
  return run !== null && MAGNITUDE_TAIL.test(run[0]);
}
const STARTS_WORD = /^[\p{L}\p{N}]/u;
const PERCENT_TAIL = /^ ?%/;

/** One number as the report actually wrote it. */
export interface NumericMention {
  /** The value, with any magnitude word applied. */
  readonly value: number;
  /** Start offset in the normalised text the mention was found in. */
  readonly index: number;
  /** The whole span, including any sign, magnitude word or percent sign. */
  readonly text: string;
  /** Whether the report wrote it as a percentage. Reported, never scored on. */
  readonly percent: boolean;
}

/**
 * Date, time and URL runs blanked before any number is read.
 *
 * The rule and every shape live in `../noise-shapes.js`, which is the **one**
 * implementation both numeric readers share. Re-exported here because this
 * module's callers have always imported it from here.
 */
export { maskDateShapes };

/**
 * Move the decimal point instead of multiplying.
 *
 * Measured rather than assumed: `1.2 * 1e9` does land on `1200000000`, but
 * `1.07 * 1e9` is `1070000000.0000001` and `2.01 * 1e3` is `2009.9999999999998`.
 * Under an `exact` tolerance a report that stated the gold value perfectly would
 * then score zero, which is precisely the false negative this module exists to
 * avoid producing by accident. Shifting the digits is exact for every input.
 */
function shiftDecimal(core: string, places: number, negative: boolean): number {
  const cleaned = core.replace(/,/g, '');
  const sign = negative ? '-' : '';
  if (places === 0) return Number(sign + cleaned);
  const dot = cleaned.indexOf('.');
  const intPart = dot === -1 ? cleaned : cleaned.slice(0, dot);
  let frac = dot === -1 ? '' : cleaned.slice(dot + 1);
  while (frac.length < places) frac += '0';
  const shifted = intPart + frac.slice(0, places);
  const rest = frac.slice(places);
  return Number(sign + (rest === '' ? shifted : `${shifted}.${rest}`));
}

/**
 * Every number the text states, in the order it states them.
 *
 * `text` must already be normalised by `normaliseForMatch`, so magnitude words
 * are lower case and offsets line up with every other position this scorer
 * works in. Date masking happens here rather than in the caller, so no caller
 * can forget it.
 */
export function extractNumericMentions(text: string): NumericMention[] {
  const masked = maskDateShapes(text);
  const mentions: NumericMention[] = [];
  const pattern = new RegExp(NUMERIC_CORE.source, 'g');

  for (;;) {
    const m = pattern.exec(masked);
    if (m === null) break;
    const core = m[0];
    const start = m.index;
    const coreEnd = start + core.length;

    // A leading `-` is a minus only where it cannot be a separator: at a
    // boundary. Between two digits or after a word it is a range or a hyphenated
    // token, and the number to its right is still a real number.
    const before = masked[start - 1];
    let negative = false;
    let spanStart = start;
    if (before === '-' || before === '+') {
      const beforeSign = masked[start - 2];
      if (beforeSign === undefined || OPENS_A_NUMBER.test(beforeSign)) {
        // Only at a real opening is a hyphen a minus sign. Anything else before
        // it means it separates two things: `50%-60%` used to read as fifty and
        // MINUS sixty, inventing a negative figure and losing a real one.
        negative = before === '-';
        spanStart = start - 1;
      } else if (LETTER.test(beforeSign) && !endsWithMagnitude(masked, start - 1)) {
        // A letter then a hyphen then digits is one hyphenated token: `COVID-19`,
        // `F-16`, `GPT-4`. The digits name the thing rather than measure it.
        // Unless those letters are a magnitude, in which case this is a range of
        // figures: `$1.15bn-1.2bn` must not lose its right-hand side, which is
        // what this rule did when it was first written.
        continue;
      }
      // Otherwise it separates two figures, as in a range, and the number on the
      // right is real and unsigned.
    } else if (before !== undefined && REJECT_BEFORE.test(before)) {
      continue;
    }

    const rest = masked.slice(coreEnd);
    if (VERSION_TAIL.test(rest) || AMBIGUOUS_GROUP_TAIL.test(rest) || FRACTION_TAIL.test(rest)) {
      continue;
    }

    // An exponent already states the magnitude, so a suffix after one is not a
    // multiplier and is not read as one. `1.2e9 billion` is a typo, and guessing
    // which half the author meant would change a score.
    const hasExponent = core.includes('e');
    const attached = hasExponent ? null : ATTACHED_MAGNITUDE.exec(rest);
    if (attached === null && STARTS_WORD.test(rest)) continue;

    let places = 0;
    let suffix = '';
    if (attached !== null) {
      places = SCALE_WORDS.get(attached[1] ?? '') ?? 0;
      suffix = attached[0];
    } else if (!hasExponent) {
      const spaced = SPACED_MAGNITUDE.exec(rest);
      if (spaced !== null) {
        places = SCALE_WORDS.get(spaced[1] ?? '') ?? 0;
        suffix = spaced[0];
      }
    }

    const percentMatch = PERCENT_TAIL.exec(masked.slice(coreEnd + suffix.length));
    if (percentMatch !== null) suffix += percentMatch[0];

    const value = hasExponent
      ? Number((negative ? '-' : '') + core.replace(/,/g, ''))
      : shiftDecimal(core, places, negative);
    if (!Number.isFinite(value)) continue;

    mentions.push({
      value,
      index: spanStart,
      // Sliced from the unmasked text, so a finding quotes what the report said.
      text: text.slice(spanStart, coreEnd + suffix.length),
      percent: percentMatch !== null,
    });
  }

  return mentions;
}

/**
 * The first mention that matches, or `null`.
 *
 * Takes mentions already extracted rather than the text, because a report is
 * scanned once and then asked about every value of every conflicting figure.
 *
 * The comparison is `withinTolerance` from `../numbers.js`, which is the **one**
 * implementation. This module held a second one, `matchesTolerance`, with the
 * same four arms written differently; BENCH-15 removed it, because "compared
 * with the per-fact tolerance" is not a specification and two implementations of
 * it disagree silently.
 */
export function findMatchingMention(
  mentions: readonly NumericMention[],
  expected: number,
  tolerance: Tolerance,
): NumericMention | null {
  for (const mention of mentions) {
    if (withinTolerance(mention.value, expected, tolerance)) return mention;
  }
  return null;
}
