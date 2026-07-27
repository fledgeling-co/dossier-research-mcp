import { join } from 'node:path';
import type { CitationIntegrityResult, ScoreCitationOptions } from '../score/citations.js';
import { scoreCitationIntegrity } from '../score/citations.js';
import { DiskRegistryCache, defaultCacheDir, type RegistryCache } from './cache.js';
import { citationLookupCoordinator, collectCitationEvidence } from './collect.js';
import type { CitationEvidence } from './evidence.js';
import { fetchPage, fetchRegistry } from './fetch.js';
import type { RegistryOptions } from './registries.js';
import { evidenceMatchesReport, readEvidence, writeEvidence } from './store.js';

/**
 * The wiring: the live adapters, the disk cache and the batch coordinator, in
 * the arrangement a real run wants.
 *
 * Every part of this slice is injectable so the gate can drive it with no
 * network, and that leaves an obligation somebody has to discharge: the default
 * arrangement has to exist somewhere, or "the same DOI across forty reports is
 * one lookup" is a property that holds only if a future caller happens to wire
 * three objects together correctly. The out-of-family critic caught exactly
 * that, so the arrangement lives here rather than in whoever writes the
 * reporting surface.
 *
 * BENCH-08 still owns what a run *reports*. This owns what a run *does*.
 */

export interface LiveCitationOptions {
  /** Where remembered registry answers live. Defaults beside the run store. */
  readonly cacheDir?: string | undefined;
  /** Where snapshots live. Defaults to a sibling of the answer cache. */
  readonly evidenceDir?: string | undefined;
  readonly registryOptions?: RegistryOptions | undefined;
  readonly concurrency?: number | undefined;
}

export interface CitationBatch {
  readonly evidenceDir: string;
  /** Collect one report's evidence and write it down under its cell key. */
  collect(cellKey: string, report: string): Promise<CitationEvidence>;
  /** Read a stored snapshot back and score a report against it. */
  score(cellKey: string, report: string, options?: ScoreCitationOptions): CitationIntegrityResult;
}

export function defaultEvidenceDir(): string {
  return join(defaultCacheDir(), '..', 'citation-evidence');
}

/**
 * One batch's worth of citation work, wired to the real world.
 *
 * The cache, the limiter and the single-flight map are built **once here** and
 * shared by every `collect` call, which is the whole reason this exists: built
 * per report they silently stop doing their jobs, enforcing a rate limit per
 * report rather than per registry and letting two concurrent cells both miss
 * the cache for the same identifier.
 */
export function citationBatch(options: LiveCitationOptions = {}): CitationBatch {
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const evidenceDir = options.evidenceDir ?? defaultEvidenceDir();
  const cache: RegistryCache = new DiskRegistryCache(cacheDir);
  const shared = citationLookupCoordinator({
    cache,
    ...(options.registryOptions === undefined ? {} : { registryOptions: options.registryOptions }),
  });

  return {
    evidenceDir,

    async collect(cellKey, report) {
      const evidence = await collectCitationEvidence(report, {
        registryTransport: fetchRegistry,
        fetchPage: (url) => fetchPage(url),
        ...shared,
        ...(options.registryOptions === undefined
          ? {}
          : { registryOptions: options.registryOptions }),
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      });
      writeEvidence(evidenceDir, cellKey, evidence);
      return evidence;
    },

    score(cellKey, report, scoreOptions) {
      const evidence = readEvidence(evidenceDir, cellKey);
      // A snapshot collected from a different text would produce a full set of
      // plausible numbers with nothing behind them, and the mismatch is silent
      // unless somebody checks. Treated as no evidence at all, which reaches
      // the caller as a pipeline gap rather than as a result about a backend.
      if (evidence !== undefined && !evidenceMatchesReport(evidence, report)) {
        return scoreCitationIntegrity(report, undefined, scoreOptions);
      }
      return scoreCitationIntegrity(report, evidence, scoreOptions);
    },
  };
}
