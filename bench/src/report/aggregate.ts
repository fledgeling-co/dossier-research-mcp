import { TASK_CATEGORIES, type TaskCategory } from '../tasks/schema.js';
import type { TaskCorpus } from '../tasks/corpus.js';
import { METRIC_IDS, type MetricId } from './metrics.js';
import { MIN_REPETITIONS_FOR_SPREAD, TARGET_REPETITIONS } from '../run/cell.js';
import { summarise, type SampleUnit, type SpreadReport } from './spread.js';
import type { RegistryCounts, ScoredCell } from './harvest.js';

/**
 * Cells in, an aggregate out. Both refusal rules live here.
 *
 * **This file must never import `node:fs`.** See `metrics.ts`.
 *
 * Three stages, in this order, taken from FutureSearch's published practice of
 * averaging first within a task category and then across tasks, which is what
 * stops a large category dominating a backend's figure:
 *
 * 1. **Cell group**, one task on one backend, over its repetitions. The spread
 *    here is across repetitions and measures the backend's non-determinism.
 * 2. **Category group**, one backend in one category, over stage 1's medians.
 *    The spread here is across tasks and measures something else entirely, so
 *    the two are labelled rather than left to be confused.
 * 3. **Backend overall**, the median of stage 2's medians, over the *scorable*
 *    categories only, always carrying the list of the ones excluded and why.
 *
 * The refusals are computed here and carried, never recomputed by the renderer.
 * A renderer that re-derived "is this scorable" would be a second
 * implementation of the rule this whole slice exists to enforce.
 */

/**
 * Five tasks in a category before it is scored at all.
 *
 * A floor nobody can defend is a floor somebody will lower, so here is the
 * derivation. `docs/plan/benchmark.md` sets the per-category target at ten.
 * Five is half of it, and five is the smallest count at which a median has at
 * least two values on each side, so no single task can drag it across the
 * range. Configurable, and printed on every report, so a report generated
 * against a lower floor says so on its face.
 *
 * The BENCH-08 brief calls this "the configured minimum" without naming a
 * number, which is what makes it a decision recorded here rather than one
 * inherited.
 */
export const MIN_TASKS_PER_CATEGORY = 5;

/**
 * The share of attempted cells a backend must complete before its figure is a
 * number rather than the word `invalid`.
 *
 * Derived rather than picked, because a floor nobody can defend is a floor
 * somebody will lower. `docs/plan/benchmark.md` runs five repetitions per cell
 * and treats three as the floor at which a figure over them says anything, so a
 * backend completing fewer than three in five has, at the median cell, fallen
 * below the sample floor its own figure is printed against. Three fifths.
 *
 * It is a **third** floor, composed with the two BENCH-08 already enforces
 * rather than replacing either, and it is checked **last** of the four so that
 * neither of theirs changes behaviour: an under-sampled corpus is still named
 * as such, and a backend that completed too few distinct tasks is still
 * withheld separately, because those three have three different fixes.
 *
 * What it catches that neither of the others does: a backend that attempted
 * every task, completed enough distinct ones to clear the count floor, and
 * failed most of its attempts on the way. Its figure is then computed over
 * whichever repetitions happened to survive, which is the completion-rate
 * lesson applied to the numerator after BENCH-08 applied it to the denominator.
 * On this project `local-codex` was 0-for-3 and `openai` 0-for-2, and both of
 * those are caught by the nothing-completed arm; the backend at 40% with full
 * task coverage is the one that would otherwise be scored.
 */
export const MIN_COMPLETION_SHARE = MIN_REPETITIONS_FOR_SPREAD / TARGET_REPETITIONS;

export type ScorableVerdict =
  | { readonly scorable: true }
  | {
      readonly scorable: false;
      /**
       * `under-sampled-corpus` is a property of the suite: too few tasks exist,
       * and nobody can be scored. `under-sampled-completed` is a property of
       * this backend's run: enough tasks exist and it finished too few of them.
       * `under-completed` is a property of the *attempts*: enough distinct
       * tasks finished, and too large a share of the attempts behind them
       * failed, so the figure is computed over whichever ones survived. They
       * have different causes and different fixes, so they are never flattened
       * into one word.
       */
      readonly reason:
        | 'under-sampled-corpus'
        | 'under-sampled-completed'
        | 'under-completed'
        | 'nothing-completed';
      readonly why: string;
    };

