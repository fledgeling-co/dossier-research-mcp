import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch, type Dispatcher, type Response as UndiciResponse } from 'undici';

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
    // IANA special-purpose ranges that are not "private" in the usual sense and
    // are still routable somewhere you did not intend. 198.18/15 in particular
    // is benchmark space that real networks do use internally.
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
    if (a === 192 && b === 88) return true; // 192.88.99.0/24 6to4 relay anycast
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (version === 6) {
    const bytes = expandIpv6(address);
    if (!bytes) return true; // unparseable but isIP said v6: fail closed

    if (bytes.every((b) => b === 0)) return true; // ::
    if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true; // ::1
    if (bytes[0] === 0xff) return true; // ff00::/8 multicast
    if ((bytes[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
    if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
    // fec0::/10 site-local. Deprecated by RFC 3879 and still configured on real
    // equipment, which is the only thing that matters for whether a request to
    // one reaches something internal.
    if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return true;
    // 2001:db8::/32 documentation, and 100::/64 discard-only.
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
    if (bytes[0] === 0x01 && bytes[1] === 0x00 && bytes.slice(2, 8).every((x) => x === 0)) return true;

    // Anything carrying an embedded IPv4 address is only as safe as that
    // address. Checked by byte pattern, never by string prefix: the WHATWG URL
    // parser canonicalises `[::ffff:127.0.0.1]` to `::ffff:7f00:1`, so a regex
    // expecting dotted-quad text matches nothing and the address sails through.
    // That was a real bypass to 127.0.0.1 and to 169.254.169.254.
    const v4 = (i: number) => `${bytes[i]}.${bytes[i + 1]}.${bytes[i + 2]}.${bytes[i + 3]}`;
    const zeroThrough = (n: number) => bytes.slice(0, n).every((b) => b === 0);
    // ::ffff:0:0/96 IPv4-mapped, and ::/96 IPv4-compatible (deprecated).
    if (zeroThrough(10) && bytes[10] === 0xff && bytes[11] === 0xff) return isPrivateAddress(v4(12));
    if (zeroThrough(12)) return isPrivateAddress(v4(12));
    // 64:ff9b::/96 NAT64.
    if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeroThrough(1))
      return isPrivateAddress(v4(12));
    // 2002::/16 6to4 carries the v4 address in bytes 2-5.
    if (bytes[0] === 0x20 && bytes[1] === 0x02) return isPrivateAddress(v4(2));

    return false;
  }
  return true; // not an IP literal we recognise: fail closed
}

/** Expand any valid IPv6 textual form to its 16 bytes. Null if unparseable. */
function expandIpv6(address: string): number[] | null {
  let text = address.toLowerCase().replace(/%.*$/, ''); // drop any zone id
  // A trailing dotted-quad (::ffff:1.2.3.4) becomes two hextets.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const quad = dotted[1].split('.').map(Number);
    if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((quad[0]! << 8) | quad[1]!).toString(16);
    const lo = ((quad[2]! << 8) | quad[3]!).toString(16);
    text = `${text.slice(0, dotted.index)}${hi}:${lo}`;
  }

  const [head, tail, ...rest] = text.split('::');
  if (rest.length > 0) return null; // more than one '::' is invalid
  const parse = (part: string | undefined) =>
    part ? part.split(':').filter((h) => h !== '') : [];
  const left = parse(head);
  const right = parse(tail);
  const gap = tail === undefined ? 0 : 8 - left.length - right.length;
  if (gap < 0) return null;
  const hextets = [...left, ...Array<string>(gap).fill('0'), ...right];
  if (hextets.length !== 8) return null;

  const bytes: number[] = [];
  for (const hextet of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(hextet)) return null;
    const value = parseInt(hextet, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

/** An address that passed validation, kept so the socket can be pinned to it. */
interface ValidatedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/**
 * Validate scheme + resolve DNS, rejecting anything that lands on a private IP.
 * Returns the approved addresses so the caller can pin the connection to them.
 */
async function assertPublicUrl(url: URL): Promise<ValidatedAddress[]> {
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new BlockedUrlError('scheme', `Scheme not allowed: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const version = isIP(host);
  if (version) {
    if (isPrivateAddress(host)) throw new BlockedUrlError('private', `Private address blocked: ${host}`);
    return [{ address: host, family: version === 6 ? 6 : 4 }];
  }
  let addresses: { address: string; family: number }[];
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
  return addresses.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
}

/**
 * Bind the connection to the addresses we actually validated.
 *
 * Checking DNS and then calling `fetch` resolves the name twice, and an
 * attacker controlling the zone can answer differently each time: a public
 * address for the check, `127.0.0.1` or `169.254.169.254` for the connection.
 * That is DNS rebinding, and validate-then-fetch cannot defend against it no
 * matter how good the address check is.
 *
 * Overriding undici's `lookup` closes the window: the socket can only reach an
 * address that already passed `isPrivateAddress`. Passing the hostname through
 * unchanged keeps the Host header and the TLS SNI correct, so certificate
 * validation still works against the real name.
 */
function pinnedDispatcher(approved: readonly ValidatedAddress[]): Dispatcher {
  return new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        const results = approved.map((a) => ({ address: a.address, family: a.family }));
        if (options.all) {
          (callback as (e: Error | null, a: typeof results) => void)(null, results);
          return;
        }
        const first = results[0]!;
        (callback as (e: Error | null, a: string, f: number) => void)(null, first.address, first.family);
      },
    },
  });
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
    const approved = await assertPublicUrl(current);
    const dispatcher = pinnedDispatcher(approved);

    let response: UndiciResponse;
    try {
      // undici's own fetch, not the global: the global's `dispatcher` option is
      // typed against a different copy of undici's types and will not compile.
      response = await undiciFetch(current, {
      dispatcher,
      method: opts.method ?? 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        // Identify honestly; some publishers block unlabelled clients and a
        // 403 would otherwise read as a dead citation.
        'user-agent': 'dossier-research-mcp/0.1 (+https://github.com/fledgeling-co/dossier-research-mcp)',
        accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
      },
      });
    } finally {
      // One agent per hop; close it so a redirect chain cannot leak sockets.
      void dispatcher.close().catch(() => undefined);
    }

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
      const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
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
