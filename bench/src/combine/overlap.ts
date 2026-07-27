import { registrableDomain } from '../../../src/research/corroborate.js';
import { memberUrlSet } from './merge.js';
import type { CombinationMember } from './member.js';

/**
 * How much of the ground a combination covered was paid for twice, measured
 * three separate ways and collapsed into none.
 *
 * Union says how much ground a combination covered. It does not say how much of
 * that ground was bought twice, and two combinations with identical union can
 * be very different purchases. Three measures, kept apart because they answer
 * three different questions:
 *
 * - **Pairwise source overlap**, Jaccard over canonical URLs. The money
 *   question: two backends reading the same pages is one perspective bought
 *   twice.
 * - **Domain overlap**, the same over registrable domains. Higher than URL
 *   overlap by construction, and *the gap between them is the finding*: members
 *   reading different pages on the same sites are less independent than a URL
 *   count suggests.
 * - **Robustness**, the share of the union that survives dropping any single
 *   member. A combination whose coverage collapses when one member is dropped
 *   is one backend with expensive company.
 *
 * ## The trap this module is built around
 *
 * **Less overlap is not monotonically better, and nothing here may imply that
 * it is.**
 *
 * Overlap between independent searchers is also a signal that a source is
 * *central* rather than idiosyncratic. Two backends reaching the same primary
 * document without seeing each other's work is evidence that the document is
 * what anyone competent would find. A combination with near-zero overlap may
 * not be broad at all; it may contain a member that is missing what everyone
 * else considers essential, and a metric that rewards that selects for
 * eccentricity.
 *
 * So there is deliberately **no `lowestOverlap`, no `bestOverlap`, no
 * comparator and no ranking** in this file, and `frontier.ts` has no axis that
 * could accept one. Overlap is reported as a curve across combinations with an
 * expected optimum somewhere in the middle, and where that optimum sits is a
 * finding this code refuses to assume.
 *
 * `centrality` is the counterweight that makes the two cases separable.
 * A member that reads nothing anyone else reads **and** misses what everyone
 * else found is eccentric; a member that reads nothing anyone else reads while
 * still finding the central sources is genuinely broad. Only having both
 * numbers can tell them apart, so both are always returned.
 *
 * ## What this is not
 *
 * This measures **sources**. Two backends finding the same *source* is a fact
 * about the web. Two backends stating the same *conclusion* is the
 * corroboration trap, and it lives in `convergence.ts` over different objects
 * through different code. Merging the two would make both meaningless.
 *
 * Pure and synchronous, and it reaches nothing.
 */

/**
 * Rides on every profile. A number that travels without its caveat acquires one
 * by default, and the default is the wrong one.
 */
export const OVERLAP_IS_NOT_AN_OBJECTIVE =
  'Overlap is reported, never optimised. Less overlap is not monotonically better: two members ' +
  'reaching the same document without seeing each other is evidence that document is what anyone ' +
  'competent would find, so a near-zero-overlap combination may simply contain a member missing what ' +
  'everyone else considers essential. Expect an optimum in the middle and read this alongside ' +
  'centrality.missedCentral, which is what separates broad from eccentric. There is deliberately no ' +
  'function here that ranks combinations by overlap.';

/** Two members, and how much of each other's reading they duplicated. */
export interface PairOverlap {
  readonly a: string;
  readonly b: string;
  /** Jaccard over canonical URLs. 0 when both members cited nothing. */
  readonly urlJaccard: number;
  /** Jaccard over registrable domains. Never below `urlJaccard`. */
  readonly domainJaccard: number;
  readonly sharedUrls: number;
  readonly sharedDomains: number;
}

/** What the union loses when one member is dropped. */
export interface MemberRobustness {
  readonly memberId: string;
  /** Share of the union's URLs that survive dropping this member. 0 to 1. */
  readonly survivingShare: number;
  /** URLs only this member found, which is exactly what would be lost. */
  readonly lostUrls: number;
}

export interface RobustnessProfile {
  readonly unionSize: number;
  readonly perMember: readonly MemberRobustness[];
  /**
   * The minimum surviving share across members: a combination is only as robust
   * as its most load-bearing member. This is the third frontier axis, oriented
   * so that higher is better.
   */
  readonly worstCaseSurvivingShare: number;
}

