import { spreadEligibility, type SpreadEligibility } from '../run/cell.js';

/**
 * `pass@1` beside `pass^k`, which are two different products.
 *
 * **This file must never import `node:fs`.** See `random.ts`.
 *
 * `pass@1` is what a user gets on one attempt. `pass^k` is whether the backend
 * gets it right **every** time out of k, which is the number that matters for
 * anything run unattended. A backend with high `pass@1` and low `pass^k` is one
 * that sometimes works, and reporting only the first sells it as one that does:
 * the prior art's headline case is tau-bench, where agents at 61% pass@1 collapse
 * to 25% pass@8, and a separate measurement of the same family at 60% pass@1
 * shows 25% consistency across trials. Those are not small corrections.
 *
 * The floor is `spreadEligibility`, imported from `bench/src/run/cell.ts` and
 * never restated. The brief asks for `k >= 3` and the design already sets three
 * as the floor at which a figure over repetitions says anything; they are the
 * same number and this file makes them the same constant, so a change to one
 * cannot leave the other behind.
 *
 * The floor is taken over the **weakest** task, exactly as
 * `bench/src/report/aggregate.ts` takes its repetition floor, because one task
 * run twice is enough to make a suite-wide `pass^k` partly a `pass^2`, and a
 * rule that averaged that away would only bite when it did not matter.
 */

/** The value at or above which a repetition counts as a pass. */
export const DEFAULT_PASS_THRESHOLD = 1;

/**
 * One task's attempts on one backend.
 *
 * `values` holds one entry per completed repetition **whose primary metric was
 * measurable**. A completed repetition that measured nothing is not a fail; it
 * is an absence, and scoring an absence as a zero is the failure this whole
 * read side refuses at every other layer.
 */
export interface TaskAttempts {
  readonly taskId: string;
  /** Which metric decided pass for this task, carried so the column can say. */
  readonly metric: string;
  readonly values: readonly number[];
}

export interface ReliabilityInput {
  readonly provider: string;
  readonly tasks: readonly TaskAttempts[];
  /** Defaults to 1. A partly-right answer is not something you rely on unattended. */
  readonly threshold?: number | undefined;
}

export interface ReliabilityReport {
  readonly provider: string;
  readonly threshold: number;
  /** The metrics that decided pass, deduplicated and sorted. Usually one or two. */
  readonly metrics: readonly string[];
  readonly tasksCounted: number;
  /** Tasks with no measurable repetition, named rather than dropped. */
  readonly tasksExcluded: readonly { readonly taskId: string; readonly why: string }[];
  readonly repetitions: number;
  readonly passingRepetitions: number;
  /** Share of single attempts that pass. Null when nothing was measurable. */
  readonly passAt1: number | null;
  /**
   * Share of tasks that passed on **every** repetition.
   *
   * Null below the floor, with `kWithheld` carrying the floor's own sentence.
   */
  readonly passHatK: number | null;
  /** The weakest task's repetition count, which is the `k` the figure is quoted at. */
  readonly k: number;
  readonly eligibility: SpreadEligibility;
  /** Empty when `passHatK` is present. */
  readonly kWithheld: string;
}

/**
 * `pass@1` and `pass^k` for one backend.
 *
 * `pass@1` is the share of individual attempts that pass, pooled over every
 * task with a measurable repetition, which is the probability a single random
 * attempt succeeds. `pass^k` is the share of tasks where every measurable
 * repetition passed.
 */
export function passRates(input: ReliabilityInput): ReliabilityReport {
  const threshold = input.threshold ?? DEFAULT_PASS_THRESHOLD;
  if (!Number.isFinite(threshold)) {
    throw new TypeError(`the pass threshold must be finite; received ${String(threshold)}`);
  }

  const counted: TaskAttempts[] = [];
  const tasksExcluded: { taskId: string; why: string }[] = [];
  for (const task of input.tasks) {
    for (const v of task.values) {
      if (!Number.isFinite(v)) {
        throw new TypeError(
          `task "${task.taskId}" carries a non-finite value; an unmeasured repetition must be absent from \`values\`, never present as a NaN, or it becomes a silent fail`,
        );
      }
    }
    if (task.values.length === 0) {
      tasksExcluded.push({
        taskId: task.taskId,
        why: `no repetition of ${task.taskId} measured ${task.metric}, so it has no pass to count. An unmeasured attempt is not a failed one.`,
      });
      continue;
    }
    counted.push(task);
  }

  let repetitions = 0;
  let passingRepetitions = 0;
  let allPassed = 0;
  let k = Number.POSITIVE_INFINITY;
  for (const task of counted) {
    repetitions += task.values.length;
    const passes = task.values.filter((v) => v >= threshold).length;
    passingRepetitions += passes;
    if (passes === task.values.length) allPassed += 1;
    k = Math.min(k, task.values.length);
  }
  const resolvedK = counted.length === 0 ? 0 : k;
  const eligibility = spreadEligibility(resolvedK);

  return {
    provider: input.provider,
    threshold,
    metrics: [...new Set(counted.map((t) => t.metric))].sort((a, b) => a.localeCompare(b)),
    tasksCounted: counted.length,
    tasksExcluded,
    repetitions,
    passingRepetitions,
    passAt1: repetitions === 0 ? null : passingRepetitions / repetitions,
    passHatK: eligibility.reportable && counted.length > 0 ? allPassed / counted.length : null,
    k: resolvedK,
    eligibility,
    kWithheld: eligibility.reportable && counted.length > 0 ? '' : withheldReason(eligibility, counted.length),
  };
}

function withheldReason(eligibility: SpreadEligibility, counted: number): string {
  if (counted === 0) {
    return 'no task had a measurable repetition, so there is nothing to count either way.';
  }
  return `${eligibility.reason}. \`pass^k\` is the share of tasks that passed on every one of k attempts, so it says nothing until k reaches the floor of ${String(eligibility.floor)}; below it, a task that passed twice is indistinguishable from one that would pass every time.`;
}
