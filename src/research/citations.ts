import { BlockedUrlError, safeFetch } from '../net/safe-fetch.js';
import type { CitationVerdict } from '../store/types.js';
import { extractCitedUrls } from './report.js';

/**
 * Citation verification.
 *
 * A confidently fabricated URL is the failure that survives into the product,
 * because nobody clicks. This pass dereferences every cited URL and records a
 * verdict, so "unverified" becomes a visible, propagating state rather than a
 * discovery someone makes in a meeting.
 *
 * What this does NOT claim: that a `live` verdict means the source supports the
 * claim. It means the URL resolves. Semantic claim-matching would need a model
 * call per citation and would still be a judgement, not a fact — so the tool
 * reports reachability and leaves the reading to the human or the red-team pass.
 */

export interface VerifyOptions {
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly maxUrls?: number;
}

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_MAX_URLS = 150;

/** A verdict without the url and timestamp, which the caller already holds. */
export type CitationJudgement = Pick<CitationVerdict, 'verdict'> & { readonly note?: string };

/**
 * What an HTTP status says about a citation.
 *
 * Exported because the benchmark's citation scorer needs the same reading over
 * a body it fetched for its own purposes, and two implementations of one rule
 * eventually disagree about what the rule is. The rule lives here once; the
 * benchmark imports it rather than restating it.
 */
export function judgeCitationStatus(status: number, ok: boolean): CitationJudgement {
  if (ok) return { verdict: 'live' };
  if (status === 404 || status === 410) return { verdict: 'not_found' };
  if (status === 401 || status === 402 || status === 403) {
    return {
      verdict: 'blocked',
      note: 'Paywalled, login-gated, or bot-blocked, existence is plausible but unconfirmed.',
    };
  }
  return { verdict: 'unverified', note: `Unexpected status ${String(status)}` };
}

/** What a thrown fetch error says about a citation. Exported for the same reason. */
export function judgeCitationError(e: unknown): CitationJudgement {
  if (e instanceof BlockedUrlError) {
    // A redirect loop says something about the SERVER, not the citation —
    // sites commonly 302 an unrecognised User-Agent back to itself as a bot
    // deterrent (milvus.io does exactly this). Reporting that as
    // `invalid_url` alongside malformed and SSRF URLs drags real sources
    // into the "suspect" badge and implies fabrication that isn't there.
    if (e.reason === 'redirect_loop') {
      return {
        verdict: 'blocked',
        note: `${e.message}, the source is probably fine; open it in a browser to confirm.`,
      };
    }
    return { verdict: 'invalid_url', note: e.message.slice(0, 300) };
  }
  const message = e instanceof Error ? e.message : String(e);
  return { verdict: 'unreachable', note: message.slice(0, 300) };
}

/**
 * The DOI in a URL, if it carries one.
 *
 * Publishers embed the DOI in the path in a handful of shapes, and every one of
 * them starts `10.<registrant>/`. Deliberately conservative: a false positive
 * here would query the registry for nonsense and report `not_found`, which is
 * the one direction this must never invent.
 */
export function extractDoi(url: string): string | undefined {
  const m = /\b(10\.\d{4,9}\/[^\s"'<>&?#]+)/.exec(url);
  if (!m?.[1]) return undefined;
  // Trailing punctuation is markdown's, not the DOI's.
  return m[1].replace(/[.,;:)\]]+$/, '');
}

/**
 * Ask the DOI registry whether an identifier exists.
 *
 * This is the fix for the number that mattered to a real reader: a run scored
 * 77% with ZERO not-found and ZERO invalid citations, because Wiley answers
 * scrapers with 403/412. Every one of those sources was real, and the headline
 * implied otherwise.
 *
 * Resolving Cochrane DOIs to PubMed was the suggestion; the registry is the
 * better version of it, because PubMed only covers biomedical literature and
 * `doi.org` answers for every discipline with a DOI, publisher-independently
 * and without a key. It proves REGISTRATION, not reachability and not that the
 * source supports the claim.
 */
