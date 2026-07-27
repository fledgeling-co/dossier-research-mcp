/**
 * Units, canonicalised so a comparison can be exact.
 *
 * The second acceptance rule of this item is that a report stating the right
 * figure with the wrong unit scores **zero** for that fact, not partial credit.
 * That is only decidable if "the wrong unit" is a mechanical test, so this
 * module holds the whole of it: which written forms mean the same unit, which
 * mean different ones, and what a unit the lexicon has never heard of counts as.
 *
 * Three rules run through everything below.
 *
 * **Canonicalise, never convert.** Kilometres do not satisfy a gold in metres.
 * Conversion would smuggle arithmetic into a match test, and a scorer that
 * quietly rescales is a scorer nobody can audit.
 *
 * **The confusable pairs stay distinct.** Percent, percentage points and basis
 * points are three units, and two currencies are two units. Those are exactly
 * the confusions the acceptance rule exists to catch, so they can never
 * canonicalise together.
 *
 * **An unrecognised unit is its own class, not an error.** A task author writes
 * `questions` or `CVSS v3.1 base score`, and both are real units of real gold
 * facts in this repo's corpus. They compare equal to themselves and unequal to
 * everything else, which is all the scorer needs.
 */

/** A canonical unit is a lower-case slug. `dimensionless` is a real answer. */
export type CanonicalUnit = string;

export const DIMENSIONLESS = 'dimensionless';

/**
 * How much a scale word multiplies the number in front of it, as a power of ten.
 *
 * Stored as an exponent rather than a factor because scaling is done by shifting
 * a decimal point in a string; see `shiftDecimal` in `numbers.ts` for why
 * multiplying by `1e6` is not good enough.
 */
export const SCALE_WORDS: ReadonlyMap<string, number> = new Map([
  ['thousand', 3],
  ['thousands', 3],
  ['k', 3],
  ['million', 6],
  ['millions', 6],
  ['m', 6],
  ['mn', 6],
  ['mm', 6],
  ['billion', 9],
  ['billions', 9],
  ['bn', 9],
  ['b', 9],
  ['trillion', 12],
  ['trillions', 12],
  ['tn', 12],
  ['t', 12],
]);

/**
 * A scale word that is also a plausible unit, so a mention carrying it has to be
 * read both ways.
 *
 * `450m` is 450 million and it is also 450 metres, and nothing in the text
 * decides which. Reading it only as the scale would score zero against a gold in
 * metres, which is the false negative the brief names as the expensive error.
 */
export const AMBIGUOUS_SCALE_SUFFIXES: ReadonlySet<string> = new Set([
  'k',
  'm',
  'mm',
  'b',
  't',
  'bn',
  'tn',
]);

/**
 * Written form to canonical class.
 *
 * Only units whose confusion changes an answer earn a place. A general unit
 * ontology would be a project of its own and would buy nothing here: an author
 * unit outside this table already compares correctly against itself.
 */
