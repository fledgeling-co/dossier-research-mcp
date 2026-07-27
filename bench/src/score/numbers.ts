import type { Tolerance } from '../tasks/schema.js';
import {
  AMBIGUOUS_SCALE_SUFFIXES,
  canonicaliseUnit,
  DIMENSIONLESS,
  matchCurrencyPrefix,
  matchUnitAt,
  SCALE_WORDS,
  type CanonicalUnit,
} from './units.js';

/**
 * Reading the numbers a report actually wrote.
 *
 * This is the module the brief singles out: **a gold fact missed on formatting
 * is a false negative that makes every backend look worse, and nothing in the
 * output says why.** `1.2 billion`, `1,200,000,000` and `1.2B` are one figure,
 * and a scorer that knows only one of those spellings measures prose style
 * rather than research quality.
 *
 * Three decisions carry the weight.
 *
 * **Scaling shifts a decimal point in a string; it never multiplies.**
 * `1.1 * 1e6` is `1100000.0000000001` in IEEE 754, so a report writing
 * `1.1 million` against a gold of `1100000` would miss under an `exact`
 * tolerance for reasons having nothing to do with research. `shiftDecimal` moves
 * the point in the digits instead, which is exact for every form a report writes.
 *
 * **Nothing here may emit exponential notation.** `String(1e21)` and
 * `(1e21).toFixed(0)` are *both* `1e+21`; guarding only the first is a bug the
 * gold-verification module already caught once in this repo. `toPlainString`
 * expands it, and a test asserts no output anywhere contains `e+`.
 *
 * **An ambiguous suffix is read every plausible way.** `450m` is 450 million and
 * it is 450 metres, and the text does not say which. Both readings are produced
 * and a fact matches if either fits. That is the lenient direction on purpose:
 * the expensive error here is the false negative, and an ambiguity the report
 * genuinely left open should not be resolved against the backend.
 */

/**
 * A number as decimal text, never in exponential notation.
 *
 * JavaScript reaches for exponents above 1e21 and below 1e-7, and both of the
 * obvious spellings do it. A benchmark that prints `1e+21` where a gold value
 * belongs has misreported its own gold set.
 */
export function toPlainString(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const s = String(value);
  if (!s.includes('e') && !s.includes('E')) return s;

  const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (!m) return s;
  const sign = m[1] ?? '';
  const intPart = m[2] ?? '0';
  const fracPart = m[3] ?? '';
  const exponent = Number.parseInt(m[4] ?? '0', 10);
  return sign + shiftDigits(intPart, fracPart, exponent);
}

/** Move a decimal point through a digit string. The exact half of scaling. */
function shiftDigits(intPart: string, fracPart: string, exponent: number): string {
  const digits = intPart + fracPart;
  // Where the decimal point lands, counted from the left of `digits`.
  const point = intPart.length + exponent;

  let out: string;
  if (point <= 0) {
    out = `0.${'0'.repeat(-point)}${digits}`;
  } else if (point >= digits.length) {
    out = digits + '0'.repeat(point - digits.length);
  } else {
    out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  // No leading zeros beyond one, and no trailing zeros in a fraction, so two
  // spellings of one value produce one string.
  out = out.replace(/^0+(?=\d)/, '');
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '');
  return out === '' ? '0' : out;
}

/**
 * `text` scaled by ten to the `exponent`, exactly.
 *
 * `text` is the digits as the report wrote them, minus grouping separators.
 */
export function shiftDecimal(text: string, exponent: number): number {
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!m) return Number.NaN;
  const sign = m[1] ?? '';
  const intPart = m[2] === '' || m[2] === undefined ? '0' : m[2];
  const fracPart = m[3] ?? '';
  return Number.parseFloat(sign + shiftDigits(intPart, fracPart, exponent));
}

/**
 * Whether a reported value is close enough to a gold one.
 *
 * Every arm's equation is written down, because "compared with the per-fact
 * tolerance" is not a specification and two implementations of it disagree
 * silently.
 *
 * `exact` carries a relative guard of 1e-12 rather than `===`. That is a
 * float-noise allowance, not a width: the task format requires a tolerance
 * precisely because comparing floats exactly is how a correct answer scores
 * zero, and re-introducing `===` here would put the defect back one layer down.
 */
export function withinTolerance(reported: number, gold: number, tolerance: Tolerance): boolean {
  if (!Number.isFinite(reported) || !Number.isFinite(gold)) return false;
  switch (tolerance.kind) {
    case 'exact':
      return Math.abs(reported - gold) <= Math.max(Math.abs(gold), 1) * 1e-12;
    case 'absolute':
      return Math.abs(reported - gold) <= tolerance.value;
    case 'relative':
      // At a gold of zero a relative tolerance has no width and this degrades to
      // equality. That is arithmetic rather than a choice, and the accuracy
      // scorer notes it on the result rather than leaving it to be discovered.
      return Math.abs(reported - gold) <= tolerance.fraction * Math.abs(gold);
    case 'significantFigures':
      return (
        Number(reported.toPrecision(tolerance.digits)) ===
        Number(gold.toPrecision(tolerance.digits))
      );
    default: {
      const exhaustive: never = tolerance;
      return exhaustive;
    }
  }
}

