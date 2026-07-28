import { TASK_CATEGORIES, type TaskCategory } from '../tasks/schema.js';
import { isRankable, metricDescriptor, metricsOfFamily, type MetricId } from './metrics.js';
import type { BenchAggregate, CategoryGroup, TaskGroup } from './aggregate.js';
import type { RankScope, SeparationVerdict, WithheldReason } from './rank.js';
import {
  NO_MEASURED_DIFFERENCE,
  pairedDifference,
  passRates,
  type PairedDifference,
  type PairedWithheld,
  type ReliabilityReport,
  type TaskValue,
} from '../stats/index.js';

/**
 * The join between the aggregate and the statistics.
 *
 * **This file must never import `node:fs`.** See `metrics.ts`.
 *
 * The whole design of this module is one instruction: **extend BENCH-08, do not
 * build beside it.** So a comparison runs only where the aggregate already says
 * a figure may be quoted, using the same three gates and the same reason
 * vocabulary, and the numbers it pairs are stage 1's medians, which are the
 * numbers the tables print. Two different answers to "can this sample support a
 * claim" in one codebase is worse than either.
 *
 * What is genuinely new is the **fourth** gate, which is the one this slice
 * exists for: even where all three of BENCH-08's gates pass, a difference whose
 * bootstrap interval crosses zero is `no measured difference` rather than a
 * smaller number a reader will rank anyway.
 */

/** Everything a comparison can be refused for, from either side of the join. */
export type ComparisonWithheld = WithheldReason | PairedWithheld;

export interface Comparison {
  readonly metric: MetricId;
  readonly scope: RankScope;
  /** Sorted, so `a` and `b` are stable and the sign of the difference is too. */
  readonly a: string;
  readonly b: string;
  /** Null when a gate refused the comparison before any pairing happened. */
  readonly result: PairedDifference | null;
  readonly withheld: ComparisonWithheld | null;
  readonly note: string;
}

export interface ComparisonSummary {
  /** Every metric, scope and backend pair the aggregate could enumerate. */
  readonly pairs: number;
  /** Those that reached a bootstrap. */
  readonly ran: number;
  readonly measured: number;
  readonly noMeasuredDifference: number;
  readonly withheld: number;
  /** Counts by reason, so a reader can see which gate did the refusing. */
  readonly withheldBy: Readonly<Record<string, number>>;
  /** One sentence, and at zero it says so plainly. */
  readonly sentence: string;
}

/**
 * The separator between two provider ids in the lookup key.
 *
 * Printable, and named for the same reason `bench/src/stats/random.ts` names
 * its own: the obvious choice for a character no provider id can contain is a
 * NUL, and a NUL in a string literal shipped in v0.2.1, made the file binary to
 * git and made it invisible to grep. A provider id is an enum member, so a pipe
 * separates two of them just as well and leaves the file readable.
 */
const PAIR_SEPARATOR = '|';

function scopeKey(scope: RankScope): string {
  return scope.kind === 'overall' ? 'overall' : scope.category;
}

function scopeName(scope: RankScope): string {
  return scope.kind === 'overall' ? 'overall' : `the ${scope.category} category`;
}

interface Candidate {
  readonly provider: string;
  readonly scorable: boolean;
  readonly why: string;
  readonly repetitionsMet: boolean;
  readonly repetitionsWhy: string;
  /** Categories this backend may be scored in, which bound an overall pairing. */
  readonly scorableCategories: ReadonlySet<TaskCategory>;
}

function candidates(agg: BenchAggregate, scope: RankScope): readonly Candidate[] {
  if (scope.kind === 'overall') {
    return agg.backends.map((b) => ({
      provider: b.provider,
      scorable: b.scorableCategories.length > 0,
      why: `${b.provider} has no scorable category, so it has no overall figure to compare`,
      repetitionsMet: b.repetitionFloor.met,
      repetitionsWhy: b.repetitionFloor.why,
      scorableCategories: new Set(b.scorableCategories),
    }));
  }
  const category = scope.category;
  return agg.categoryGroups
    .filter((g: CategoryGroup) => g.category === category)
    .map((g) => ({
      provider: g.provider,
      scorable: g.verdict.scorable,
      why: g.verdict.scorable ? '' : g.verdict.why,
      repetitionsMet: g.repetitionFloor.met,
      repetitionsWhy: g.repetitionFloor.why,
      scorableCategories: new Set<TaskCategory>(g.verdict.scorable ? [category] : []),
    }));
}

