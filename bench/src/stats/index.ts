/**
 * The statistics, in one import.
 *
 * Four things the benchmark design had none of, all pure, all computed from
 * cells already bought: a paired difference with a cluster-bootstrap interval,
 * a standard error clustered on category beside the naive one, `pass@1` beside
 * `pass^k`, and the quantile both the intervals and the quartiles are read off.
 *
 * Nothing here reaches a filesystem, a network, a model or a wallet, and a test
 * asserts it by reading these files' own source rather than by saying so here.
 *
 * The completion floor is deliberately **not** here. It belongs to the verdict
 * `bench/src/report/aggregate.ts` already computes, because two different
 * answers to "can this sample support a claim" in one codebase is worse than
 * either one of them.
 *
 * `docs/bench/statistics.md` is the reference.
 */
export { byCluster, clusteredError, millerClusteredVariance } from './clustered.js';
export type { ClusteredError, Observation } from './clustered.js';

export { DEFAULT_CONFIDENCE, DEFAULT_RESAMPLES, clusterBootstrap } from './bootstrap.js';
export type { BootstrapOptions, BootstrapResult } from './bootstrap.js';

export { NO_MEASURED_DIFFERENCE, pairedDifference } from './paired.js';
export type { PairedDifference, PairedInput, PairedShared, PairedWithheld, TaskValue } from './paired.js';

export { DEFAULT_PASS_THRESHOLD, passRates } from './reliability.js';
export type { ReliabilityInput, ReliabilityReport, TaskAttempts } from './reliability.js';

export { quantile } from './quantile.js';
export { mulberry32, seedFrom } from './random.js';