/** Whether a relative tolerance has been asked to work against a zero gold. */
export function isZeroWidthTolerance(gold: number, tolerance: Tolerance): boolean {
  return tolerance.kind === 'relative' && gold === 0;
}

/**
 * One reading of one numeral in the text.
 *
 * A single written number can produce more than one of these when its suffix is
 * ambiguous. `unit` is `null` when no recognised unit is attached, which is
 * different from `dimensionless`: the first means the report did not say, the
 * second means it said "none".
 */
export interface NumberReading {
  readonly value: number;
  readonly unit: CanonicalUnit | null;
  /** The unit exactly as written, when there was one. */
  readonly unitSurface: string | null;
}

/** Every reading of one numeral, with where it sits in the searched text. */
export interface NumberMention {
  readonly start: number;
  readonly end: number;
  /** The numeral and everything attached to it, as written. */
  readonly text: string;
  readonly readings: readonly NumberReading[];
}

/**
 * The numeral itself.
 *
 * Comma-grouped, plain, decimal, leading-dot, with an optional exponent. A sign
 * is only taken when the character before it is not a digit, so the `-07` inside
 * `2026-07-01` reads as `7` and a date cannot manufacture a negative number that
 * the report never wrote.
 */
const NUMERAL = /(?<![\d.])(?:(?<![\w])[-−])?(?:\d{1,3}(?:,\d{3})+|\d+|(?=\.\d))(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/**
 * Read every number in `text`, with every plausible reading of each.
 *
 * `text` must already be in the scorers' one coordinate system, meaning
 * `normaliseForSearch(extractProse(report))`, so the indices returned line up
 * with the ones the term matchers produce and the negation rule reads.
 *
 * `extraUnitForms` carries the gold fact's own unit spellings, so an author unit
 * like `questions` is recognised as *stated* rather than falling through as
 * absent. It is per-fact, which is why mentions are read per fact rather than
 * once for the whole report.
 */
export function readNumbers(text: string, extraUnitForms: readonly string[] = []): NumberMention[] {
  const out: NumberMention[] = [];
  for (const m of text.matchAll(NUMERAL)) {
    const raw = m[0];
    if (raw === '' || !/\d/.test(raw)) continue;
    const start = m.index;
    const digits = raw.replace(/,/g, '').replace(/−/g, '-');

    // An exponent in the source is part of the numeral; expand it first so the
    // scale suffix below composes with it rather than fighting it.
    const base = /[eE]/.test(digits) ? toPlainString(Number.parseFloat(digits)) : digits;

    let cursor = start + raw.length;
    let scaleSurface: string | null = null;
    let scaleExponent = 0;

    // A scale word or suffix, allowing a single space before it.
    let probe = cursor;
    while (probe < text.length && (text[probe] === ' ' || text[probe] === '\t')) probe += 1;
    const scaleMatch = /^[a-z]+/.exec(text.slice(probe, probe + 12));
    if (scaleMatch) {
      const word = scaleMatch[0];
      // Longest scale word that is a whole token: `bn` before `b`.
      for (let len = word.length; len >= 1; len -= 1) {
        const candidate = word.slice(0, len);
        if (!SCALE_WORDS.has(candidate)) continue;
        const after = text[probe + len];
        if (after !== undefined && /[\p{L}\p{N}]/u.test(after)) continue;
        scaleSurface = candidate;
        scaleExponent = SCALE_WORDS.get(candidate) ?? 0;
        cursor = probe + len;
        break;
      }
    }

    const prefix = matchCurrencyPrefix(text, start);
    const readings: NumberReading[] = [];

    const attach = (value: number, from: number): void => {
      const unit = matchUnitAt(text, from, extraUnitForms);
      if (unit) {
        readings.push({ value, unit: unit.canonical, unitSurface: unit.surface });
      } else if (prefix) {
        readings.push({ value, unit: prefix.canonical, unitSurface: prefix.surface });
      } else {
        readings.push({ value, unit: null, unitSurface: null });
      }
    };

    // Reading one: the scale suffix is a multiplier.
    attach(shiftDecimal(base, scaleExponent), cursor);

    // Reading two: the suffix was a unit all along. Only for the short forms
    // that genuinely collide, and only when the plain reading differs, so an
    // unambiguous `1.2 billion` yields exactly one reading.
    if (scaleSurface !== null && AMBIGUOUS_SCALE_SUFFIXES.has(scaleSurface)) {
      const asUnit = canonicaliseUnit(scaleSurface);
      readings.push({
        value: shiftDecimal(base, 0),
        unit: asUnit === DIMENSIONLESS ? null : asUnit,
        unitSurface: scaleSurface,
      });
    }

    out.push({ start, end: cursor, text: text.slice(start, cursor), readings });
  }
  return out;
}
