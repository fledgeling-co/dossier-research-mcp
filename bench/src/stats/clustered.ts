/**
 * Standard errors clustered on category, which is the one this corpus needs.
 *
 * **This file must never import `node:fs`.** See `random.ts`.
 *
 * The failure being prevented: two tasks in one category are not two
 * independent observations. They share a topic, often a source, sometimes an
 * entity, and a backend that is good at one is more likely to be good at the
 * other. Treating them as independent understates the standard error, which
 * makes a difference look significant when it is not, **in the direction that
 * flatters whichever backend happened to win**. Miller measures the inflation
 * at up to 3.05x on DROP; the ICLR 2026 error-bars blogpost gives the design
 * effect as `1 + (m - 1) * rho` and puts realistic intracluster correlations at
 * 0.2 to 0.4, which inflates a standard error by a factor of two or three. The
 * benchmark design is ten categories of ten related tasks, so this is not a
 * hypothetical correction; it is the ordinary case here.
 *
 * Both figures are returned, always, with the ratio between them. Reporting
 * only the corrected one hides how much of the apparent precision was an
 * artefact, and that ratio is the single most legible number in the whole
 * slice.
 */

/** One observation and the cluster it belongs to. Cluster is a task category. */
export interface Observation {
  readonly value: number;
  /** The cluster id. Category, here, and never a task id. */
  readonly cluster: string;
}

export interface ClusteredError {
  readonly n: number;
  readonly mean: number;
  /** The standard error that assumes every observation is independent. */
  readonly naive: number;
  /** The same quantity with within-cluster covariance restored. */
  readonly clustered: number;
  /**
   * `clustered / naive`. Null when the naive error is zero, which happens when
   * every observation is identical and there is nothing to inflate.
   */
  readonly inflation: number | null;
  /** `inflation^2`. The design effect, in the literature's own vocabulary. */
  readonly designEffect: number | null;
  readonly clusters: number;
  /** Cluster ids in sorted order, with their sizes. Printed, so the reader can see the shape. */
  readonly clusterSizes: readonly { readonly cluster: string; readonly size: number }[];
}

/**
 * Group observations by cluster, in a deterministic order.
 *
 * Sorted rather than insertion-ordered, because the bootstrap draws from this
 * list and a draw whose meaning depends on the order rows arrived in is not
 * reproducible in any useful sense.
 */
export function byCluster(
  observations: readonly Observation[],
): readonly { readonly cluster: string; readonly values: readonly number[] }[] {
  const map = new Map<string, number[]>();
  for (const o of observations) {
    if (!Number.isFinite(o.value)) {
      throw new TypeError(
        `a clustered standard error needs finite values; received ${String(o.value)}. An unmeasured observation must be dropped before it reaches here, never carried as a NaN.`,
      );
    }
    const bucket = map.get(o.cluster);
    if (bucket === undefined) map.set(o.cluster, [o.value]);
    else bucket.push(o.value);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cluster, values]) => ({ cluster, values }));
}

/**
 * The naive and the clustered standard error of the mean, and the ratio.
 *
 * `naive^2  = (1/n^2) * sum_i (v_i - mean)^2`
 * `clustered^2 = (1/n^2) * sum_c ( sum_{i in c} (v_i - mean) )^2`
 *
 * The second is algebraically identical to Miller's published form,
 * `SE_CLT^2 + (1/n^2) * sum_c sum_{i != j in c} (v_i - mean)(v_j - mean)`,
 * because expanding the square of a sum gives exactly the diagonal plus the
 * off-diagonal terms. It is written as a sum of squares here for one reason
 * that matters: **it cannot go negative.** The additive form can be handed a
 * negative radicand by floating-point rounding on strongly negatively
 * correlated clusters, and a `NaN` standard error printed beside a difference
 * is worse than no standard error at all. A test asserts the two forms agree.
 *
 * With one observation per cluster the two collapse onto each other exactly,
 * because every inner sum has a single term. That is the right behaviour and it
 * is asserted: with no cluster to share, clustering may not change the answer.
 *
 * Returns null below two observations. A standard error over one value is zero
 * by construction and says nothing.
 */
export function clusteredError(observations: readonly Observation[]): ClusteredError | null {
  if (observations.length < 2) return null;

  const groups = byCluster(observations);
  const n = observations.length;
  let total = 0;
  for (const o of observations) total += o.value;
  const mean = total / n;

  let naiveSquares = 0;
  for (const o of observations) naiveSquares += (o.value - mean) ** 2;

  let clusteredSquares = 0;
  for (const group of groups) {
    let inner = 0;
    for (const v of group.values) inner += v - mean;
    clusteredSquares += inner ** 2;
  }

  const naive = Math.sqrt(naiveSquares) / n;
  const clustered = Math.sqrt(clusteredSquares) / n;
  const inflation = naive === 0 ? null : clustered / naive;

  return {
    n,
    mean,
    naive,
    clustered,
    inflation,
    designEffect: inflation === null ? null : inflation ** 2,
    clusters: groups.length,
    clusterSizes: groups.map((g) => ({ cluster: g.cluster, size: g.values.length })),
  };
}

/**
 * The same clustered variance, written Miller's way.
 *
 * Exported **only** so a test can prove the two forms agree, including on a
 * fixture with a negative within-cluster covariance where the difference
 * between them would otherwise be invisible. Nothing else calls it, and
 * `clusteredError` is the one a caller should use, because this one can return
 * a negative variance that its caller would then have to decide what to do
 * with.
 */
export function millerClusteredVariance(observations: readonly Observation[]): number {
  const groups = byCluster(observations);
  const n = observations.length;
  let total = 0;
  for (const o of observations) total += o.value;
  const mean = total / n;

  let diagonal = 0;
  for (const o of observations) diagonal += (o.value - mean) ** 2;

  let offDiagonal = 0;
  for (const group of groups) {
    for (let i = 0; i < group.values.length; i += 1) {
      for (let j = 0; j < group.values.length; j += 1) {
        if (i === j) continue;
        const a = group.values[i];
        const b = group.values[j];
        if (a === undefined || b === undefined) continue;
        offDiagonal += (a - mean) * (b - mean);
      }
    }
  }

  return (diagonal + offDiagonal) / n ** 2;
}
