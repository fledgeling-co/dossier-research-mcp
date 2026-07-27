import type { BenchTaskFile } from '../tasks/schema.js';
import { mentions, normaliseForSearch } from './confidence.js';
import { extractProse } from './prose.js';

/**
 * Relevance, without a judge.
 *
 * The naive version of this metric needs a model to read the report and say
 * whether it answered the right question. This design forbids a model in the
 * scoring loop, so the measurement is moved to authoring time instead: the task
 * author records the **required terms** a competent answer cannot avoid using
 * and the **drift terms** that mean the answer wandered into an adjacent topic,
 * and the scorer counts them.
 *
 * **It is crude on purpose, and it must stay crude.** Its whole job is to
 * separate an answer about the right subject from one that is not. Whether the
 * answer is *correct* is the accuracy scorer's question, and quietly upgrading
 * this into something that needs a model would give up the one property that
 * makes the benchmark re-runnable for free.
 *
 * Two smaller decisions worth knowing:
 *
 * **Terms are matched over prose, not citations.** A required term like
 * `containerd` appears in every URL a report cites about containerd, so matching
 * the raw markdown would score coverage for the link list rather than the
 * writing.
 *
 * **Negation is deliberately not applied here**, unlike in accuracy. A report
 * saying "this is not about Kubernetes" has raised Kubernetes; the subject was
 * discussed. Polarity changes whether an *answer* is right, which is why
 * accuracy cares and this does not.
 */

/**
 * How hard a drift term counts against coverage.
 *
 * One, which is literally "coverage minus a drift penalty" as the design states
 * it. It is a named constant rather than a literal so a later item can retune it
 * against evidence from a real corpus, and `coverage` and `drift` are both
 * returned separately so a reader who disagrees with the weight can recompute
 * the score without re-running anything.
 */
export const DEFAULT_DRIFT_WEIGHT = 1;

export interface RelevanceNotApplicable {
  readonly status: 'not-applicable';
  readonly why: string;
  readonly notes: readonly string[];
}

export interface RelevanceScored {
  readonly status: 'scored';
  /** `clamp(coverage - weight * drift, 0, 1)`. */
  readonly score: number;
  /** Share of required terms present. Each term counts once. */
  readonly coverage: number;
  /** Share of drift terms present, or zero when the task records none. */
  readonly drift: number;
  readonly weight: number;
  readonly requiredHits: readonly string[];
  readonly requiredMisses: readonly string[];
  readonly driftHits: readonly string[];
  readonly notes: readonly string[];
}

export type RelevanceResult = RelevanceNotApplicable | RelevanceScored;

export interface RelevanceOptions {
  /** Replace the drift weight. Every result carries the weight that made it. */
  readonly driftWeight?: number | undefined;
}

const CLAMP_NOTE =
  'The score is clamped at zero, so a report that drifted further than it covered reads as zero rather than as a negative. Read `coverage` and `drift` when the difference matters.';

/**
 * Score one report's relevance against one task.
 *
 * A term counts once whether it appears once or forty times: this asks whether
 * the subject was raised, and counting repetitions would reward a report for
 * saying the same word more often.
 */
export function scoreRelevance(
  report: string,
  task: BenchTaskFile,
  options: RelevanceOptions = {},
): RelevanceResult {
  const notes: string[] = [];
  const weight = options.driftWeight ?? DEFAULT_DRIFT_WEIGHT;
  if (!Number.isFinite(weight) || weight < 0) {
    throw new TypeError(
      `the drift weight must be a finite number of at least zero; received ${String(weight)}`,
    );
  }

  // Agrees with `ApplicableMetrics.relevance` rather than re-deriving it. A task
  // recording no required terms has nothing to be relevant *to*, and scoring it
  // zero would report every backend as worse than it is.
  if (task.requiredTerms.length === 0) {
    return {
      status: 'not-applicable',
      why: 'the task records no required terms, so there is nothing to measure coverage against',
      notes,
    };
  }

  const prose = normaliseForSearch(extractProse(report));

  const requiredHits: string[] = [];
  const requiredMisses: string[] = [];
  for (const term of task.requiredTerms) {
    if (mentions(prose, term)) requiredHits.push(term);
    else requiredMisses.push(term);
  }

  const driftHits = task.driftTerms.filter((term) => mentions(prose, term));

  const coverage = requiredHits.length / task.requiredTerms.length;
  const drift = task.driftTerms.length === 0 ? 0 : driftHits.length / task.driftTerms.length;
  const raw = coverage - weight * drift;
  const score = Math.min(1, Math.max(0, raw));

  if (raw < 0) notes.push(CLAMP_NOTE);
  if (task.driftTerms.length === 0) {
    notes.push(
      'The task records no drift terms, so this score is coverage alone. Nothing here penalises an answer that wandered.',
    );
  }
  notes.push(
    'Terms are matched literally on word boundaries over the report\'s prose. A report using a synonym the task author did not record scores no coverage for it, and that limit is stated rather than hidden.',
  );

  return {
    status: 'scored',
    score,
    coverage,
    drift,
    weight,
    requiredHits,
    requiredMisses,
    driftHits,
    notes,
  };
}