const LEXICON: ReadonlyArray<readonly [string, CanonicalUnit]> = [
  // The three that must never collapse together.
  ['%', 'percent'],
  ['percent', 'percent'],
  ['percents', 'percent'],
  ['percentage', 'percent'],
  ['pct', 'percent'],
  ['per cent', 'percent'],
  ['percentage point', 'percentage-point'],
  ['percentage points', 'percentage-point'],
  ['pp', 'percentage-point'],
  ['ppt', 'percentage-point'],
  ['p.p.', 'percentage-point'],
  ['basis point', 'basis-point'],
  ['basis points', 'basis-point'],
  ['bps', 'basis-point'],
  ['bp', 'basis-point'],

  // Currencies. One class each, symbols and words included.
  ['$', 'usd'],
  ['us$', 'usd'],
  ['usd', 'usd'],
  ['dollar', 'usd'],
  ['dollars', 'usd'],
  ['us dollars', 'usd'],
  ['€', 'eur'],
  ['eur', 'eur'],
  ['euro', 'eur'],
  ['euros', 'eur'],
  ['£', 'gbp'],
  ['gbp', 'gbp'],
  ['pound', 'gbp'],
  ['pounds', 'gbp'],
  ['¥', 'jpy'],
  ['jpy', 'jpy'],
  ['yen', 'jpy'],
  ['cny', 'cny'],
  ['rmb', 'cny'],
  ['yuan', 'cny'],
  ['a$', 'aud'],
  ['aud', 'aud'],
  ['c$', 'cad'],
  ['cad', 'cad'],
  ['nz$', 'nzd'],
  ['nzd', 'nzd'],
  ['chf', 'chf'],
  ['₹', 'inr'],
  ['inr', 'inr'],
  ['rupee', 'inr'],
  ['rupees', 'inr'],

  // Length, mass, time and data: the places a scale suffix is ambiguous.
  ['m', 'metre'],
  ['metre', 'metre'],
  ['metres', 'metre'],
  ['meter', 'metre'],
  ['meters', 'metre'],
  ['km', 'kilometre'],
  ['kilometre', 'kilometre'],
  ['kilometres', 'kilometre'],
  ['kilometer', 'kilometre'],
  ['kilometers', 'kilometre'],
  ['cm', 'centimetre'],
  ['g', 'gram'],
  ['gram', 'gram'],
  ['grams', 'gram'],
  ['kg', 'kilogram'],
  ['kilogram', 'kilogram'],
  ['kilograms', 'kilogram'],
  ['t', 'tonne'],
  ['tonne', 'tonne'],
  ['tonnes', 'tonne'],
  ['second', 'second'],
  ['seconds', 'second'],
  ['minute', 'minute'],
  ['minutes', 'minute'],
  ['hour', 'hour'],
  ['hours', 'hour'],
  ['day', 'day'],
  ['days', 'day'],
  ['week', 'week'],
  ['weeks', 'week'],
  ['month', 'month'],
  ['months', 'month'],
  ['year', 'year'],
  ['years', 'year'],
  ['byte', 'byte'],
  ['bytes', 'byte'],
  ['kb', 'kilobyte'],
  ['mb', 'megabyte'],
  ['gb', 'gigabyte'],
  ['tb', 'terabyte'],
  ['°c', 'celsius'],
  ['celsius', 'celsius'],
  ['°f', 'fahrenheit'],
  ['fahrenheit', 'fahrenheit'],
];

const LEXICON_MAP: ReadonlyMap<string, CanonicalUnit> = new Map(LEXICON);

/** Longest first, so `percentage points` is never read as `percentage`. */
const SORTED_LEXICON_FORMS: readonly string[] = [...new Set(LEXICON.map(([s]) => s))].sort(
  (a, b) => b.length - a.length,
);

/** Currency forms that may sit *before* a number rather than after it. */
const CURRENCY_PREFIXES: readonly string[] = LEXICON.filter(
  ([, canonical]) => canonical.length === 3 && /^[a-z]{3}$/.test(canonical),
)
  .map(([surface]) => surface)
  .sort((a, b) => b.length - a.length);

/**
 * Lower-case, NFKC, whitespace-collapsed.
 *
 * Periods are deliberately left alone. `p.p.` is a lexicon key, and trimming its
 * trailing stop would make the abbreviation for percentage points fail to
 * canonicalise, turning the sharpest of the three confusable classes back into
 * an unrecognised unit.
 */
