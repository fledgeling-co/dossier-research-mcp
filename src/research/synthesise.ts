import { canonicaliseUrl, registrableDomain } from './corroborate.js';
import { classifySource, countsAsCorroboration, profileEvidence, type EvidenceProfile } from './evidence.js';
import { extractCitedUrls } from './report.js';

/**
 * Merging several backends' reports into one evidence base.
 *
 * The reason this is a module rather than a prompt: the interesting number is
 * not how many backends agreed, it is how many **independent domains** the
 * agreement rests on. Three research agents all citing the same vendor press
 * release is one source wearing three hats, and a "3 of 3 backends agree"
 * confidence score built on it is actively misleading rather than merely weak.
 *
 * So the overlap is computed here, deterministically, and reported as a finding
 * in its own right. A fan-out where every backend read the same ten pages cost
 * three times as much as one run and learned nearly nothing extra; the operator
 * should be told that plainly rather than shown a confident merged report.
 */

/** One completed run, ready to fold into the merged evidence base. */
export interface RunEvidence {
  readonly runId: string;
  readonly provider: string;
  readonly model?: string | undefined;
  readonly markdown: string;
}

/** A source in the merged registry, with every backend that cited it. */
export interface MergedSource {
  readonly n: number;
  readonly url: string;
  readonly domain: string;
  /** Backends that cited this exact page, deduplicated. */
  readonly citedBy: readonly string[];
  /** Whether this source can count toward independent corroboration at all. */
  readonly countsAsCorroboration: boolean;
}

export interface MergedEvidence {
  readonly sources: readonly MergedSource[];
  /** Distinct registrable domains across every backend. The real breadth number. */
  readonly independentDomains: number;
  /** Sources exactly one backend found. Usually coverage, occasionally the whole point. */
  readonly uniqueByProvider: readonly { provider: string; count: number; sources: readonly number[] }[];
  /** Sources every participating backend cited. High overlap means a costly fan-out taught you little. */
  readonly citedByAll: readonly number[];
  /** 0 to 1. The share of sources that more than one backend found. */
  readonly overlapRatio: number;
  readonly profile: EvidenceProfile;
  readonly runs: readonly { runId: string; provider: string; model?: string | undefined; sourceCount: number }[];
}

/**
 * Fold N reports into one deduplicated, provenance-carrying evidence base.
 *
 * Deduplication is by canonical URL, so the same page reached through three
 * different tracking parameters is one source rather than three. Domain counting
 * happens after that, because it is the number every confidence judgement
 * downstream actually rests on.
 */
export function mergeEvidence(runs: readonly RunEvidence[]): MergedEvidence {
  // Provenance is per RUN, not per backend. Merging four Gemini runs is a
  // perfectly ordinary thing to do, and keying on the provider name collapses
  // them into one label: every source then looks unique to "gemini" and the
  // overlap reads 0% however much the runs actually shared.
  const counts = new Map<string, number>();
  for (const r of runs) counts.set(r.provider, (counts.get(r.provider) ?? 0) + 1);
  const labelOf = (r: RunEvidence): string =>
    (counts.get(r.provider) ?? 0) > 1 ? `${r.provider}/${r.runId.replace(/^dr_/, '').slice(0, 6)}` : r.provider;

  const byUrl = new Map<string, { url: string; domain: string; citedBy: Set<string> }>();
  const perRun: { runId: string; provider: string; model?: string | undefined; sourceCount: number }[] = [];

  for (const run of runs) {
    const label = labelOf(run);
    const urls = new Set(extractCitedUrls(run.markdown).map((u) => canonicaliseUrl(u)));
    perRun.push({
      runId: run.runId,
      provider: run.provider,
      ...(run.model ? { model: run.model } : {}),
      sourceCount: urls.size,
    });
    for (const url of urls) {
      const existing = byUrl.get(url);
      if (existing) existing.citedBy.add(label);
      else byUrl.set(url, { url, domain: registrableDomain(url), citedBy: new Set([label]) });
    }
  }
  const labels = runs.map(labelOf);

  const sources: MergedSource[] = [...byUrl.values()].map((s, i) => ({
    n: i + 1,
    url: s.url,
    domain: s.domain,
    citedBy: [...s.citedBy].sort(),
    countsAsCorroboration: countsAsCorroboration(classifySource(s.url)),
  }));

  const uniqueByProvider = [...new Set(labels)].map((p) => {
    const mine = sources.filter((s) => s.citedBy.length === 1 && s.citedBy[0] === p);
    return { provider: p, count: mine.length, sources: mine.map((s) => s.n) };
  });

  const citedByAll =
    labels.length > 1 ? sources.filter((s) => labels.every((p) => s.citedBy.includes(p))).map((s) => s.n) : [];
  const shared = sources.filter((s) => s.citedBy.length > 1).length;

  return {
    sources,
    independentDomains: new Set(sources.map((s) => s.domain)).size,
    uniqueByProvider,
    citedByAll,
    overlapRatio: sources.length === 0 ? 0 : shared / sources.length,
    profile: profileEvidence(sources.map((s) => classifySource(s.url))),
    runs: perRun,
  };
}

