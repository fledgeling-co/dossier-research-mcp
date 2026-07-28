import { readDates } from '../score/dates.js';
import { isoDateFromUtcDayOrdinal, utcDayOrdinalFromIsoDate } from '../tasks/schema.js';
import { decodeEntities } from '../verify/match.js';

/**
 * When a cited page says it was published, or the honest admission that it does
 * not say.
 *
 * **Pure.** No filesystem, no network, no clock of its own: the fetch time comes
 * in as a parameter. `collect.ts` calls it with the body it already holds, which
 * is the whole reason this closes a gap the reporting layer could not: the data
 * does not exist by the time a report is rendered, and it does exist at the
 * moment a page is fetched.
 *
 * ## Why this exists at all
 *
 * `docs/plan/benchmark.md` lists recency as a scored dimension and BENCH-06
 * built the durability axis it needs. BENCH-08 then found the dimension could
 * not be computed, because nothing anywhere recorded a publication date;
 * `PageEvidence` recorded when a page was **checked**, which is a different
 * fact. Approximating one from the other would grade every source fresh, which
 * is exactly the failure the axis exists to catch.
 *
 * ## The rule this file is arranged around
 *
 * **A date that could not be found is never a date that was guessed, and a page
 * nobody could read is never a page that carries no date.** Three states, not
 * two. That is the same distinction this project has now had to make four
 * times: an unreachable registry is `unchecked` and never `absent`, a search
 * that failed is not an established negative, and a run that never happened is
 * not a run that failed everything. There is deliberately no optional
 * `publishedAt?: string` anywhere on the result, because an optional string has
 * one absent state and a caller reading it cannot tell which of the two it has.
 *
 * ## What was measured before any of this was designed
 *
 * The benchmark's own cited URLs were fetched on 28 July 2026 and their date
 * signals dumped. Three findings shaped the code below.
 *
 * **The commonest date on a real page is not a publication date.** Modification
 * dates outnumbered publication dates in both probes, four to one in JSON-LD.
 * Oracle answers `Updated Date`, Intel answers `lastModifieddate`, and
 * bentley.com carries `article:modified_time` beside its published one. An
 * extractor taking the first date-shaped thing it found would date a page to its
 * last rebuild and grade every documentation site fresh forever.
 *
 * **Most of a real corpus is honestly undated.** JSON APIs, plain-text RFCs,
 * PDFs and rebuilt documentation carry nothing. That is a finding about the
 * corpus rather than a defect here, which is why the share that could not be
 * dated is reported beside the score rather than hidden inside its denominator.
 *
 * **Ambiguity is in the corpus.** Cisco answers `1/31/2022 9:16:10 PM`. `1/31`
 * resolves because 31 cannot be a month; `1/5/2022` would not, and picking a
 * convention would be wrong about half of that class.
 *
 * ## What the finished thing could date
 *
 * Run over 212 distinct cited URLs through the production collection path:
 * **41 dated, 151 read in full and stating no date, 20 never read.** Six of the
 * seven signals fired on a real page, so the ranking is a measured order rather
 * than a guess. `bench/evidence/publication-dates.json` has it page by page.
 */

/**
 * Where a date came from, ranked by how explicitly the publisher said
 * "published".
 *
 * Recorded on every result. The point is traceability: a wrong date can then be
 * traced to the signal that produced it rather than argued about, and a signal
 * that turns out to be unreliable can be demoted with evidence.
 */
export const PUBLICATION_SIGNALS = [
  /** schema.org `datePublished`, the publisher's own machine-readable statement. */
  'json-ld',
  /** `citation_publication_date` and friends. The academic web's own convention. */
  'citation-meta',
  /** `article:published_time`, the Open Graph article namespace. */
  'article-published-time',
  /** Dublin Core `issued`, then its ambiguous bare `date`. */
  'dublin-core',
  /** A named meta tag, or one whose name says `publish` and does not say modified. */
  'meta-date',
  /** A `<time>` element that declares itself a publication date. */
  'time-element',
  /** A year and month adjacent in the URL path. The weakest, and last. */
  'url-path',
] as const;
export type PublicationSignal = (typeof PUBLICATION_SIGNALS)[number];

