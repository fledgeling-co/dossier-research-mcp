import { z } from 'zod';
import {
  hasTraversalSegment,
  isbnChecksumValid,
  type IdentifierKind,
} from '../score/identifiers.js';

/**
 * The five registries, as a URL to ask and a rule for reading the answer.
 *
 * Split in two on purpose. `plan()` builds URLs and `interpret()` reads bodies,
 * and neither of them touches a network: the transport is injected by
 * `collect.ts`, so every predicate in this file is exercised in the gate with no
 * network, no key and no waiting. That is the same shape `bench/src/verify/`
 * already uses for gold-fact checking, and the reason is the same, a rule that
 * can only be exercised with a network is a rule nobody exercises.
 *
 * **Everything here fails closed in exactly one direction.** An answer is
 * `absent` only when the registry positively said so in a shape this module
 * recognises. Anything else, a timeout, a 429, a 500, an unparseable body, a
 * shape that changed since this was written, is `unchecked`. That asymmetry is
 * the single most important rule in the slice: `absent` means "this reference
 * was fabricated", and a benchmark that says that because a server was busy has
 * become the thing it exists to detect.
 *
 * Every endpoint and every predicate below was checked against the live service
 * on 27 July 2026 rather than taken from documentation, and three of them do not
 * behave the way the brief assumed. The details are in
 * `docs/bench/citation-integrity.md`.
 */

export const REGISTRY_IDS = [
  'crossref',
  'doi-handle',
  'arxiv',
  'ncbi',
  'openlibrary',
  'nvd',
] as const;
export type RegistryId = (typeof REGISTRY_IDS)[number];

/** What a lookup concluded. `invalid` never reaches the network. */
export type RegistryStatus = 'present' | 'absent' | 'unchecked' | 'invalid';

/** What an injected transport hands back. Deliberately headerless: see `gapMs`. */
export interface RegistryResponse {
  readonly status: number;
  readonly body: string;
  /** Set when the request never produced a response at all. */
  readonly error?: string | undefined;
}

export type RegistryTransport = (url: string) => Promise<RegistryResponse>;

/**
 * One step's reading of one response.
 *
 * `next` means this step could not decide and the following step should run. A
 * `next` with no following step is `unchecked`, never `absent`, which is the
 * fail-closed rule expressed as a data structure rather than as a convention
 * somebody has to remember.
 */
export type StepOutcome =
  | { readonly kind: 'present' | 'absent' | 'unchecked'; readonly detail: string }
  | { readonly kind: 'next'; readonly detail: string };

export interface RegistryStep {
  readonly registry: RegistryId;
  readonly url: string;
  readonly interpret: (response: RegistryResponse) => StepOutcome;
}

export interface RegistryOptions {
  /**
   * A contact address for Crossref's polite pool.
   *
   * Crossref asks callers to identify themselves and rewards it: verified 27
   * July 2026, a request carrying `mailto` answers `x-api-pool: polite-single`
   * with `x-rate-limit-limit: 10`, and one without answers `public-single` with
   * `5`. It is an option with no default rather than a constant, because the
   * address belongs to whoever is running the benchmark and baking one person's
   * inbox into a shared tool is not a decision this code gets to make. Unset,
   * the request still identifies itself through `safeFetch`'s user agent, which
   * carries the project URL, and the limiter drops to the public pool's rate.
   */
  readonly crossrefMailto?: string | undefined;
}

/**
 * The minimum gap between two requests to one registry, in milliseconds.
 *
 * Each is at or below what the service publishes, and each is applied across
 * every worker rather than per worker, because a limit divided among eight
 * concurrent cells is not the limit the service asked for.
 *
 * arXiv's is the one that matters most in practice. Its stated terms are one
 * request every three seconds, and on 27 July 2026 it answered `429 Rate
 * exceeded` to every attempt over a seven-minute span after a handful of
 * requests, so `unchecked` is the ordinary answer from that archive rather than
 * the rare one. That is a measurement, not a guess, and it is the clearest
 * argument in the whole slice for why the first rule had to be written down.
 */
export const REGISTRY_GAP_MS: Readonly<Record<RegistryId, number>> = {
  // 5 requests a second on the public pool; 10 with a contact address.
  crossref: 200,
  'doi-handle': 200,
  // arXiv's published terms: no more than one request every three seconds.
  arxiv: 3000,
  // NCBI E-utilities: 3 requests a second without an API key.
  ncbi: 350,
  // OpenLibrary publishes no limit; this is politeness rather than compliance.
  openlibrary: 1000,
  // The NVD without an API key: 5 requests per rolling 30 seconds.
  nvd: 6000,
};

