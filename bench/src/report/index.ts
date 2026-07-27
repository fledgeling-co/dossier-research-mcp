/**
 * The benchmark's read side, in one import.
 *
 * Cells already bought, turned into something a person can act on. Everything
 * exported here except the CLI is pure: no filesystem, no network, no model,
 * no wallet. That is what makes the property `docs/plan/benchmark.md` bought by
 * separating the run from the scoring real rather than aspirational, because a
 * metric added in three months can be applied to research already paid for.
 *
 * The rule this slice enforces, and the reason it exists: **never report a
 * ranking the sample cannot support.** `rank.ts` withholds; `aggregate.ts`
 * refuses to score an under-sampled category; `render.ts` prints what was
 * withheld and why, and puts completion rate, the stale count and the
 * unchecked-registry share above every score rather than under them.
 *
 * `docs/bench/reporting.md` is the reference.
 */
export {
  METRIC_IDS,
  allMetrics,
  betterFirst,
  isRankable,
  metricDescriptor,
  metricsOfFamily,
} from './metrics.js';
export type {
  MetricDescriptor,
  MetricDirection,
  MetricFamily,
  MetricId,
  MetricUnit,
} from './metrics.js';

export { spreadsOverlap, summarise } from './spread.js';
export type { SampleUnit, Spread, SpreadReport } from './spread.js';

export { harvestCell } from './harvest.js';
export type { EvidenceState, HarvestInput, RegistryCounts, ScoredCell } from './harvest.js';

export { MIN_TASKS_PER_CATEGORY, aggregate, uncheckedShare } from './aggregate.js';
export type {
  AggregateInput,
  BackendSummary,
  BenchAggregate,
  CategoryGroup,
  CompletionCounts,
  CorpusFacts,
  ScorableVerdict,
  TaskGroup,
} from './aggregate.js';

export { OVERLAP_NOTE, rankBackends } from './rank.js';
export type { RankCandidate, RankScope, Ranking, RankedEntry, WithheldReason } from './rank.js';

export { formatValue, render, renderJson, renderMarkdown, rankings } from './render.js';
export type { ReportFormat } from './render.js';