/**
 * Say what the fan-out actually bought.
 *
 * Deliberately blunt about the bad case. Someone who has just paid for four
 * backends wants to hear that it was worth it, and the honest answer is
 * sometimes that they bought the same ten pages four times. Saying so is the
 * only way the next decision is better informed than this one was.
 */
export function describeOverlap(merged: MergedEvidence): string {
  const participants = merged.runs.length;
  if (participants < 2) return '_One run, so there is nothing to cross-check._';
  const sameBackend = new Set(merged.runs.map((r) => r.provider)).size === 1;

  const pct = Math.round(merged.overlapRatio * 100);
  const lines: string[] = [
    `**${String(merged.sources.length)} distinct source(s)** across ${String(participants)} run(s), ` +
      `on **${String(merged.independentDomains)} independent domain(s)**.`,
    '',
  ];

  for (const u of merged.uniqueByProvider) {
    lines.push(`- **${u.provider}** found ${String(u.count)} source(s) no other run did.`);
  }
  lines.push('');
  if (sameBackend) {
    lines.push(
      `_Every run here used the same backend, so overlap measures how much the questions differed, not how much two research systems independently agreed._`,
      '',
    );
  }

  if (merged.citedByAll.length > 0) {
    lines.push(
      `${String(merged.citedByAll.length)} source(s) were cited by every run. Those are the pages the question unavoidably rests on.`,
    );
  }

  if (pct >= 60) {
    lines.push(
      '',
      '> [!WARNING]',
      `> **${String(pct)}% of sources were found by more than one run.** This fan-out mostly re-read the same pages, so it cost several times a single run and added little breadth. Treat the agreement between these reports as one source of evidence wearing several hats, not as independent confirmation, and consider a single run plus \`research_verify_claims\` next time.`,
    );
  } else if (pct <= 15) {
    lines.push(
      '',
      `Only ${String(pct)}% of sources overlapped, so the runs read largely different material. That is the case where merging genuinely earns its cost, and it also means any claim only one backend made is **uncorroborated rather than agreed**.`,
    );
  } else {
    lines.push('', `${String(pct)}% of sources were found by more than one run.`);
  }

  const useless = merged.sources.filter((s) => !s.countsAsCorroboration).length;
  if (useless > 0) {
    lines.push(
      '',
      `_${String(useless)} source(s) cannot count toward corroboration at all (aggregators, content farms, or the user's own documents). They may still be worth reading; they are not evidence that something is true._`,
    );
  }

  return lines.join('\n');
}

/** The merged registry, as the only list a synthesis may cite from. */
export function renderMergedRegistry(merged: MergedEvidence): string {
  if (merged.sources.length === 0) return '_No cited sources in any of these reports._';
  return merged.sources
    .map((s) => `${String(s.n)}. ${s.url}\n   _${s.domain} · found by: ${s.citedBy.join(', ')}_`)
    .join('\n');
}