/** Per-member sources most others also found, and the ones it missed. */
export interface MemberCentrality {
  readonly memberId: string;
  /** Central URLs this member did not find. High means eccentric, not broad. */
  readonly missedCentral: number;
  /** URLs no other member found. Breadth, **not** value; see `marginal.ts`. */
  readonly uniqueUrls: number;
}

export interface CentralityProfile {
  /**
   * URLs more than half the members found.
   *
   * "Central" is a claim about the *web*, not about quality: it says several
   * independent searchers converged on this page, which is what makes missing
   * it informative.
   */
  readonly centralUrls: readonly string[];
  /** The threshold used, so a reader who disagrees can recompute. */
  readonly centralThreshold: number;
  readonly perMember: readonly MemberCentrality[];
}

export interface OverlapProfile {
  readonly memberIds: readonly string[];
  readonly pairs: readonly PairOverlap[];
  /** Mean pairwise URL Jaccard. `undefined` with fewer than two members. */
  readonly meanUrlJaccard: number | undefined;
  readonly meanDomainJaccard: number | undefined;
  /**
   * `meanDomainJaccard - meanUrlJaccard`. Never negative, and the size of it is
   * the finding: a large gap means members read different pages on the same
   * sites, which is less independent than the URL count alone suggests.
   */
  readonly urlToDomainGap: number | undefined;
  readonly robustness: RobustnessProfile;
  readonly centrality: CentralityProfile;
  /** Always `OVERLAP_IS_NOT_AN_OBJECTIVE`. */
  readonly caution: string;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): { score: number; shared: number } {
  if (a.size === 0 && b.size === 0) return { score: 0, shared: 0 };
  let shared = 0;
  // Iterate the smaller set, which matters once a member cites hundreds of
  // pages and the lattice asks for this 2^N times.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const v of small) if (large.has(v)) shared += 1;
  const union = a.size + b.size - shared;
  return { score: union === 0 ? 0 : shared / union, shared };
}

const domainsOf = (urls: ReadonlySet<string>): Set<string> => {
  const out = new Set<string>();
  for (const url of urls) {
    const domain = registrableDomain(url);
    if (domain !== '') out.add(domain);
  }
  return out;
};

const mean = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : values.reduce((s, v) => s + v, 0) / values.length;

/**
 * Profile one combination's internal overlap.
 *
 * Takes members rather than URL sets so a caller cannot accidentally hand it a
 * claim set: see the note about `convergence.ts` above, and the test that pins
 * the two apart.
 */
