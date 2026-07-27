import {
  assessSupport,
  canonicaliseUrl,
  isHttpUrl,
  registrableDomain,
} from '../../../src/research/corroborate.js';
import {
  classifySource,
  profileEvidence,
  type ClassifiedSource,
  type EvidenceProfile,
} from '../../../src/research/evidence.js';
import {
  MAX_PAGE_CHARS,
  MIN_SHINGLES,
  sameStory,
  shingleHashes,
  SHINGLE_WORDS,
  SYNDICATION_CONTAINMENT,
  SYNDICATION_RESEMBLANCE,
} from './syndication.js';

/**
 * Source quality, independence, and the syndication the domain count cannot see.
 *
 * Three things, in order of how much of them is new.
 *
 * **The source mix is entirely the product's own rule**, not a second opinion
 * invented for the benchmark: `classifySource` decides what a URL is and
 * `profileEvidence` turns a set of them into the official / academic /
 * journalism / community mix with the shares. Reimplementing either would give
 * the benchmark and the product two definitions of "official source" that
 * eventually disagree, which is the argument `docs/plan/benchmark.md` already
 * makes for building the benchmark inside this repo rather than beside it.
 *
 * **The independent-domain count is `assessSupport`'s.** It is the function that
 * encodes the rule the whole product turns on: corroboration is counted in
 * independent registrable domains after canonicalisation, never in providers and
 * never in raw URLs. (`countsAsCorroboration`, which an early draft of this
 * item's brief named for the job, does something else entirely: it filters a
 * user's own documents out of independent corroboration and counts nothing.)
 *
 * **Syndication is the new part.** Four domains carrying one wire story are four
 * domains and one source, and no amount of care about domain identity can see
 * that, because the four domains genuinely are four domains. It takes the page
 * text. See `syndication.ts` for the method and for the provenance of its
 * threshold.
 *
 * Two rules run through the whole file.
 *
 * **Both counts, always.** The collapsed count is never returned without the raw
 * one, and the type makes that impossible rather than asking anyone to remember
 * it. The threshold that produces the collapse is a judgement, and a reader who
 * disagrees with the judgement needs the raw figure to reason from.
 *
 * **No blended number.** There is deliberately no single "source quality score"
 * here. The 2026 prior art in `docs/deep-research/benchmark-prior-art.md` is
 * blunt about why: citation volume and citation quality are close to orthogonal
 * in current systems and human preference tracks the former, so a blended score
 * systematically fails to penalise the failure mode being measured. The parts
 * are returned separately and whoever reports them decides what to do with them.
 *
 * Pure and synchronous, like every other scorer here. Nothing fetches: the page
 * text arrives already collected, exactly as `recency.ts` takes publication
 * dates already collected. That is what keeps the result reproducible from a
 * stored run and keeps every test off the network.
 */

/**
 * The most pages one call will compare.
 *
 * A resource bound, like `MAX_PAGE_CHARS`. The comparison is pairwise, so the
 * work grows with the square of the page count; two hundred pages is forty
 * thousand comparisons, which is nothing, and is already far more citations than
 * any report in the corpus carries. Pages beyond the cap are **reported as
 * unexamined**, not dropped quietly, because a page nobody looked at must not
 * be able to make the collapsed count look more thorough than it was.
 */
export const MAX_PAGES = 200;

/** One page whose text was collected by whoever did the fetching. */
export interface FetchedPage {
  readonly url: string;
  /** The page as plain text. HTML stripping is the caller's job, not this one's. */
  readonly text: string;
}

/** A pair of pages this judged to be the same story, and on what evidence. */
export interface SyndicationLink {
  readonly a: string;
  readonly b: string;
  readonly resemblance: number;
  readonly containment: number;
  readonly basis: 'resemblance' | 'containment';
}

/** Two or more domains that the page text says are carrying one story. */
export interface SyndicationCluster {
  readonly domains: readonly string[];
  readonly urls: readonly string[];
  /** The pairs that joined it, with their scores. This is the evidence. */
  readonly links: readonly SyndicationLink[];
}

/** A cited domain that could not be tested for syndication, and why not. */
export interface UncheckedDomain {
  readonly domain: string;
  readonly why: string;
}

export interface SourceQualityNotApplicable {
  readonly status: 'not-applicable';
  readonly why: string;
  /** Citations that were not resolvable web addresses at all. */
  readonly discardedCitations: readonly string[];
}