/**
 * Whether the repetitions underneath a figure clear the spread floor.
 *
 * Carried up from stage 1, and it is the fix for the subtlest hole in a
 * two-stage aggregation. A backend run **once** per task still produces a
 * six-task spread at the category level, and that spread is real: it describes
 * how much the category varies. What it does not describe is the backend's
 * non-determinism, which is the thing repetitions exist to measure and the
 * thing `docs/plan/benchmark.md` means when it says a single run per cell is a
 * rank ordering of noise.
 *
 * So a category figure whose tasks were each run once is printed, with its
 * numbers, and **never ranked**. That is exactly the brief's headline case,
 * and without this field it would have passed silently: a plausible ranking
 * assembled from single runs, which is the failure this whole slice exists to
 * prevent, appearing in its own output.
 */
export interface RepetitionFloor {
  readonly met: boolean;
  /** The smallest completed repetition count behind any task in the figure. */
  readonly minRepetitions: number;
  readonly floor: number;
  readonly why: string;
}

export interface CompletionCounts {
  readonly attempted: number;
  readonly completed: number;
  readonly failed: number;
  /** `completed / attempted`, or null when nothing was attempted. */
  readonly rate: number | null;
  /** Failure kinds and their counts, so a rate limit is distinguishable from a bug. */
  readonly failureKinds: Readonly<Record<string, number>>;
}

/** Stage 1: one task on one backend. */
export interface TaskGroup {
  readonly taskId: string;
  readonly provider: string;
  readonly category: TaskCategory;
  readonly stale: boolean;
  readonly completion: CompletionCounts;
  /** Across repetitions. Null when nothing measured this metric. */
  readonly metrics: Readonly<Record<MetricId, SpreadReport | null>>;
  readonly costUsd: SpreadReport | null;
  readonly wallClockMs: SpreadReport | null;
  /**
   * What this task actually reserved, summed over its completed cells.
   *
   * A real sum rather than a median times a count. The two agree only when
   * every cell cost the same, and the figure a reader acts on is the money,
   * so an approximation of it that happens to be right in the uniform case is
   * the wrong shape for the one number nobody should have to check.
   */
  readonly totalCostUsd: number;
  readonly registry: RegistryCounts;
  /**
   * Which metric decides whether a repetition of this task passed.
   *
   * `refusal` where the task measured it, otherwise `accuracy`, and null where
   * neither was measurable. Carried rather than re-derived, so `pass@1` and
   * `pass^k` are computed over the same numbers the tables print.
   */
  readonly passMetric: MetricId | null;
  /**
   * That metric's value on each completed repetition that measured it.
   *
   * One entry per measurable repetition, never one per requested repetition. A
   * completed repetition that measured nothing is an absence, and counting it
   * as a failed attempt would score an absence as a zero, which every other
   * layer of this read side refuses.
   */
  readonly passValues: readonly number[];
}

/** Stage 2: one backend in one category. */
export interface CategoryGroup {
  readonly provider: string;
  readonly category: TaskCategory;
  /** Tasks in the corpus for this category, regardless of who ran them. */
  readonly tasksInCorpus: number;
  /** Tasks this backend completed at least one repetition of. */
  readonly tasksCompleted: number;
  readonly staleTasks: number;
  readonly completion: CompletionCounts;
  readonly verdict: ScorableVerdict;
  /** Whether the repetitions behind this figure clear the spread floor. */
  readonly repetitionFloor: RepetitionFloor;
  /** Across tasks. Populated even when the verdict withholds, so JSON keeps it. */
  readonly metrics: Readonly<Record<MetricId, SpreadReport | null>>;
  readonly costUsd: SpreadReport | null;
  readonly wallClockMs: SpreadReport | null;
  readonly totalCostUsd: number;
  readonly registry: RegistryCounts;
}

