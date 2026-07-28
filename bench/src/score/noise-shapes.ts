/**
 * The runs of text that look like numbers and are not: dates, clock times and
 * URLs, blanked before any figure is read.
 *
 * **One implementation, two readers.** `bench/src/score/numbers.ts` reads the
 * figures a report stated and `bench/src/score/due-weight/numbers.ts` asks
 * whether a report stated a particular figure. Both had to solve this first,
 * both solved it, and they solved it differently: BENCH-04 required a four-digit
 * year and masked nothing but dates, BENCH-05 masked two-digit years, a bare
 * `YYYY-MM`, clock times and URLs but matched a single literal space and only
 * lower case. Each therefore missed exactly what the other caught, which is what
 * two implementations of one rule always come to. This is the union, and the
 * places the two genuinely disagreed are decided here rather than split.
 *
 * The rule itself is the one both authors wrote down independently: **a date
 * states no number.** `2026-07-01` holds a `07`, and because an unstated unit is
 * compatible with any gold unit, a gold value of seven would otherwise be
 * recovered from a publication date. A clock time is the same class of thing and
 * was simply left behind when dates were masked. Digits inside a URL are an
 * identifier rather than a figure the report stated.
 *
 * **Whole shapes only**, never a rule about the character after a number.
 * `2026-07-27` and `50-60%` look identical at the hyphen, so any rule sharp
 * enough to drop the date also drops the range, and a range is exactly how a
 * report writes two figures that disagree.
 *
 * ## Two decisions, recorded because they moved a score
 *
 * **The fill is `#`, not a space.** Both fills preserve length, which is the
 * property every offset downstream depends on, and they are not otherwise
 * equivalent. A space is whitespace, and `readNumbers` skips whitespace looking
 * for the magnitude word attached to a figure, so a space-filled date sitting
 * between the two was skipped straight over: `revenue was 1.2 2026-07-27
 * billion` read as `1200000000`, a magnitude the report never attached to that
 * figure. `#` is not whitespace and the probe stops on it.
 *
 * **`MONTH` names months rather than starting like one.** Both files spelled it
 * `(?:jan|feb|...|dec)[a-z]*`, which also matches `novel`, `decade`, `marginal`
 * and `mayonnaise`. That survived in `bench/src/score/numbers.ts` because it had
 * no shape where a month is followed only by a year, and it did real damage in
 * the file that did: `maskDateShapes('novel 2026')` blanked the figure. The
 * union carries the bare `MONTH YYYY` shape, so the pattern is tightened to the
 * twelve names and their standard abbreviations, ending on a word boundary.
 *
 * This module imports nothing, deliberately. It sits above both readers rather
 * than beside either, so neither has to depend on the other's module graph.
 */

/**
 * The twelve month names and their standard abbreviations, longest form first.
 *
 * Exported so a test can assert the closure by name rather than by probing, and
 * so the tightening above is visible rather than implied. `sept` is here as well
 * as `sep` because reports write both.
 */
export const MONTH_NAMES: readonly string[] = [
  'january',
  'jan',
  'february',
  'feb',
  'march',
  'mar',
  'april',
  'apr',
  'may',
  'june',
  'jun',
  'july',
  'jul',
  'august',
  'aug',
  'september',
  'sept',
  'sep',
  'october',
  'oct',
  'november',
  'nov',
  'december',
  'dec',
];

/**
 * A month name that begins and ends where a month name does.
 *
 * **Both boundaries, and the left one was found by a test rather than by
 * reading.** With only the right-hand guard, the alternation is free to start
 * matching one character in, so `smarch 2026` masked from the `m` and
 * `undecember 2026` masked from the `d`. A month name is a whole word or it is
 * part of another word.
 */
const MONTH = `(?<![\\p{L}\\p{N}])(?:${MONTH_NAMES.join('|')})(?![\\p{L}\\p{N}])`;

/**
 * Every shape blanked, in the order the alternation tries them.
 *
 * Longest and most specific first, so a full ISO date is never read as the
 * `YYYY-MM` shape with a stray `-27` left behind, and a URL is consumed whole
 * rather than mined for the dates inside it.
 *
 * Exported as strings so a test can name the union rather than restate it.
 */
export const NOISE_SHAPE_SOURCES: readonly string[] = [
  // A URL first: its digits are an identifier, and it can contain every other
  // shape below. Bounded by whitespace and the closers a report writes around a
  // link, matching what `extractProse` leaves behind when it strips a citation.
  String.raw`https?:\/\/[^\s<>"')\]]+`,
  // `2026-07-27`, `2026/07/27`.
  String.raw`\d{4}-\d{2}-\d{2}`,
  String.raw`\d{4}\/\d{2}\/\d{2}`,
  // `03/04/2026` and `03/04/26`. The two-digit year is BENCH-05's, taken because
  // a slashed date with a short year is still a date, and `26` sits in the range
  // where a gold value would be recovered from one.
  String.raw`\d{1,2}\/\d{1,2}\/\d{2,4}`,
  // `8 July 2026`, `8th July, 2026`, `8. Juli 2026`. `\s+` and the `i` flag are
  // BENCH-04's, taken because a doubly-spaced or upper-case date is the same
  // date.
  `\\d{1,2}(?:st|nd|rd|th)?\\.?\\s+${MONTH}\\.?,?\\s+\\d{4}`,
  `${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}`,
  // `July 2026`. BENCH-05's, and the shape that forced `MONTH` to be tightened.
  `${MONTH}\\.?\\s+\\d{4}`,
  // `2026-07`, with a real month and nothing after it. The bound is what keeps
  // `2026-2030` and `1150-1200` ranges: both numbers in a range are real.
  String.raw`\d{4}-(?:0[1-9]|1[0-2])(?!\d)`,
  // `10:30`, `10:30:00`. Left behind when dates were masked, so
  // `2026-07-27T10:30:00Z` was yielding the figure 30.
  String.raw`(?<!\d)\d{1,2}:\d{2}(?::\d{2})?`,
];

const NOISE_SHAPES = new RegExp(NOISE_SHAPE_SOURCES.join('|'), 'giu');

/**
 * What a blanked run is filled with.
 *
 * Not whitespace, and that is the whole point; see the header. Exported so the
 * two readers and their tests name one character rather than three.
 */
export const NOISE_FILL = '#';

/**
 * Date, time and URL runs blanked, one fill character per source character.
 *
 * Length-preserving, so every offset a caller reports still refers to the same
 * position in the string it passed in.
 */
export function maskDateShapes(text: string): string {
  return text.replace(NOISE_SHAPES, (run) => NOISE_FILL.repeat(run.length));
}
