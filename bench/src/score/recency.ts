import { canonicaliseUrl, registrableDomain } from '../../../src/research/corroborate.js';
import { classifySource, type Freshness, type SourceType } from '../../../src/research/evidence.js';

/**
 * Recency, and the rule the design said already existed.
 *
 * `docs/plan/benchmark.md` lists recency as a scored dimension and says to
 * "weight by source type using the existing rule that a standard from 2019 is
 * current while a benchmark from 2019 is not". BENCH-01 checked and the rule
 * does not exist: `HORIZONS` in `src/research/evidence.ts` is keyed by source
 * type alone, so a 2019 W3C recommendation and a 2019 leaderboard both land in
 * the same bucket and are graded identically. No fleet item owned building it.
 * BENCH-06 takes it, and this file is it.
 *
 * **The missing axis is durability, and it is orthogonal to source type.** What
 * makes a document age is not who published it but whether it describes
 * something that changes. A specification is current until something
 * supersedes it, and the calendar is a poor proxy for that. A benchmark result,
 * a price list, a changelog or a leaderboard is a measurement of a moment, and
 * six months later it is describing a world that has moved.
 *
 * **The product's own staleness grading is deliberately untouched.** Changing
 * `assessStaleness` changes what `research_evidence` prints for every user of
 * the product, which is a product decision and not a benchmark item's to take.
 * The table below therefore restates the product's per-type numbers rather than
 * importing them (they are module-private there), and a parity test asserts
 * that a source of unknown durability grades exactly as the product grades it,
 * so the restatement cannot drift unnoticed. Adopting the durability axis into
 * the product is a named follow-up, not something done here by side effect.
 */

export type Durability = 'durable' | 'perishable' | 'unknown';

export interface DurabilityVerdict {
  readonly durability: Durability;
  /** Why it landed there, so a wrong call is arguable rather than opaque. */
  readonly basis: string;
}

/**
 * Bodies whose primary output is a standard, a specification or a statute.
 *
 * Deliberately narrow. A broad government or university host publishes news,
 * blog posts and press releases alongside its durable documents, and treating
 * the whole host as durable would let a report pad its recency with whatever
 * happened to sit on a plausible domain. That is the same conservatism
 * `classifySource` already applies when it leaves an unrecognised domain
 * `other` rather than guessing.
 */
const DURABLE_HOSTS =
  /(^|\.)(iso\.org|iec\.ch|ietf\.org|rfc-editor\.org|w3\.org|whatwg\.org|ecma-international\.org|unicode\.org|itu\.int|etsi\.org|ansi\.org|astm\.org|bipm\.org|opengroup\.org|oasis-open\.org|legislation\.gov\.uk|eur-lex\.europa\.eu|congress\.gov|govinfo\.gov|supremecourt\.gov|legislation\.gov\.au|austlii\.edu\.au|courtlistener\.com)$/i;

/** Path segments that name a durable document wherever it is hosted. */
const DURABLE_PATHS =
  /(^|\/)(tr|rfc|rfcs?|std|standards?|specs?|specification|statute|statutes|legislation|regulation|regulations|directive|judgment|judgement|constitution)(\/|$)/i;

/**
 * Pages whose whole content is a measurement of a moment.
 *
 * Checked **before** durability, and the order is the interesting half: a
 * benchmark result published by a standards body is still a benchmark result.
 * The host says who wrote it; the path says what it is.
 */
const PERISHABLE_PATHS =
  /(^|\/)(leaderboards?|benchmarks?|pricing|prices?|plans|changelogs?|releases?|release-notes|whats-new|what-s-new|status|roadmap|downloads?|state-of-[a-z0-9-]+)(\/|$)/i;

/** Hosts that exist to publish a moving number. */
const PERISHABLE_HOSTS = /(^|\.)(status\.[a-z0-9-]+\..+|paperswithcode\.com)$/i;

/**
 * Classify one cited URL on the durability axis.
 *
 * Unknown is the common and honest answer, and it costs nothing: an unknown
 * source falls back to exactly the horizon the product already uses, so the
 * classifier can only ever improve on the status quo or leave it alone.
 */