export interface PublicationFound {
  readonly status: 'found';
  /** `YYYY-MM-DD`, the calendar day the publisher stated. */
  readonly date: string;
  readonly signal: PublicationSignal;
  /** The string as the page wrote it, so a disputed reading is arguable. */
  readonly raw: string;
  readonly detail: string;
}

/** The page was read and states no publication date this extractor recognises. */
export interface PublicationAbsent {
  readonly status: 'absent';
  readonly detail: string;
}

/**
 * Nobody could look.
 *
 * The page did not resolve, or its body was cut short at the byte cap so a date
 * further down was never seen. Distinct from `absent` for the same reason an
 * unreachable registry is `unchecked`: reporting a fetch failure as a publisher
 * who omitted a date is an accusation dressed as a measurement.
 */
export interface PublicationUnchecked {
  readonly status: 'unchecked';
  readonly detail: string;
}

export type PublicationDate = PublicationFound | PublicationAbsent | PublicationUnchecked;

export interface PublicationInput {
  /**
   * The canonical URL. Read for a date only when the page resolved, because on
   * a page that did not, a date in the address is the cited report's own claim.
   */
  readonly url: string;
  /** The raw body. Empty when nothing was read. */
  readonly body: string;
  /** When the page was fetched. A page cannot have been published after it. */
  readonly checkedAt: string;
  /** False when the fetch failed or the page did not resolve. */
  readonly bodyRead: boolean;
  /** True when the read stopped at a cap, which turns "not found" into "not looked". */
  readonly truncated: boolean;
}

/**
 * The oldest date this reader will believe from a page.
 *
 * Low on purpose. A cited source really can be a 1930s statute or a digitised
 * paper, and refusing those would report a genuinely ancient source as undated,
 * which removes it from the denominator instead of counting it stale. The bound
 * is here to catch a misparse, not to police what a report may cite.
 */
export const EARLIEST_PUBLICATION = '1900-01-01';

/**
 * The oldest year this reader will believe from a *URL path*, which is a
 * different question.
 *
 * A path segment is a guess by construction, and the web did not exist before
 * this, so a `/1970/01/` in a path is far likelier to be an identifier that
 * happens to look like a date.
 */
export const EARLIEST_URL_YEAR = 1990;

/**
 * How far past the fetch a stated date may sit before it is a misread.
 *
 * Not zero. A publisher's own timezone can stamp tomorrow's date on something
 * published tonight, and a clock two hours out is ordinary. Two days absorbs
 * both without admitting a date that is genuinely in the future, which
 * `assessSourceRecency` would then have to report as a transcription error.
 */
export const FUTURE_GRACE_DAYS = 2;

const MAX_META_TAGS = 4000;
const MAX_TIME_TAGS = 500;
const MAX_JSON_LD_BLOCKS = 20;
const MAX_JSON_LD_CHARS = 200_000;
const MAX_JSON_LD_DEPTH = 12;
const MAX_JSON_LD_NODES = 5000;
const MAX_RAW_CHARS = 180;
const MAX_DETAIL_CHARS = 380;

/**
 * Any of these words in a meta name and the value is refused before it is read.
 *
 * Matched as substrings of the name rather than as exact names, because the
 * corpus carries `Updated Date`, `lastModifieddate` and `article:modified_time`,
 * and an exact-name list would have to guess every publisher's spelling. The
 * cost of the substring rule is that a name containing one of these words for
 * another reason is refused; the benefit is that a modification date can never
 * be recorded as a publication date, which is the failure worth preventing.
 */
const MODIFICATION_WORDS = ['modif', 'updat', 'revis', 'lastmod', 'last-mod', 'edited', 'changed'];

const CITATION_NAMES = [
  'citation_publication_date',
  'citation_date',
  'citation_online_date',
  'citation_cover_date',
  'prism.publicationdate',
  'prism.coverdate',
];

