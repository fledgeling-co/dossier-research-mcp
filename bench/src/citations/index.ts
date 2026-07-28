/**
 * Citation evidence collection, in one import.
 *
 * The impure half of BENCH-03: the part that reaches registries and cited
 * pages. `bench/src/score/citations.ts` is the pure half and never sees a
 * network. The split is what makes a stored report score the same twice.
 */
export {
  DiskRegistryCache,
  MemoryRegistryCache,
  RateLimiter,
  SingleFlight,
  cacheKey,
  defaultCacheDir,
  realSleeper,
} from './cache.js';
export type { RegistryCache, Sleeper } from './cache.js';

export { citationLookupCoordinator, collectAnchors, collectCitationEvidence } from './collect.js';
export type { CollectOptions } from './collect.js';

export {
  CitationEvidenceSchema,
  EVIDENCE_VERSION,
  MAX_PAGE_TEXT_CHARS,
  PageEvidenceSchema,
  PublicationDateSchema,
  RegistryAnswerSchema,
  emptyEvidence,
  pagesByUrl,
  parseEvidence,
  registryByIdentifier,
} from './evidence.js';
export type {
  CitationEvidence,
  PageEvidence,
  PersistedPublicationDate,
  RegistryAnswer,
} from './evidence.js';

export {
  EARLIEST_PUBLICATION,
  EARLIEST_URL_YEAR,
  FUTURE_GRACE_DAYS,
  PUBLICATION_SIGNALS,
  extractPublicationDate,
  plausibleRange,
  readMetaTags,
  readPublicationDate,
} from './published.js';
export type {
  DateReading,
  PlausibleRange,
  PublicationAbsent,
  PublicationDate,
  PublicationFound,
  PublicationInput,
  PublicationSignal,
  PublicationUnchecked,
} from './published.js';

export { MAX_PAGE_BYTES, MAX_REGISTRY_BYTES, fetchPage, fetchRegistry } from './fetch.js';
export type { FetchedPage } from './fetch.js';

export { evidenceMatchesReport, evidencePath, readEvidence, writeEvidence } from './store.js';

export { citationBatch, defaultEvidenceDir } from './live.js';
export type { CitationBatch, LiveCitationOptions } from './live.js';

export { REGISTRY_GAP_MS, REGISTRY_IDS, crossrefGapMs, isRefusal, plan } from './registries.js';
export type {
  RegistryId,
  RegistryOptions,
  RegistryPlan,
  RegistryRefusal,
  RegistryResponse,
  RegistryStatus,
  RegistryStep,
  RegistryTransport,
  StepOutcome,
} from './registries.js';