/** Stage 3: one backend, over the categories it may be scored in. */
export interface BackendSummary {
  readonly provider: string;
  readonly completion: CompletionCounts;
  readonly scorableCategories: readonly TaskCategory[];
  readonly excludedCategories: readonly { readonly category: TaskCategory; readonly why: string }[];
  readonly repetitionFloor: RepetitionFloor;
  readonly metrics: Readonly<Record<MetricId, SpreadReport | null>>;
  readonly costUsd: SpreadReport | null;
  readonly wallClockMs: SpreadReport | null;
  readonly totalCostUsd: number;
  readonly registry: RegistryCounts;
}

export interface CorpusFacts {
  readonly tasks: number;
  readonly staleTasks: number;
  /** `staleTasks / tasks`, or null on an empty corpus. */
  readonly staleShare: number | null;
  readonly staleAfterDays: number;
  readonly staleIds: readonly string[];
  readonly evaluatedAt: string;
  /** Tasks per category, from the corpus rather than from what ran. */
  readonly tasksByCategory: Readonly<Record<TaskCategory, number>>;
}

export interface BenchAggregate {
  readonly corpus: CorpusFacts;
  readonly minTasksPerCategory: number;
  /** The completion share below which a figure renders invalid. Printed, always. */
  readonly minCompletionShare: number;
  readonly providers: readonly string[];
  readonly taskGroups: readonly TaskGroup[];
  readonly categoryGroups: readonly CategoryGroup[];
  readonly backends: readonly BackendSummary[];
  /** Categories no backend may be scored in, with the corpus count that decided it. */
  readonly underSampledCategories: readonly {
    readonly category: TaskCategory;
    readonly tasksInCorpus: number;
  }[];
  readonly overall: CompletionCounts;
  readonly registry: RegistryCounts;
  /** Cells whose stored report or snapshot was missing. Ours, not a backend's. */
  readonly pipelineGaps: readonly string[];
  /** Cells naming a task that is not in the corpus. Counted, never silently dropped. */
  readonly orphanCells: readonly string[];
}

export interface AggregateInput {
  readonly cells: readonly ScoredCell[];
  readonly corpus: TaskCorpus;
  readonly minTasksPerCategory?: number | undefined;
  /**
   * The share of attempted cells a backend must complete before its figure in a
   * scope is a number. Defaults to `MIN_COMPLETION_SHARE`.
   */
  readonly minCompletionShare?: number | undefined;
  /**
   * Cell keys the caller could not harvest because the corpus no longer holds
   * their task.
   *
   * Passed in rather than invented. A `ScoredCell` needs a category and a
   * staleness flag, both of which come from the task, so a caller that met an
   * orphan cannot honestly construct one; fabricating a category to get it into
   * the list would put a wrong value in the store's own output. The keys travel
   * on their own and are reported as orphans.
   */
  readonly orphanCells?: readonly string[] | undefined;
}

const EMPTY_REGISTRY: RegistryCounts = { present: 0, absent: 0, unchecked: 0, invalid: 0 };

/**
 * The key two coordinates are grouped under.
 *
 * A task id is a slug, a provider id is an enum member and a category is one of
 * ten fixed words, so none of them can contain a `/`. The same reasoning, and
 * the same separator, as `cellKey` in `bench/src/run/cell.ts`: a key two
 * different groups can collide on is two backends silently averaged together.
 */
function groupKey(a: string, b: string): string {
  return `${a}/${b}`;
}

function addRegistry(a: RegistryCounts, b: RegistryCounts): RegistryCounts {
  return {
    present: a.present + b.present,
    absent: a.absent + b.absent,
    unchecked: a.unchecked + b.unchecked,
    invalid: a.invalid + b.invalid,
  };
}

/** The unchecked share of every identifier that was looked at. Null when none was. */
export function uncheckedShare(counts: RegistryCounts): number | null {
  const total = counts.present + counts.absent + counts.unchecked + counts.invalid;
  return total === 0 ? null : counts.unchecked / total;
}