export interface SourceQualityScored {
  readonly status: 'scored';
  readonly sources: readonly ClassifiedSource[];
  /**
   * The product's own source-mix profile: counts by type, the official or
   * academic share, the largest single domain's share, and the product's
   * advisory floors. The floors are **reported, never scored**: they are
   * gameable and they wrongly penalise investigative work, which is exactly what
   * `profileEvidence` says about them, and nothing here overrides that.
   */
  readonly profile: EvidenceProfile;
  /**
   * Independent registrable domains, counted the way the product counts them.
   * Always present, always beside the collapsed figure.
   */
  readonly rawIndependentDomains: number;
  /**
   * The same count after domains carrying one story have been merged.
   * Never `<= 0` while `rawIndependentDomains` is positive, and never returned
   * on its own.
   */
  readonly collapsedIndependentDomains: number;
  readonly syndicationClusters: readonly SyndicationCluster[];
  /** How many supplied pages were long enough to be compared at all. */
  readonly comparedPages: number;
  /** Pages compared on a prefix only, named so a partial score is never silent. */
  readonly truncatedPages: readonly string[];
  /** Pages past the page ceiling that were never examined. */
  readonly unexaminedPages: number;
  /**
   * Every cited domain no page could be compared for. A collapsed count that
   * quietly means "we checked some of them" is worse than no collapsed count,
   * so the ones that were not checked are named rather than counted.
   */
  readonly uncheckedDomains: readonly UncheckedDomain[];
  readonly discardedCitations: readonly string[];
  /** The judgement calls, returned as values so a reader can re-decide. */
  readonly thresholds: {
    readonly resemblance: number;
    readonly containment: number;
    readonly shingleWords: number;
    readonly minShingles: number;
    readonly maxPageChars: number;
    readonly maxPages: number;
  };
  readonly notes: readonly string[];
}

export type SourceQualityResult = SourceQualityNotApplicable | SourceQualityScored;

/**
 * Disjoint-set over domain names.
 *
 * Union-find rather than pairwise grouping because syndication is transitive and
 * the transitivity is the point: a wire story reaches a chain of outlets, the
 * first and last of which may share little directly once each has trimmed it
 * differently. Handling that as a set of independent pairs would count one story
 * as several sources, which is the exact error this whole module exists to stop.
 */
class DomainGroups {
  private readonly parent = new Map<string, string>();

  add(domain: string): void {
    if (!this.parent.has(domain)) this.parent.set(domain, domain);
  }

  find(domain: string): string {
    let root = this.parent.get(domain) ?? domain;
    while (root !== (this.parent.get(root) ?? root)) root = this.parent.get(root) ?? root;
    // Path compression, so a long syndication chain does not degrade the walk.
    let cursor = domain;
    while (cursor !== root) {
      const next = this.parent.get(cursor) ?? cursor;
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    this.add(a);
    this.add(b);
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootA, rootB);
  }

  groups(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const domain of this.parent.keys()) {
      const root = this.find(domain);
      const bucket = out.get(root);
      if (bucket) bucket.push(domain);
      else out.set(root, [domain]);
    }
    return out;
  }
}

/**
 * Score a report's cited sources for quality, independence and syndication.
 *
 * `citedUrls` is what the report cited; `pages` is the text of whichever of them
 * were fetched. `buildRegistry` in `src/research/evidence.ts` is the existing
 * way to get the first from report markdown, deduplicated by canonical URL, and
 * is the list a caller should pass rather than re-extracting one.
 *
 * **Ordering is load-bearing.** Citations that are not resolvable web addresses
 * are discarded once, first, before either count. `assessSupport` already
 * ignores them and `classifySource` does not, so filtering anywhere later would
 * leave the two counts describing different populations and make the difference
 * between them mean something other than syndication. Model output really does
 * arrive with "unknown" and "not available" among the links, and the product
 * already learned what counting those does to a corroboration figure.
 */
