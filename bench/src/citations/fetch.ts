import { safeFetch } from '../../../src/net/safe-fetch.js';
import type { FetchedSource } from '../verify/verify.js';

/**
 * The two live adapters, and the only things in this slice that reach a network.
 *
 * Both go through `safeFetch` rather than `fetch`, because a URL that came out
 * of a model that was itself reading the open web is untrusted input by any
 * reading and gets per-hop SSRF validation, redirect re-checking, a timeout and
 * a byte cap (CP §4 A10, §6.12). The brief's instruction to reuse the existing
 * fetcher rather than write a second one is honoured literally: there is no
 * second fetcher here, only two thin shapes over the one there already is.
 *
 * `FetchedSource` is BENCH-09's type, imported rather than redeclared. Its
 * `truncated` field is the reason: that slice reached the same conclusion first,
 * that `safeFetch` truncates silently and a fact sitting past the cap reads
 * exactly like a fact that was never there. One definition of a fetched page in
 * `bench/`, so the two slices cannot come to disagree about what truncated
 * means.
 */

/**
 * The page cap, and why it is not BENCH-09's.
 *
 * Gold verification fetches a handful of sources and can afford 32 MB for an
 * npm registry document. This fetches every cited page of every report in a
 * matrix, so the same cap would be gigabytes per batch. Two megabytes covers an
 * ordinary article several times over, and where it does bite the page is
 * marked truncated and containment answers `unchecked` rather than
 * `unsupported`, so the cap costs a measurement and never a false accusation.
 */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;

/** Registry answers are small JSON or Atom documents; this is generous for one. */
export const MAX_REGISTRY_BYTES = 512 * 1024;

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Whether the read stopped at the cap.
 *
 * The same inference `bench/src/verify/cli.ts` makes, deliberately identical
 * rather than improved: `safeFetch` breaks its read once the byte total reaches
 * the cap, so a body at or over it was cut short. The decoder can hold back up
 * to three bytes of an incomplete character, which makes this a false negative
 * in a three-byte window at the very end of a two-megabyte read. Writing it
 * down rather than tuning it, because a divergence between the two slices about
 * what truncated means would be worth far more than three bytes.
 */
function looksTruncated(body: string, cap: number): boolean {
  return Buffer.byteLength(body, 'utf8') >= cap;
}

/** Fetch one cited page for the containment and anchor checks. */
export async function fetchPage(
  url: string,
  options: { readonly timeoutMs?: number; readonly maxBytes?: number } = {},
): Promise<FetchedSource> {
  const maxBytes = options.maxBytes ?? MAX_PAGE_BYTES;
  try {
    const result = await safeFetch(url, {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes,
    });
    return {
      url: result.url,
      status: result.status,
      ok: result.ok,
      body: result.body,
      truncated: looksTruncated(result.body, maxBytes),
      // `safeFetch` surfaces no headers, and `extractText` sniffs a JSON body
      // from its first characters anyway. Left blank rather than guessed from
      // the URL, which would be wrong for every API that omits `.json`.
      contentType: '',
    };
  } catch (e: unknown) {
    return {
      url,
      status: 0,
      ok: false,
      body: '',
      contentType: '',
      truncated: false,
      error: e instanceof Error ? e.message : 'fetch failed',
    };
  }
}

/** Ask one registry one question. The transport `collect.ts` injects in production. */
export async function fetchRegistry(
  url: string,
): Promise<{ status: number; body: string; error?: string }> {
  try {
    const result = await safeFetch(url, {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxBytes: MAX_REGISTRY_BYTES,
    });
    return { status: result.status, body: result.body };
  } catch (e: unknown) {
    // A refusal to fetch is never evidence about the identifier. It reaches
    // `interpret` as an error and comes back `unchecked`, never `absent`.
    return { status: 0, body: '', error: e instanceof Error ? e.message : 'fetch failed' };
  }
}
