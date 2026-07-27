import { createHash } from 'node:crypto';
import { canonicaliseUrl } from '../../../src/research/corroborate.js';
import { judgeCitationError, judgeCitationStatus } from '../../../src/research/citations.js';
import { extractCitedUrls } from '../../../src/research/report.js';
import { decodeEntities, extractText } from '../verify/match.js';
import type { FetchedPage } from './fetch.js';
import { extractIdentifiers, type ExtractedIdentifier } from '../score/identifiers.js';
import {
  MemoryRegistryCache,
  RateLimiter,
  SingleFlight,
  cacheKey,
  type RegistryCache,
} from './cache.js';
import {
  EVIDENCE_VERSION,
  MAX_PAGE_TEXT_CHARS,
  type CitationEvidence,
  type PageEvidence,
  type RegistryAnswer,
} from './evidence.js';
import { crossrefGapMs, isRefusal, plan, type RegistryOptions, type RegistryTransport } from './registries.js';

/**
 * Gather everything a citation score needs, once, and write it down.
 *
 * The impure half of BENCH-03. It walks a report, asks each registry about each
 * identifier through the on-disk cache, fetches each cited page once, and
 * returns a timestamped snapshot. **Nothing here decides a score**; that is
 * `bench/src/score/citations.ts`, which is pure and never sees a network.
 *
 * Everything that touches the outside is injected: the registry transport, the
 * page fetcher, the cache, the limiter and the clock. So the whole of this file
 * runs in the gate with no network, no waiting and no temporary directory
 * unless a test asks for one, and a batch that runs entirely offline still
 * produces a complete snapshot in which every registry answer is `unchecked`.
 */

export interface CollectOptions {
  readonly registryTransport: RegistryTransport;
  readonly fetchPage: (url: string) => Promise<FetchedPage>;
  readonly cache?: RegistryCache | undefined;
  readonly limiter?: RateLimiter | undefined;
  /**
   * Shared across every collector call in one batch.
   *
   * The cache, the limiter and this are all injected together and all three
   * have to outlive a single call to do their jobs: a limiter created per
   * report enforces a gap per report rather than per registry, and a
   * single-flight map created per report cannot collapse two concurrent cells
   * that want the same DOI. `citationLookupCoordinator()` builds the three as
   * one unit; a batch builds it once and passes it to every call.
   */
  readonly flight?: SingleFlight | undefined;
  readonly now?: (() => Date) | undefined;
  /** Bounded well below the harness's own, since this is batch work. */
  readonly concurrency?: number | undefined;
  readonly registryOptions?: RegistryOptions | undefined;
  /** Cap on cited pages fetched from one report, so one runaway cannot stall a batch. */
  readonly maxPages?: number | undefined;
  readonly maxIdentifiers?: number | undefined;
}

/**
 * The three things that must be shared across a whole batch, built as one.
 *
 * Handed to every `collectCitationEvidence` call in a run. Built per call
 * instead, the cache still works and the other two silently do not: the gap
 * would be enforced per report rather than per registry, and two cells wanting
 * the same identifier at the same moment would both miss and both request,
 * which is the requirement that the same DOI across forty reports is one
 * lookup, quietly unmet.
 */
