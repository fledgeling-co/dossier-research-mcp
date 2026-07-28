import { clusteredError, type ClusteredError, type Observation } from './clustered.js';
import { clusterBootstrap, type BootstrapOptions, type BootstrapResult } from './bootstrap.js';

/**
 * The paired difference between two backends, with a clustered interval.
 *
 * **This file must never import `node:fs`.** See `random.ts`.
 *
 * Paired, because the backends were run on the **same** tasks. An unpaired test
 * throws away exactly the structure that makes the comparison powerful: Miller
 * gives `Var(paired) = Var(unpaired) - 2 * Cov(A, B) / n`, and his worked
 * example, two models each with variance 1/12 correlated at 0.5, cuts the
 * variance by a third. On a corpus this size that third is the difference
 * between a comparison and a shrug.
 *
 * The rule this module exists to enforce is one sentence, and it is the reason
 * the brief was written: **a difference whose interval crosses zero is reported
 * as no measured difference, in those words, and not as a smaller number a
 * reader will rank anyway.** A point estimate printed beside a crossing
 * interval is read as an ordering by everybody in a hurry, which is everybody.
 */

/** The literal words the brief requires. Exported so nothing can paraphrase it. */
export const NO_MEASURED_DIFFERENCE = 'no measured difference';

/** One backend's figure on one task, with the cluster that task belongs to. */
export interface TaskValue {
  readonly taskId: string;
  /** The cluster. A task category, and never a task id. */
  readonly cluster: string;
  readonly value: number;
}

export interface PairedInput {
  readonly a: string;
  readonly b: string;
  readonly aValues: readonly TaskValue[];
  readonly bValues: readonly TaskValue[];
  /** Which way is better. Decides which name goes in `betterBackend`, nothing else. */
  readonly direction: 'higher' | 'lower';
  readonly bootstrap?: BootstrapOptions | undefined;
}

export type PairedWithheld =
  /** Fewer than two tasks both backends have a value on. */
  | 'too-few-shared-tasks'
  /**
   * One cluster. Resampling one category with replacement always draws that
   * category, so every replicate is identical and the interval is a point:
   * something that looks like precision and is an artefact of having nothing to
   * resample.
   */
  | 'too-few-clusters';

export interface PairedShared {
  readonly taskId: string;
  readonly cluster: string;
  readonly a: number;
  readonly b: number;
  /** `a - b`, always in that order, whatever the metric's direction. */
  readonly difference: number;
}

export interface PairedDifference {
  readonly a: string;
  readonly b: string;
  readonly direction: 'higher' | 'lower';
  /** The tasks both backends have a value on. */
  readonly shared: readonly PairedShared[];
  /** Tasks only `a` had, and only `b` had. Counted so a thin pairing is visible. */
  readonly droppedFromA: readonly string[];
  readonly droppedFromB: readonly string[];
  /**
   * `measured` means the interval excludes zero. `no-measured-difference` means
   * it does not. A withheld reason means the comparison never ran.
   */
  readonly verdict: 'measured' | 'no-measured-difference' | PairedWithheld;
  /**
   * The mean paired difference, `a - b`.
   *
   * Present whenever the comparison ran, and **deliberately not rendered** when
   * the verdict is `no-measured-difference`. It is on the object because the
   * JSON is an input to later work; it is off the page because a number on a
   * page is an ordering.
   */
  readonly pointEstimate: number | null;
  readonly interval: BootstrapResult | null;
  readonly error: ClusteredError | null;
  /** The better backend's name, or null when the sample cannot say. */
  readonly betterBackend: string | null;
  /** One sentence, carrying the literal phrase where it applies. */
  readonly summary: string;
}