/**
 * The per-task figures one backend brings to a pairing.
 *
 * Stage 1's median over repetitions, which is the number the tables print.
 * Restricted to the categories the scope admits, so an overall comparison is
 * taken over exactly the categories the overall figure is taken over rather
 * than over a wider set that would make the two disagree.
 */
function taskValues(
  taskGroups: readonly TaskGroup[],
  provider: string,
  metric: MetricId,
  allowed: ReadonlySet<TaskCategory>,
): readonly TaskValue[] {
  const out: TaskValue[] = [];
  for (const group of taskGroups) {
    if (group.provider !== provider) continue;
    if (!allowed.has(group.category)) continue;
    const value = group.metrics[metric]?.median;
    if (value === undefined) continue;
    out.push({ taskId: group.taskId, cluster: group.category, value });
  }
  return out;
}

function withheldComparison(
  metric: MetricId,
  scope: RankScope,
  a: string,
  b: string,
  reason: ComparisonWithheld,
  note: string,
): Comparison {
  return { metric, scope, a, b, result: null, withheld: reason, note };
}

/**
 * Every pairwise comparison the aggregate can support, and every one it cannot.
 *
 * Emitted in a stable order: registry metric order, then overall before the
 * categories in their own fixed order, then backend pairs sorted by name. Two
 * renders of one store produce the same list in the same order, which is what
 * makes a diff between two runs readable.
 */
export function comparisons(agg: BenchAggregate): readonly Comparison[] {
  const out: Comparison[] = [];
  const scopes: RankScope[] = [
    { kind: 'overall' },
    ...TASK_CATEGORIES.filter((c) => agg.corpus.tasksByCategory[c] > 0).map(
      (category): RankScope => ({ kind: 'category', category }),
    ),
  ];

  for (const descriptor of metricsOfFamily('quality')) {
    const metric = descriptor.id;
    for (const scope of scopes) {
      // Gate 1, the metric. A count is never ordered and never differenced.
      if (!isRankable(metric)) continue;

      // Gate 2, the scope. Identical to `rank.ts`'s second condition, read off
      // the same corpus counts rather than re-derived from what happened to run.
      const scopeScorable =
        scope.kind === 'overall'
          ? agg.backends.some((b) => b.scorableCategories.length > 0)
          : agg.corpus.tasksByCategory[scope.category] >= agg.minTasksPerCategory;

      const list = [...candidates(agg, scope)].sort((x, y) =>
        x.provider.localeCompare(y.provider),
      );
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const a = list[i];
          const b = list[j];
          if (a === undefined || b === undefined) continue;

          if (!scopeScorable) {
            out.push(
              withheldComparison(
                metric,
                scope,
                a.provider,
                b.provider,
                'scope-not-scorable',
                `${scopeName(scope)} holds too few tasks to be scored, so there is nothing to compare in it.`,
              ),
            );
            continue;
          }
          // Gate 3, both candidates. A backend whose figure is withheld is not
          // one half of a difference.
          const blocked = [a, b].filter((c) => !c.scorable);
          if (blocked.length > 0) {
            out.push(
              withheldComparison(
                metric,
                scope,
                a.provider,
                b.provider,
                'scope-not-scorable',
                blocked.map((c) => c.why).join(' '),
              ),
            );
            continue;
          }
          const thin = [a, b].filter((c) => !c.repetitionsMet);
          if (thin.length > 0) {
            out.push(
              withheldComparison(
                metric,
                scope,
                a.provider,
                b.provider,
                'sample-below-spread-floor',
                thin.map((c) => `${c.provider}: ${c.repetitionsWhy}`).join(' '),
              ),
            );
            continue;
          }

          // Only categories BOTH may be scored in enter an overall pairing, so
          // the comparison is taken over the same set the overall figure is.
          const allowed = new Set(
            [...a.scorableCategories].filter((c) => b.scorableCategories.has(c)),
          );
          const result = pairedDifference({
            a: a.provider,
            b: b.provider,
            aValues: taskValues(agg.taskGroups, a.provider, metric, allowed),
            bValues: taskValues(agg.taskGroups, b.provider, metric, allowed),
            direction: descriptor.direction === 'lower' ? 'lower' : 'higher',
            bootstrap: { seedParts: [metric, scopeKey(scope), a.provider, b.provider] },
          });

          out.push({
            metric,
            scope,
            a: a.provider,
            b: b.provider,
            result,
            withheld:
              result.verdict === 'measured' || result.verdict === 'no-measured-difference'
                ? null
                : result.verdict,
            note: result.summary,
          });
        }
      }
    }
  }
  return out;
}

