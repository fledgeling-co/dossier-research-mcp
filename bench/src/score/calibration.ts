import type { BenchTaskFile, GoldFact } from '../tasks/schema.js';
import {
  assertProbabilities,
  DEFAULT_CONFIDENCE_PROBABILITY,
  findConfidenceMarkers,
  mentions,
  type ConfidenceLevel,
  type ConfidenceProbabilities,
} from './confidence.js';

/**
 * Calibration: is a backend's stated confidence worth anything.
 *
 * The measurement the whole suite is missing without this: a backend right 60%
 * of the time that says High every time is worse than one right 55% whose Highs
 * are right 90%, because the second can be acted on selectively and the first
 * has to be verified entirely. Accuracy cannot see the difference. Only pairing
 * each stated confidence with what actually happened can.
 *
 * Three properties shape the implementation.
 *
 * **Whether an answer was recovered is an input, not a decision made here.**
 * Deciding it means knowing that `1.2 billion`, `1,200,000,000` and `1.2B` are
 * one number, that a unit changes the answer, and how names normalise. That is
 * the accuracy scorer's whole job, and two implementations of a rule eventually
 * disagree about what the rule is. The seam is one plain serialisable record
 * keyed by the stable gold-fact id, which is the exact reason the id is
 * required by the task format.
 *
 * **Pairing keys on the subject, not the answer.** Pairing a confidence marker
 * to an answer by looking for the answer's *value* can only ever match a report
 * that already got it right, so the confidently-wrong claim, which is the
 * single thing this metric exists to catch, would never be paired and would
 * never be charged for. The answer's human-readable label is the subject and
 * survives a wrong answer, so it is the primary key. Where an answer has no
 * label the value is the stated fallback, and the result says so rather than
 * degrading quietly.
 *
 * **Unmeasurable is not zero.** A Brier score of zero is a *perfect* score.
 * Returning zero for a report that carried no confidence markers would report
 * the worst case as the best, so an unmeasurable result carries no Brier score
 * at all and no caller can read one.
 */

/** Whether each gold fact was recovered, keyed by its id. BENCH-04 produces it. */
export type FactRecovery = Readonly<Record<string, boolean>>;

export type UnmeasurableReason =
  /** The report stated no confidence anywhere. */
  | 'no-markers'
  /** It stated confidence, but never about anything the gold set asked for. */
  | 'markers-present-but-unpaired'
  /** It stated confidence about the right things, and nothing said if they were right. */
  | 'no-recovery-input';

export interface CalibrationBin {
  readonly level: ConfidenceLevel;
  readonly count: number;
  /** What the probability map assigns to this level. */
  readonly predicted: number;
  /** The share of this bin's answers that were actually recovered. */
  readonly observed: number;
}

export interface CalibrationPairing {
  readonly factId: string;
  readonly level: ConfidenceLevel;
  readonly recovered: boolean;
  /** Which key matched. `value` carries the bias named in the notes. */
  readonly pairedBy: 'label' | 'value';
  /** The marker as written, so a disputed pairing is arguable against the text. */
  readonly markerText: string;
  /** The report stated more than one level about this answer. */
  readonly ambiguous: boolean;
}

interface CalibrationCommon {
  readonly probabilities: ConfidenceProbabilities;
  /** What this score cannot see, in plain words. Always present, often empty. */
  readonly notes: readonly string[];
}

export interface CalibrationNotApplicable extends CalibrationCommon {
  readonly status: 'not-applicable';
  readonly why: string;
}

export interface CalibrationUnmeasurable extends CalibrationCommon {
  readonly status: 'unmeasurable';
  readonly reason: UnmeasurableReason;
  readonly why: string;
  /** Every marker found, abstentions included. Same meaning as in `scoreRefusal`. */
  readonly markerCount: number;
  /** Markers that stated a level. `markerCount` minus `abstentions`. */
  readonly gradedMarkers: number;
  readonly abstentions: number;
}

