/**
 * The benchmark's scorers, in one import.
 *
 * Every function here is pure and synchronous over a report's text and a
 * loaded task. Nothing reads a file, nothing calls a network, and nothing calls
 * a model: the governing rule of the whole benchmark is that every score is
 * computed by code from a gold set fixed before the run.
 *
 * `confidence.ts` parses markers, `calibration.ts` turns them into a Brier
 * score, `refusal.ts` grades the two families where the right answer is not an
 * answer, and `recency.ts` grades a source set against the task's as-of date.
 */
export {
  assertProbabilities,
  CONFIDENCE_LEVELS,
  DEFAULT_CONFIDENCE_PROBABILITY,
  findAllMentions,
  findConfidenceMarkers,
  findMention,
  mentions,
  normaliseForSearch,
  paragraphAt,
  paragraphRanges,
} from './confidence.js';
export type {
  ConfidenceLevel,
  ConfidenceMarker,
  ConfidenceProbabilities,
  MarkerForm,
  Range,
  SpanDirection,
} from './confidence.js';

/**
 * Re-exported because they are structural members of what this barrel returns:
 * `SourceRecency.freshness`, `SourceRecency.type` and `RecencyScored.counts` are
 * all typed by them, and a consumer that could not name them would have to
 * reach into `src/research/evidence.js` to describe a value this module handed
 * it.
 */
export type { Freshness, SourceType } from '../../../src/research/evidence.js';

export { scoreCalibration } from './calibration.js';
export type {
  CalibrationBin,
  CalibrationNotApplicable,
  CalibrationOptions,
  CalibrationPairing,
  CalibrationResult,
  CalibrationScored,
  CalibrationUnmeasurable,
  FactRecovery,
  UnmeasurableReason,
} from './calibration.js';

export { REFUSAL_SCORE, scoreRefusal } from './refusal.js';
export type { RefusalNotApplicable, RefusalOutcome, RefusalResult, RefusalScored } from './refusal.js';

export {
  assessSourceRecency,
  BENCH_SOURCE_HORIZONS,
  classifyDurability,
  DURABLE_FLOOR,
  PERISHABLE_CEILING,
  recencyHorizon,
  scoreRecency,
} from './recency.js';
export type {
  Durability,
  DurabilityVerdict,
  Horizon,
  RecencyNotApplicable,
  RecencyResult,
  RecencyScored,
  RecencySource,
  RecencyUnmeasurable,
  SourceRecency,
} from './recency.js';
