import type { Tolerance } from '../../tasks/schema.js';

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
 * **Known debt, recorded rather than hidden.** BENCH-04 needs the same tolerance
 * comparison for gold facts. The two items are in flight at the same time on
 * disjoint files, so the primitive lives here and they should be unified once
 * both have merged. Racing a shared file between concurrent runners is worse.
 */

/**
 * Date-shaped runs, masked out before any number is read.
 *
 * Only *whole* shapes, never a fragment: an ISO date, a slashed date, and a
 * year with a month between 01 and 12. `2026-2030` is deliberately not here,
 * because that is a range of years and both of its numbers are real.
 */
const DATE_SHAPES = /\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}\/\d{2}\/\d{2}|\d{4}-(?:0[1-9]|1[0-2])(?!\d)/g;

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
const NUMERIC_CORE = /(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:e[-+]?\d+)?/;

/**
 * Magnitude written attached to the number, as in `1.2bn` or `5m`.
 *
 * Longest forms first, because the alternation takes the first that matches.
 * The abbreviations are accepted **only** attached, never after a space: `5 m`
 * is metres far more often than five million, while `$1.2bn` is never anything
 * else. That asymmetry is the reason there are two patterns rather than one.
 */
const ATTACHED_MAGNITUDE = /^(thousand|trillion|billion|million|bn|mn|tn|k|m|b|t)(?![\p{L}\p{N}])/u;

/** Magnitude written as a whole word after a space. Words only, for the reason above. */
const SPACED_MAGNITUDE = /^ (thousand|million|billion|trillion)(?![\p{L}\p{N}])/u;

const MAGNITUDE_PLACES: Readonly<Record<string, number>> = {
  thousand: 3,
  k: 3,
  million: 6,
  m: 6,
  mn: 6,
  billion: 9,
  b: 9,
  bn: 9,
  trillion: 12,
  t: 12,
  tn: 12,
};

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
const WORD_CHAR = /[\p{L}\p{N}]/u;
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

/** Replace every date-shaped run with the same number of `#`, so offsets survive. */
export function maskDateShapes(text: string): string {
  return text.replace(DATE_SHAPES, (run) => '#'.repeat(run.length));
}

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
      if (beforeSign === undefined || !WORD_CHAR.test(beforeSign)) {
        negative = before === '-';
        spanStart = start - 1;
      }
    } else if (before !== undefined && REJECT_BEFORE.test(before)) {
      continue;
    }

    const rest = masked.slice(coreEnd);
    if (VERSION_TAIL.test(rest) || AMBIGUOUS_GROUP_TAIL.test(rest)) continue;

    // An exponent already states the magnitude, so a suffix after one is not a
    // multiplier and is not read as one. `1.2e9 billion` is a typo, and guessing
    // which half the author meant would change a score.
    const hasExponent = core.includes('e');
    const attached = hasExponent ? null : ATTACHED_MAGNITUDE.exec(rest);
    if (attached === null && STARTS_WORD.test(rest)) continue;

    let places = 0;
    let suffix = '';
    if (attached !== null) {
      places = MAGNITUDE_PLACES[attached[1] ?? ''] ?? 0;
      suffix = attached[0];
    } else if (!hasExponent) {
      const spaced = SPACED_MAGNITUDE.exec(rest);
      if (spaced !== null) {
        places = MAGNITUDE_PLACES[spaced[1] ?? ''] ?? 0;
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

function roundToSignificant(x: number, digits: number): number {
  if (x === 0) return 0;
  return Number(x.toPrecision(digits));
}

/**
 * Whether a reported number counts as the gold number.
 *
 * The four arms are BENCH-01's, and each names its payload differently so a
 * fraction can never be read as a percentage. A non-finite value on either side
 * is never a match: every comparison below would answer `false` anyway, and
 * answering "no" for the stated reason is worth one line.
 */
export function matchesTolerance(actual: number, expected: number, tolerance: Tolerance): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  switch (tolerance.kind) {
    case 'exact':
      return actual === expected;
    case 'absolute':
      return Math.abs(actual - expected) <= tolerance.value;
    case 'relative':
      return Math.abs(actual - expected) <= Math.abs(expected) * tolerance.fraction;
    case 'significantFigures':
      return (
        roundToSignificant(actual, tolerance.digits) ===
        roundToSignificant(expected, tolerance.digits)
      );
    default: {
      const exhaustive: never = tolerance;
      return exhaustive;
    }
  }
}

/**
 * The first mention that matches, or `null`.
 *
 * Takes mentions already extracted rather than the text, because a report is
 * scanned once and then asked about every value of every conflicting figure.
 */
export function findMatchingMention(
  mentions: readonly NumericMention[],
  expected: number,
  tolerance: Tolerance,
): NumericMention | null {
  for (const mention of mentions) {
    if (matchesTolerance(mention.value, expected, tolerance)) return mention;
  }
  return null;
}