async function doiIsRegistered(doi: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await safeFetch(`https://doi.org/api/handles/${encodeURIComponent(doi)}`, {
      method: 'GET',
      timeoutMs: Math.min(timeoutMs, 8_000),
      maxBytes: 16 * 1024,
    });
    // Verified against the live registry on 29 July 2026: a registered handle
    // answers 200 with `responseCode: 1`, an unknown one 404 with
    // `responseCode: 100`.
    //
    // BOTH are required, and the redundancy is deliberate. The failure this
    // guards is asymmetric: certifying a fabricated citation as real is the one
    // outcome that would make this feature worse than not having it, so a
    // future change to the API's status codes must not be able to flip the
    // answer on its own.
    if (!res.ok) return false;
    try {
      const parsed: unknown = JSON.parse(res.body);
      return (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { responseCode?: unknown }).responseCode === 1
      );
    } catch {
      return false;
    }
  } catch {
    // The registry being unreachable is not evidence about the citation.
    return false;
  }
}

async function verifyOne(url: string, timeoutMs: number): Promise<CitationVerdict> {
  const checkedAt = new Date().toISOString();
  try {
    // HEAD first: cheap, and most publishers answer it. Fall through to GET
    // when a server rejects HEAD outright (many CDNs return 405).
    let result = await safeFetch(url, { method: 'HEAD', timeoutMs });
    if (result.status === 405 || result.status === 501) {
      result = await safeFetch(url, { method: 'GET', timeoutMs, maxBytes: 32 * 1024 });
    }
    const judged = judgeCitationStatus(result.status, result.ok);
    // Only for `blocked`. A publisher's 404 is a real not-found and the registry
    // must not be allowed to talk us out of it; a 403 is the publisher
    // declining to talk to a robot, which is the case worth appealing.
    if (judged.verdict === 'blocked') {
      const doi = extractDoi(url);
      if (doi !== undefined && (await doiIsRegistered(doi, timeoutMs))) {
        return {
          url,
          httpStatus: result.status,
          checkedAt,
          verdict: 'blocked',
          registered: true,
          note: `Publisher returned ${String(result.status)} to an automated request, but DOI ${doi} is registered, so the source exists.`,
        };
      }
    }
    return { url, httpStatus: result.status, checkedAt, ...judged };
  } catch (e: unknown) {
    return { url, checkedAt, ...judgeCitationError(e) };
  }
}

/** Bounded-concurrency verification of every URL a report cites. */
export async function verifyCitations(
  markdown: string,
  opts: VerifyOptions = {},
): Promise<{ verdicts: CitationVerdict[]; totalFound: number; checked: number }> {
  const all = extractCitedUrls(markdown);
  const maxUrls = Math.min(opts.maxUrls ?? DEFAULT_MAX_URLS, 500);
  const urls = all.slice(0, maxUrls);
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, 16));
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const verdicts: CitationVerdict[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const url = urls[index];
      if (url === undefined) return;
      verdicts[index] = await verifyOne(url, timeoutMs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));

  return { verdicts: verdicts.filter(Boolean), totalFound: all.length, checked: urls.length };
}

export interface CitationScorecard {
  readonly total: number;
  readonly live: number;
  readonly notFound: number;
  readonly blocked: number;
  readonly unreachable: number;
  readonly invalid: number;
  readonly unverified: number;
  /** Share of citations that resolved, 0-1. */
  readonly liveRate: number;
  /**
   * Citations that do not exist: 404/410 plus malformed URLs.
   *
   * THIS is the fabrication number, and it is the one that matters. It is
   * reported apart from reachability because they answer different questions
   * and were previously collapsed into one percentage that a reader reasonably
   * took as an accuracy score.
   */
  readonly fabricated: number;
  /** Blocked citations whose identifier is nevertheless registered, so the source exists. */
  readonly existenceConfirmed: number;
  /** `live` plus `existenceConfirmed`: everything shown to exist, however it was shown. */
  readonly confirmedRate: number;
  /**
   * Overall badge, for a UI or a downstream gate.
   *
   * `blocked` is its own outcome, and adding it is the point: a report whose
   * citations are all real but sit behind Wiley's bot wall used to land on
   * `partial`, which reads as doubt about the citations rather than about our
   * access to them.
   */
  readonly badge: 'verified' | 'partial' | 'blocked' | 'suspect' | 'none';
}

