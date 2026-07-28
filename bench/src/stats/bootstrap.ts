import { byCluster, type Observation } from './clustered.js';
import { quantile } from './quantile.js';
import { mulberry32, seedFrom } from './random.js';

/**
 * A percentile bootstrap that resamples clusters, not observations.
 *
 * **This file must never import `node:fs`.** See `random.ts`.
 *
 * 5,000 resamples at 95%, following FutureSearch, which is the only
 * deep-research leaderboard the prior art could find that publishes an interval
 * at all: "95% confidence intervals from percentile bootstrap with 5,000
 * resamples, and a pairwise matrix of paired-bootstrap differences computed
 * only on questions both agents answered". The instruction attached to that
 * finding was one word, copy this, and this is that.
 *
 * The cluster part is the part that would be easy to get wrong and invisible if
 * you did. Drawing **tasks** with replacement would produce an interval that
 * assumes two tasks in one category are two independent observations, which is
 * the same error `clustered.ts` exists to correct, made again one layer up and
 * this time hidden inside a resampling loop where no ratio would show it. So a
 * category is drawn or not drawn **as a unit**, all of its tasks with it, and
 * the within-category correlation survives into the interval's width.
 *
 * Percentile rather than bias-corrected and accelerated. BCa is better on a
 * skewed sample and is more machinery than a corpus of seven tasks can justify;
 * the choice is recorded in `docs/bench/statistics.md` so it can be revisited
 * when the corpus is large enough for the difference to matter.
 */

/** The published default, from FutureSearch. Changing it changes every interval. */
export const DEFAULT_RESAMPLES = 5000;
/** Two-sided, 95%. Stated on every result rather than assumed by a reader. */
export const DEFAULT_CONFIDENCE = 0.95;

export interface BootstrapOptions {
  readonly resamples?: number | undefined;
  readonly confidence?: number | undefined;
  /**
   * Seed parts, joined into the PRNG seed.
   *
   * Pass what is being compared: the metric, the scope, both backend names. Two
   * renders of one store then resample identically and two different
   * comparisons do not share a draw.
   */
  readonly seedParts?: readonly string[] | undefined;
}

export interface BootstrapResult {
  /** The statistic on the sample in hand, before any resampling. */
  readonly estimate: number;
  readonly lower: number;
  readonly upper: number;
  /** `true` when the interval contains zero, computed once, here. */
  readonly crossesZero: boolean;
  readonly resamples: number;
  readonly confidence: number;
  readonly clusters: number;
  readonly n: number;
  /** The seed actually used, so a reader can reproduce the interval. */
  readonly seed: number;
}

/**
 * Bootstrap the mean of a clustered sample.
 *
 * Returns null below two clusters. One cluster resampled with replacement
 * always draws the same cluster, so every replicate is identical and the
 * interval is a point: an answer that looks like precision and is an artefact
 * of having nothing to resample. Said as null rather than printed as a
 * zero-width interval.
 */
export function clusterBootstrap(
  observations: readonly Observation[],
  options: BootstrapOptions = {},
): BootstrapResult | null {
  const resamples = options.resamples ?? DEFAULT_RESAMPLES;
  const confidence = options.confidence ?? DEFAULT_CONFIDENCE;
  if (!Number.isInteger(resamples) || resamples < 1) {
    throw new TypeError(`the resample count must be a positive integer; received ${String(resamples)}`);
  }
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new TypeError(`the confidence level must be strictly between 0 and 1; received ${String(confidence)}`);
  }

  const groups = byCluster(observations);
  if (groups.length < 2) return null;

  const n = observations.length;
  let total = 0;
  for (const o of observations) total += o.value;
  const estimate = total / n;

  // Pre-summed, because the inner loop runs `resamples * clusters` times and a
  // re-walk of every cluster's members inside it is the difference between a
  // report that renders in a second and one that renders in a minute.
  const sums = groups.map((g) => g.values.reduce((acc, v) => acc + v, 0));
  const sizes = groups.map((g) => g.values.length);

  const seed = seedFrom(options.seedParts ?? ['dossier-bench-13']);
  const random = mulberry32(seed);

  const replicates: number[] = [];
  for (let r = 0; r < resamples; r += 1) {
    let drawnSum = 0;
    let drawnCount = 0;
    for (let c = 0; c < groups.length; c += 1) {
      const pick = Math.floor(random() * groups.length);
      // `random()` is in [0, 1), so `pick` is in range; the clamp is for the
      // one floating-point rounding that would put it at `groups.length`.
      const index = pick >= groups.length ? groups.length - 1 : pick;
      drawnSum += sums[index] ?? 0;
      drawnCount += sizes[index] ?? 0;
    }
    // Every cluster is non-empty by construction, so `drawnCount` is positive.
    replicates.push(drawnSum / drawnCount);
  }

  replicates.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  const lower = quantile(replicates, alpha);
  const upper = quantile(replicates, 1 - alpha);

  return {
    estimate,
    lower,
    upper,
    crossesZero: lower <= 0 && upper >= 0,
    resamples,
    confidence,
    clusters: groups.length,
    n,
    seed,
  };
}