export interface CalibrationScored extends CalibrationCommon {
  readonly status: 'scored';
  /** Mean squared error between stated confidence and outcome. Lower is better. */
  readonly brier: number;
  /** How far each level's stated probability sits from what it delivered. */
  readonly reliability: number;
  /** How much the levels actually separated outcomes. */
  readonly resolution: number;
  /** The base rate's own variance, which no backend controls. */
  readonly uncertainty: number;
  readonly bins: readonly CalibrationBin[];
  readonly pairings: readonly CalibrationPairing[];
  /**
   * The denominator, stated, because a Brier score without it is unreadable.
   *
   * Silence is otherwise free: a backend that states a confidence only about
   * the answers it got right scores near-perfectly over its own chosen sample.
   * On a three-answer task with two wrong, staying quiet about the two is worth
   * roughly fifty times on the headline number. `coverage` is what makes that
   * visible, and BENCH-08 must print it beside the score rather than under it.
   */
  readonly scoredAnswers: number;
  readonly goldFacts: number;
  /** `scoredAnswers / goldFacts`. Read the Brier score only against this. */
  readonly coverage: number;
  /** Every marker found, abstentions included. Same meaning as in `scoreRefusal`. */
  readonly markerCount: number;
  /** Markers that stated a level. `markerCount` minus `abstentions`. */
  readonly gradedMarkers: number;
  readonly abstentions: number;
  /** Answers paired to a marker but absent from the recovery input. */
  readonly unresolved: readonly string[];
  /** Answers no marker's span mentioned. */
  readonly unpaired: readonly string[];
  readonly ambiguousPairings: number;
  /** At least one answer carries no label and could only be paired by value. */
  readonly pairedByValueOnly: boolean;
}

export type CalibrationResult =
  | CalibrationNotApplicable
  | CalibrationUnmeasurable
  | CalibrationScored;

export interface CalibrationOptions {
  /** Replace the probability map. Every result carries the map that produced it. */
  readonly probabilities?: ConfidenceProbabilities | undefined;
}

const LEVEL_ORDER: Readonly<Record<ConfidenceLevel, number>> = { low: 0, medium: 1, high: 2 };

/** The label, then the written value, then any alternate wording. */
function pairingKeys(fact: GoldFact): { readonly label: string | null; readonly values: string[] } {
  const values: string[] = [String(fact.value)];
  if (fact.kind === 'name' || fact.kind === 'identifier') values.push(...fact.aliases);
  return { label: fact.label ?? null, values };
}

const VALUE_PAIRING_NOTE =
  'At least one answer carries no label, so it could only be paired by the value it states. Value pairing can match a report that got the answer right and cannot match one that got it wrong, so a confidently wrong claim about those answers is invisible to this score. Give the answer a label in the task file to close it.';

/**
 * Score one report's calibration against one task.
 *
 * `recovered` says, per gold-fact id, whether the report actually recovered
 * that answer. An id missing from it is counted `unresolved` and excluded: a
 * sibling scorer failing to report must never turn into a penalty against the
 * backend under test.
 */
