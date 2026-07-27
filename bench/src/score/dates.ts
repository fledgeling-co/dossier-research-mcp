import { utcDayOrdinalFromIsoDate } from '../tasks/schema.js';

/**
 * Reading the dates a report actually wrote.
 *
 * A gold date is an exact calendar day, so the comparison is whole UTC days
 * rather than timestamps: a report and a gold set that agree on the day must not
 * disagree because of a time zone neither of them mentioned. `utcDayOrdinal`
 * comes from the task format rather than being re-derived, so both sides of the
 * comparison use one definition of a day.
 *
 * The accepted written forms are enumerated rather than left to `Date.parse`,
 * which is permissive in ways that would quietly manufacture matches: it accepts
 * `2026` as a date, guesses at ambiguous input, and differs between engines on
 * anything outside ISO 8601.
 *
 * **`03/04/2026` is genuinely ambiguous** and no rule can settle it from the
 * text. Both readings are produced and either may match, with the ambiguity
 * carried on the result so a disputed score can be argued. Resolving it by
 * guessing a locale would silently score one convention's reports better than
 * the other's.
 *
 * **A month and year with no day is not a match for a full date.** "July 2026"
 * has not stated the eighth, and crediting it would let a report that named the
 * month score the same as one that found the day.
 */

const MONTHS: readonly string[] = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** Month name or three-letter abbreviation to a 1-based month number. */
const MONTH_INDEX: ReadonlyMap<string, number> = new Map(
  MONTHS.flatMap((name, i) => [
    [name, i + 1] as const,
    [name.slice(0, 3), i + 1] as const,
  ]),
);

const MONTH_ALTERNATION = [...new Set(MONTHS.flatMap((m) => [m, m.slice(0, 3)]))].join('|');

/** Which written shape a date was found in. Carried so a parse is arguable. */
export type DateForm =
  /** `2026-07-08`. */
  | 'iso'
  /** `2026/07/08`. */
  | 'iso-slash'
  /** `8 July 2026`. */
  | 'day-month-year'
  /** `July 8, 2026`, with or without the comma and with an optional ordinal. */
  | 'month-day-year'
  /** `08/07/2026`, which is two dates until something else decides. */
  | 'ambiguous-numeric';

export interface DateMention {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly form: DateForm;
  /** Every calendar day this text could mean, as whole UTC day ordinals. */
  readonly days: readonly number[];
  /** True when the text supports more than one reading. */
  readonly ambiguous: boolean;
}

/** A real calendar day, or null. Rejects 31 February without a lookup table. */
function dayOrdinal(year: number, month: number, day: number): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // `new Date('2026-02-30')` is not an error in every engine, so the round trip
  // is what proves the day exists rather than the parse succeeding.
  if (parsed.getUTCFullYear() !== year) return null;
  if (parsed.getUTCMonth() + 1 !== month) return null;
  if (parsed.getUTCDate() !== day) return null;
  return utcDayOrdinalFromIsoDate(iso);
}

const PATTERNS: readonly { readonly form: DateForm; readonly re: RegExp }[] = [
  { form: 'iso', re: /(?<![\d-])(\d{4})-(\d{1,2})-(\d{1,2})(?![\d-])/g },
  { form: 'iso-slash', re: /(?<![\d/])(\d{4})\/(\d{1,2})\/(\d{1,2})(?![\d/])/g },
  {
    form: 'day-month-year',
    re: new RegExp(
      String.raw`(?<![\d])(\d{1,2})(?:st|nd|rd|th)?\.?\s+(${MONTH_ALTERNATION})\.?,?\s+(\d{4})(?![\d])`,
      'g',
    ),
  },
  {
    form: 'month-day-year',
    re: new RegExp(
      String.raw`(?<![\p{L}])(${MONTH_ALTERNATION})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?![\d])`,
      'gu',
    ),
  },
  { form: 'ambiguous-numeric', re: /(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4})(?![\d/])/g },
];

/**
 * Every date in `text`, with every calendar day each could mean.
 *
 * `text` must already be in the scorers' one coordinate system, meaning
 * `normaliseForSearch(extractProse(report))`, which is lower case, hence the
 * lower-case month table.
 *
 * Overlaps are resolved by first match wins in pattern order, so an ISO date is
 * never also read as an ambiguous numeric one.
 */
export function readDates(text: string): DateMention[] {
  const out: DateMention[] = [];
  const claimed: { start: number; end: number }[] = [];

  const overlaps = (start: number, end: number): boolean =>
    claimed.some((c) => start < c.end && end > c.start);

  for (const { form, re } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;

      const days: number[] = [];
      let ambiguous = false;

      if (form === 'iso' || form === 'iso-slash') {
        const d = dayOrdinal(Number(m[1]), Number(m[2]), Number(m[3]));
        if (d !== null) days.push(d);
      } else if (form === 'day-month-year') {
        const month = MONTH_INDEX.get(m[2] ?? '');
        if (month !== undefined) {
          const d = dayOrdinal(Number(m[3]), month, Number(m[1]));
          if (d !== null) days.push(d);
        }
      } else if (form === 'month-day-year') {
        const month = MONTH_INDEX.get(m[1] ?? '');
        if (month !== undefined) {
          const d = dayOrdinal(Number(m[3]), month, Number(m[2]));
          if (d !== null) days.push(d);
        }
      } else {
        // Both readings. When one component exceeds twelve only one survives,
        // which is why the ambiguity flag is computed from what parsed rather
        // than asserted from the shape.
        const a = Number(m[1]);
        const b = Number(m[2]);
        const year = Number(m[3]);
        const dayFirst = dayOrdinal(year, b, a);
        const monthFirst = dayOrdinal(year, a, b);
        for (const d of [dayFirst, monthFirst]) {
          if (d !== null && !days.includes(d)) days.push(d);
        }
        ambiguous = days.length > 1;
      }

      if (days.length === 0) continue;
      claimed.push({ start, end });
      out.push({ start, end, text: m[0], form, days, ambiguous });
    }
  }

  return out.sort((a, b) => a.start - b.start);
}

/** The gold date, as a whole UTC day ordinal. */
export function goldDay(iso: string): number {
  return utcDayOrdinalFromIsoDate(iso);
}