const ARTICLE_NAMES = ['article:published_time', 'og:article:published_time', 'og:published_time'];

/** `issued` first: the bare `dc.date` does not say which date it is. */
const DUBLIN_NAMES = ['dcterms.issued', 'dc.date.issued', 'dcterms.date', 'dc.date'];

const EXPLICIT_PUBLISH_NAMES = [
  'datepublished',
  'pubdate',
  'publishdate',
  'publish-date',
  'publish_date',
  'publication-date',
  'publication_date',
  'publicationdate',
  'published',
  'published_time',
  'published_at',
  'sailthru.date',
  'parsely-pub-date',
];

/**
 * A `<time>` element says nothing on its own.
 *
 * It is as likely to be a comment timestamp, a reading time or an event date, so
 * one is read only when the element itself says what it is. Every other `<time>`
 * is refused with the reason recorded rather than taken as a publication date.
 */
const TIME_PUBLISHED_CLASS =
  /(^|[\s_-])(published|pubdate|post-date|entry-date|article-date|date-published|publish-date)([\s_-]|$)/i;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export interface PlausibleRange {
  readonly earliest: number;
  readonly latest: number;
}

/**
 * The window a stated date has to fall inside, as whole UTC day ordinals.
 *
 * Throws on an unreadable fetch time rather than widening to everything. That is
 * `assessSourceRecency`'s posture for the same class of input: a caller's broken
 * argument reported as the page's missing date sends whoever is debugging it to
 * the wrong place entirely.
 */
export function plausibleRange(checkedAt: string): PlausibleRange {
  const at = Date.parse(checkedAt);
  if (Number.isNaN(at)) {
    throw new TypeError(
      `a publication date needs a readable fetch time to bound it; received "${clip(checkedAt, 40)}"`,
    );
  }
  return {
    earliest: utcDayOrdinalFromIsoDate(EARLIEST_PUBLICATION),
    latest: Math.floor(at / 86_400_000) + FUTURE_GRACE_DAYS,
  };
}

export interface DateReading {
  /** `YYYY-MM-DD`, or null when nothing usable was in the string. */
  readonly date: string | null;
  /** Why, in the words a reader disputing the verdict would need. */
  readonly why: string;
}

/**
 * Read one stated value as a calendar day, refusing far more than it accepts.
 *
 * The written forms come from `bench/src/score/dates.ts` rather than from a
 * second parser written here. That module already enumerates the accepted forms
 * instead of leaving them to `Date.parse`, already returns whole UTC days so a
 * timezone nobody mentioned cannot shift the answer, and already produces
 * **both** readings of an ambiguous numeric date with a flag saying so. A second
 * implementation would be the third date reader in this tree, and BENCH-15
 * exists because two of them already disagree in both directions.
 *
 * Three refusals sit on top of what it returns.
 *
 * **An ambiguous numeric date is refused.** `readDates` reports `1/5/2022` with
 * two readings; a convention picked here would be wrong about half of that class
 * in whichever direction the author's locale fell. `1/31/2022` survives, because
 * 31 cannot be a month, and the order is therefore determined rather than
 * assumed. That case is in the corpus.
 *
 * **A date outside the plausible window is refused**, including one later than
 * the fetch. A page cannot have been published after it was read.
 *
 * **Where several dates are present the earliest wins.** The older reading is
 * the one that cannot flatter a backend, which is the tie-break this whole
 * slice takes wherever two answers are available.
 *
 * A bare year is not accepted, because `readDates` deliberately does not read
 * one and reaching around it would put a second opinion about what a date is
 * into this file. It is refused by name in `why`, so a corpus that turns out to
 * carry year-only publication dates will say so rather than look empty.
 *
 * **A timestamp's zone offset does not move the day.** `2024-03-15T23:30:00-08:00`
 * reads as 15 March, the calendar day the publisher wrote, rather than the 16th
 * it would be in UTC. Against horizons measured in ninety days and upward the
 * difference is immaterial, and taking the publisher's own day is the reading
 * that can be checked by looking at the page.
 */