function intersect(
  aValues: readonly TaskValue[],
  bValues: readonly TaskValue[],
): { shared: PairedShared[]; droppedFromA: string[]; droppedFromB: string[] } {
  const byTaskA = new Map(aValues.map((v) => [v.taskId, v]));
  const byTaskB = new Map(bValues.map((v) => [v.taskId, v]));

  const shared: PairedShared[] = [];
  for (const [taskId, a] of byTaskA) {
    const b = byTaskB.get(taskId);
    if (b === undefined) continue;
    if (a.cluster !== b.cluster) {
      throw new TypeError(
        `task "${taskId}" is in cluster "${a.cluster}" for one backend and "${b.cluster}" for the other; a task belongs to exactly one category, so this is a corpus that moved under a stored result rather than a comparison`,
      );
    }
    shared.push({ taskId, cluster: a.cluster, a: a.value, b: b.value, difference: a.value - b.value });
  }
  shared.sort((x, y) => x.taskId.localeCompare(y.taskId));

  return {
    shared,
    droppedFromA: [...byTaskA.keys()].filter((id) => !byTaskB.has(id)).sort((x, y) => x.localeCompare(y)),
    droppedFromB: [...byTaskB.keys()].filter((id) => !byTaskA.has(id)).sort((x, y) => x.localeCompare(y)),
  };
}

/**
 * Compare two backends on the tasks they both answered.
 *
 * Never on the tasks only one of them answered. That set is counted and named,
 * because a comparison that quietly dropped half of one backend's failures is
 * the completion-rate lesson reappearing inside the statistics.
 */
export function pairedDifference(input: PairedInput): PairedDifference {
  const { shared, droppedFromA, droppedFromB } = intersect(input.aValues, input.bValues);
  const base = {
    a: input.a,
    b: input.b,
    direction: input.direction,
    shared,
    droppedFromA,
    droppedFromB,
  } as const;

  if (shared.length < 2) {
    return {
      ...base,
      verdict: 'too-few-shared-tasks',
      pointEstimate: null,
      interval: null,
      error: null,
      betterBackend: null,
      summary: `${input.a} and ${input.b} share ${String(shared.length)} task${shared.length === 1 ? '' : 's'} with a value on this metric, which is not a comparison. There is ${NO_MEASURED_DIFFERENCE} because there was no measurement.`,
    };
  }

  const observations: Observation[] = shared.map((s) => ({ value: s.difference, cluster: s.cluster }));
  const error = clusteredError(observations);
  const interval = clusterBootstrap(observations, {
    ...input.bootstrap,
    seedParts: input.bootstrap?.seedParts ?? [input.a, input.b, input.direction],
  });

  if (interval === null) {
    const clusters = new Set(shared.map((s) => s.cluster)).size;
    return {
      ...base,
      verdict: 'too-few-clusters',
      pointEstimate: null,
      interval: null,
      error,
      betterBackend: null,
      summary: `${input.a} and ${input.b} share tasks in only ${String(clusters)} categor${clusters === 1 ? 'y' : 'ies'}, so resampling categories cannot produce an interval. Reported as ${NO_MEASURED_DIFFERENCE} rather than as a point estimate with an interval of width zero.`,
    };
  }

  const pointEstimate = interval.estimate;

  if (interval.crossesZero) {
    return {
      ...base,
      verdict: 'no-measured-difference',
      pointEstimate,
      interval,
      error,
      betterBackend: null,
      summary: `${NO_MEASURED_DIFFERENCE} between ${input.a} and ${input.b} over ${String(shared.length)} shared task${shared.length === 1 ? '' : 's'}: the ${String(Math.round(interval.confidence * 100))}% interval runs from ${interval.lower.toFixed(4)} to ${interval.upper.toFixed(4)} and contains zero.`,
    };
  }

  const aIsBetter = input.direction === 'higher' ? pointEstimate > 0 : pointEstimate < 0;
  const better = aIsBetter ? input.a : input.b;
  return {
    ...base,
    verdict: 'measured',
    pointEstimate,
    interval,
    error,
    betterBackend: better,
    summary: `${better} is ahead over ${String(shared.length)} shared task${shared.length === 1 ? '' : 's'}: the mean paired difference is ${pointEstimate.toFixed(4)} with a ${String(Math.round(interval.confidence * 100))}% interval of ${interval.lower.toFixed(4)} to ${interval.upper.toFixed(4)}, which excludes zero.`,
  };
}
