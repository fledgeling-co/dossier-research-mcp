import type { CitationVerdict } from '../store/types.js';
import { canonicaliseUrl, registrableDomain } from './corroborate.js';
import { extractCitedUrls } from './report.js';

/**
 * Evidence governance: grading the sources a report used, rather than trusting
 * that it used good ones.
 *
 * Every provider produces citations. None of them grade them, and a report with
 * forty links looks identical whether they are forty regulators or forty SEO
 * aggregators repeating one press release. This layer is provider-neutral by
 * construction, which is also what makes cross-provider comparison mean
 * anything.
 *
 * The honesty constraint runs through all of it: these are **coarse
 * heuristics over URLs**, not a judgement about quality, and the numbers they
 * produce are advisory. Where the numbers and the evidence disagree, both are
 * reported and a human decides. A tool that refused to show you a report
 * because its source mix looked unusual would be wrong far more often than the
 * report.
 */

/** Can a reader get at this, and on what terms. */
export type Accessibility = 'public' | 'semi-public' | 'exclusive-user-provided' | 'private-user-owned';

/** What kind of source it is. `other` is common and honest. */
export type SourceType = 'official' | 'academic' | 'journalism' | 'secondary-industry' | 'community' | 'other';

export interface ClassifiedSource {
  readonly url: string;
  readonly domain: string;
  readonly accessibility: Accessibility;
  readonly type: SourceType;
  /** Why it landed in that bucket, so a wrong call is arguable rather than opaque. */
  readonly basis: string;
}

const ACADEMIC = /(^|\.)(arxiv\.org|doi\.org|ssrn\.com|pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov|nature\.com|science\.org|sciencedirect\.com|springer\.com|springeropen\.com|wiley\.com|tandfonline\.com|jstor\.org|acm\.org|ieee\.org|plos\.org|biorxiv\.org|medrxiv\.org|semanticscholar\.org|openreview\.net)$/i;
const COMMUNITY = /(^|\.)(reddit\.com|stackoverflow\.com|stackexchange\.com|news\.ycombinator\.com|ycombinator\.com|medium\.com|substack\.com|quora\.com|x\.com|twitter\.com|linkedin\.com|facebook\.com|discord\.com|youtube\.com|tiktok\.com)$/i;
const JOURNALISM = /(^|\.)(reuters\.com|apnews\.com|bloomberg\.com|ft\.com|wsj\.com|nytimes\.com|washingtonpost\.com|theguardian\.com|bbc\.co\.uk|bbc\.com|economist\.com|afr\.com|abc\.net\.au|smh\.com\.au|theage\.com\.au|cnbc\.com|forbes\.com|techcrunch\.com|theverge\.com|arstechnica\.com|wired\.com|theregister\.com)$/i;
const AGGREGATOR = /(^|\.)(g2\.com|capterra\.com|trustradius\.com|slashdot\.org|softwareadvice\.com|gartner\.com|forrester\.com|statista\.com|crunchbase\.com|similarweb\.com)$/i;

/**
 * Classify one cited URL.
 *
 * Deliberately conservative: anything the patterns do not recognise is `other`,
 * never a guess. An over-eager classifier would let a report pad its "official
 * share" with whatever happened to sit on a `.io` domain, which is worse than
 * admitting the classifier does not know.
 */
export function classifySource(
  url: string,
  opts: { readonly verdict?: CitationVerdict['verdict']; readonly fromCorpus?: boolean; readonly local?: boolean } = {},
): ClassifiedSource {
  const canonical = canonicaliseUrl(url);
  const domain = registrableDomain(canonical);

  if (opts.local) {
    return {
      url: canonical,
      domain,
      accessibility: 'private-user-owned',
      type: 'other',
      basis: 'a file on your machine, never sent anywhere',
    };
  }
  if (opts.fromCorpus) {
    return {
      url: canonical,
      domain,
      accessibility: 'exclusive-user-provided',
      type: 'other',
      basis: 'your own corpus',
    };
  }

  // A 401/402/403 is a registration wall or a paywall: readable, but not by
  // everyone, and a reader deserves to know before they follow the link.
  const accessibility: Accessibility =
    opts.verdict === 'blocked' ? 'semi-public' : 'public';

  let type: SourceType = 'other';
  let basis = 'unrecognised domain, so deliberately left unclassified';
  if (/(^|\.)(gov|mil)(\.[a-z]{2})?$/i.test(domain) || /(^|\.)europa\.eu$/i.test(domain)) {
    type = 'official';
    basis = 'government or regulator domain';
  } else if (/(^|\.)(edu|ac\.[a-z]{2})$/i.test(domain) || ACADEMIC.test(domain)) {
    type = 'academic';
    basis = 'academic publisher or institution';
  } else if (JOURNALISM.test(domain)) {
    type = 'journalism';
    basis = 'recognised news organisation';
  } else if (AGGREGATOR.test(domain)) {
    type = 'secondary-industry';
    basis = 'analyst or review aggregator, which is commentary about sources rather than a source';
  } else if (COMMUNITY.test(domain)) {
    type = 'community';
    basis = 'community or social platform';
  }

  return { url: canonical, domain, accessibility, type, basis };
}