export function scoreSourceQuality(
  citedUrls: readonly string[],
  pages: readonly FetchedPage[] = [],
): SourceQualityResult {
  const discardedCitations: string[] = [];
  const usable: string[] = [];
  const seen = new Set<string>();
  for (const raw of citedUrls) {
    if (!isHttpUrl(raw)) {
      discardedCitations.push(raw.slice(0, 200));
      continue;
    }
    // Deduplicate by canonical URL, matching `buildRegistry`: the same page
    // cited three different ways is one source, not three.
    const canonical = canonicaliseUrl(raw);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    usable.push(canonical);
  }

  if (usable.length === 0) {
    return {
      status: 'not-applicable',
      why:
        discardedCitations.length > 0
          ? `none of the ${String(discardedCitations.length)} citation(s) is a resolvable web address, so there are no sources to grade. An unresolvable citation is not a source.`
          : 'the report cited no sources, so there is no source mix to grade. An empty set is not an independent one.',
      discardedCitations,
    };
  }

  const sources = usable.map((url) => classifySource(url));
  const profile = profileEvidence(sources);

  // The product's own counter, called with the report as a single claim. This
  // is the number, not a reimplementation of it; `profile.distinctDomains` and
  // the domain set below are two further paths to the same figure and a test
  // pins all three together so none of them can drift.
  const rawIndependentDomains = assessSupport([
    { provider: 'report', text: '', urls: usable },
  ]).independentDomains;

  const citedDomains = new Set(sources.map((s) => s.domain));
  const groups = new DomainGroups();
  for (const domain of citedDomains) groups.add(domain);

  // Only pages on a domain the report actually cited take part. A page supplied
  // for something the report never cited is not evidence about this report, and
  // letting it join two cited domains would merge them on the strength of a
  // document that is not in the report at all.
  const comparable: { url: string; domain: string; shingles: Set<number> }[] = [];
  const domainsWithShortPage = new Set<string>();
  const truncatedPages: string[] = [];
  let ignoredPages = 0;
  let unexaminedPages = 0;
  const seenPageUrls = new Set<string>();
  for (const page of pages) {
    if (!isHttpUrl(page.url)) {
      ignoredPages += 1;
      continue;
    }
    const url = canonicaliseUrl(page.url);
    const domain = registrableDomain(url);
    if (!citedDomains.has(domain) || seenPageUrls.has(url)) {
      ignoredPages += 1;
      continue;
    }
    seenPageUrls.add(url);
    if (comparable.length >= MAX_PAGES) {
      unexaminedPages += 1;
      continue;
    }
    if (page.text.length > MAX_PAGE_CHARS) truncatedPages.push(url);
    const shingles = shingleHashes(page.text);
    if (shingles.size < MIN_SHINGLES) {
      domainsWithShortPage.add(domain);
      continue;
    }
    comparable.push({ url, domain, shingles });
  }

  /**
   * The rule, stated because a domain can contribute more than one page.
   *
   * Two domains merge when **any** page on one is the same story as **any** page
   * on the other. Pages are what get compared; domains are what get counted, and
   * this is the mapping between them.
   *
   * The consequence worth knowing: an outlet that ran both its own original
   * reporting and the wire copy merges with the wire's other carriers on the
   * strength of the wire copy alone, even though its original piece is genuine
   * independent evidence. That direction *understates* independence. It is
   * accepted rather than engineered around for two reasons. Counting story
   * clusters instead of domains would answer a different question from the raw
   * figure it sits beside, so the two numbers would stop being comparable, which
   * is the one property the brief insists on. And the case is visible rather
   * than silent: the cluster is reported with its URLs and its scores, and a
   * note below names any merged domain that also carried a page in no cluster,
   * so a reader can see exactly what was merged and disagree.
   */
  const links: SyndicationLink[] = [];
  const clusteredPageUrls = new Set<string>();
  for (let i = 0; i < comparable.length; i += 1) {
    for (let j = i + 1; j < comparable.length; j += 1) {
      const a = comparable[i]!;
      const b = comparable[j]!;
      // Two pages on one domain cannot change the domain count, so the pair is
      // skipped rather than compared and reported as a cluster of one.
      if (a.domain === b.domain) continue;
      const verdict = sameStory(a.shingles, b.shingles);
      if (!verdict.same) continue;
      groups.union(a.domain, b.domain);
      clusteredPageUrls.add(a.url);
      clusteredPageUrls.add(b.url);
      links.push({
        a: a.url,
        b: b.url,
        resemblance: Math.round(verdict.resemblance * 1000) / 1000,
        containment: Math.round(verdict.containment * 1000) / 1000,
        // `sameStory` only returns these two bases when `same` is true; the
        // narrowing is asserted here rather than left to a cast.
        basis: verdict.basis === 'containment' ? 'containment' : 'resemblance',
      });
    }
  }

  const grouped = groups.groups();
  const urlsByDomain = new Map<string, string[]>();
  for (const page of comparable) {
    const bucket = urlsByDomain.get(page.domain);
    if (bucket) bucket.push(page.url);
    else urlsByDomain.set(page.domain, [page.url]);
  }

  const syndicationClusters: SyndicationCluster[] = [];
  for (const domains of grouped.values()) {
    if (domains.length < 2) continue;
    const sorted = [...domains].sort();
    const inCluster = new Set(sorted);
    syndicationClusters.push({
      domains: sorted,
      urls: sorted.flatMap((d) => urlsByDomain.get(d) ?? []),
      links: links.filter(
        (l) => inCluster.has(registrableDomain(l.a)) && inCluster.has(registrableDomain(l.b)),
      ),
    });
  }
  syndicationClusters.sort((a, b) => b.domains.length - a.domains.length);

  const checkedDomains = new Set(comparable.map((p) => p.domain));
  const uncheckedDomains: UncheckedDomain[] = [];
  for (const domain of [...citedDomains].sort()) {
    if (checkedDomains.has(domain)) continue;
    uncheckedDomains.push({
      domain,
      why: domainsWithShortPage.has(domain)
        ? `every page supplied for this domain was shorter than ${String(MIN_SHINGLES)} shingles, which is too little text to characterise; it is counted as its own source rather than merged`
        : 'no page text was supplied for this domain, so it could not be compared; it is counted as its own source',
    });
  }

  const notes: string[] = [];
  if (discardedCitations.length > 0) {
    notes.push(
      `${String(discardedCitations.length)} citation(s) were not resolvable web addresses and were discarded before either count, so both counts describe the same set of links.`,
    );
  }
  if (uncheckedDomains.length > 0) {
    notes.push(
      `${String(uncheckedDomains.length)} of ${String(citedDomains.size)} cited domain(s) had no page long enough to compare. Syndication among them is not ruled out; it is untested, and the collapsed count therefore reads as an upper bound on how much collapsing there is.`,
    );
  }
  if (ignoredPages > 0) {
    notes.push(
      `${String(ignoredPages)} supplied page(s) were on a domain the report did not cite, or repeated a page already supplied, and took no part.`,
    );
  }
  if (truncatedPages.length > 0) {
    notes.push(
      `${String(truncatedPages.length)} page(s) were longer than ${String(MAX_PAGE_CHARS)} characters and were compared on the first ${String(MAX_PAGE_CHARS)} only: ${truncatedPages.join(', ')}.`,
    );
  }
  if (unexaminedPages > 0) {
    notes.push(
      `${String(unexaminedPages)} page(s) past the ${String(MAX_PAGES)}-page ceiling were not examined at all, so any syndication among them is untested rather than ruled out.`,
    );
  }
  if (syndicationClusters.length > 0) {
    notes.push(
      `${String(rawIndependentDomains)} independent domain(s) collapse to ${String(grouped.size)} once pages carrying the same story are merged. Both figures are reported: the merging threshold is a judgement and the raw figure is what a reader who disagrees with it should reason from.`,
    );
    // A merged domain that also carried a page in no cluster contributed
    // evidence the merge is not accounting for, so the collapsed figure
    // understates independence for that domain. Named rather than silently
    // folded in; see the rule statement above the pairwise loop.
    const mergedDomains = new Set(syndicationClusters.flatMap((c) => c.domains));
    const alsoOriginal = [
      ...new Set(
        comparable
          .filter((p) => mergedDomains.has(p.domain) && !clusteredPageUrls.has(p.url))
          .map((p) => p.domain),
      ),
    ].sort();
    if (alsoOriginal.length > 0) {
      notes.push(
        `${String(alsoOriginal.length)} merged domain(s) also carried a page matching nothing else (${alsoOriginal.join(', ')}). Merging counts them once, so for those the collapsed figure understates independence rather than overstating it.`,
      );
    }
  }

  return {
    status: 'scored',
    sources,
    profile,
    rawIndependentDomains,
    collapsedIndependentDomains: grouped.size,
    syndicationClusters,
    comparedPages: comparable.length,
    truncatedPages,
    unexaminedPages,
    uncheckedDomains,
    discardedCitations,
    thresholds: {
      resemblance: SYNDICATION_RESEMBLANCE,
      containment: SYNDICATION_CONTAINMENT,
      shingleWords: SHINGLE_WORDS,
      minShingles: MIN_SHINGLES,
      maxPageChars: MAX_PAGE_CHARS,
      maxPages: MAX_PAGES,
    },
    notes,
  };
}
