import type { TaskCategory } from '../tasks/schema.js';
import type { BenchTask } from '../tasks/corpus.js';
import type { CellRecord } from '../run/cell.js';
import { factRecovery, scoreAccuracy } from '../score/accuracy.js';
import { scoreCalibration } from '../score/calibration.js';
import { scoreRelevance } from '../score/relevance.js';
import { scoreRefusal } from '../score/refusal.js';
import { scoreDueWeight } from '../score/due-weight/index.js';
import { scoreCitationIntegrity, type CitationEvidenceView } from '../score/citations.js';
import { scoreSourceQuality } from '../score/source-quality.js';
import { recencyInputs, scoreRecency, type DatedPage, type DatingCounts } from '../score/recency.js';
import { sourceUniverse } from '../score/matrix.js';
import { METRIC_IDS, type MetricId } from './metrics.js';

/**
 * One stored cell, turned into the numbers a report is built from.
 *
 * **This file must never import `node:fs`.** The report text and the evidence
 * snapshot arrive as values; `cli.ts` is the only part of this slice that opens
 * anything. That is what makes the whole read side pure over stored bytes, and
 * it is the property `docs/plan/benchmark.md` bought by separating the run from
 * the scoring: a metric added in three months applies to research already paid
 * for, without buying it again.
 *
 * The single most important rule in this file: **a metric that could not be
 * measured is `null` with a reason, and never `0`.** A failed cell, a refusal
 * task with no gold facts, a report with no citations and a backend that stated
 * no confidence are four different absences, and every one of them scored as a
 * zero would report every backend as worse than it is while saying nothing
 * about why. BENCH-03 applied this rule to `unchecked` registry answers and
 * BENCH-02 applied it to recorded failures; this is the same rule at the layer
 * where a naive average would otherwise reward giving up.
 */

/** Counts from a registry check, carried up so the unchecked share is reportable. */
export interface RegistryCounts {
  readonly present: number;
  readonly absent: number;
  readonly unchecked: number;
  readonly invalid: number;
}

const NO_REGISTRY: RegistryCounts = { present: 0, absent: 0, unchecked: 0, invalid: 0 };

const NO_DATING: DatingCounts = { dated: 0, absent: 0, unchecked: 0 };

/** Whether this cell had a citation evidence snapshot to score against. */
export type EvidenceState = 'present' | 'absent';

export interface ScoredCell {
  readonly key: string;
  readonly taskId: string;
  readonly provider: string;
  readonly repeat: number;
  readonly category: TaskCategory;
  /** The task's staleness at load time, carried so the report can count it. */
  readonly stale: boolean;
  readonly outcome: CellRecord['outcome'];
  /** Present only on a failed cell. `unclassified` when the runner did not say. */
  readonly failureKind: string | null;
  readonly wallClockMs: number;
  readonly estimatedCostUsd: number;
  /** `null` means not measured. Read `unmeasured` for why. Never zero-filled. */
  readonly metrics: Readonly<Record<MetricId, number | null>>;
  /** Why each null is null. Keyed identically, so an absence always has a reason. */
  readonly unmeasured: Readonly<Record<MetricId, string>>;
  readonly registry: RegistryCounts;
  /**
   * How many of this cell's cited sources could be dated, and why the rest
   * could not.
   *
   * A count rather than a metric, exactly as `registry` is, because it describes
   * the instrument rather than the backend's quality. It is what makes the
   * recency figure readable: a fresh share of 1.0 over one dated source in forty
   * is not a finding, and only the denominator beside it says so.
   */
  readonly dating: DatingCounts;
  readonly evidence: EvidenceState;
  /** Anything about this cell the pipeline could not do, as opposed to the backend. */
  readonly gaps: readonly string[];
}