export function readPublicationDate(raw: string, bounds: PlausibleRange): DateReading {
  const text = raw.trim();
  if (text === '') return { date: null, why: 'the value was empty' };

  // Lower case because the month table in `readDates` is lower case; its own
  // contract is that it is handed text already in the scorers' coordinate
  // system.
  const mentions = readDates(text.toLowerCase());
  if (mentions.length === 0) {
    return {
      date: null,
      why: `"${clip(text, 60)}" carries no calendar date this reader accepts. A bare year and a locale-specific form are refused rather than guessed`,
    };
  }

  const decided = mentions.filter((m) => !m.ambiguous);
  if (decided.length === 0) {
    return {
      date: null,
      why: `"${clip(text, 60)}" is a numeric date whose field order cannot be determined, and picking a convention would be wrong about half of them`,
    };
  }

  const days = decided
    .flatMap((m) => m.days)
    .filter((d) => d >= bounds.earliest && d <= bounds.latest);
  if (days.length === 0) {
    return {
      date: null,
      why: `"${clip(text, 60)}" reads as a date before ${EARLIEST_PUBLICATION} or later than the page was fetched, so it is a misread rather than a publication date`,
    };
  }

  const earliest = Math.min(...days);
  return {
    date: isoDateFromUtcDayOrdinal(earliest),
    why:
      days.length > 1
        ? 'several dates were stated and the earliest was taken, which is the reading that cannot flatter a source'
        : '',
  };
}

interface MetaTag {
  readonly name: string;
  readonly content: string;
}

const ATTRIBUTE_VALUE = String.raw`(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))`;

/**
 * Compiled once per attribute name, not once per tag.
 *
 * A hostile page is allowed four thousand `<meta>` tags and each one is asked
 * about three attribute names, so building the pattern inside the loop compiled
 * twelve thousand identical regexes for a page whose only crime was being long.
 * The set of names is fixed and small, so a lazy cache is exact.
 */
const ATTRIBUTE_PATTERNS = new Map<string, RegExp>();

function attributePattern(name: string): RegExp {
  const existing = ATTRIBUTE_PATTERNS.get(name);
  if (existing !== undefined) return existing;
  const built = new RegExp(String.raw`\b${name}\s*=\s*${ATTRIBUTE_VALUE}`, 'i');
  ATTRIBUTE_PATTERNS.set(name, built);
  return built;
}

function attribute(tag: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    const m = attributePattern(name).exec(tag);
    if (m !== null) return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return undefined;
}

/** Every `<meta>` tag carrying both a name and a value, in document order. */
export function readMetaTags(html: string): MetaTag[] {
  const out: MetaTag[] = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (out.length >= MAX_META_TAGS) break;
    const tag = m[0];
    const name = attribute(tag, ['name', 'property', 'itemprop']);
    const content = attribute(tag, ['content']);
    if (name === undefined || content === undefined) continue;
    out.push({ name: name.trim().toLowerCase(), content });
  }
  return out;
}

function namesAModification(name: string): boolean {
  return MODIFICATION_WORDS.some((word) => name.includes(word));
}

interface SignalAttempt {
  readonly found?: PublicationFound | undefined;
  readonly rejected: readonly string[];
}

function found(
  signal: PublicationSignal,
  date: string,
  raw: string,
  detail: string,
): PublicationFound {
  return {
    status: 'found',
    date,
    signal,
    raw: clip(raw, MAX_RAW_CHARS),
    detail: clip(detail, MAX_DETAIL_CHARS),
  };
}

/**
 * The earliest of several usable readings of one key.
 *
 * Split out because "the earliest wins" has to hold **across** the values a
 * single key carries as well as inside one of them, and the first version of
 * this file only did the second. A page emitting two `datePublished` values
 * would then have been dated by whichever the parser reached first, which is
 * document order and not a judgement at all.
 *
 * Preference between two *names* is a different question and is decided by the
 * order the name lists declare, because `citation_publication_date` saying one
 * thing and `citation_online_date` saying another is a publisher being specific
 * rather than a page carrying two dates.
 */
