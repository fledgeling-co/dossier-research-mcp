import { summarise, type SpreadReport } from '../report/spread.js';

/**
 * A `SpreadReport` over a combination's per-repetition scores.
 *
 * A one-line adapter rather than a second implementation. The quartile
 * definition, the floor at which a spread may be stated at all, and the wording
 * of a withheld spread are all `bench/src/report/spread.ts`'s, which in turn
 * imports the floor from `bench/src/run/cell.ts`. Three modules, one rule, and
 * a frontier that treats two combinations as separable must mean the same thing
 * by that as the ranker does.
 *
 * Every supplied value is a completed measurement, which is why `completed` is
 * the list's own length here: a combination whose score could not be measured
 * has no value to pass, rather than a zero.
 */
export function scoreSpread(values: readonly number[]): SpreadReport | null {
  return summarise(values, values.length, 'repetition');
}