export interface HarvestInput {
  readonly cell: CellRecord;
  readonly task: BenchTask;
  /**
   * The report text, read from the Dossier store by the caller.
   *
   * Absent for a failed cell, which is expected, and absent for an `ok` cell
   * whose file could not be read, which is a **pipeline gap** rather than a
   * result about a backend. The two are worded differently on purpose: one is
   * the backend's outcome and the other is ours.
   */
  readonly report?: string | undefined;
  /** BENCH-03's snapshot for this cell, when one was collected. */
  readonly evidence?: HarvestEvidenceView | undefined;
}

/**
 * The snapshot, as this file needs to see it.
 *
 * Wider than `CitationEvidenceView` by exactly one field: each page's
 * publication date, which the citation scorer has no use for and recency cannot
 * work without. **Required, not optional.** An optional field is a sentinel a
 * caller can forget, and a caller that forgot this one would silently report
 * every source undated while every test stayed green.
 */
export interface HarvestEvidenceView extends CitationEvidenceView {
  readonly pages: readonly (CitationEvidenceView['pages'][number] & DatedPage)[];
}

type MutableMetrics = Record<MetricId, number | null>;
type MutableReasons = Record<MetricId, string>;

function blank(reason: string): { metrics: MutableMetrics; unmeasured: MutableReasons } {
  const metrics = {} as MutableMetrics;
  const unmeasured = {} as MutableReasons;
  for (const id of METRIC_IDS) {
    metrics[id] = null;
    unmeasured[id] = reason;
  }
  return { metrics, unmeasured };
}

/**
 * Recency, computed rather than withheld, from 28 July 2026.
 *
 * It was declared permanently unavailable here, and the reason was true: BENCH-06
 * built the durability axis, the axis needs a publication date per source, and
 * nothing recorded one. `PageEvidence` carried the time a page was *checked*,
 * which is a different fact, and approximating one from the other would have
 * graded every source fresh.
 *
 * BENCH-16 closed that at the only point where it can be closed: the collector
 * now extracts a publication date from the fetched page, or records explicitly
 * that it could not, and `PageEvidence.published` persists the answer. What is
 * left here is the join, and it is deliberately thin: `recencyInputs` builds the
 * source list and the counts from one pass so the printed denominator cannot
 * disagree with the score above it.
 *
 * **A source with no date never scores as fresh**, and that is enforced by
 * `assessSourceRecency` rather than restated here: an undated source is graded
 * `undated` and leaves the denominator entirely. A report where nothing could be
 * dated comes back `unmeasurable` with its own reason, which lands as `null` and
 * never as a zero.
 */
function record(
  input: HarvestInput,
  metrics: MutableMetrics,
  unmeasured: MutableReasons,
  registry: RegistryCounts,
  dating: DatingCounts,
  evidence: EvidenceState,
  gaps: readonly string[],
): ScoredCell {
  const { cell, task } = input;
  return {
    key: cell.key,
    taskId: cell.taskId,
    provider: cell.provider,
    repeat: cell.repeat,
    category: task.category,
    stale: task.stale,
    outcome: cell.outcome,
    failureKind: cell.outcome === 'failed' ? (cell.failureKind ?? 'unclassified') : null,
    wallClockMs: cell.wallClockMs,
    estimatedCostUsd: cell.estimatedCostUsd,
    metrics,
    unmeasured,
    registry,
    dating,
    evidence,
    gaps,
  };
}

/** Set a measured value and clear its reason, in one place so they cannot drift. */
function set(
  metrics: MutableMetrics,
  unmeasured: MutableReasons,
  id: MetricId,
  value: number | null,
  why: string,
): void {
  if (value === null || !Number.isFinite(value)) {
    metrics[id] = null;
    unmeasured[id] = why;
    return;
  }
  metrics[id] = value;
  unmeasured[id] = '';
}

/**
 * Turn one stored cell into one row of numbers.
 *
 * Deterministic: the same cell, task, report and snapshot produce the same
 * result every time, because every scorer it calls is pure and none of them
 * reads a clock.
 */