function earliestOf(
  candidates: readonly { readonly date: string; readonly raw: string; readonly why: string }[],
): { readonly date: string; readonly raw: string; readonly why: string } | undefined {
  let best: { date: string; raw: string; why: string } | undefined;
  for (const candidate of candidates) {
    if (best === undefined || candidate.date < best.date) best = { ...candidate };
  }
  if (best === undefined) return undefined;
  return candidates.length > 1
    ? {
        ...best,
        why:
          best.why === ''
            ? 'several dates were stated and the earliest was taken, which is the reading that cannot flatter a source'
            : best.why,
      }
    : best;
}

/**
 * Try one list of meta names, in order, and report what was refused on the way.
 *
 * The refusals are carried rather than dropped because "a date was present and
 * this refused it" is a different finding from "the page carries nothing", and
 * only the first one tells a reader that the extractor saw something.
 */
function fromMetaNames(
  metas: readonly MetaTag[],
  names: readonly string[],
  signal: PublicationSignal,
  bounds: PlausibleRange,
): SignalAttempt {
  const rejected: string[] = [];
  for (const name of names) {
    const usable: { date: string; raw: string; why: string }[] = [];
    for (const meta of metas) {
      if (meta.name !== name) continue;
      const reading = readPublicationDate(meta.content, bounds);
      if (reading.date !== null) {
        usable.push({ date: reading.date, raw: meta.content, why: reading.why });
        continue;
      }
      rejected.push(`the \`${name}\` meta tag was not usable: ${reading.why}`);
    }
    const best = earliestOf(usable);
    if (best !== undefined) {
      return {
        found: found(
          signal,
          best.date,
          best.raw,
          `read from the \`${name}\` meta tag${best.why === '' ? '' : `; ${best.why}`}`,
        ),
        rejected,
      };
    }
  }
  return { rejected };
}

function fromJsonLd(html: string, bounds: PlausibleRange): SignalAttempt {
  const rejected: string[] = [];
  const values: string[] = [];
  let blocks = 0;
  for (const m of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi,
  )) {
    if (blocks >= MAX_JSON_LD_BLOCKS) break;
    blocks += 1;
    const body = m[1] ?? '';
    // Page text is untrusted input by any reading: the URL came out of a model
    // that was itself reading the open web (CP §4). Bounded in size, parsed
    // inside a `try`, and walked to a bounded depth and node count.
    if (body.length > MAX_JSON_LD_CHARS) {
      rejected.push('a JSON-LD block was larger than this reader will parse and was skipped');
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      rejected.push('a JSON-LD block was not valid JSON and was skipped');
      continue;
    }
    collectDatePublished(parsed, 0, { nodes: MAX_JSON_LD_NODES }, values);
  }

  const usable: { date: string; raw: string; why: string }[] = [];
  for (const value of values) {
    const reading = readPublicationDate(value, bounds);
    if (reading.date !== null) {
      usable.push({ date: reading.date, raw: value, why: reading.why });
      continue;
    }
    rejected.push(`a JSON-LD \`datePublished\` was not usable: ${reading.why}`);
  }
  const best = earliestOf(usable);
  if (best !== undefined) {
    return {
      found: found(
        'json-ld',
        best.date,
        best.raw,
        `read from a schema.org \`datePublished\` in a JSON-LD block${best.why === '' ? '' : `; ${best.why}`}`,
      ),
      rejected,
    };
  }
  return { rejected };
}

/**
 * Every `datePublished` in a parsed JSON-LD document, at any depth.
 *
 * `dateModified`, `dateCreated` and `uploadDate` are not collected, and that is
 * the whole reason this walks for one key rather than for anything date-shaped:
 * `dateModified` outnumbered `datePublished` four to one in the probe, so a
 * walker that took either would mostly take the wrong one.
 */
