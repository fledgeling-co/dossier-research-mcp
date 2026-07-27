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

async function verifyOne(url: string, timeoutMs: number): Promise<CitationVerdict> {
  const checkedAt = new Date().toISOString();
  try {
    // HEAD first: cheap, and most publishers answer it. Fall through to GET
    // when a server rejects HEAD outright (many CDNs return 405).
    let result = await safeFetch(url, { method: 'HEAD', timeoutMs });
    if (result.status === 405 || result.status === 501) {
      result = await safeFetch(url, { method: 'GET', timeoutMs, maxBytes: 32 * 1024 });
    }

    if (result.ok) return { url, verdict: 'live', httpStatus: result.status, checkedAt };
    if (result.status === 404 || result.status === 410) {
      return { url, verdict: 'not_found', httpStatus: result.status, checkedAt };
    }
    if (result.status === 401 || result.status === 402 || result.status === 403) {
      return {
        url,
        verdict: 'blocked',
        httpStatus: result.status,
        checkedAt,
        note: 'Paywalled, login-gated, or bot-blocked, existence is plausible but unconfirmed.',
      };
    }
    return {
      url,
      verdict: 'unverified',
      httpStatus: result.status,
      checkedAt,
      note: `Unexpected status ${result.status}`,
    };
  } catch (e: unknown) {
    if (e instanceof BlockedUrlError) {
      // A redirect loop says something about the SERVER, not the citation —
      // sites commonly 302 an unrecognised User-Agent back to itself as a bot
      // deterrent (milvus.io does exactly this). Reporting that as
      // `invalid_url` alongside malformed and SSRF URLs drags real sources
      // into the "suspect" badge and implies fabrication that isn't there.
      if (e.reason === 'redirect_loop') {
        return {
          url,
          verdict: 'blocked',
          checkedAt,
          note: `${e.message}, the source is probably fine; open it in a browser to confirm.`,
        };
      }
      return { url, verdict: 'invalid_url', checkedAt, note: e.message.slice(0, 300) };
    }
    const message = e instanceof Error ? e.message : String(e);
    return { url, verdict: 'unreachable', checkedAt, note: message.slice(0, 300) };
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
  /** Overall badge, for a UI or a downstream gate. */
  readonly badge: 'verified' | 'partial' | 'suspect' | 'none';
}

export function scoreCitations(verdicts: readonly CitationVerdict[]): CitationScorecard {
  const count = (v: CitationVerdict['verdict']): number =>
    verdicts.filter((x) => x.verdict === v).length;
  const total = verdicts.length;
  const live = count('live');
  const notFound = count('not_found');
  const invalid = count('invalid_url');
  const liveRate = total === 0 ? 0 : live / total;

  const badge: CitationScorecard['badge'] =
    total === 0
      ? 'none'
      : notFound + invalid > total * 0.15
        ? 'suspect'
        : liveRate >= 0.9
          ? 'verified'
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
    badge,
  };
}

export function renderScorecard(card: CitationScorecard): string {
  if (card.total === 0) return 'No citations found in this report.';
  const pct = (n: number): string => `${Math.round((n / card.total) * 100)}%`;
  return [
    `Citation scorecard: ${card.badge.toUpperCase()}, ${card.live}/${card.total} resolved (${pct(card.live)}).`,
    `  live ${card.live} · not_found ${card.notFound} · blocked ${card.blocked} · unreachable ${card.unreachable} · invalid ${card.invalid} · unverified ${card.unverified}`,
    card.badge === 'suspect'
      ? '  ⚠ A high share of citations do not resolve. Treat quantitative claims in this report as unconfirmed until checked by hand.'
      : '  Note: "live" means the URL resolves, it does not mean the source supports the claim it is attached to.',
  ].join('\n');
}