/**
 * The user's own documents are valid **primary** evidence about their own
 * position and never **independent corroboration** of an external fact.
 *
 * Citing someone's own file back to them as though it confirmed something about
 * the world is circular verification: it produces a report that looks sourced
 * and proves nothing.
 */
export function countsAsCorroboration(source: ClassifiedSource): boolean {
  return source.accessibility === 'public' || source.accessibility === 'semi-public';
}

export interface QualityGate {
  readonly name: string;
  readonly actual: string;
  readonly floor: string;
  readonly met: boolean;
}

export interface EvidenceProfile {
  readonly sources: readonly ClassifiedSource[];
  readonly distinctDomains: number;
  readonly officialShare: number;
  readonly largestSingleDomainShare: number;
  readonly byType: Readonly<Record<SourceType, number>>;
  readonly gates: readonly QualityGate[];
  /** True when every advisory floor was met. Never a reason to refuse a report. */
  readonly allGatesMet: boolean;
}

const FLOORS = {
  standard: { officialShare: 0.3, approved: 12, domains: 5, maxSingle: 0.25 },
  light: { officialShare: 0.2, approved: 6, domains: 3, maxSingle: 0.3 },
} as const;

/**
 * Profile a report's source mix against advisory floors.
 *
 * > These are **floors for routine work, not pass/fail gates.** They are
 * > gameable — padding with official sources satisfies a percentage without
 * > improving anything — and they wrongly penalise good investigative research,
 * > where one leaked primary document outweighs twenty secondary write-ups.
 *
 * So this reports and never refuses. `allGatesMet: false` on a report built on
 * a single extraordinary document is the correct output, and so is publishing
 * that report.
 */
export function profileEvidence(
  sources: readonly ClassifiedSource[],
  level: 'standard' | 'light' = 'standard',
): EvidenceProfile {
  const floors = FLOORS[level];
  const byType: Record<SourceType, number> = {
    official: 0,
    academic: 0,
    journalism: 0,
    'secondary-industry': 0,
    community: 0,
    other: 0,
  };
  const perDomain = new Map<string, number>();
  for (const s of sources) {
    byType[s.type] += 1;
    perDomain.set(s.domain, (perDomain.get(s.domain) ?? 0) + 1);
  }

  const total = sources.length;
  // Academic counts toward the "official" floor: a peer-reviewed paper is a
  // primary source in exactly the sense the floor is reaching for, and a
  // technical question can be well-evidenced without a single regulator.
  const official = byType.official + byType.academic;
  const officialShare = total === 0 ? 0 : official / total;
  const largest = Math.max(0, ...perDomain.values());
  const largestShare = total === 0 ? 0 : largest / total;

  const pct = (n: number): string => `${String(Math.round(n * 100))}%`;
  const gates: QualityGate[] = [
    {
      name: 'Official or academic share',
      actual: pct(officialShare),
      floor: `≥${pct(floors.officialShare)}`,
      met: officialShare >= floors.officialShare,
    },
    {
      name: 'Sources used',
      actual: String(total),
      floor: `≥${String(floors.approved)}`,
      met: total >= floors.approved,
    },
    {
      name: 'Distinct domains',
      actual: String(perDomain.size),
      floor: `≥${String(floors.domains)}`,
      met: perDomain.size >= floors.domains,
    },
    {
      name: 'Largest single domain',
      actual: pct(largestShare),
      floor: `≤${pct(floors.maxSingle)}`,
      met: total === 0 || largestShare <= floors.maxSingle,
    },
  ];

  return {
    sources,
    distinctDomains: perDomain.size,
    officialShare,
    largestSingleDomainShare: largestShare,
    byType,
    gates,
    allGatesMet: gates.every((g) => g.met),
  };
}