export function harvestCell(input: HarvestInput): ScoredCell {
  const { cell, task, report, evidence } = input;

  if (cell.key !== `${cell.taskId}/${cell.provider}/${String(cell.repeat)}`) {
    throw new TypeError(
      `cell key "${cell.key}" does not match its own coordinates; the store validates this, so a cell reaching here in that state means it was constructed rather than read`,
    );
  }
  if (cell.taskId !== task.id) {
    throw new TypeError(
      `cell "${cell.key}" was harvested against task "${task.id}"; a cell scored against the wrong task produces a full set of plausible numbers with nothing behind them`,
    );
  }

  if (cell.outcome === 'failed') {
    const { metrics, unmeasured } = blank(
      'the cell failed and produced no report, so nothing about this backend was measured here. It counts against the completion rate and reaches no metric denominator.',
    );
    return record(input, metrics, unmeasured, NO_REGISTRY, NO_DATING, 'absent', []);
  }

  if (report === undefined || report === '') {
    const { metrics, unmeasured } = blank(
      'the cell completed but its report could not be read from the store, so this is a gap in the reporting pipeline rather than a result about the backend.',
    );
    return record(input, metrics, unmeasured, NO_REGISTRY, NO_DATING, 'absent', [
      `${cell.key}: the report at ${cell.reportPath} could not be read`,
    ]);
  }

  const { metrics, unmeasured } = blank('not measured');
  const gaps: string[] = [];

  // Accuracy first: its recovery record is exactly the input calibration takes,
  // which is why the answer ids in the task format are required rather than
  // optional. Re-deriving it here would be a second implementation of the rule.
  const accuracy = scoreAccuracy(report, task);
  set(
    metrics,
    unmeasured,
    'accuracy',
    accuracy.status === 'scored' ? accuracy.share : null,
    accuracy.status === 'scored' ? '' : accuracy.why,
  );

  const calibration = scoreCalibration(report, task, factRecovery(accuracy));
  set(
    metrics,
    unmeasured,
    'calibration-brier',
    calibration.status === 'scored' ? calibration.brier : null,
    calibration.status === 'scored' ? '' : calibration.why,
  );

  const relevance = scoreRelevance(report, task);
  set(
    metrics,
    unmeasured,
    'relevance',
    relevance.status === 'scored' ? relevance.score : null,
    relevance.status === 'scored' ? '' : relevance.why,
  );

  const refusal = scoreRefusal(report, task);
  set(
    metrics,
    unmeasured,
    'refusal',
    refusal.status === 'scored' ? refusal.score : null,
    refusal.status === 'scored' ? '' : refusal.why,
  );

  const dueWeight = scoreDueWeight(task, { text: report });
  set(
    metrics,
    unmeasured,
    'dissent-recall',
    dueWeight.dissentRecall.measured ? dueWeight.dissentRecall.score : null,
    dueWeight.dissentRecall.measured ? '' : dueWeight.dissentRecall.reason,
  );
  set(
    metrics,
    unmeasured,
    'conflict-acknowledgement',
    dueWeight.conflictAcknowledgement.measured ? dueWeight.conflictAcknowledgement.score : null,
    dueWeight.conflictAcknowledgement.measured ? '' : dueWeight.conflictAcknowledgement.reason,
  );
  set(
    metrics,
    unmeasured,
    'false-balance',
    dueWeight.falseBalance.measured ? dueWeight.falseBalance.score : null,
    dueWeight.falseBalance.measured ? '' : dueWeight.falseBalance.reason,
  );

  const cited = sourceUniverse(report);
  // One pass builds both the graded source list and the counts printed beside
  // the score, so the denominator on the report can never disagree with the
  // figure above it.
  const { sources: recencySources, dating } = recencyInputs(
    cited,
    evidence === undefined ? [] : evidence.pages,
  );
  const recency = scoreRecency(recencySources, task.asOf);
  set(
    metrics,
    unmeasured,
    'recency-fresh-share',
    recency.status === 'scored' ? recency.freshShare : null,
    recency.status === 'scored' ? '' : recency.why,
  );
  set(metrics, unmeasured, 'report-chars', cell.reportChars, '');

  // Citation integrity and source quality both need the snapshot. Scored with
  // `undefined` when there is none, so the scorer's own `no-evidence` arm
  // decides what that means rather than this file guessing.
  const citation = scoreCitationIntegrity(report, evidence);
  const evidenceState: EvidenceState = evidence === undefined ? 'absent' : 'present';
  const noEvidence =
    'no citation evidence snapshot was collected for this cell, so nothing about its citations was checked. This is a gap in the collection pass, not a result about the backend.';

  if (citation.status === 'scored') {
    set(
      metrics,
      unmeasured,
      'citation-accuracy',
      citation.citationAccuracy,
      'nothing was cited, or no cited pair\'s support could be decided. An undecided pair leaves the denominator rather than counting as wrong.',
    );
    set(
      metrics,
      unmeasured,
      'citation-thoroughness',
      citation.citationThoroughness,
      'no supported pair to divide by, or the pair budget bound',
    );
    set(
      metrics,
      unmeasured,
      'source-necessity',
      citation.sourceNecessity,
      'nothing in the support matrix could be decided',
    );
    set(
      metrics,
      unmeasured,
      'resolvability',
      citation.resolvability.liveRate,
      'no citation resolved to a checkable answer',
    );
    set(metrics, unmeasured, 'citation-sources', citation.volume.sources, '');
    set(
      metrics,
      unmeasured,
      'citations-per-statement',
      citation.volume.citationsPerStatement,
      'the report has no statement outside its source list',
    );
  } else {
    const why = evidence === undefined ? noEvidence : citation.why;
    for (const id of [
      'citation-accuracy',
      'citation-thoroughness',
      'source-necessity',
      'resolvability',
    ] as const) {
      set(metrics, unmeasured, id, null, why);
    }
    // Volume survives the unmeasurable arm, because it is computed from the
    // report alone and is exactly the number that must not disappear when
    // accuracy cannot be computed. That asymmetry is the whole point of
    // keeping them apart.
    set(metrics, unmeasured, 'citation-sources', citation.volume.sources, '');
    set(
      metrics,
      unmeasured,
      'citations-per-statement',
      citation.volume.citationsPerStatement,
      'the report has no statement outside its source list',
    );
    if (evidence === undefined) gaps.push(`${cell.key}: no citation evidence snapshot`);
  }

  const registry: RegistryCounts =
    citation.status === 'scored'
      ? {
          present: citation.registryTotal.present,
          absent: citation.registryTotal.absent,
          unchecked: citation.registryTotal.unchecked,
          invalid: citation.registryTotal.invalid,
        }
      : NO_REGISTRY;

  const pages = evidence === undefined ? [] : evidence.pages.map((p) => ({ url: p.url, text: p.text }));
  const sourceQuality = scoreSourceQuality(cited, pages);
  if (sourceQuality.status === 'scored') {
    set(metrics, unmeasured, 'independent-domains', sourceQuality.rawIndependentDomains, '');
    // The collapsed count is withheld when no page text was compared, and this
    // is not fussiness. With nothing to compare, the collapsed count is
    // identical to the raw one by construction, and printing it would assert
    // that syndication was looked for and not found. Four domains carrying one
    // wire story would report as four independent sources with a column
    // implying somebody checked.
    set(
      metrics,
      unmeasured,
      'independent-domains-collapsed',
      sourceQuality.comparedPages === 0 ? null : sourceQuality.collapsedIndependentDomains,
      'no page text was available to compare, so no syndication could be detected. The collapsed count would equal the raw one and would falsely imply the check ran.',
    );
  } else {
    set(metrics, unmeasured, 'independent-domains', null, sourceQuality.why);
    set(metrics, unmeasured, 'independent-domains-collapsed', null, sourceQuality.why);
  }

  return record(input, metrics, unmeasured, registry, dating, evidenceState, gaps);
}