function collectDatePublished(
  node: unknown,
  depth: number,
  budget: { nodes: number },
  out: string[],
): void {
  if (budget.nodes <= 0 || depth > MAX_JSON_LD_DEPTH) return;
  budget.nodes -= 1;
  if (Array.isArray(node)) {
    for (const item of node) collectDatePublished(item, depth + 1, budget, out);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'datePublished') {
      if (typeof value === 'string') out.push(value);
      else if (Array.isArray(value)) {
        for (const item of value) if (typeof item === 'string') out.push(item);
      }
      continue;
    }
    collectDatePublished(value, depth + 1, budget, out);
  }
}

/** A `<time>` element, but only one that declares itself a publication date. */
function fromTimeElement(html: string, bounds: PlausibleRange): SignalAttempt {
  const rejected: string[] = [];
  let seen = 0;
  let undeclared = 0;
  for (const m of html.matchAll(/<time\b([^>]*)>/gi)) {
    if (seen >= MAX_TIME_TAGS) break;
    seen += 1;
    const tag = m[0];
    const datetime = attribute(tag, ['datetime']);
    if (datetime === undefined) continue;

    const itemprop = attribute(tag, ['itemprop'])?.toLowerCase() ?? '';
    const className = attribute(tag, ['class']) ?? '';
    const declaresPubdate = /\bpubdate\b/i.test(m[1] ?? '');
    const declares =
      declaresPubdate || itemprop.includes('datepublished') || TIME_PUBLISHED_CLASS.test(className);
    if (!declares) {
      undeclared += 1;
      continue;
    }

    const reading = readPublicationDate(datetime, bounds);
    if (reading.date !== null) {
      return {
        found: found(
          'time-element',
          reading.date,
          datetime,
          `read from a \`<time>\` element that declares itself a publication date${reading.why === '' ? '' : `; ${reading.why}`}`,
        ),
        rejected,
      };
    }
    rejected.push(`a published \`<time>\` element was not usable: ${reading.why}`);
  }
  if (undeclared > 0) {
    rejected.push(
      `${String(undeclared)} \`<time>\` element(s) were present but none said it was the publication date, so none was used; a bare \`<time>\` is as likely to be a comment timestamp`,
    );
  }
  return { rejected };
}

/**
 * A year and a month adjacent in the path.
 *
 * The adjacency is the whole rule. A lone four-digit segment is an issue number,
 * a version, a product year or a page id far more often than it is a
 * publication date, and `/issues/2019` would date a live issue tracker to seven
 * years ago. Requiring the month costs the handful of sites that put only a year
 * in a path and buys the whole class of false positives.
 */
function fromUrlPath(url: string, bounds: PlausibleRange): SignalAttempt {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return { rejected: [] };
  }

  const full = /(?:^|[^\d])((?:19|20)\d{2})[/-](0[1-9]|1[0-2])[/-](0[1-9]|[12]\d|3[01])(?:[^\d]|$)/.exec(
    path,
  );
  const partial = /(?:^|[^\d])((?:19|20)\d{2})[/-](0[1-9]|1[0-2])(?:\/|$)/.exec(path);
  const hit = full ?? partial;
  if (hit === null) return { rejected: [] };

  const year = Number(hit[1]);
  if (year < EARLIEST_URL_YEAR) {
    return {
      rejected: [
        `the path holds "${clip(hit[0], 40)}", which reads as a date before ${String(EARLIEST_URL_YEAR)} and is far likelier to be an identifier`,
      ],
    };
  }

  const raw = full === null ? `${hit[1] ?? ''}-${hit[2] ?? ''}-01` : `${hit[1] ?? ''}-${hit[2] ?? ''}-${hit[3] ?? ''}`;
  const reading = readPublicationDate(raw, bounds);
  if (reading.date === null) {
    return { rejected: [`the path date "${clip(hit[0], 40)}" was not usable: ${reading.why}`] };
  }
  return {
    found: found(
      'url-path',
      reading.date,
      hit[0],
      full === null
        ? 'read from a year and month in the URL path, with no day stated, so the first of that month was taken'
        : 'read from a date in the URL path',
    ),
    rejected: [],
  };
}