export function classifyDurability(url: string): DurabilityVerdict {
  let parsed: URL;
  try {
    parsed = new URL(canonicaliseUrl(url));
  } catch {
    return {
      durability: 'unknown',
      basis: 'the URL could not be parsed, so nothing is assumed about what kind of document it is',
    };
  }
  const path = parsed.pathname;
  const host = parsed.hostname;
  const domain = registrableDomain(url);

  if (PERISHABLE_PATHS.test(path)) {
    return {
      durability: 'perishable',
      basis: 'its path names a leaderboard, benchmark, price list, changelog or release, all of which describe a moment rather than a rule',
    };
  }
  if (PERISHABLE_HOSTS.test(host) || PERISHABLE_HOSTS.test(domain)) {
    return {
      durability: 'perishable',
      basis: 'the host exists to publish a moving number',
    };
  }
  // Host as well as registrable domain: `registrableDomain` collapses
  // `eur-lex.europa.eu` to `europa.eu`, which is the right answer for counting
  // independent sources and the wrong one for recognising a specific publisher.
  if (DURABLE_HOSTS.test(domain) || DURABLE_HOSTS.test(host)) {
    return {
      durability: 'durable',
      basis: 'a standards body, a legislature or a court, whose output stands until something supersedes it',
    };
  }
  if (DURABLE_PATHS.test(path)) {
    return {
      durability: 'durable',
      basis: 'its path names a standard, specification or statute, which stands until superseded',
    };
  }
  return {
    durability: 'unknown',
    basis: 'nothing in the host or path says what kind of document this is, so the source-type horizon applies unchanged',
  };
}

export interface Horizon {
  readonly ageing: number;
  readonly stale: number;
}

/**
 * The per-type horizons, in days, restated from `src/research/evidence.ts`.
 *
 * Restated rather than imported because `HORIZONS` is module-private there. The
 * parity test in `recency.test.ts` drives the product's own `assessStaleness`
 * and this file side by side on the same inputs, so if the product ever changes
 * its numbers the benchmark fails rather than quietly measuring against an old
 * rule.
 */
export const BENCH_SOURCE_HORIZONS: Readonly<Record<SourceType, Horizon>> = {
  academic: { ageing: 730, stale: 1095 },
  journalism: { ageing: 90, stale: 183 },
  community: { ageing: 90, stale: 183 },
  official: { ageing: 183, stale: 548 },
  'secondary-industry': { ageing: 183, stale: 548 },
  other: { ageing: 183, stale: 548 },
};

/**
 * Ten years before a durable document is worth re-checking, fifteen before
 * leaning on it unexamined is reckless.
 *
 * A floor rather than a replacement: durability may only ever *widen* a
 * horizon. The point of the axis is that a standard does not rot on a
 * calendar, so it must never make a source look staler than the source-type
 * rule already said it was.
 */
export const DURABLE_FLOOR: Horizon = { ageing: 3653, stale: 5478 };

/**
 * Three months and six months for a measurement of a moment.
 *
 * A ceiling, the mirror of the floor above: perishability may only ever
 * *narrow* a horizon. Six months is the same number the product already uses
 * for news, and for the same reason: a benchmark from last year is describing a
 * field that has moved, exactly as last year's reporting is.
 */
export const PERISHABLE_CEILING: Horizon = { ageing: 90, stale: 183 };

/** The horizon a source is graded against, once both axes are known. */
export function recencyHorizon(type: SourceType, durability: Durability): Horizon {
  const base = BENCH_SOURCE_HORIZONS[type];
  switch (durability) {
    case 'durable':
      return {
        ageing: Math.max(base.ageing, DURABLE_FLOOR.ageing),
        stale: Math.max(base.stale, DURABLE_FLOOR.stale),
      };
    case 'perishable':
      return {
        ageing: Math.min(base.ageing, PERISHABLE_CEILING.ageing),
        stale: Math.min(base.stale, PERISHABLE_CEILING.stale),
      };
    case 'unknown':
      return base;
    default: {
      const exhaustive: never = durability;
      return exhaustive;
    }
  }
}

export interface RecencySource {
  readonly url: string;
  /** As the source states it. Anything `Date.parse` reads; absent is normal. */
  readonly publishedAt?: string | undefined;
  /** Supplied by the harness where it knows; otherwise derived from the URL. */
  readonly type?: SourceType | undefined;
}

export interface SourceRecency {
  readonly url: string;
  readonly domain: string;
  readonly type: SourceType;
  readonly durability: Durability;
  readonly durabilityBasis: string;
  readonly horizon: Horizon;
  readonly freshness: Freshness;
  readonly ageDays: number | null;
  readonly why: string;
}

const DAY_MS = 86_400_000;

/**
 * Grade one source's age against the task's as-of date, on both axes.
 *
 * The `Freshness` vocabulary is the product's own, imported rather than
 * redefined, so nothing downstream has to learn a second word for the same
 * idea. `undated` is the honest answer for a source carrying no date and for
 * one whose date cannot be read: treating either as current would be a
 * measurement of nothing.
 */