/** Crossref's polite pool doubles the allowance, so the gap halves. */
export function crossrefGapMs(options: RegistryOptions): number {
  return options.crossrefMailto === undefined || options.crossrefMailto === '' ? 200 : 100;
}

/**
 * Percent-encode an identifier for use as URL path segments.
 *
 * Segment by segment, keeping the separators, because a DOI's suffix contains
 * slashes that are part of the identifier. The identifier came out of a model
 * that was reading the open web, so this is a trust boundary (CP §4 A10) and
 * `plan()` refuses a traversal segment outright before reaching here.
 */
function encodePath(id: string): string {
  return id.split('/').map(encodeURIComponent).join('/');
}

const HandleBody = z.object({ responseCode: z.number() });
const NcbiBody = z.object({ result: z.record(z.string(), z.unknown()) });
const NvdBody = z.object({ totalResults: z.number() });
const OpenLibraryBody = z.record(z.string(), z.unknown());

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** A transport-level failure is never evidence about the identifier. */
function transportFailed(response: RegistryResponse): StepOutcome | null {
  if (response.error !== undefined) {
    return { kind: 'unchecked', detail: `the request failed: ${response.error}` };
  }
  return null;
}

function crossrefStep(id: string, options: RegistryOptions): RegistryStep {
  const mailto = options.crossrefMailto;
  const query =
    mailto === undefined || mailto === '' ? '' : `?mailto=${encodeURIComponent(mailto)}`;
  return {
    registry: 'crossref',
    url: `https://api.crossref.org/works/${encodePath(id)}${query}`,
    interpret: (response) => {
      const failed = transportFailed(response);
      if (failed) return failed;
      if (response.status === 200) {
        return { kind: 'present', detail: 'Crossref holds a record for this DOI' };
      }
      // Everything else, including 404, falls through to the handle directory.
      // Crossref is one registration agency among several, so its 404 says only
      // that Crossref did not register this DOI. Verified 27 July 2026: the
      // live Zenodo DOI 10.5281/zenodo.3509134 is a Crossref 404 and a handle
      // 200, so treating this 404 as absent would call a real reference
      // fabricated.
      return {
        kind: 'next',
        detail: `Crossref answered ${String(response.status)}; Crossref is one agency of several, so this decides nothing on its own`,
      };
    },
  };
}

function handleStep(id: string): RegistryStep {
  return {
    registry: 'doi-handle',
    url: `https://doi.org/api/handles/${encodePath(id)}`,
    interpret: (response) => {
      const failed = transportFailed(response);
      if (failed) return failed;
      if (response.status === 200) {
        return { kind: 'present', detail: 'the global DOI directory resolves this handle' };
      }
      if (response.status === 404) {
        const parsed = HandleBody.safeParse(parseJson(response.body));
        // Handle protocol response code 100 is "handle not found". Requiring it
        // rather than trusting the 404 alone means a proxy error page, which is
        // also a 404, cannot be read as a fabricated reference.
        if (parsed.success && parsed.data.responseCode === 100) {
          return {
            kind: 'absent',
            detail: 'the global DOI directory has no such handle, across every registration agency',
          };
        }
        return {
          kind: 'unchecked',
          detail: 'a 404 whose body is not the directory’s own not-found answer',
        };
      }
      return { kind: 'unchecked', detail: `the directory answered ${String(response.status)}` };
    },
  };
}

/**
 * arXiv answers an Atom feed, and the count is read from one element.
 *
 * A regex rather than an XML parser, because exactly one field decides the
 * answer and adding a dependency to read it would be the larger change. The
 * narrowness is the safety: a feed this pattern cannot read is `unchecked`.
 */
const ARXIV_TOTAL = /<opensearch:totalResults[^>]*>\s*(\d+)\s*<\/opensearch:totalResults>/i;

function arxivStep(id: string): RegistryStep {
  return {
    registry: 'arxiv',
    url: `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`,
    interpret: (response) => {
      const failed = transportFailed(response);
      if (failed) return failed;
      if (response.status !== 200) {
        // 429 is the common answer, not the rare one. See REGISTRY_GAP_MS.
        return { kind: 'unchecked', detail: `arXiv answered ${String(response.status)}` };
      }
      const match = ARXIV_TOTAL.exec(response.body);
      const total = match?.[1];
      if (total === undefined) {
        return { kind: 'unchecked', detail: 'the response was not an arXiv result feed' };
      }
      if (Number(total) === 0) {
        return { kind: 'absent', detail: 'arXiv returned no entry for this id' };
      }
      return { kind: 'present', detail: 'arXiv returned an entry for this id' };
    },
  };
}

