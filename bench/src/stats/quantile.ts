/**
 * One definition of a quantile, for the whole read side.
 *
 * **This file must never import `node:fs`.** See `random.ts`.
 *
 * `bench/src/report/spread.ts` had this privately, for quartiles. The bootstrap
 * needs the same thing for interval endpoints, and a second implementation of a
 * quantile is how two tables in one report end up disagreeing about what the
 * 25th percentile of a sample is. There is already a ledger row on this fleet
 * for three primitives that came to exist twice (BENCH-15); this is the same
 * mistake declined rather than repeated, so `spread.ts` imports from here.
 */

/**
 * Linear interpolation between order statistics: R's type 7.
 *
 * Also Excel's `PERCENTILE.INC` and NumPy's default, chosen because it is the
 * most widely implemented, so a reader reproducing a number in a spreadsheet
 * gets the same answer. Named here so nobody later "fixes" it to a different
 * one and quietly moves every quartile and every interval endpoint in the
 * report at once.
 *
 * On a sample of one it returns that value, which is why it never divides by
 * zero. The input must already be sorted ascending; sorting inside would hide a
 * caller that forgot, and this is called once per bootstrap replicate set.
 */
export function quantile(sorted: readonly number[], p: number): number {
  const last = sorted.length - 1;
  if (last < 0) throw new TypeError('quantile needs at least one value');
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new TypeError(`quantile needs a probability in [0, 1]; received ${String(p)}`);
  }
  const position = p * last;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined) {
    throw new TypeError('quantile indexed outside its own sample');
  }
  if (lowerIndex === upperIndex) return lower;
  return lower + (upper - lower) * (position - lowerIndex);
}