export function assessSourceRecency(source: RecencySource, asOf: string): SourceRecency {
  const type = source.type ?? classifySource(source.url).type;
  const { durability, basis } = classifyDurability(source.url);
  const horizon = recencyHorizon(type, durability);
  const domain = registrableDomain(source.url);
  const base = { url: source.url, domain, type, durability, durabilityBasis: basis, horizon };

  const published = source.publishedAt?.trim();
  if (!published) {
    return {
      ...base,
      freshness: 'undated',
      ageDays: null,
      why: 'no publication date was recorded, so its age cannot be assessed at all',
    };
  }
  const at = Date.parse(published);
  const anchor = Date.parse(asOf);
  if (Number.isNaN(at) || Number.isNaN(anchor)) {
    return {
      ...base,
      freshness: 'undated',
      ageDays: null,
      why: `the recorded date "${published.slice(0, 40)}" could not be read as a date`,
    };
  }

  const ageDays = Math.round((anchor - at) / DAY_MS);
  if (ageDays < 0) {
    return {
      ...base,
      freshness: 'after-horizon',
      ageDays,
      why: 'its stated date is later than the as-of date, which is a transcription error or a back-dated source',
    };
  }
  if (ageDays >= horizon.stale) {
    return {
      ...base,
      freshness: 'stale',
      ageDays,
      why: `${String(ageDays)} days old against a ${String(horizon.stale)}-day horizon for a ${durability} ${type} source`,
    };
  }
  if (ageDays >= horizon.ageing) {
    return {
      ...base,
      freshness: 'ageing',
      ageDays,
      why: `${String(ageDays)} days old, past the ${String(horizon.ageing)}-day mark for a ${durability} ${type} source`,
    };
  }
  return {
    ...base,
    freshness: 'fresh',
    ageDays,
    why: `${String(ageDays)} days old, within the horizon for a ${durability} ${type} source`,
  };
}

export interface RecencyNotApplicable {
  readonly status: 'not-applicable';
  readonly why: string;
}

export interface RecencyUnmeasurable {
  readonly status: 'unmeasurable';
  readonly why: string;
  readonly sources: readonly SourceRecency[];
  readonly counts: Readonly<Record<Freshness, number>>;
}

export interface RecencyScored {
  readonly status: 'scored';
  /** Fresh over the sources that could actually be dated. Never over all of them. */
  readonly freshShare: number;
  /** The denominator, stated, because the share is meaningless without it. */
  readonly dated: number;
  readonly counts: Readonly<Record<Freshness, number>>;
  readonly sources: readonly SourceRecency[];
  readonly notes: readonly string[];
}

export type RecencyResult = RecencyNotApplicable | RecencyUnmeasurable | RecencyScored;

function emptyCounts(): Record<Freshness, number> {
  return { fresh: 0, ageing: 0, stale: 0, undated: 0, 'after-horizon': 0 };
}

/**
 * Score a report's source set for recency against the task's as-of date.
 *
 * The denominator is the **dated** sources only. An undated source is carried
 * as its own number and never counted as current, and a source dated after the
 * as-of date is a transcription error rather than a fresh source, so neither
 * enters the share. A recency figure that quietly counts undated as fresh
 * rewards a backend for citing pages that carry no date at all.
 */
export function scoreRecency(
  sources: readonly RecencySource[],
  asOf: string,
): RecencyResult {
  if (sources.length === 0) {
    return {
      status: 'not-applicable',
      why: 'the report cited no sources, so there is no recency to measure. An empty set is not a fresh one.',
    };
  }

  const graded = sources.map((s) => assessSourceRecency(s, asOf));
  const counts = emptyCounts();
  for (const g of graded) counts[g.freshness] += 1;

  const dated = counts.fresh + counts.ageing + counts.stale;
  if (dated === 0) {
    return {
      status: 'unmeasurable',
      why: `none of the ${String(sources.length)} cited sources carries a readable publication date at or before the as-of date, so recency cannot be assessed`,
      sources: graded,
      counts,
    };
  }

  const notes: string[] = [];
  if (counts.undated > 0) {
    notes.push(
      `${String(counts.undated)} source(s) carry no readable date and are excluded from the share rather than counted as current.`,
    );
  }
  if (counts['after-horizon'] > 0) {
    notes.push(
      `${String(counts['after-horizon'])} source(s) are dated after the task's as-of date, which is a transcription error or a back-dated source; they are excluded.`,
    );
  }
  const unknownDurability = graded.filter((g) => g.durability === 'unknown').length;
  if (unknownDurability > 0) {
    notes.push(
      `${String(unknownDurability)} source(s) could not be classified as durable or perishable and were graded on source type alone, exactly as the product grades them.`,
    );
  }

  return {
    status: 'scored',
    freshShare: counts.fresh / dated,
    dated,
    counts,
    sources: graded,
    notes,
  };
}