function completion(cells: readonly ScoredCell[]): CompletionCounts {
  const failureKinds: Record<string, number> = {};
  let completed = 0;
  for (const cell of cells) {
    if (cell.outcome === 'ok') {
      completed += 1;
      continue;
    }
    const kind = cell.failureKind ?? 'unclassified';
    failureKinds[kind] = (failureKinds[kind] ?? 0) + 1;
  }
  return {
    attempted: cells.length,
    completed,
    failed: cells.length - completed,
    rate: cells.length === 0 ? null : completed / cells.length,
    failureKinds,
  };
}

function mergeCompletion(parts: readonly CompletionCounts[]): CompletionCounts {
  const failureKinds: Record<string, number> = {};
  let attempted = 0;
  let completed = 0;
  for (const part of parts) {
    attempted += part.attempted;
    completed += part.completed;
    for (const [kind, count] of Object.entries(part.failureKinds)) {
      failureKinds[kind] = (failureKinds[kind] ?? 0) + count;
    }
  }
  return {
    attempted,
    completed,
    failed: attempted - completed,
    rate: attempted === 0 ? null : completed / attempted,
    failureKinds,
  };
}

/**
 * Summarise one metric over a set of values, dropping the ones never measured.
 *
 * `completed` is passed separately and is what the spread floor is judged on.
 * A metric five completed cells could have measured and only two did has two
 * values and five completions, and quoting a five-sample spread from it would
 * be the same fabrication as counting a deduped run five times.
 */
function metricOver(
  values: readonly (number | null)[],
  completed: number,
  unit: SampleUnit,
): SpreadReport | null {
  const measured = values.filter((v): v is number => v !== null);
  return summarise(measured, completed, unit);
}

function emptyMetrics(): Record<MetricId, SpreadReport | null> {
  const out = {} as Record<MetricId, SpreadReport | null>;
  for (const id of METRIC_IDS) out[id] = null;
  return out;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket === undefined) map.set(k, [item]);
    else bucket.push(item);
  }
  return map;
}

/**
 * Which metric decides a pass on this task, and its value per repetition.
 *
 * Refusal first, because on a false-premise or obscure-entity task the correct
 * answer is not an answer and accuracy is not applicable there at all. Accuracy
 * otherwise. Neither measurable leaves the task out of the reliability figures,
 * with the exclusion named rather than the task counted as a failure.
 */
function passSeries(ok: readonly ScoredCell[]): {
  metric: MetricId | null;
  values: readonly number[];
} {
  for (const metric of ['refusal', 'accuracy'] as const) {
    const values = ok.map((c) => c.metrics[metric]).filter((v): v is number => v !== null);
    if (values.length > 0) return { metric, values };
  }
  return { metric: null, values: [] };
}

/**
 * Stage 1: one task on one backend, over its repetitions.
 */
function buildTaskGroups(cells: readonly ScoredCell[]): TaskGroup[] {
  const groups: TaskGroup[] = [];
  for (const bucket of groupBy(cells, (c) => groupKey(c.taskId, c.provider)).values()) {
    const first = bucket[0];
    if (first === undefined) continue;
    const counts = completion(bucket);
    const ok = bucket.filter((c) => c.outcome === 'ok');

    const metrics = emptyMetrics();
    for (const id of METRIC_IDS) {
      metrics[id] = metricOver(
        ok.map((c) => c.metrics[id]),
        counts.completed,
        'repetition',
      );
    }

    let registry = EMPTY_REGISTRY;
    for (const cell of bucket) registry = addRegistry(registry, cell.registry);
    const pass = passSeries(ok);

    groups.push({
      taskId: first.taskId,
      provider: first.provider,
      category: first.category,
      stale: first.stale,
      completion: counts,
      metrics,
      // Cost and wall clock are taken over the cells that completed. A cell
      // that failed at the provider still cost wall clock and may have cost
      // money, but a median that mixed a 4-second refusal with a 20-minute
      // report would describe neither.
      costUsd: summarise(
        ok.map((c) => c.estimatedCostUsd),
        counts.completed,
        'repetition',
      ),
      wallClockMs: summarise(
        ok.map((c) => c.wallClockMs),
        counts.completed,
        'repetition',
      ),
      // Summed over every recorded cell, failures included. A cell that failed
      // after the ledger reserved has already cost money, and a total that
      // counted only the successful ones would under-report the bill in
      // exactly the case an operator cares about.
      totalCostUsd: Number(
        bucket.reduce((sum, c) => sum + c.estimatedCostUsd, 0).toFixed(4),
      ),
      registry,
      passMetric: pass.metric,
      passValues: pass.values,
    });
  }
  groups.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.provider.localeCompare(b.provider));
  return groups;
}

