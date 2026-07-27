/**
 * The pure half of gold-fact verification.
 *
 * BENCH-09's acceptance rule is that a scripted pass confirms each gold fact is
 * really present in the source it cites, on the day it was authored. A gold set
 * that was wrong when it was written poisons every run afterwards and the blame
 * lands on the backends, which is the most expensive failure this benchmark can
 * have. Everything that decides *whether* a fact is present lives here, with no
 * network and no filesystem, so the rules are unit-testable and the adapter
 * around them stays thin enough to read in one sitting.
 *
 * Two asymmetries are deliberate and run through every function below.
 *
 * **A missing fact and an unreachable page are different answers.** That
 * distinction is `src/research/citations.ts`'s posture and it matters more here:
 * reporting a publisher's 403 as a fabricated gold fact would be the same defect
 * the verifier exists to catch, wearing the other hat.
 *
 * **Matching is generous about form and strict about content.** `8.8` and
 * `8.80`, `1500000` and `1,500,000`, `2026-07-08` and `July 8, 2026` are the
 * same fact written differently, and a naive substring test would call a true
 * gold fact missing. Being generous costs a false *pass* only if a page happens
 * to contain the right characters for the wrong reason, which the recorded quote
 * is there to rule out — so the two checks are reported separately rather than
 * collapsed into one verdict.
 */

/** How a single string was looked for, and what came back. */
export type Presence = 'present' | 'absent';

/**
 * Decode the HTML entities that survive tag stripping.
 *
 * Deliberately a small fixed table plus numeric references rather than a full
 * entity set: these are the ones that appear in ordinary prose and in the JSON
 * that publishers embed in pages, and an unrecognised entity left as written is
 * a missed match reported honestly, not a wrong one.
 */
export function decodeEntities(input: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ndash: '–',
    mdash: '—',
    hellip: '…',
    rsquo: '’',
    lsquo: '‘',
    ldquo: '“',
    rdquo: '”',
  };
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, ref: string) => {
    if (ref.startsWith('#')) {
      const isHex = ref[1] === 'x' || ref[1] === 'X';
      const digits = isHex ? ref.slice(2) : ref.slice(1);
      const code = Number.parseInt(digits, isHex ? 16 : 10);
      // Surrogates and out-of-range code points would throw; leaving the
      // reference as written is the honest failure.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    return named[ref.toLowerCase()] ?? whole;
  });
}

/**
 * Reduce a fetched body to the text a human would read.
 *
 * JSON is returned as-is: a publisher API response *is* the readable form, and
 * stripping it would destroy the field names that make a quote pinpointable. For
 * HTML, `script` and `style` bodies are removed **before** tags are stripped,
 * because a page's inline JavaScript routinely contains numbers and names that
 * have nothing to do with what the page says, and letting them through would
 * turn the value check into a coin flip.
 */
export function extractText(body: string, contentType = ''): string {
  const type = contentType.toLowerCase();
  const looksJson = type.includes('json') || /^\s*[[{]/.test(body.slice(0, 200));
  // The escaped solidus is legal JSON and several publishers emit it: Crossref
  // returns `10.1038\/s41586-026-10726-x` for a DOI whose every printed form
  // has a plain slash. Unescaping it is the difference between a true gold fact
  // and a false "absent" — and it is exactly the generosity-about-form rule
  // this module already applies to numbers and dates.
  if (looksJson) return body.replace(/\\\//g, '/');

  const withoutScripts = body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  return decodeEntities(withoutScripts.replace(/<[^>]*>/g, ' '));
}

/**
 * One spelling of a string, for comparison.
 *
 * Whitespace is collapsed because a quote copied out of a wrapped page carries
 * whatever line breaks the layout happened to have, and comparison is
 * case-insensitive because the case of a heading is not part of the fact. Unicode
 * is normalised to NFKC so a typographic quote or a non-breaking space in the
 * source matches the plain character an author typed.
 */
export function normalise(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Whether a recorded quote appears in the extracted text. */
export function quoteAppears(text: string, quote: string): Presence {
  return normalise(text).includes(normalise(quote)) ? 'present' : 'absent';
}

/**
 * Every written form of a number that should count as the same figure.
 *
 * The set is small and explicit rather than clever. A regex that "finds numbers"
 * would have to decide what a thousands separator is in a document whose locale
 * it does not know, and would quietly disagree with the accuracy scorer that
 * BENCH-04 owns. Listing the forms keeps the rule readable and keeps a
 * disagreement visible as a missing string rather than as a silent mismatch.
 */
export function numberForms(value: number): string[] {
  const forms = new Set<string>();
  const add = (s: string): void => {
    if (s.length > 0) forms.add(s);
  };

  add(String(value));
  // `toFixed` rather than exponent notation: a large integer printed by
  // JavaScript as 1e+21 appears in no publisher's page.
  if (Number.isInteger(value)) {
    const plain = value.toFixed(0);
    add(plain);
    add(plain.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
    add(plain.replace(/\B(?=(\d{3})+(?!\d))/g, ' '));
    // A score published as 8 and recorded as 8 is also written 8.0 by scoring
    // systems that always print one decimal.
    add(value.toFixed(1));
  } else {
    for (const digits of [1, 2, 3, 4]) {
      const fixed = value.toFixed(digits);
      // Only forms that round-trip; 8.8 must not claim to be written 8.80 when
      // that would silently accept 8.804 as well.
      if (Number.parseFloat(fixed) === value) add(fixed);
    }
    const [intPart = '', fracPart = ''] = String(value).split('.');
    if (fracPart !== '') {
      add(`${intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fracPart}`);
    }
  }
  return [...forms];
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Every written form of a calendar date that should count as the same day.
 *
 * ISO first, because the sources this corpus cites are mostly publisher APIs and
 * they all print ISO. The long forms are here for the static HTML pages, where a
 * release note says "8 July 2026" and nothing on the page says `2026-07-08`.
 */
export function dateForms(iso: string): string[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return [iso];
  const [, year = '', month = '', day = ''] = match;
  const monthName = MONTHS[Number.parseInt(month, 10) - 1] ?? '';
  const dayNum = String(Number.parseInt(day, 10));
  const forms = [
    iso,
    `${year}/${month}/${day}`,
    `${dayNum} ${monthName} ${year}`,
    `${monthName} ${dayNum}, ${year}`,
    `${monthName} ${dayNum} ${year}`,
    `${day} ${monthName} ${year}`,
  ];
  return forms.filter((f) => f.length > 0);
}

/** A value to look for, already reduced to the strings that would express it. */
export interface ValueProbe {
  /** Any one of these appearing counts as the value being present. */
  readonly forms: readonly string[];
}

/**
 * Whether any spelling of a value appears in the text.
 *
 * Any-of rather than all-of: the forms are alternative spellings of one fact,
 * not several facts.
 */
export function valueAppears(text: string, probe: ValueProbe): Presence {
  const haystack = normalise(text);
  return probe.forms.some((form) => haystack.includes(normalise(form))) ? 'present' : 'absent';
}