export function scoreCitations(verdicts: readonly CitationVerdict[]): CitationScorecard {
  const count = (v: CitationVerdict['verdict']): number =>
    verdicts.filter((x) => x.verdict === v).length;
  const total = verdicts.length;
  const live = count('live');
  const notFound = count('not_found');
  const invalid = count('invalid_url');
  const liveRate = total === 0 ? 0 : live / total;
  const fabricated = notFound + invalid;
  const existenceConfirmed = verdicts.filter((v) => v.verdict !== 'live' && v.registered === true).length;
  const confirmed = live + existenceConfirmed;
  const confirmedRate = total === 0 ? 0 : confirmed / total;

  // Fabrication is asked FIRST, and nothing below can override it. The ordering
  // is the fix: reachability used to be able to pull a report with zero
  // fabricated citations down to `partial`.
  const badge: CitationScorecard['badge'] =
    total === 0
      ? 'none'
      : fabricated > total * 0.15
        ? 'suspect'
        : confirmedRate >= 0.9
          ? 'verified'
          : fabricated === 0
            ? // Nothing was shown to be fake; we just could not read some of it.
              // A distinct badge, because `partial` was being read as doubt
              // about the citations rather than about our access to them.
              'blocked'
            : 'partial';

  return {
    total,
    live,
    notFound,
    blocked: count('blocked'),
    unreachable: count('unreachable'),
    invalid,
    unverified: count('unverified'),
    liveRate,
    fabricated,
    existenceConfirmed,
    confirmedRate,
    badge,
  };
}

export function renderScorecard(card: CitationScorecard): string {
  if (card.total === 0) return 'No citations found in this report.';
  const pct = (n: number): string => `${Math.round((n / card.total) * 100)}%`;

  // Two questions, answered in the order they matter, because collapsing them
  // into one percentage cost a reader real trust: a run with zero fabricated
  // citations read as 77% and looked like an accuracy score. It was a measure of
  // how many publishers would talk to a robot.
  const fabrication =
    card.fabricated === 0
      ? `Fabrication check: PASS. No citation was fabricated, ${String(card.total)} checked, 0 dead links, 0 malformed URLs.`
      : `Fabrication check: ${card.badge === 'suspect' ? 'FAIL' : 'ATTENTION'}. ${String(card.fabricated)} of ${String(card.total)} citations do not exist (${String(card.notFound)} dead, ${String(card.invalid)} malformed).`;

  const reach = [
    `Reachability: ${pct(card.live)} opened directly (${String(card.live)}/${String(card.total)}).`,
    card.existenceConfirmed > 0
      ? ` A further ${String(card.existenceConfirmed)} were blocked to us but confirmed registered, so ${pct(card.live + card.existenceConfirmed)} are shown to exist.`
      : '',
  ].join('');

  return [
    fabrication,
    reach,
    `  live ${card.live} · not_found ${card.notFound} · blocked ${card.blocked} · unreachable ${card.unreachable} · invalid ${card.invalid} · unverified ${card.unverified}`,
    card.fabricated > 0
      ? '  ⚠ Citations that do not resolve at all. Treat the claims attached to them as unconfirmed until checked by hand.'
      : card.live < card.total
        ? '  A blocked or unreachable citation is usually a paywall or a bot wall, and says nothing about whether the source is real. The fabrication check above is the number to judge this report by.'
        : '',
    '  Note: neither number means the source SUPPORTS the claim it is attached to. That still needs a reader.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