export interface RegistryEntry {
  readonly n: number;
  readonly url: string;
  readonly domain: string;
}

/**
 * One numbered, deduplicated, frozen source list, built from the report.
 *
 * Numbers are final. A follow-up or a verification pass cites *from the
 * registry*, never from the report's prose, which closes the failure where a
 * model invents a plausible reference mid-answer to support a sentence it
 * wanted to write. Deduplication is by canonical URL, so the same page cited
 * three different ways is entry 7 three times rather than 7, 12 and 19.
 */
export function buildRegistry(markdown: string): RegistryEntry[] {
  const seen = new Map<string, RegistryEntry>();
  for (const raw of extractCitedUrls(markdown)) {
    const url = canonicaliseUrl(raw);
    if (seen.has(url)) continue;
    seen.set(url, { n: seen.size + 1, url, domain: registrableDomain(url) });
  }
  return [...seen.values()];
}

/**
 * How a statement earned its place in a report.
 *
 * The middle mark is the whole point, and it is the one every provider omits.
 * When a research agent established three correct facts, multiplied two of them
 * and ignored the third, every input was sourced and the output was wrong. A
 * reader told "this conclusion is *synthesised* from claims 4, 7 and 11" knows
 * exactly where to look. A reader shown a paragraph of confident prose does not.
 */
export const SYNTHESIS_MARKS = {
  sourced: 'supported by a specific citation',
  synthesised: 'the system joining two or more sourced claims; the inputs are cited, the connection is not',
  unverified: 'asserted without support, and never to be presented as a finding',
} as const;
export type SynthesisMark = keyof typeof SYNTHESIS_MARKS;

/**
 * A record of what was actually asked, for a method section.
 *
 * Repeated searches return different result sets, on every backend here, which
 * breaks the search-documentation requirement of any serious review method.
 * Guaranteeing reproducibility is not achievable and claiming it would be
 * dishonest; recording exactly what was asked and what came back is achievable,
 * and it is what makes a report auditable rather than merely cited.
 */
export interface SearchTrace {
  readonly provider: string;
  readonly tier: string;
  readonly shape: string;
  readonly window?: string;
  readonly enforced: readonly string[];
  readonly requested: readonly string[];
  readonly asOf: string;
  readonly urls: readonly string[];
}

export function renderTrace(trace: SearchTrace): string {
  return [
    '### Search trace',
    '',
    `- Backend: ${trace.provider} (${trace.tier} tier, ${trace.shape} shape)`,
    trace.window ? `- Window: ${trace.window}` : '',
    trace.enforced.length > 0 ? `- Enforced by the backend: ${trace.enforced.join('; ')}` : '',
    trace.requested.length > 0 ? `- Asked for in the prompt only: ${trace.requested.join('; ')}` : '',
    `- As of: ${trace.asOf}`,
    `- Sources returned: ${String(trace.urls.length)}`,
    '',
    '_Re-running is not guaranteed to reproduce this. Every backend here returns different result sets for the same query on different days, so this records what was asked and what came back rather than promising repeatability._',
  ]
    .filter(Boolean)
    .join('\n');
}

/** One line a caller can show verbatim. */
export function renderProfile(profile: EvidenceProfile): string {
  const rows = profile.gates.map((g) => `| ${g.name} | ${g.actual} | ${g.floor} | ${g.met ? '✅' : '⚠️'} |`);
  const types = Object.entries(profile.byType)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${t}: ${String(n)}`)
    .join(' · ');
  return [
    '### Source profile',
    '',
    `${String(profile.sources.length)} cited source(s) across ${String(profile.distinctDomains)} domain(s). ${types}`,
    '',
    '| Check | Actual | Floor | |',
    '|---|---|---|---|',
    ...rows,
    '',
    profile.allGatesMet
      ? '_Every advisory floor met._'
      : '_One or more floors not met. These are advisory: they are gameable, and they wrongly penalise investigative work where a single primary document outweighs twenty write-ups. Read the mix, not the ticks._',
  ].join('\n');
}