/**
 * The weakest repetition count behind a figure decides whether it may be ranked.
 *
 * The MINIMUM rather than the median, because one task run once is enough to
 * make the whole figure partly an ordering of noise, and a rule that averaged
 * that away would be a rule that only bites when it does not matter.
 */
function repetitionFloor(
  completedPerTask: readonly number[],
  scopeLabel: string,
): RepetitionFloor {
  const floor = MIN_REPETITIONS_FOR_SPREAD;
  if (completedPerTask.length === 0) {
    return {
      met: false,
      minRepetitions: 0,
      floor,
      why: `nothing completed in ${scopeLabel}, so there are no repetitions to judge`,
    };
  }
  const minRepetitions = Math.min(...completedPerTask);
  if (minRepetitions >= floor) {
    return {
      met: true,
      minRepetitions,
      floor,
      why: `every task in ${scopeLabel} completed at least ${String(minRepetitions)} repetitions`,
    };
  }
  return {
    met: false,
    minRepetitions,
    floor,
    why:
      `at least one task in ${scopeLabel} completed only ${String(minRepetitions)} repetition${minRepetitions === 1 ? '' : 's'}, ` +
      `below the floor of ${String(floor)}. The figure is printed; it is not ranked, because a spread across tasks says nothing about how much this backend varies between runs of the same task.`,
  };
}

function verdictFor(
  tasksInCorpus: number,
  tasksCompleted: number,
  minTasks: number,
  provider: string,
  category: TaskCategory,
  completionRate: number | null,
  minCompletionShare: number,
): ScorableVerdict {
  if (tasksInCorpus < minTasks) {
    return {
      scorable: false,
      reason: 'under-sampled-corpus',
      why:
        `the corpus holds ${String(tasksInCorpus)} ${category} task${tasksInCorpus === 1 ? '' : 's'}, ` +
        `below the floor of ${String(minTasks)}. No backend is scored in this category; the fix is authoring tasks, not re-running.`,
    };
  }
  if (tasksCompleted === 0) {
    return {
      scorable: false,
      reason: 'nothing-completed',
      why: `${provider} completed no ${category} task, so there is nothing to score.`,
    };
  }
  if (tasksCompleted < minTasks) {
    return {
      scorable: false,
      reason: 'under-sampled-completed',
      why:
        `${provider} completed ${String(tasksCompleted)} of the ${String(tasksInCorpus)} ${category} tasks, ` +
        `below the floor of ${String(minTasks)}. Scoring it here would grade it on whichever tasks it happened to finish; the fix is re-running the failed cells.`,
    };
  }
  // Last, because it is the narrowest of the four and BENCH-08's two floors
  // keep their existing behaviour exactly. This one catches what neither of
  // them can see: a backend that finished enough distinct tasks to clear the
  // count floor and failed most of its attempts getting there, so its figure is
  // computed over whichever repetitions survived.
  if (completionRate !== null && completionRate < minCompletionShare) {
    return {
      scorable: false,
      reason: 'under-completed',
      why:
        `${provider} completed ${percent(completionRate)} of its attempted ${category} cells, ` +
        `below the floor of ${percent(minCompletionShare)}. The score is rendered invalid rather than as a number: ` +
        `a figure computed over whichever attempts survived describes the attempts that survived, and a backend that fails its hard cells and is scored on the rest is a benchmark rewarding giving up.`,
    };
  }
  return { scorable: true };
}

/** One decimal place, so a floor of 0.6 reads as 60.0% rather than as 0.6. */
function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Stage 2: one backend in one category, over stage 1's medians.
 */