/**
 * The publication date of one fetched page, or the reason there is not one.
 *
 * Signals are tried in the order `PUBLICATION_SIGNALS` declares, which is by how
 * explicitly the publisher said "published". Where two disagree the more
 * explicit one wins, and `signal` on the result says which was used.
 *
 * **Every signal, including the URL path, needs a page that resolved.** The
 * first version of this file read the path even when nothing was read, on the
 * reasoning that an address is the one signal that survives a failed fetch.
 * Running it over the real corpus refuted that: the only page it dated that way
 * was a **fabricated** URL from the detector corpus, `example-news.invalid`,
 * which got a fresh 2026 date out of its own path. That is the recency axis
 * being fed by the backend under test, which is the one input a measurement may
 * never take. A path on a page that *did* resolve is corroborated by something
 * having genuinely been served at that address, and that case is 14 of the 43
 * dates this extractor finds on the real corpus, so the line is drawn there
 * rather than at the signal.
 *
 * It costs one real case, measured: a live MIT blog post behind a bot deterrent
 * whose path states its date. That page is now `unchecked`, which is the true
 * statement about it, and `unchecked` is what this whole file exists to keep
 * distinct from `absent`.
 */
export function extractPublicationDate(input: PublicationInput): PublicationDate {
  const bounds = plausibleRange(input.checkedAt);
  const rejected: string[] = [];
  const bodyAvailable = input.bodyRead && input.body !== '';

  const attempts: SignalAttempt[] = [];
  if (bodyAvailable) {
    const metas = readMetaTags(input.body).filter((meta) => {
      if (!namesAModification(meta.name)) return true;
      rejected.push(
        `the \`${meta.name}\` meta tag was refused: a modification date is not a publication date, and taking one would grade a rebuilt page fresh forever`,
      );
      return false;
    });

    attempts.push(fromJsonLd(input.body, bounds));
    attempts.push(fromMetaNames(metas, CITATION_NAMES, 'citation-meta', bounds));
    attempts.push(fromMetaNames(metas, ARTICLE_NAMES, 'article-published-time', bounds));
    attempts.push(fromMetaNames(metas, DUBLIN_NAMES, 'dublin-core', bounds));
    attempts.push(fromMetaNames(metas, EXPLICIT_PUBLISH_NAMES, 'meta-date', bounds));
    // Any other name that says "publish". `sei_date_published` and `published_at`
    // are both in the corpus under site-specific names no allowlist would hold,
    // and the modification filter above has already run, so a name saying
    // "publish" here cannot also be saying "updated".
    attempts.push(
      fromMetaNames(
        metas,
        [
          ...new Set(
            metas
              .filter((m) => m.name.includes('publish') || m.name.includes('pubdate'))
              .map((m) => m.name),
          ),
        ],
        'meta-date',
        bounds,
      ),
    );
    // The bare `date`, last among the meta tags, because it does not say which
    // date it is. Cisco's advisories are dated by nothing else.
    attempts.push(fromMetaNames(metas, ['date'], 'meta-date', bounds));
    attempts.push(fromTimeElement(input.body, bounds));
    attempts.push(fromUrlPath(input.url, bounds));
  }

  for (const attempt of attempts) {
    if (attempt.found !== undefined) return attempt.found;
    rejected.push(...attempt.rejected);
  }

  const seen = rejected.length === 0 ? '' : ` ${rejected.slice(0, 2).join('; ')}`;
  if (!bodyAvailable) {
    return {
      status: 'unchecked',
      detail: clip(
        `nothing was read from this page, so whether it states a publication date is unknown. A date in its address is not read here: on a page that never resolved that is the cited report's own claim about a source nobody could reach.${seen}`,
        MAX_DETAIL_CHARS,
      ),
    };
  }
  if (input.truncated) {
    return {
      status: 'unchecked',
      detail: clip(
        `the page was read only as far as the byte cap and no publication date appeared in that part, so a date further down was never seen.${seen}`,
        MAX_DETAIL_CHARS,
      ),
    };
  }
  return {
    status: 'absent',
    detail: clip(
      `the page was read in full and states no publication date this extractor recognises.${seen}`,
      MAX_DETAIL_CHARS,
    ),
  };
}
