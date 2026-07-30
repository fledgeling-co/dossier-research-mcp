/**
 * Which claims in a report are load-bearing and unsupported, and what to check.
 *
 * The gap this closes, from a real session. A five-member panel produced a
 * disputed figure (a 400 W power floor). `research_verify_citations` correctly
 * reported zero fabricated citations and correctly listed the URLs that did not
 * resolve. The caller then had to notice, by hand, that one of those
 * non-resolving URLs was the *only* support for the disputed figure, work out
 * which claim it belonged to, and go and verify it with a separate search.
 *
 * Every input to that deduction was already on this machine. The verdicts name
 * the failed URLs, the report names which claim cites which URL, and the merge
 * knows which claims only one backend made. Dossier had all three and handed
 * back three separate lists, leaving the join, which is the actual analysis, to
 * whoever was reading.
 *
 * **What this deliberately does not do.** It does not verify anything. Dossier
 * has no web search and cannot borrow one, so it cannot go and check the 400 W
 * figure; that is the host's job and the rule is older than this file. What it
 * can do is stop making the host work out WHAT to check. A worklist is the
 * server's half; the searching is the client's.
 */

import type { CitationVerdict } from '../store/types.js';

/** Why a claim wants an independent check. Ordered worst first. */
export type RiskReason =
  /** Its only cited source did not resolve, so nothing supports it right now. */
  | 'sole-source-unresolved'
  /** Members disagreed, so at most one of them is right. */
  | 'contested'
  /** One backend said it and nothing else did. */
  | 'single-sourced'
  /** Some of its sources did not resolve, but not all. */
  | 'partly-unresolved';

export interface ClaimRisk {
  readonly claim: string;
  readonly reasons: readonly RiskReason[];
  /** The cited URLs that did not resolve, if any. */
  readonly unresolved: readonly string[];
  /** What to actually do about it, in one sentence. */
  readonly check: string;
}

/**
 * A verdict that leaves a citation unable to support anything.
 *
 * `blocked` with a registered identifier is deliberately NOT here: the source
 * was shown to exist, we simply could not read it, and treating that as
 * unsupported would flood the worklist with paywalled journal articles that are
 * the best evidence in the report.
 */
function isUnsupporting(v: CitationVerdict): boolean {
  if (v.registered === true) return false;
  return v.verdict === 'not_found' || v.verdict === 'invalid_url' || v.verdict === 'unreachable';
}

/**
 * Split a report into sentences, keeping the URLs each one cites.
 *
 * Crude on purpose. The alternative is a model call per report, which costs
 * money on something this file can do with a regex, and a sentence that is
 * occasionally split at "Fig. 3" is a cosmetic problem in a worklist rather
 * than a wrong answer.
 */
export function sentencesWithUrls(markdown: string): { text: string; urls: string[] }[] {
  // Reference-style link definitions are not prose and would otherwise each
  // become a "sentence" consisting of one URL.
  const prose = markdown.replace(/^\s*\[[^\]]+\]:\s*\S+\s*$/gm, '');
  const out: { text: string; urls: string[] }[] = [];
  for (const raw of prose.split(/(?<=[.!?])\s+(?=[A-Z(])|\n{2,}/)) {
    const text = raw.trim();
    if (text.length < 20) continue;
    const urls = new Set<string>();
    for (const m of text.matchAll(/\((https?:\/\/[^\s)]+)\)/gi)) if (m[1]) urls.add(m[1]);
    for (const m of text.matchAll(/<(https?:\/\/[^\s<>]+)>/gi)) if (m[1]) urls.add(m[1]);
    for (const m of text.matchAll(/(?<![("<])\bhttps?:\/\/[^\s<>"'|)\]]+/gi)) urls.add(m[0]);
    out.push({ text, urls: [...urls] });
  }
  return out;
}

/**
 * The claims that rest on a citation which did not resolve.
 *
 * This is the join the caller was doing by hand: not "these four URLs failed"
 * but "this sentence is the disputed figure, and the only source it cites is one
 * of the four".
 */
export function claimsRestingOnFailedCitations(
  markdown: string,
  verdicts: readonly CitationVerdict[],
  limit = 25,
): ClaimRisk[] {
  const bad = new Set(verdicts.filter(isUnsupporting).map((v) => v.url));
  if (bad.size === 0) return [];

  const risks: ClaimRisk[] = [];
  for (const s of sentencesWithUrls(markdown)) {
    if (s.urls.length === 0) continue;
    const failed = s.urls.filter((u) => bad.has(u));
    if (failed.length === 0) continue;

    // Every source gone versus some gone. The first means the claim currently
    // has no support at all, which is a different instruction to the reader.
    const sole = failed.length === s.urls.length;
    risks.push({
      claim: s.text.slice(0, 400),
      reasons: [sole ? 'sole-source-unresolved' : 'partly-unresolved'],
      unresolved: failed,
      check: sole
        ? 'Nothing in this report currently supports this. Search for the figure independently before relying on it, or drop it.'
        : `Confirm the claim against the sources that DID resolve; ${String(failed.length)} of ${String(s.urls.length)} did not.`,
    });
    if (risks.length >= limit) break;
  }
  // Worst first: a claim with no surviving source outranks one with a gap.
  return risks.sort((a, b) => Number(b.reasons[0] === 'sole-source-unresolved') - Number(a.reasons[0] === 'sole-source-unresolved'));
}

/** The worklist as text, or nothing when there is nothing to check. */
export function renderClaimRisks(risks: readonly ClaimRisk[]): string[] {
  if (risks.length === 0) return [];
  const sole = risks.filter((r) => r.reasons[0] === 'sole-source-unresolved');
  return [
    '',
    `### ${String(risks.length)} claim(s) cite a source that did not resolve`,
    '',
    sole.length > 0
      ? `**${String(sole.length)} of them cite NOTHING ELSE**, so at this moment the report does not support them. That is the list to work through, in this order.`
      : 'Each of these has at least one source that did resolve, so the claim is not unsupported, only thinner than it looks.',
    '',
    ...risks.map(
      (r, i) =>
        `${String(i + 1)}. ${r.reasons[0] === 'sole-source-unresolved' ? '🔴' : '🟡'} "${r.claim}"\n` +
        `   - Did not resolve: ${r.unresolved.map((u) => `\`${u}\``).join(', ')}\n` +
        `   - ${r.check}`,
    ),
    '',
    '> [!NOTE]',
    '> Dossier has no web search and cannot check these itself; that is what your own search tool is for. What it can do is tell you WHICH claims need it, rather than handing you a list of broken URLs and a list of claims and leaving you to join them.',
  ];
}