function buildCategoryGroups(
  taskGroups: readonly TaskGroup[],
  providers: readonly string[],
  tasksByCategory: Readonly<Record<TaskCategory, number>>,
  staleByCategory: Readonly<Record<TaskCategory, number>>,
  minTasks: number,
  minCompletionShare: number,
): CategoryGroup[] {
  const byKey = groupBy(taskGroups, (g) => groupKey(g.provider, g.category));
  const groups: CategoryGroup[] = [];

  // Every provider is crossed with every category that exists in the corpus,
  // rather than only with the ones it has cells for. A category a backend never
  // touched must appear as untouched; dropping it would make a backend that
  // skipped a whole category look identical to one that never faced it.
  for (const provider of providers) {
    for (const category of TASK_CATEGORIES) {
      const tasksInCorpus = tasksByCategory[category];
      if (tasksInCorpus === 0) continue;
      const bucket = byKey.get(groupKey(provider, category)) ?? [];
      const counts = mergeCompletion(bucket.map((g) => g.completion));
      const scored = bucket.filter((g) => g.completion.completed > 0);
      const tasksCompleted = scored.length;

      const metrics = emptyMetrics();
      for (const id of METRIC_IDS) {
        metrics[id] = metricOver(
          scored.map((g) => g.metrics[id]?.median ?? null),
          tasksCompleted,
          'task',
        );
      }

      let registry = EMPTY_REGISTRY;
      let totalCostUsd = 0;
      for (const group of bucket) {
        registry = addRegistry(registry, group.registry);
        totalCostUsd += group.totalCostUsd;
      }

      groups.push({
        provider,
        category,
        tasksInCorpus,
        tasksCompleted,
        staleTasks: staleByCategory[category],
        completion: counts,
        verdict: verdictFor(
          tasksInCorpus,
          tasksCompleted,
          minTasks,
          provider,
          category,
          counts.rate,
          minCompletionShare,
        ),
        repetitionFloor: repetitionFloor(
          scored.map((g) => g.completion.completed),
          `${provider}'s ${category} tasks`,
        ),
        metrics,
        costUsd: metricOver(
          scored.map((g) => g.costUsd?.median ?? null),
          tasksCompleted,
          'task',
        ),
        wallClockMs: metricOver(
          scored.map((g) => g.wallClockMs?.median ?? null),
          tasksCompleted,
          'task',
        ),
        totalCostUsd: Number(totalCostUsd.toFixed(4)),
        registry,
      });
    }
  }
  return groups;
}

/**
 * Stage 3: one backend, over the categories it may be scored in.
 *
 * Only the scorable ones contribute, and the excluded ones are named on the
 * result. An overall figure that quietly folded in an under-sampled category
 * would be the under-sample rule enforced in one table and abandoned in the
 * next one down the page.
 */
function buildBackends(
  categoryGroups: readonly CategoryGroup[],
  providers: readonly string[],
): BackendSummary[] {
  return providers.map((provider) => {
    const mine = categoryGroups.filter((g) => g.provider === provider);
    const scorable = mine.filter((g) => g.verdict.scorable);
    const excluded = mine
      .filter((g) => !g.verdict.scorable)
      .map((g) => ({ category: g.category, why: g.verdict.scorable ? '' : g.verdict.why }));

    const metrics = emptyMetrics();
    for (const id of METRIC_IDS) {
      metrics[id] = metricOver(
        scorable.map((g) => g.metrics[id]?.median ?? null),
        scorable.length,
        'category',
      );
    }

    let registry = EMPTY_REGISTRY;
    let totalCostUsd = 0;
    for (const group of mine) {
      registry = addRegistry(registry, group.registry);
      totalCostUsd += group.totalCostUsd;
    }

    return {
      provider,
      completion: mergeCompletion(mine.map((g) => g.completion)),
      scorableCategories: scorable.map((g) => g.category),
      excludedCategories: excluded,
      repetitionFloor: repetitionFloor(
        scorable.map((g) => g.repetitionFloor.minRepetitions),
        `${provider}'s scorable categories`,
      ),
      metrics,
      // Cost and wall clock are taken over EVERY category, not only the
      // scorable ones. A price is a fact about what was spent; withholding it
      // because a category is under-sampled would hide the money actually paid.
      costUsd: metricOver(
        mine.map((g) => g.costUsd?.median ?? null),
        mine.filter((g) => g.completion.completed > 0).length,
        'category',
      ),
      wallClockMs: metricOver(
        mine.map((g) => g.wallClockMs?.median ?? null),
        mine.filter((g) => g.completion.completed > 0).length,
        'category',
      ),
      totalCostUsd: Number(totalCostUsd.toFixed(4)),
      registry,
    };
  });
}

