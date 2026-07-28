import type { TaskCategory } from '../tasks/schema.js';
import type { BenchTask, TaskCorpus } from '../tasks/corpus.js';
import type { CellRecord } from '../run/cell.js';
import { cellKey } from '../run/cell.js';
import { METRIC_IDS, type MetricId } from './metrics.js';
import type { RegistryCounts, ScoredCell } from './harvest.js';
import type { DatingCounts } from '../score/recency.js';

/**
 * Fixtures the report tests build their inputs from.
 *
 * Not a test file: it is imported by several, so it lives beside them rather
 * than being copied into each. It reads no disk and calls nothing that does.
 */

export const NO_REGISTRY: RegistryCounts = { present: 0, absent: 0, unchecked: 0, invalid: 0 };

export const NO_DATING: DatingCounts = { dated: 0, absent: 0, unchecked: 0, afterHorizon: 0 };

export function task(id: string, category: TaskCategory, stale = false): BenchTask {
  return {
    id,
    category,
    question: `a question long enough to be valid, about ${id}`,
    asOf: '2026-07-01',
    reverifiedAt: '2026-07-01',
    goldFacts: [
      {
        id: 'f1',
        kind: 'name',
        value: 'anything',
        aliases: [],
        source: { url: 'https://example.test/a' },
      },
    ],
    requiredTerms: ['anything'],
    driftTerms: [],
    knownDissent: [],
    conflictingFigures: [],
    fringeClaims: [],
    file: `${id}.yaml`,
    reverifiedAgeDays: stale ? 200 : 1,
    stale,
    applicableMetrics: {
      accuracy: true,
      relevance: true,
      calibration: true,
      dissentRecall: false,
      conflictAcknowledgement: false,
      falseBalance: false,
      refusal: false,
      enumerationCompleteness: false,
    },
  };
}

export function corpus(tasks: readonly BenchTask[], evaluatedAt = '2026-07-27'): TaskCorpus {
  const staleIds = tasks.filter((t) => t.stale).map((t) => t.id);
  return {
    tasks,
    staleCount: staleIds.length,
    staleIds,
    staleAfterDays: 183,
    evaluatedAt,
    ignoredFiles: [],
  };
}

export interface CellOptions {
  readonly outcome?: 'ok' | 'failed';
  readonly failureKind?: string;
  readonly wallClockMs?: number;
  readonly estimatedCostUsd?: number;
  readonly reportChars?: number;
}

export function cell(
  taskId: string,
  provider: string,
  repeat: number,
  options: CellOptions = {},
): CellRecord {
  const base = {
    key: cellKey({ taskId, provider, repeat }),
    taskId,
    provider,
    repeat,
    startedAt: '2026-07-27T00:00:00.000Z',
    finishedAt: '2026-07-27T00:10:00.000Z',
    wallClockMs: options.wallClockMs ?? 600_000,
    estimatedCostUsd: options.estimatedCostUsd ?? 2,
    runId: `run-${taskId}-${provider}-${String(repeat)}`,
  };
  if (options.outcome === 'failed') {
    return {
      ...base,
      outcome: 'failed',
      reason: 'the provider returned 429',
      ...(options.failureKind === undefined ? {} : { failureKind: options.failureKind }),
    };
  }
  return {
    ...base,
    outcome: 'ok',
    reportPath: `reports/${base.runId}.md`,
    reportChars: options.reportChars ?? 40_000,
    sourceCount: 12,
  };
}

export interface ScoredOptions extends CellOptions {
  readonly stale?: boolean;
  readonly registry?: RegistryCounts;
  readonly dating?: DatingCounts;
  readonly gaps?: readonly string[];
}

/**
 * A `ScoredCell` with one metric set and every other one honestly null.
 *
 * The tests that exercise aggregation and ranking do not want a real report;
 * they want a known value on a known coordinate. Everything not named is
 * `null` with a reason, which is also the shape those tests assert never turns
 * into a zero.
 */
export function scoredCell(
  taskId: string,
  provider: string,
  repeat: number,
  category: TaskCategory,
  values: Partial<Record<MetricId, number | null>>,
  options: ScoredOptions = {},
): ScoredCell {
  const record = cell(taskId, provider, repeat, options);
  const metrics = {} as Record<MetricId, number | null>;
  const unmeasured = {} as Record<MetricId, string>;
  for (const id of METRIC_IDS) {
    const given = values[id];
    metrics[id] = given ?? null;
    unmeasured[id] = given === undefined || given === null ? 'not measured in this fixture' : '';
  }
  return {
    key: record.key,
    taskId,
    provider,
    repeat,
    category,
    stale: options.stale ?? false,
    outcome: record.outcome,
    failureKind: record.outcome === 'failed' ? (options.failureKind ?? 'unclassified') : null,
    wallClockMs: record.wallClockMs,
    estimatedCostUsd: record.estimatedCostUsd,
    metrics,
    unmeasured,
    registry: options.registry ?? NO_REGISTRY,
    dating: options.dating ?? NO_DATING,
    evidence: 'absent',
    gaps: options.gaps ?? [],
  };
}