export function scoreCalibration(
  report: string,
  task: BenchTaskFile,
  recovered: FactRecovery,
  options: CalibrationOptions = {},
): CalibrationResult {
  const probabilities = options.probabilities ?? DEFAULT_CONFIDENCE_PROBABILITY;
  assertProbabilities(probabilities);
  const notes: string[] = [];

  // Agrees with `ApplicableMetrics.calibration` rather than re-deriving it: a
  // refusal task carries no answers, so calibration over it is not applicable
  // and must never reach a denominator as a zero.
  if (task.goldFacts.length === 0) {
    return {
      status: 'not-applicable',
      why: 'the task records no gold facts, so there is nothing a stated confidence could be paired against',
      probabilities,
      notes,
    };
  }

  const markers = findConfidenceMarkers(report);
  const graded = markers.filter((m) => m.level !== null);
  const abstentions = markers.length - graded.length;

  if (graded.length === 0) {
    return {
      status: 'unmeasurable',
      reason: 'no-markers',
      why:
        abstentions > 0
          ? `the report states no confidence anywhere; ${String(abstentions)} abstention(s) were found, and an abstention is not a confidence assertion`
          : 'the report states no confidence anywhere, so there is nothing to pair with an outcome',
      markerCount: markers.length,
      gradedMarkers: 0,
      abstentions,
      probabilities,
      notes,
    };
  }

  const pairings: CalibrationPairing[] = [];
  const unresolved: string[] = [];
  const unpaired: string[] = [];
  let ambiguousPairings = 0;
  let pairedByValueOnly = false;

  for (const fact of task.goldFacts) {
    const keys = pairingKeys(fact);
    if (keys.label === null) pairedByValueOnly = true;

    let best: { level: ConfidenceLevel; text: string; by: 'label' | 'value' } | null = null;
    const levelsSeen = new Set<ConfidenceLevel>();

    for (const marker of graded) {
      const level = marker.level;
      if (level === null) continue;
      const byLabel = keys.label !== null && mentions(marker.span, keys.label);
      const byValue = !byLabel && keys.values.some((v) => mentions(marker.span, v));
      if (!byLabel && !byValue) continue;
      levelsSeen.add(level);
      if (best === null || LEVEL_ORDER[level] > LEVEL_ORDER[best.level]) {
        best = { level, text: marker.text, by: byLabel ? 'label' : 'value' };
      }
    }

    if (best === null) {
      unpaired.push(fact.id);
      continue;
    }
    const outcome = recovered[fact.id];
    if (outcome === undefined) {
      unresolved.push(fact.id);
      continue;
    }
    if (levelsSeen.size > 1) ambiguousPairings += 1;
    pairings.push({
      factId: fact.id,
      level: best.level,
      recovered: outcome,
      pairedBy: best.by,
      markerText: best.text,
      ambiguous: levelsSeen.size > 1,
    });
  }

  if (pairedByValueOnly) notes.push(VALUE_PAIRING_NOTE);

  if (pairings.length === 0) {
    // `no-recovery-input` wins the tie on purpose. When both went wrong, the
    // report did state a confidence about an answer the gold set records and
    // nothing told this scorer the outcome, which is the fixable half; saying
    // "it never discussed our answers" would send the reader to the wrong end.
    const missingOutcome = unresolved.length > 0;
    return {
      status: 'unmeasurable',
      reason: missingOutcome ? 'no-recovery-input' : 'markers-present-but-unpaired',
      why: missingOutcome
        ? `${String(unresolved.length)} answer(s) were discussed under a confidence marker and are missing from the recovery input, so no outcome is known for any pairing`
        : `the report states ${String(graded.length)} confidence(s), none of which discuss an answer the gold set records`,
      markerCount: markers.length,
      gradedMarkers: graded.length,
      abstentions,
      probabilities,
      notes,
    };
  }

  if (unresolved.length > 0) {
    notes.push(
      `${String(unresolved.length)} paired answer(s) were excluded because the recovery input said nothing about them. They are not counted as wrong.`,
    );
  }
  if (unpaired.length > 0) {
    notes.push(
      `${String(unpaired.length)} answer(s) were never mentioned inside a confidence marker's span, so the report stated no confidence about them.`,
    );
  }
  if (ambiguousPairings > 0) {
    notes.push(
      `${String(ambiguousPairings)} answer(s) were discussed at more than one confidence level; the highest was taken, since that is the claim a reader acts on.`,
    );
  }
  if (abstentions > 0) {
    notes.push(
      `${String(abstentions)} abstention(s) were found and excluded. An abstention is a refusal to state a confidence, not a low one.`,
    );
  }

  const n = pairings.length;
  const brier = pairings.reduce((sum, p) => {
    const predicted = probabilities[p.level];
    const observed = p.recovered ? 1 : 0;
    return sum + (predicted - observed) ** 2;
  }, 0) / n;

  const baseRate = pairings.filter((p) => p.recovered).length / n;
  const bins: CalibrationBin[] = [];
  let reliability = 0;
  let resolution = 0;
  for (const level of ['high', 'medium', 'low'] as const) {
    const inBin = pairings.filter((p) => p.level === level);
    if (inBin.length === 0) continue;
    const observed = inBin.filter((p) => p.recovered).length / inBin.length;
    const predicted = probabilities[level];
    bins.push({ level, count: inBin.length, predicted, observed });
    reliability += (inBin.length * (predicted - observed) ** 2) / n;
    resolution += (inBin.length * (observed - baseRate) ** 2) / n;
  }

  const coverage = n / task.goldFacts.length;
  if (coverage < 1) {
    notes.push(
      `This score covers ${String(n)} of the task's ${String(task.goldFacts.length)} answers. A backend that states a confidence only about what it got right scores well over a sample it chose, so read the score against its coverage.`,
    );
  }

  return {
    status: 'scored',
    brier,
    reliability,
    resolution,
    uncertainty: baseRate * (1 - baseRate),
    bins,
    pairings,
    scoredAnswers: n,
    goldFacts: task.goldFacts.length,
    coverage,
    markerCount: markers.length,
    gradedMarkers: graded.length,
    abstentions,
    unresolved,
    unpaired,
    ambiguousPairings,
    pairedByValueOnly,
    probabilities,
    notes,
  };
}