function ncbiStep(id: string): RegistryStep {
  return {
    registry: 'ncbi',
    url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${encodeURIComponent(id)}&retmode=json`,
    interpret: (response) => {
      const failed = transportFailed(response);
      if (failed) return failed;
      if (response.status !== 200) {
        return { kind: 'unchecked', detail: `NCBI answered ${String(response.status)}` };
      }
      const parsed = NcbiBody.safeParse(parseJson(response.body));
      if (!parsed.success) {
        return { kind: 'unchecked', detail: 'the response was not an E-utilities summary' };
      }
      const entry = parsed.data.result[id];
      if (entry === undefined) {
        return { kind: 'unchecked', detail: 'the summary carried no entry for this id' };
      }
      // Verified 27 July 2026: a missing PMID answers HTTP 200 with
      // `{"error":"cannot get document summary"}` on the entry. Reading the
      // status alone would score every fabricated PMID as real.
      const hasError =
        typeof entry === 'object' && entry !== null && 'error' in entry;
      return hasError
        ? { kind: 'absent', detail: 'PubMed has no record with this identifier' }
        : { kind: 'present', detail: 'PubMed returned a summary for this identifier' };
    },
  };
}

function openLibraryStep(id: string): RegistryStep {
  return {
    registry: 'openlibrary',
    url: `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(id)}&format=json`,
    interpret: (response) => {
      const failed = transportFailed(response);
      if (failed) return failed;
      if (response.status !== 200) {
        return { kind: 'unchecked', detail: `OpenLibrary answered ${String(response.status)}` };
      }
      const parsed = OpenLibraryBody.safeParse(parseJson(response.body));
      if (!parsed.success) {
        return { kind: 'unchecked', detail: 'the response was not an OpenLibrary lookup' };
      }
      // Both directions are weak and the detail says so on every answer, not
      // just the negative one. Verified 27 July 2026: the fabricated
      // 9789999999991 returns a real catalogue record, and 9786060606062
      // returns `{}`. The catalogue is community-edited and incomplete.
      return Object.hasOwn(parsed.data, `ISBN:${id}`)
        ? {
            kind: 'present',
            detail: 'the catalogue holds a record listing this number; catalogue presence, not proof the book exists',
          }
        : {
            kind: 'absent',
            detail: 'the catalogue holds no record listing this number; catalogue absence, and its coverage is incomplete',
          };
    },
  };
}

function nvdStep(id: string): RegistryStep {
  return {
    registry: 'nvd',
    url: `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${encodeURIComponent(id)}`,
    interpret: (response) => {
      const failed = transportFailed(response);
      if (failed) return failed;
      if (response.status !== 200) {
        return { kind: 'unchecked', detail: `the NVD answered ${String(response.status)}` };
      }
      const parsed = NvdBody.safeParse(parseJson(response.body));
      if (!parsed.success) {
        return { kind: 'unchecked', detail: 'the response was not an NVD result page' };
      }
      // Verified 27 July 2026: an unknown CVE answers HTTP 200 with
      // `totalResults: 0`. The status alone decides nothing.
      return parsed.data.totalResults > 0
        ? { kind: 'present', detail: 'the NVD holds a record for this CVE' }
        : { kind: 'absent', detail: 'the NVD returned no record for this CVE' };
    },
  };
}

/**
 * A refusal to look something up at all, with the reason.
 *
 * Returned instead of steps when the identifier itself is malformed. It is
 * `invalid` and never `absent`, because a typo is not a fabrication.
 */
export interface RegistryRefusal {
  readonly status: 'invalid';
  readonly detail: string;
}

export type RegistryPlan = { readonly steps: readonly RegistryStep[] } | RegistryRefusal;

export function isRefusal(plan: RegistryPlan): plan is RegistryRefusal {
  return 'status' in plan;
}

/**
 * The ordered lookups that decide one identifier.
 *
 * Only the DOI has more than one, and that second step is the finding this
 * slice turns on: Crossref alone would report a genuine reference as
 * fabricated, so the global handle directory is what an `absent` verdict
 * actually rests on.
 */
export function plan(
  kind: IdentifierKind,
  id: string,
  options: RegistryOptions = {},
): RegistryPlan {
  switch (kind) {
    case 'doi': {
      if (hasTraversalSegment(id)) {
        return { status: 'invalid', detail: 'the DOI contains a path-traversal segment' };
      }
      return { steps: [crossrefStep(id, options), handleStep(id)] };
    }
    case 'arxiv':
      return { steps: [arxivStep(id)] };
    case 'pmid':
      return { steps: [ncbiStep(id)] };
    case 'isbn': {
      if (!isbnChecksumValid(id)) {
        return {
          status: 'invalid',
          detail: 'the check digit does not agree with the number, so this is a typo rather than a reference',
        };
      }
      return { steps: [openLibraryStep(id)] };
    }
    case 'cve':
      return { steps: [nvdStep(id)] };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