export function citationLookupCoordinator(options: {
  readonly cache?: RegistryCache | undefined;
  readonly registryOptions?: RegistryOptions | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
} = {}): { cache: RegistryCache; limiter: RateLimiter; flight: SingleFlight } {
  return {
    cache: options.cache ?? new MemoryRegistryCache(),
    limiter: new RateLimiter({
      gaps: { crossref: crossrefGapMs(options.registryOptions ?? {}) },
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    }),
    flight: new SingleFlight(),
  };
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_PAGES = 300;
const DEFAULT_MAX_IDENTIFIERS = 300;

/**
 * Every `id` and `name` an HTML document declares.
 *
 * Separate from `extractText` because that strips tags, and the attributes go
 * with them. Entities are decoded so `id="a&amp;b"` matches the fragment
 * `#a&b`, which is the form a browser would resolve.
 */
export function collectAnchors(html: string): string[] {
  const found = new Set<string>();
  // Script bodies, style bodies and comments are dropped first: a browser would
  // not resolve a fragment against a string inside a script, and a page whose
  // JavaScript happens to contain `name="x"` would otherwise be reported as
  // declaring an anchor it does not have.
  const markup = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  // The attribute must open one, so `data-id` and `aria-labelledby` do not
  // count: only `id` and `name` address a fragment.
  const pattern = /[\s<"'](?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>=`]+))/gi;
  for (const m of markup.matchAll(pattern)) {
    const value = m[1] ?? m[2] ?? m[3] ?? '';
    const decoded = decodeEntities(value).trim();
    if (decoded.length > 0 && decoded.length <= 300) found.add(decoded);
  }
  return [...found];
}

/** Whether a body is HTML we read to the end, which is what gates the anchor check. */
function isCompleteHtml(source: FetchedPage): boolean {
  if (source.truncated || source.error !== undefined || !source.ok) return false;
  const head = source.body.slice(0, 2000).toLowerCase();
  return head.includes('<!doctype html') || head.includes('<html') || /<(body|head|div|p|h1)\b/.test(head);
}

async function lookUpIdentifier(
  identifier: ExtractedIdentifier,
  checkedAt: string,
  options: CollectOptions,
  limiter: RateLimiter,
  cache: RegistryCache,
  flight: SingleFlight,
): Promise<RegistryAnswer> {
  const { kind, id } = identifier;

  // An identifier its own grammar already rejects never reaches a network. A
  // typo is not a fabrication, so it is `invalid` rather than `absent`.
  if (identifier.invalidReason !== undefined) {
    return { kind, id, status: 'invalid', detail: identifier.invalidReason, checkedAt };
  }

  const cached = cache.get(kind, id);
  if (cached !== undefined) return cached;

  return flight.run(cacheKey(kind, id), async () => {
    // Re-read inside the flight: a caller that queued behind another asking the
    // same question should take its answer rather than issue a second request.
    const second = cache.get(kind, id);
    if (second !== undefined) return second;

    const built = plan(kind, id, options.registryOptions ?? {});
    if (isRefusal(built)) {
      return { kind, id, status: 'invalid' as const, detail: built.detail, checkedAt };
    }

    let lastDetail = 'no registry step reached a conclusion';
    for (const step of built.steps) {
      // A transport that REJECTS rather than resolving with an error would
      // otherwise reject the whole collection, losing every other answer in the
      // snapshot along with this one. Normalised here so a thrown timeout
      // reaches `interpret` as the `unchecked` it is.
      const response = await limiter
        .schedule(step.registry, () => options.registryTransport(step.url))
        .catch((e: unknown) => ({
          status: 0,
          body: '',
          error: e instanceof Error ? e.message : 'the registry request threw',
        }));
      const outcome = step.interpret(response);
      if (outcome.kind === 'next') {
        lastDetail = outcome.detail;
        continue;
      }
      const answer: RegistryAnswer = {
        kind,
        id,
        status: outcome.kind,
        via: step.registry,
        detail: outcome.detail,
        checkedAt,
      };
      cache.set(answer);
      return answer;
    }

    // Every step said "cannot decide". That is `unchecked`, never `absent`, and
    // it is deliberately not cached: a transient outage must not become a
    // permanent verdict about somebody's citation.
    return { kind, id, status: 'unchecked' as const, detail: lastDetail, checkedAt };
  });
}

async function collectPage(
  url: string,
  checkedAt: string,
  fetchOne: (url: string) => Promise<FetchedPage>,
): Promise<PageEvidence> {
  // Same reason as the registry transport: a fetcher that throws must cost one
  // page's evidence, never the whole report's.
  const source = await fetchOne(url).catch(
    (e: unknown): FetchedPage => ({
      url,
      status: 0,
      ok: false,
      body: '',
      contentType: '',
      truncated: false,
      error: e instanceof Error ? e.message : 'the page request threw',
      thrown: e,
    }),
  );

  // The error object itself where there is one, so a URL `safeFetch` refused as
  // private or malformed keeps its own verdict instead of flattening into
  // `unreachable` alongside a timeout.
  const judged =
    source.error === undefined
      ? judgeCitationStatus(source.status, source.ok)
      : judgeCitationError(source.thrown ?? new Error(source.error));

  const raw = extractText(source.body, source.contentType);
  const text = raw.slice(0, MAX_PAGE_TEXT_CHARS);
  // One flag for both causes: the read stopped at the byte cap, or the text was
  // longer than a snapshot keeps. Containment asks one question of it and the
  // answer is the same either way.
  const truncated = source.truncated || raw.length > MAX_PAGE_TEXT_CHARS;

  return {
    url,
    ...(source.url !== url ? { finalUrl: source.url } : {}),
    verdict: judged.verdict,
    ...(source.status > 0 ? { httpStatus: source.status } : {}),
    text,
    truncated,
    completeHtml: isCompleteHtml(source) && !truncated,
    anchors: isCompleteHtml(source) ? collectAnchors(source.body) : [],
    checkedAt,
    ...(judged.note === undefined ? {} : { note: judged.note }),
  };
}

/** Run `work` over `items` with a bounded number in flight, preserving order. */
async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      out[index] = await work(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker),
  );
  return out;
}