function tidy(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The canonical class of a written unit.
 *
 * An empty unit is `dimensionless`, which the task format asks authors to write
 * explicitly so "no unit" is a decision rather than a skipped field. A unit the
 * lexicon does not know becomes its own class, tidied and singularised, so two
 * spellings of one author's unit still agree while two different units do not.
 */
export function canonicaliseUnit(text: string): CanonicalUnit {
  const t = tidy(text);
  if (t === '' || t === DIMENSIONLESS) return DIMENSIONLESS;
  const direct = LEXICON_MAP.get(t);
  if (direct !== undefined) return direct;
  const singular = t.endsWith('s') && t.length > 1 ? t.slice(0, -1) : t;
  return LEXICON_MAP.get(singular) ?? singular;
}

export interface FoldedUnit {
  /** Power of ten the gold value must be shifted by. */
  readonly exponent: number;
  readonly canonical: CanonicalUnit;
  /** The unit text with its scale word removed, for surface-form generation. */
  readonly rest: string;
}

/**
 * Pull a scale word out of a gold fact's own unit and into its value.
 *
 * An author may write `1.2` with unit `USD billions`, or `millions of USD`, and
 * a report writing `$1.2bn` states the same fact. Folding the scale onto the
 * value puts both sides in one comparison, and it happens on the gold side
 * because that is the side whose text an author controls.
 *
 * A unit that is *only* a scale word (`millions`) folds to dimensionless.
 */
export function foldScaleWord(unit: string): FoldedUnit {
  const t = tidy(unit);
  if (t === '') return { exponent: 0, canonical: DIMENSIONLESS, rest: '' };

  const ofMatch = /^([a-z]+)\s+of\s+(.+)$/.exec(t);
  if (ofMatch) {
    const scale = SCALE_WORDS.get(ofMatch[1] ?? '');
    if (scale !== undefined && !AMBIGUOUS_SCALE_SUFFIXES.has(ofMatch[1] ?? '')) {
      const rest = ofMatch[2] ?? '';
      return { exponent: scale, canonical: canonicaliseUnit(rest), rest };
    }
  }

  const words = t.split(' ');
  // Only a spelled-out scale word counts here. A bare `m` or `b` in an author's
  // unit is far more likely to be metres or bytes than a multiplier, and reading
  // it as a multiplier would silently move a gold value by six orders of
  // magnitude, the loudest possible version of this scorer being wrong.
  const scaleAt = words.findIndex(
    (w) => SCALE_WORDS.has(w) && !AMBIGUOUS_SCALE_SUFFIXES.has(w),
  );
  if (scaleAt === -1) return { exponent: 0, canonical: canonicaliseUnit(t), rest: t };

  const exponent = SCALE_WORDS.get(words[scaleAt] ?? '') ?? 0;
  const rest = [...words.slice(0, scaleAt), ...words.slice(scaleAt + 1)].join(' ').trim();
  return { exponent, canonical: canonicaliseUnit(rest), rest };
}

/**
 * Every written form that, sitting after a number, means this unit.
 *
 * The lexicon's own forms for the canonical class, plus whatever the author
 * wrote and its singular and plural. The author's own text has to be in here or
 * a unit outside the lexicon could never be *stated*, only ever absent, and a
 * task whose unit is `questions` would score a report writing `303 percent` as
 * a match.
 */
export function unitSurfaceForms(canonical: CanonicalUnit, rawUnit: string): string[] {
  const forms = new Set<string>();
  for (const [surface, c] of LEXICON) {
    if (c === canonical) forms.add(surface);
  }
  const t = tidy(rawUnit);
  if (t !== '' && t !== DIMENSIONLESS) {
    forms.add(t);
    forms.add(t.endsWith('s') ? t.slice(0, -1) : `${t}s`);
  }
  forms.delete('');
  return [...forms];
}

const ALPHANUMERIC = /[\p{L}\p{N}]/u;

export interface UnitMatch {
  readonly surface: string;
  readonly canonical: CanonicalUnit;
  /** Index just past the matched unit, in the string that was searched. */
  readonly end: number;
}

/**
 * The unit written immediately after `index`, if any.
 *
 * **`text` must already be lower case**, meaning it has been through
 * `normaliseForSearch`, because every surface form in the lexicon is. Passing
 * raw report text here finds nothing and looks exactly like a report that
 * stated no unit, which would turn the unit rule off without failing anything.
 *
 * Longest form first, which is the whole reason `percentage points` is never
 * read as `percentage`. A form ending in a letter must end on a word boundary,
 * so `m` does not match inside `market`; a symbol form needs no boundary,
 * because `28.6%` has none.
 *
 * `extraForms` carries the gold fact's own surface forms, so an author's unit
 * participates without needing a place in a global table.
 */
export function matchUnitAt(
  text: string,
  index: number,
  extraForms: readonly string[] = [],
): UnitMatch | null {
  let at = index;
  while (at < text.length && (text[at] === ' ' || text[at] === '\t')) at += 1;
  if (at >= text.length) return null;

  // Built once at module load for the common case. `matchUnitAt` runs per number
  // per reading per gold fact, so rebuilding and re-sorting the lexicon inside it
  // is the repeated-work-in-a-loop shape CP §6.14 names, and a report is a long
  // document with a lot of numerals in it.
  const candidates =
    extraForms.length === 0
      ? SORTED_LEXICON_FORMS
      : [...new Set([...SORTED_LEXICON_FORMS, ...extraForms])].sort((a, b) => b.length - a.length);

  for (const surface of candidates) {
    if (surface === '') continue;
    if (!text.startsWith(surface, at)) continue;
    const lastChar = surface[surface.length - 1];
    if (lastChar !== undefined && ALPHANUMERIC.test(lastChar)) {
      const after = text[at + surface.length];
      if (after !== undefined && ALPHANUMERIC.test(after)) continue;
    }
    return { surface, canonical: canonicaliseUnit(surface), end: at + surface.length };
  }
  return null;
}

/** How far before a figure a unit phrase may sit and still be its unit. */
export const UNIT_LOOKBEHIND_CHARS = 60;

/**
 * Words that may sit between a unit phrase and the figure it governs.
 *
 * "CVSS v3.1 base score **was** 8.8" and "a base score **of** 8.8" both attach.
 * Kept to a short closed list, because anything longer starts attaching a unit
 * to a figure in a different sentence.
 */
const UNIT_CONNECTORS = /(?:\s|[:=,]|\bwas\b|\bis\b|\bof\b|\bat\b|\bscored\b|\bassigned\b)*$/;

/**
 * Whether one of `forms` is the unit phrase written *before* `index`.
 *
 * The forward matcher cannot see this shape, and the shape is the normal way a
 * multi-word unit is written: a report says "the CVSS v3.1 base score was 8.8",
 * never "8.8 CVSS v3.1 base score". Without it every such figure reads as
 * unit-unstated, and the wrong-unit rule stops biting on exactly the answers
 * whose unit is most worth checking.
 *
 * **`text` must already be lower case**, as with the other two matchers.
 */
export function matchUnitBefore(
  text: string,
  index: number,
  forms: readonly string[],
): UnitMatch | null {
  if (forms.length === 0) return null;
  const from = Math.max(0, index - UNIT_LOOKBEHIND_CHARS);
  const window = text.slice(from, index);
  const stem = window.replace(UNIT_CONNECTORS, '');
  for (const surface of [...forms].sort((a, b) => b.length - a.length)) {
    if (surface === '' || !stem.endsWith(surface)) continue;
    const before = stem[stem.length - surface.length - 1];
    if (before !== undefined && ALPHANUMERIC.test(before)) continue;
    return { surface, canonical: canonicaliseUnit(surface), end: index };
  }
  return null;
}

/**
 * The token that names the *family* a multi-word author unit belongs to.
 *
 * `CVSS v3.1 base score` and `CVSS v4.0 base score` are two different units of
 * one family, and the corpus really does carry the first as gold while a report
 * may legitimately quote the second. Neither can be in a global lexicon, so the
 * family token is what lets the scorer tell "the report named this measurement
 * but a different member of it" apart from "the report stated no unit at all".
 *
 * `null` for a single-token unit, because there is no family to be wrong about:
 * a gold unit of `questions` against a report writing `303 answers` is an
 * unstated unit, not a wrong one.
 */
export function unitFamilyToken(rawUnit: string): string | null {
  const words = tidy(rawUnit).split(' ').filter((w) => w !== '');
  if (words.length < 2) return null;
  const first = words[0];
  if (first === undefined || first.length < 3) return null;
  return LEXICON_MAP.has(first) ? null : first;
}

/**
 * A currency written immediately *before* `index`, if any.
 *
 * `$1.2B` and `USD 1.2 billion` both state a currency the number cannot carry
 * behind it. Only currencies are looked for: no other unit in ordinary prose
 * precedes its number.
 *
 * **`text` must already be lower case**, for the same reason as `matchUnitAt`.
 */
export function matchCurrencyPrefix(text: string, index: number): UnitMatch | null {
  let at = index;
  while (at > 0 && (text[at - 1] === ' ' || text[at - 1] === '\t')) at -= 1;

  const symbols = ['us$', 'a$', 'c$', 'nz$', '$', '€', '£', '¥', '₹'];
  for (const surface of symbols) {
    if (at - surface.length >= 0 && text.startsWith(surface, at - surface.length)) {
      return { surface, canonical: canonicaliseUnit(surface), end: index };
    }
  }
  for (const surface of CURRENCY_PREFIXES) {
    const start = at - surface.length;
    if (start < 0 || !text.startsWith(surface, start)) continue;
    const before = text[start - 1];
    if (before !== undefined && ALPHANUMERIC.test(before)) continue;
    // A three-letter code must be separated from its number; `usd1.2` is not a
    // form anybody writes, and allowing it would let the tail of a word attach.
    if (at === index) continue;
    return { surface, canonical: canonicaliseUnit(surface), end: index };
  }
  return null;
}