/**
 * Everything a report needs, computed once.
 *
 * Deterministic in ordering as well as in value: providers, categories and
 * tasks all sort, so two runs over the same store render byte-identically.
 */
export function aggregate(input: AggregateInput): BenchAggregate {
  const minTasksPerCategory = input.minTasksPerCategory ?? MIN_TASKS_PER_CATEGORY;
  if (!Number.isInteger(minTasksPerCategory) || minTasksPerCategory < 1) {
    throw new TypeError(
      `the minimum tasks per category must be a positive integer; received ${String(minTasksPerCategory)}`,
    );
  }
  const minCompletionShare = input.minCompletionShare ?? MIN_COMPLETION_SHARE;
  if (!Number.isFinite(minCompletionShare) || minCompletionShare <= 0 || minCompletionShare > 1) {
    throw new TypeError(
      `the minimum completion share must be a number in (0, 1]; received ${String(minCompletionShare)}`,
    );
  }

  const tasksByCategory = {} as Record<TaskCategory, number>;
  const staleByCategory = {} as Record<TaskCategory, number>;
  for (const category of TASK_CATEGORIES) {
    tasksByCategory[category] = 0;
    staleByCategory[category] = 0;
  }
  const knownTasks = new Set<string>();
  for (const task of input.corpus.tasks) {
    knownTasks.add(task.id);
    tasksByCategory[task.category] += 1;
    if (task.stale) staleByCategory[task.category] += 1;
  }

  // A cell naming a task the corpus does not hold is counted and named rather
  // than dropped. It means the corpus moved under a stored result, and a
  // silently narrower denominator is the exact failure the loader already
  // refuses at the other end of the pipeline.
  const orphanCells = [
    ...new Set([
      ...input.cells.filter((c) => !knownTasks.has(c.taskId)).map((c) => c.key),
      ...(input.orphanCells ?? []),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  const cells = input.cells.filter((c) => knownTasks.has(c.taskId));

  const providers = [...new Set(cells.map((c) => c.provider))].sort((a, b) => a.localeCompare(b));
  const taskGroups = buildTaskGroups(cells);
  const categoryGroups = buildCategoryGroups(
    taskGroups,
    providers,
    tasksByCategory,
    staleByCategory,
    minTasksPerCategory,
    minCompletionShare,
  );
  const backends = buildBackends(categoryGroups, providers);

  let registry = EMPTY_REGISTRY;
  for (const cell of cells) registry = addRegistry(registry, cell.registry);

  const underSampledCategories = TASK_CATEGORIES.filter(
    (c) => tasksByCategory[c] > 0 && tasksByCategory[c] < minTasksPerCategory,
  ).map((category) => ({ category, tasksInCorpus: tasksByCategory[category] }));

  const pipelineGaps = [...new Set(cells.flatMap((c) => c.gaps))].sort((a, b) => a.localeCompare(b));

  return {
    corpus: {
      tasks: input.corpus.tasks.length,
      staleTasks: input.corpus.staleCount,
      staleShare:
        input.corpus.tasks.length === 0
          ? null
          : input.corpus.staleCount / input.corpus.tasks.length,
      staleAfterDays: input.corpus.staleAfterDays,
      staleIds: input.corpus.staleIds,
      evaluatedAt: input.corpus.evaluatedAt,
      tasksByCategory,
    },
    minTasksPerCategory,
    minCompletionShare,
    providers,
    taskGroups,
    categoryGroups,
    backends,
    underSampledCategories,
    overall: completion(cells),
    registry,
    pipelineGaps,
    orphanCells,
  };
}