/**
 * Collect one report's citation evidence.
 *
 * Never throws for a network reason. Every failure is recorded in the snapshot
 * as the thing it is, because a collection that gives up halfway would leave a
 * scorer computing a rate over whichever half happened to succeed.
 */
export async function collectCitationEvidence(
  report: string,
  options: CollectOptions,
): Promise<CitationEvidence> {
  const now = options.now ?? ((): Date => new Date());
  const checkedAt = now().toISOString();
  const cache = options.cache ?? new MemoryRegistryCache();
  const limiter =
    options.limiter ??
    new RateLimiter({ gaps: { crossref: crossrefGapMs(options.registryOptions ?? {}) } });
  const flight = options.flight ?? new SingleFlight();
  const notes: string[] = [];

  const allUrls = extractCitedUrls(report).map(canonicaliseUrl);
  const uniqueUrls = [...new Set(allUrls)];
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const urls = uniqueUrls.slice(0, maxPages);
  if (uniqueUrls.length > urls.length) {
    notes.push(
      `the report cites ${String(uniqueUrls.length)} distinct addresses and this pass fetched the first ${String(urls.length)}; the rest are unchecked rather than absent`,
    );
  }

  const allIdentifiers = extractIdentifiers(report);
  const maxIdentifiers = options.maxIdentifiers ?? DEFAULT_MAX_IDENTIFIERS;
  const identifiers = allIdentifiers.slice(0, maxIdentifiers);
  if (allIdentifiers.length > identifiers.length) {
    notes.push(
      `the report carries ${String(allIdentifiers.length)} identifiers and this pass checked the first ${String(identifiers.length)}; the rest are unchecked rather than absent`,
    );
  }

  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  const [pages, registry] = await Promise.all([
    mapBounded(urls, concurrency, (url) => collectPage(url, checkedAt, options.fetchPage)),
    mapBounded(identifiers, concurrency, (identifier) =>
      lookUpIdentifier(identifier, checkedAt, options, limiter, cache, flight),
    ),
  ]);

  return {
    version: EVIDENCE_VERSION,
    collectedAt: checkedAt,
    reportSha256: createHash('sha256').update(report).digest('hex'),
    pages,
    registry,
    notes,
  };
}