/** The headline: how much of this corpus can actually tell two backends apart. */
export function comparisonSummary(list: readonly Comparison[]): ComparisonSummary {
  const withheldBy: Record<string, number> = {};
  let ran = 0;
  let measured = 0;
  let none = 0;
  let withheld = 0;
  for (const c of list) {
    if (c.withheld !== null) {
      withheld += 1;
      withheldBy[c.withheld] = (withheldBy[c.withheld] ?? 0) + 1;
      continue;
    }
    ran += 1;
    if (c.result?.verdict === 'measured') measured += 1;
    else none += 1;
  }

  const sentence =
    list.length === 0
      ? 'No two backends could even be lined up against each other on this corpus, because nothing was recorded for two of them on one metric in one scope.'
      : measured === 0
        ? `**Almost nothing here is distinguishable yet.** Of ${String(list.length)} possible pairwise comparisons, ${String(ran)} could be run and **none produced a measured difference**: every interval that could be computed contains zero, or the sample was refused before one could be. That is the correct answer for a corpus this size rather than a fault in the method, and the fix is authoring tasks, not loosening the statistics.`
        : `Of ${String(list.length)} possible pairwise comparisons, ${String(ran)} could be run and **${String(measured)} produced a measured difference**; ${String(none)} came back as ${NO_MEASURED_DIFFERENCE} and ${String(withheld)} were refused before an interval could be computed.`;

  return { pairs: list.length, ran, measured, noMeasuredDifference: none, withheld, withheldBy, sentence };
}

/**
 * `pass@1` and `pass^k` per backend, over the whole corpus.
 *
 * Not per category: at three repetitions a per-category `pass^k` over one or
 * two tasks takes two or three values, and a column of those would look like a
 * measurement. Reported once per backend, with `k` and the threshold beside it.
 */
export function reliability(agg: BenchAggregate): readonly ReliabilityReport[] {
  return agg.providers.map((provider) =>
    passRates({
      provider,
      tasks: agg.taskGroups
        .filter((g) => g.provider === provider)
        .map((g) => ({
          taskId: g.taskId,
          metric: g.passMetric ?? 'none',
          values: g.passValues,
        })),
    }),
  );
}

/**
 * The separation oracle `rank.ts` consults before falling back to overlap.
 *
 * This is the sentence in `docs/bench/reporting.md` that said the overlap check
 * was "the cheapest honest thing available before they land", made obsolete by
 * them landing. Where a paired interval exists it decides; where it does not,
 * `rank.ts` keeps the interquartile check, because something is better than
 * declaring every pair incomparable.
 */
export function separatorFor(
  list: readonly Comparison[],
  metric: MetricId,
  scope: RankScope,
): (a: string, b: string) => SeparationVerdict | null {
  const index = new Map<string, Comparison>();
  for (const c of list) {
    if (c.metric !== metric) continue;
    if (scopeKey(c.scope) !== scopeKey(scope)) continue;
    index.set(`${c.a}${PAIR_SEPARATOR}${c.b}`, c);
  }
  return (a, b) => {
    const found =
      index.get(`${a}${PAIR_SEPARATOR}${b}`) ?? index.get(`${b}${PAIR_SEPARATOR}${a}`);
    if (found === undefined || found.result === null) return null;
    if (found.result.verdict === 'measured') return 'separated';
    if (found.result.verdict === 'no-measured-difference') return 'tied';
    return null;
  };
}

/** The descriptor, re-exported so a renderer does not import two modules for one row. */
export { metricDescriptor };
