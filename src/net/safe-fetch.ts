import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF-safe outbound fetch (CP §4 A10, §6.12).
 *
 * Citation verification dereferences URLs that came out of a model that was
 * itself reading the open web. That is untrusted input by any reading, so
 * every hop is validated: scheme allowlist, DNS resolution checked against
 * private/loopback/link-local ranges, redirects followed manually and
 * re-validated, an explicit timeout, and a response-size cap.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_REDIRECTS = 5;
const MAX_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Why a URL was refused. The distinction is load-bearing downstream: a
 * malformed URL or a private address is a red flag about the *citation*, while
 * a redirect loop is a fact about the *server* — many sites bot-deter by
 * 302-ing an unrecognised User-Agent back to the same URL forever. Collapsing
 * the two makes real sources look fabricated.
 */
export type BlockReason = 'scheme' | 'malformed' | 'private' | 'dns' | 'redirect_loop';

export class BlockedUrlError extends Error {
  readonly code = 'blocked_url' as const;
  readonly reason: BlockReason;
  constructor(reason: BlockReason, message: string) {
    super(message);
    this.name = 'BlockedUrlError';
    this.reason = reason;
  }
}

/** IPv4/IPv6 ranges that must never be reachable from a user-supplied URL. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const parts = address.split('.').map(Number);
    const [a, b] = parts;
    if (a === undefined || b === undefined) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local
    // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4 address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // not an IP literal we recognise: fail closed
}

/** Validate scheme + resolve DNS, rejecting anything that lands on a private IP. */
async function assertPublicUrl(url: URL): Promise<void> {
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new BlockedUrlError('scheme', `Scheme not allowed: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new BlockedUrlError('private', `Private address blocked: ${host}`);
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new BlockedUrlError('dns', `DNS resolution failed for ${host}`);
  }
  if (addresses.length === 0) throw new BlockedUrlError('dns', `No addresses for ${host}`);
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new BlockedUrlError('private', `Host ${host} resolves to a private address`);
    }
  }
}

export interface SafeFetchResult {
  readonly url: string;
  readonly status: number;
  readonly ok: boolean;
  readonly body: string;
  readonly redirects: number;
}

/**
 * Fetch with per-hop SSRF validation. Redirects are followed manually
 * (`redirect: 'manual'`) because a permitted first hop can 302 straight to
 * `169.254.169.254` — validating only the URL the caller passed is no
 * protection at all.
 */
export async function safeFetch(
  rawUrl: string,
  opts: { readonly timeoutMs?: number; readonly method?: 'GET' | 'HEAD'; readonly maxBytes?: number } = {},
): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError('malformed', 'Malformed URL');
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicUrl(current);

    const response = await fetch(current, {
      method: opts.method ?? 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        // Identify honestly; some publishers block unlabelled clients and a
        // 403 would otherwise read as a dead citation.
        'user-agent': 'deep-research-mcp/0.1 (+https://github.com/fledgeling-co/deep-research-mcp)',
        accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
      },
    });

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new BlockedUrlError('malformed', 'Malformed redirect target');
      }
      // A redirect to the same URL never terminates. Recognise it on the first
      // hop rather than burning the whole budget: it is the signature of a
      // bot deterrent, not of a broken link.
      if (next.toString() === current.toString()) {
        throw new BlockedUrlError(
          'redirect_loop',
          'Server redirects this URL to itself (typically a bot deterrent)',
        );
      }
      if (hop === MAX_REDIRECTS) {
        throw new BlockedUrlError('redirect_loop', 'Too many redirects');
      }
      current = next;
      continue;
    }

    // Cap the read rather than trusting content-length, which a hostile or
    // simply wrong server may understate.
    let body = '';
    if (opts.method !== 'HEAD' && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        body += decoder.decode(value, { stream: true });
        if (total >= maxBytes) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }

    return {
      url: current.toString(),
      status: response.status,
      ok: response.ok,
      body,
      redirects: hop,
    };
  }

  throw new BlockedUrlError('redirect_loop', 'Too many redirects');
}