export function sourceOverlapProfile(members: readonly CombinationMember[]): OverlapProfile {
  const ids = members.map((m) => m.id);
  const urlSets = new Map<string, ReadonlySet<string>>();
  const domainSets = new Map<string, ReadonlySet<string>>();
  for (const m of members) {
    const urls = memberUrlSet(m);
    urlSets.set(m.id, urls);
    domainSets.set(m.id, domainsOf(urls));
  }

  const pairs: PairOverlap[] = [];
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const a = ids[i]!;
      const b = ids[j]!;
      const url = jaccard(urlSets.get(a)!, urlSets.get(b)!);
      const domain = jaccard(domainSets.get(a)!, domainSets.get(b)!);
      pairs.push({
        a,
        b,
        urlJaccard: url.score,
        domainJaccard: domain.score,
        sharedUrls: url.shared,
        sharedDomains: domain.shared,
      });
    }
  }

  const union = new Set<string>();
  for (const set of urlSets.values()) for (const url of set) union.add(url);

  // How many members found each URL. One pass, reused by robustness and by
  // centrality, which are two readings of the same count.
  const finders = new Map<string, number>();
  for (const set of urlSets.values()) {
    for (const url of set) finders.set(url, (finders.get(url) ?? 0) + 1);
  }

  const perMemberRobustness: MemberRobustness[] = ids.map((id) => {
    let lost = 0;
    for (const url of urlSets.get(id)!) if (finders.get(url) === 1) lost += 1;
    return {
      memberId: id,
      // A combination of one loses everything when its only member is dropped,
      // which is 0 and is correct rather than a division-by-zero edge case.
      survivingShare: union.size === 0 ? 0 : (union.size - lost) / union.size,
      lostUrls: lost,
    };
  });

  // More than half, strictly. At two members a source both found is central,
  // which is the intended reading: two independent searchers converging is the
  // whole signal.
  const centralThreshold = members.length / 2;
  const centralUrls = [...finders.entries()]
    .filter(([, n]) => n > centralThreshold)
    .map(([url]) => url)
    .sort();
  const centralSet = new Set(centralUrls);

  const perMemberCentrality: MemberCentrality[] = ids.map((id) => {
    const mine = urlSets.get(id)!;
    let missed = 0;
    for (const url of centralSet) if (!mine.has(url)) missed += 1;
    let unique = 0;
    for (const url of mine) if (finders.get(url) === 1) unique += 1;
    return { memberId: id, missedCentral: missed, uniqueUrls: unique };
  });

  const meanUrl = mean(pairs.map((p) => p.urlJaccard));
  const meanDomain = mean(pairs.map((p) => p.domainJaccard));

  return {
    memberIds: ids,
    pairs,
    meanUrlJaccard: meanUrl,
    meanDomainJaccard: meanDomain,
    urlToDomainGap:
      meanUrl === undefined || meanDomain === undefined ? undefined : meanDomain - meanUrl,
    robustness: {
      unionSize: union.size,
      perMember: perMemberRobustness,
      worstCaseSurvivingShare:
        perMemberRobustness.length === 0
          ? 0
          : Math.min(...perMemberRobustness.map((m) => m.survivingShare)),
    },
    centrality: { centralUrls, centralThreshold, perMember: perMemberCentrality },
    caution: OVERLAP_IS_NOT_AN_OBJECTIVE,
  };
}

/** One point on the overlap curve: a combination's overlap beside its score. */
export interface OverlapPoint {
  readonly id: string;
  /** Mean pairwise URL Jaccard. Combinations of one have none and are excluded. */
  readonly meanUrlJaccard: number | undefined;
  readonly score: number;
}

export interface OverlapBin {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  readonly meanScore: number;
  readonly minScore: number;
  readonly maxScore: number;
  readonly ids: readonly string[];
}

export const DEFAULT_OVERLAP_BINS = 10;

/**
 * The overlap curve: score distribution per overlap band.
 *
 * Returned in ascending overlap order **because that is how a curve is read**,
 * not because low is good. There is no "best bin" and no argmax here on
 * purpose; whoever reads it decides what the shape means, and the brief's
 * expectation of an optimum in the middle is a hypothesis this refuses to
 * encode.
 *
 * Combinations of one carry no pairwise overlap and are excluded rather than
 * assigned zero, which would pile every singleton into the leftmost bin and
 * invent a trend that is an artefact of the binning.
 */
export function overlapCurve(
  points: readonly OverlapPoint[],
  bins: number = DEFAULT_OVERLAP_BINS,
): readonly OverlapBin[] {
  if (!Number.isInteger(bins) || bins < 1) {
    throw new TypeError(`overlapCurve needs a positive integer bin count; received ${String(bins)}`);
  }
  const usable = points.filter(
    (p): p is OverlapPoint & { meanUrlJaccard: number } => p.meanUrlJaccard !== undefined,
  );
  const out: OverlapBin[] = [];
  for (let i = 0; i < bins; i += 1) {
    const lower = i / bins;
    const upper = (i + 1) / bins;
    // Half-open bands, with the top band closed so a Jaccard of exactly 1 lands
    // somewhere rather than being dropped.
    const mine = usable.filter((p) =>
      i === bins - 1
        ? p.meanUrlJaccard >= lower && p.meanUrlJaccard <= upper
        : p.meanUrlJaccard >= lower && p.meanUrlJaccard < upper,
    );
    const scores = mine.map((p) => p.score);
    out.push({
      lower,
      upper,
      count: mine.length,
      meanScore: scores.length === 0 ? 0 : scores.reduce((s, v) => s + v, 0) / scores.length,
      minScore: scores.length === 0 ? 0 : Math.min(...scores),
      maxScore: scores.length === 0 ? 0 : Math.max(...scores),
      ids: mine.map((p) => p.id),
    });
  }
  return out;
}
