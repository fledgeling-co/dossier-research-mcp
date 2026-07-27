import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectCitationEvidence } from '../citations/collect.js';
import { fetchPage } from '../citations/fetch.js';
import { sha256Hex } from './corpus.js';
import { detectorPaths } from './files.js';
import type { PageVerdict } from './schema.js';

/**
 * The capture pass. **Touches the network and is never in the gate.**
 *
 * It fetches a real page through `collectCitationEvidence`, which is the
 * production path: SSRF-safe fetch, `extractText`, `judgeCitationStatus`. Going
 * through the real collector rather than a second fetcher is the point. The
 * fixture is then the same text the scorer would have been handed live, and the
 * verdict is the one the product's own rule reached, so the corpus measures the
 * shipped behaviour instead of a plausible imitation of it.
 *
 * What it produces is deliberately frozen. `docs/plan/benchmark.md` keeps raw
 * reports so a metric added later can be applied to research already paid for,
 * and the prior art is explicit that live-web evaluation is not reproducible,
 * which is why RetroSearch and BrowseComp-Plus exist at all. The cost is a shelf
 * life, and the honest move is to stamp it: every fixture records where it came
 * from, when, and the digest of what was read.
 */

export interface CapturedPage {
  readonly url: string;
  readonly capturedAt: string;
  readonly verdict: PageVerdict;
  readonly httpStatus: number | undefined;
  readonly truncated: boolean;
  readonly completeHtml: boolean;
  readonly text: string;
  readonly sha256: string;
  readonly chars: number;
  readonly note: string | undefined;
}

/** A registry transport that answers nothing, so a capture never probes a registry. */
function noRegistry(): Promise<{ status: number; body: string; error: string }> {
  return Promise.resolve({
    status: 0,
    body: '',
    error: 'the capture pass asks no registry',
  });
}

/** Fetch one page and reduce it to what the corpus stores. */
export async function capturePage(url: string): Promise<CapturedPage> {
  const evidence = await collectCitationEvidence(url, {
    registryTransport: noRegistry,
    fetchPage,
    maxIdentifiers: 0,
  });
  const page = evidence.pages[0];
  if (page === undefined) {
    throw new Error(
      `nothing was fetched for ${url}; the collector found no cited address in it, which usually means the URL needs to be written as a bare link`,
    );
  }
  return {
    url: page.url,
    capturedAt: evidence.collectedAt,
    verdict: page.verdict,
    httpStatus: page.httpStatus,
    truncated: page.truncated,
    completeHtml: page.completeHtml,
    text: page.text,
    sha256: sha256Hex(page.text),
    chars: page.text.length,
    note: page.note,
  };
}

/** Write a fixture into the corpus and return the YAML block that refers to it. */
export function writeFixture(root: string, name: string, captured: CapturedPage): string {
  const paths = detectorPaths(root);
  mkdirSync(paths.pagesDir, { recursive: true });
  const file = `${name}.txt`;
  writeFileSync(join(paths.pagesDir, file), captured.text, 'utf8');

  const lines = [
    '  provenance: captured',
    `  capturedAt: "${captured.capturedAt}"`,
    `  verdict: ${captured.verdict}`,
    ...(captured.httpStatus === undefined ? [] : [`  httpStatus: ${String(captured.httpStatus)}`]),
    `  truncated: ${String(captured.truncated)}`,
    `  completeHtml: ${String(captured.completeHtml)}`,
    `  textFile: ${file}`,
    `  textSha256: "${captured.sha256}"`,
    `  textChars: ${String(captured.chars)}`,
    ...(captured.note === undefined ? [] : [`  note: ${JSON.stringify(captured.note)}`]),
  ];
  return lines.join('\n');
}

/**
 * Record a page whose text was written by hand rather than fetched.
 *
 * Legitimate where the live web will not hold a shape still. A consent
 * interstitial differs by region, by cookie jar and by week, so freezing one
 * freezes a photograph of a moving thing and calls it a page. The distinction
 * rides in the corpus as `provenance: constructed` rather than in a commit
 * message, because a reader weighing a result needs it.
 */
export function writeConstructedFixture(
  root: string,
  name: string,
  input: {
    readonly text: string;
    readonly capturedAt: string;
    readonly verdict: PageVerdict;
    readonly httpStatus?: number;
    readonly completeHtml: boolean;
    readonly note: string;
  },
): string {
  const paths = detectorPaths(root);
  mkdirSync(paths.pagesDir, { recursive: true });
  const file = `${name}.txt`;
  writeFileSync(join(paths.pagesDir, file), input.text, 'utf8');
  return [
    '  provenance: constructed',
    `  capturedAt: "${input.capturedAt}"`,
    `  verdict: ${input.verdict}`,
    ...(input.httpStatus === undefined ? [] : [`  httpStatus: ${String(input.httpStatus)}`]),
    '  truncated: false',
    `  completeHtml: ${String(input.completeHtml)}`,
    `  textFile: ${file}`,
    `  textSha256: "${sha256Hex(input.text)}"`,
    `  textChars: ${String(input.text.length)}`,
    `  note: ${JSON.stringify(input.note)}`,
  ].join('\n');
}
