import { canonicaliseUrl } from '../../../../src/research/corroborate.js';
import { extractCitedUrls } from '../../../../src/research/report.js';
import type { BenchTask } from '../../tasks/corpus.js';
import type { ConflictingFigure, FringeClaim, TaskCategory } from '../../tasks/schema.js';
import { extractNumericMentions, type NumericMention } from './numbers.js';
import { withinTolerance } from '../numbers.js';
import {
  PROXIMITY_CHARS,
  containsTerm,
  findNearbyCue,
  findTermPositions,
  normaliseForMatch,
} from './text.js';

/**
 * Due weight: whether a report kept a genuine minority position, and whether it
 * manufactured one that was never there.
 *
 * The failure being measured is **consensus collapse** — a real dissenting
 * position dropped because the weight of published material sits on the other
 * side. It is scoreable without a model only because the task author names the
 * dissent in advance, at a known URL with a distinguishing term, so at scoring
 * time there is nothing to judge and everything to look up.
 *
 * ## Three metrics, and why the third one is the whole item
 *
 * 1. **Dissent recall.** Did the report reach the dissenting source the author
 *    recorded, by citing it or by using its distinguishing term?
 * 2. **Conflict acknowledgement.** Where two authoritative sources give
 *    different figures, did the report carry both, or flag the disagreement?
 *    Stating one number as settled when two exist is the failure.
 * 3. **False-balance guard.** On a question that is genuinely settled and has a
 *    documented fringe claim, did the report present the fringe claim as though
 *    it were contested?
 *
 * The first two, alone, **reward hedging**. A backend that presents every
 * question as contested cites every dissent, uses every distinguishing term and
 * reports every figure, and scores perfectly on both while being useless. The
 * guard is the counterweight, and it is what makes due weight mean *due* rather
 * than *equal*.
 *
 * ## Why the headline number is a suite-level harmonic mean
 *
 * Two decisions follow from the guard living on different tasks from the other
 * two metrics, and both are load-bearing.
 *
 * **Suite level, not per task.** The guard is recorded on `settled-with-fringe`
 * tasks and the other two on `contested` tasks, so no single task can carry all
 * three. A per-task overall could never express the trade the metric exists to
 * make.
 *
 * **Each metric counts once, and the combination is harmonic.** Averaging over
 * tasks lets ninety contested tasks drown ten fringe tasks, which is exactly the
 * dilution the guard exists to prevent. And the *arithmetic* mean of three
 * metrics reads a perfect hedger — 1.0, 1.0, 0.0 — as 0.67, which is not "badly
 * overall", it is a passing grade. The harmonic mean reads it as 0. It is the
 * only common aggregation where being excellent at two of three things and
 * useless at the third does not average out to respectable.
 *
 * The cost is real and is stated rather than hidden: the harmonic mean collapses
 * to 0 whenever any component is 0, so a perfect hedger and a backend that found
 * nothing at all both score 0 overall. Every component is reported beside it, so
 * nothing is concealed; the overall's job is to refuse to rank a hedger above an
 * honest backend, not to rank two different failures against each other.
 *
 * **The overall is withheld entirely when no fringe task ran.** Without the
 * counterweight the number rewards indiscriminate hedging, and a caveat printed
 * next to a number is read as a number.
 *
 * ## What this measures, and what it does not
 *
 * Every result carries `limits` in words, and they travel into the report rather
 * than living in a document nobody opens. The brief is explicit that the synonym
 * limit must be *stated in the output rather than hidden*, and the same
 * discipline is applied to every other approximation made here.
 */

/** Half credit for flagging a disagreement without carrying the figures. */
export const FLAGGED_ONLY_CREDIT = 0.5;

/**
 * How close the declared unit must sit to a figure to be reported as present.
 *
 * Much tighter than `PROXIMITY_CHARS`, because a unit belongs to a number rather
 * than to a passage: `USD 1.2bn` and `1.2 billion USD` are the shapes this is
 * looking for, and a currency mentioned two sentences away says nothing about
 * this figure.
 */
export const UNIT_PROXIMITY_CHARS = 24;

/**
 * The wording that counts as flagging a disagreement.
 *
 * The task schema records the clashing figures and their sources but **no
 * wording for a flag**, and the brief asks for "contained both, *or explicitly
 * flagged the disagreement*". A fixed vocabulary within a proximity window is
 * the only mechanical answer, so it is exported and enumerated rather than
 * buried: a reader can see exactly what was checked, and the limit that other
 * phrasings score as not-flagged is stated in the output.
 *
 * Inflections are listed rather than stemmed, because matching is literal and
 * boundary-respecting: stemming `contest` would find `contestant`.
 */
export const DISAGREEMENT_CUES: readonly string[] = [
  'disagree',
  'disagrees',
  'disagreed',
  'disagreement',
  'conflicting',
  'conflicts with',
  'contradict',
  'contradicts',
  'contradictory',
  'discrepancy',
  'discrepancies',
  'differ',
  'differs',
  'differing',
  'sources differ',
  'estimates vary',
  'figures vary',
  'no consensus',
  'disputed',
  'contested',
  'inconsistent',
  'at odds',
  'two figures',
  'both figures',
  'different sources',
  'other sources',
  'depending on the source',
  'variously reported',
  'ranges from',
  'somewhere between',
];

/**
 * The stated limits, as constants so a scorecard and a test cite one wording.
 *
 * These are not decoration. The acceptance criterion for this item requires the
 * synonym limit to appear *in the output*, and the rest of the approximations
 * this scorer makes are held to the same standard.
 */
export const DUE_WEIGHT_LIMITS = {
  literalTerm:
    'Dissent recall counts an exactly-cited URL or the literal distinguishing term. A report reaching the same position in its own words, or with a synonym of the term, does not score recall.',
  urlIdentity:
    'A dissenting source is matched on its canonical URL, so the http or https scheme, a www prefix, a trailing slash, a tracking parameter and a fragment are all ignored. A non-tracking query parameter is significant, and another rendering of the same document at a different path is not recognised as the same source.',
  disagreementVocabulary: `A disagreement counts as flagged only when one of ${String(DISAGREEMENT_CUES.length)} fixed cue phrases appears within ${String(PROXIMITY_CHARS)} characters of the quantity as the task names it, or of a figure the report did state. A report flagging the disagreement in other wording is scored as not flagging it.`,
  unitNotGating:
    'A conflicting figure is matched on its value under the tolerance the task declares. The declared unit is reported where it appears near the figure and does not gate the match, because requiring the unit token would miss a figure written with a currency symbol.',
  rejectionProximity: `A fringe claim counts as rejected when one of its recorded rejection cues appears within ${String(PROXIMITY_CHARS)} characters of a mention of its distinguishing term, One rejected mention is enough, so a report that dismissed the claim and then listed its source again is not penalised. Where a task records several fringe claims close together, a single cue can credit more than one of them, so a report that dismisses one claim and entertains another inside the same window is scored as rejecting both.`,
  fringeTermOnly:
    'A fringe claim counts as raised when the report uses its literal distinguishing term or cites its source. A report that paraphrases the claim in its own words and cites nothing is invisible to the guard, the same limit dissent recall carries and for the same reason.',
  guardNotExercised:
    'The false-balance guard scored without being exercised: no report in this set raised any recorded fringe claim, so nothing put the guard to the question. That is the correct outcome for a backend that did not hedge, and it is also what a backend that answered nothing produces, so read it beside dissent recall rather than on its own.',
  harmonicOverall:
    'The overall is the harmonic mean of the metric means, each metric counting once regardless of how many tasks fed it. That is what stops a perfect hedger, which scores 1 on recall and 0 on the guard, averaging out to a passing grade.',
} as const;

/**
 * The half of a report this scorer reads.
 *
 * Structural on purpose. BENCH-02 owns the canonical run record and does not
 * exist yet, so a harness can satisfy this shape without importing anything from
 * here. When `citedUrls` is omitted it is derived from `text` with the product's
 * own extractor, which is what stops a report and its citation list disagreeing.
 */
export interface ScoredReport {
  readonly text: string;
  readonly citedUrls?: readonly string[] | undefined;
}

/** A metric a task cannot support is not zero, and must never be summed as one. */
export interface NotMeasured {
  readonly measured: false;
  readonly reason: string;
}
export type Measured<T> = ({ readonly measured: true } & T) | NotMeasured;

export type DissentReach = 'url' | 'term' | 'url-and-term' | 'missed';

export interface DissentFinding {
  readonly url: string;
  readonly distinguishingTerm: string;
  readonly reachedBy: DissentReach;
}

export interface DissentRecall {
  readonly score: number;
  readonly reached: number;
  readonly total: number;
  readonly findings: readonly DissentFinding[];
}

/**
 * `one-sided` and `unaddressed` both score zero and are named apart on purpose.
 * One is a report that picked a side of a disagreement it never disclosed; the
 * other never went near the quantity. A scorecard that conflates them tells the
 * reader less than one that does not.
 */
export type ConflictOutcome = 'both-figures' | 'flagged-only' | 'one-sided' | 'unaddressed';

export interface ConflictValueFinding {
  readonly id: string;
  readonly expected: number;
  readonly unit: string;
  readonly found: boolean;
  /** What the report actually wrote, where it was found. */
  readonly matchedText?: string | undefined;
  /** Reported, never scored on. See `DUE_WEIGHT_LIMITS.unitNotGating`. */
  readonly unitNearby: boolean;
}

export interface ConflictFinding {
  readonly quantity: string;
  readonly outcome: ConflictOutcome;
  readonly score: number;
  readonly disagreementFlagged: boolean;
  /** The cue that fired, so the finding names it rather than only asserting it. */
  readonly matchedCue?: string | undefined;
  readonly values: readonly ConflictValueFinding[];
}

export interface ConflictAcknowledgement {
  readonly score: number;
  readonly findings: readonly ConflictFinding[];
}

export type FringeOutcome = 'not-surfaced' | 'surfaced-and-rejected' | 'surfaced-as-contested';

export interface FringeFinding {
  readonly distinguishingTerm: string;
  readonly outcome: FringeOutcome;
  readonly score: number;
  readonly matchedCue?: string | undefined;
}

export interface FalseBalanceGuard {
  readonly score: number;
  /**
   * How many recorded fringe claims the report raised at all, however it framed
   * them.
   *
   * Reported because a perfect guard score is ambiguous on its own. A report
   * that says nothing scores 1 here, correctly — it did not present a fringe
   * claim as contested — but so does a report that engaged with the question
   * properly, and those are not the same thing. Zero surfaced across a whole run
   * means the guard passed **without ever being exercised**, which the summary
   * says out loud rather than letting a clean column imply a test that happened.
   */
  readonly surfaced: number;
  readonly findings: readonly FringeFinding[];
}

export interface DueWeightScore {
  readonly taskId: string;
  readonly category: TaskCategory;
  readonly dissentRecall: Measured<DissentRecall>;
  readonly conflictAcknowledgement: Measured<ConflictAcknowledgement>;
  readonly falseBalance: Measured<FalseBalanceGuard>;
  /** What was measured and what was not, in words, carried into the report. */
  readonly limits: readonly string[];
}

/**
 * One source's identity, for deciding whether a report cited it.
 *
 * `canonicaliseUrl` does the work — tracking parameters, `www.`, a trailing
 * slash and a fragment all collapse — but it deliberately **preserves the
 * scheme**, because it exists to count independent sources for corroboration
 * and there `http` and `https` are two strings it has no business equating.
 * Measured rather than assumed: it returns `http://example.org/a` and
 * `https://example.org/a` unchanged and distinct.
 *
 * For dissent recall they are the same document, and a report citing the `http`
 * form of a source the author recorded as `https` has plainly reached it. So the
 * scheme fold is layered on here rather than pushed into the product's function:
 * a benchmark that edits the behaviour it is measuring to make its own numbers
 * nicer has stopped being a benchmark.
 */
function sourceIdentity(raw: string): string {
  return canonicaliseUrl(raw).replace(/^http:\/\//i, 'https://');
}

function citesUrl(citedIdentities: ReadonlySet<string>, target: string): boolean {
  return citedIdentities.has(sourceIdentity(target));
}

function scoreDissent(
  task: BenchTask,
  normalised: string,
  citedCanonical: ReadonlySet<string>,
): Measured<DissentRecall> {
  if (!task.applicableMetrics.dissentRecall) {
    return { measured: false, reason: 'the task records no knownDissent' };
  }
  if (task.knownDissent.length === 0) {
    return {
      measured: false,
      reason: 'the task declares dissent recall applicable but records no knownDissent entries',
    };
  }

  const findings = task.knownDissent.map((dissent): DissentFinding => {
    const byUrl = citesUrl(citedCanonical, dissent.url);
    const byTerm = containsTerm(normalised, dissent.distinguishingTerm);
    const reachedBy: DissentReach =
      byUrl && byTerm ? 'url-and-term' : byUrl ? 'url' : byTerm ? 'term' : 'missed';
    return { url: dissent.url, distinguishingTerm: dissent.distinguishingTerm, reachedBy };
  });

  const reached = findings.filter((f) => f.reachedBy !== 'missed').length;
  return {
    measured: true,
    score: reached / findings.length,
    reached,
    total: findings.length,
    findings,
  };
}

/**
 * Give each gold value at most one distinct mention, matching as many as
 * possible.
 *
 * **One stated number must not satisfy two gold values.** Without that rule, a
 * report stating a single figure scores as having disclosed a disagreement it
 * never mentioned whenever two recorded values have overlapping tolerances,
 * which is a score over a check that did not happen and the worst failure this
 * scorer can have.
 *
 * Claiming greedily in value order enforces the rule but answers the wrong
 * question: a loose value can take the one mention a tighter value uniquely
 * needed, and then a report that did state both figures is reported one-sided.
 * That error runs in the direction the whole benchmark is most careful about,
 * because a false negative makes every backend look worse than it is.
 *
 * So this is a maximum bipartite matching (Kuhn's augmenting paths) rather than
 * a greedy pass. A gold set carries at most ten values, so the cost is nothing
 * and the answer no longer depends on the order the author happened to write
 * them in. Candidates are walked in report order, so where the assignment is
 * free the earliest mention wins and the quoted text is the first one a reader
 * would find.
 */
function assignMentions(
  values: ConflictingFigure['values'],
  mentions: readonly NumericMention[],
): (NumericMention | null)[] {
  // Candidates are distinct NUMBERS, not distinct mentions. Matching over
  // mentions enforces one mention per value and still lets one number satisfy
  // two values whenever a report repeats it, which reports do constantly:
  // abstract, body, table. `Revenue was 1.18 billion. As noted, revenue was 1.18
  // billion.` scored `both-figures` against gold of 1.2bn and 1.15bn, both at
  // ten percent, disclosing a disagreement the report never made. Found by an
  // out-of-family reviewer against the earlier mention-based matching.
  const firstByValue = new Map<number, number>();
  for (let i = 0; i < mentions.length; i += 1) {
    const m = mentions[i];
    if (m !== undefined && !firstByValue.has(m.value)) firstByValue.set(m.value, i);
  }
  const distinct = [...firstByValue.values()].sort((a, b) => a - b);
  const candidates = values.map((value) =>
    distinct.filter((i) => {
      const m = mentions[i];
      return m !== undefined && withinTolerance(m.value, value.value, value.tolerance);
    }),
  );
  const holderOfMention = new Map<number, number>();

  const augment = (vi: number, seen: Set<number>): boolean => {
    for (const mi of candidates[vi] ?? []) {
      if (seen.has(mi)) continue;
      seen.add(mi);
      const holder = holderOfMention.get(mi);
      if (holder === undefined || augment(holder, seen)) {
        holderOfMention.set(mi, vi);
        return true;
      }
    }
    return false;
  };

  for (let vi = 0; vi < values.length; vi += 1) augment(vi, new Set<number>());

  const out: (NumericMention | null)[] = values.map(() => null);
  for (const [mi, vi] of holderOfMention) out[vi] = mentions[mi] ?? null;
  return out;
}

function scoreOneConflict(
  figure: ConflictingFigure,
  normalised: string,
  mentions: readonly NumericMention[],
): ConflictFinding {
  const assigned = assignMentions(figure.values, mentions);
  const anchors: number[] = [];
  const values = figure.values.map((value, vi): ConflictValueFinding => {
    const hit = assigned[vi] ?? null;
    if (hit !== null) anchors.push(hit.index);
    const unitNearby =
      hit !== null &&
      findNearbyCue(normalised, [hit.index], [value.unit], UNIT_PROXIMITY_CHARS) !== null;
    return {
      id: value.id,
      expected: value.value,
      unit: value.unit,
      found: hit !== null,
      matchedText: hit?.text,
      unitNearby,
    };
  });

  const found = values.filter((v) => v.found).length;

  // The anchor is the quantity where the report names it, and any figure that
  // was found where it does not. Without the fallback, a report that stated a
  // figure and called the evidence inconsistent, but never used the author's
  // exact phrasing of the quantity, reads as not having flagged anything.
  const allAnchors = [...new Set([...findTermPositions(normalised, figure.quantity), ...anchors])]
    .sort((a, b) => a - b);
  const matchedCue = findNearbyCue(normalised, allAnchors, DISAGREEMENT_CUES, PROXIMITY_CHARS);
  const disagreementFlagged = matchedCue !== null;

  const outcome: ConflictOutcome =
    found === values.length
      ? 'both-figures'
      : disagreementFlagged
        ? 'flagged-only'
        : found > 0
          ? 'one-sided'
          : 'unaddressed';
  const score =
    outcome === 'both-figures' ? 1 : outcome === 'flagged-only' ? FLAGGED_ONLY_CREDIT : 0;

  return {
    quantity: figure.quantity,
    outcome,
    score,
    disagreementFlagged,
    matchedCue: matchedCue ?? undefined,
    values,
  };
}

function scoreConflicts(
  task: BenchTask,
  normalised: string,
  mentions: readonly NumericMention[],
): Measured<ConflictAcknowledgement> {
  if (!task.applicableMetrics.conflictAcknowledgement) {
    return { measured: false, reason: 'the task records no conflictingFigures' };
  }
  if (task.conflictingFigures.length === 0) {
    return {
      measured: false,
      reason:
        'the task declares conflict acknowledgement applicable but records no conflictingFigures',
    };
  }

  const findings = task.conflictingFigures.map((f) => scoreOneConflict(f, normalised, mentions));
  const total = findings.reduce((sum, f) => sum + f.score, 0);
  return { measured: true, score: total / findings.length, findings };
}

/**
 * Attribute each rejection cue to the claim it is actually about.
 *
 * A cue belongs to the claim it **follows**: a report states a claim and then
 * dismisses it. So a cue is attributed to the nearest raised claim before it,
 * and only to the nearest one after it when nothing precedes it in the window.
 *
 * The bare proximity rule this replaces was defeated by one sentence. An
 * out-of-family reviewer demonstrated it: `There is no evidence for the first of
 * these readings. That said, fringe readings 0 to 5 are all argued by serious
 * people` scored a perfect 1.0 while presenting six documented fringe claims as
 * live controversies, because one cue sat within the window of all six.
 *
 * Attributing to the nearest claim in *either* direction was tried first and is
 * worse than both: a report dismissing four claims in sequence has each cue
 * sitting nearer the NEXT claim's mention than the one it belongs to, so three
 * of four score as false balance. Reading direction is what separates the two
 * cases, and it is free.
 */
function attributeCue(
  cueAt: number,
  ownMentions: readonly number[],
  otherMentions: readonly number[],
): boolean {
  const before = (xs: readonly number[]): number | null => {
    let best: number | null = null;
    for (const x of xs) if (x <= cueAt && cueAt - x <= PROXIMITY_CHARS) best = x;
    return best;
  };
  const after = (xs: readonly number[]): number | null => {
    for (const x of xs) if (x > cueAt && x - cueAt <= PROXIMITY_CHARS) return x;
    return null;
  };

  const ownBefore = before(ownMentions);
  const otherBefore = before(otherMentions);
  if (ownBefore !== null) return otherBefore === null || ownBefore >= otherBefore;
  if (otherBefore !== null) return false;

  const ownAfter = after(ownMentions);
  const otherAfter = after(otherMentions);
  if (ownAfter === null) return false;
  return otherAfter === null || ownAfter <= otherAfter;
}

/**
 * Was this fringe claim raised in order to be dismissed, or presented as live?
 *
 * A claim counts as raised when the report uses its distinguishing term **or
 * cites its source**. The second door matters and was missing: the task author's
 * distinguishing term is private to the gold set, so a backend that cites the
 * fringe source and paraphrases the claim in its own words was invisible to the
 * guard and scored a perfect 1.0. Dissent recall has had both doors from the
 * start, and the asymmetry was the hole. Found by an out-of-family reviewer.
 */
function scoreOneFringe(
  claim: FringeClaim,
  normalised: string,
  ownMentions: readonly number[],
  otherMentions: readonly number[],
): FringeFinding {
  if (ownMentions.length === 0) {
    return { distinguishingTerm: claim.distinguishingTerm, outcome: 'not-surfaced', score: 1 };
  }

  for (const cue of claim.rejectionCues) {
    for (const at of findTermPositions(normalised, cue)) {
      if (attributeCue(at, ownMentions, otherMentions)) {
        return {
          distinguishingTerm: claim.distinguishingTerm,
          outcome: 'surfaced-and-rejected',
          score: 1,
          matchedCue: cue,
        };
      }
    }
  }

  return {
    distinguishingTerm: claim.distinguishingTerm,
    outcome: 'surfaced-as-contested',
    score: 0,
  };
}

function scoreFalseBalance(
  task: BenchTask,
  normalised: string,
  citedIdentities: ReadonlySet<string>,
): Measured<FalseBalanceGuard> {
  if (!task.applicableMetrics.falseBalance) {
    return { measured: false, reason: 'the task records no fringeClaims' };
  }
  if (task.fringeClaims.length === 0) {
    return {
      measured: false,
      reason: 'the task declares the false-balance guard applicable but records no fringeClaims',
    };
  }

  const anchorsPerClaim = task.fringeClaims.map((c) => {
    const positions = [...findTermPositions(normalised, c.distinguishingTerm)];
    // The source counts as raising the claim, so a paraphrase that cites it is
    // not invisible. The URL is looked for in the normalised text rather than
    // taken from the citation list, because a rejection cue has to be measured
    // against a position and a citation list carries none.
    if (citesUrl(citedIdentities, c.source.url)) {
      positions.push(...findTermPositions(normalised, c.source.url));
    }
    return [...new Set(positions)].sort((a, b) => a - b);
  });
  const findings = task.fringeClaims.map((c, i) =>
    scoreOneFringe(
      c,
      normalised,
      anchorsPerClaim[i] ?? [],
      anchorsPerClaim.flatMap((m, j) => (j === i ? [] : m)).sort((a, b) => a - b),
    ),
  );
  const raised = findings.filter((f) => f.outcome !== 'not-surfaced');

  // **The denominator is the claims the report actually raised, not every claim
  // the task records.** Averaging over all of them lets a claim nobody mentioned
  // pay for one that was framed as live: a task recording twenty fringe claims
  // where the report presents one as contested scores 19/20, and the whole
  // suite's overall lands at 0.98 for a backend doing exactly what this guard
  // exists to catch. Found by an out-of-family reviewer against an earlier
  // version whose fixture used one claim per task and so could not see it.
  //
  // Not surfacing a claim is a non-event, not a credit. The question the guard
  // asks is: of the fringe claims this report chose to raise, how many did it
  // frame as settled rather than live?
  const score = raised.length === 0 ? 1 : raised.filter((f) => f.score === 1).length / raised.length;

  return { measured: true, score, surfaced: raised.length, findings };
}

/**
 * Score one report against one task.
 *
 * Eligibility comes from BENCH-01's `applicableMetrics` and is never re-derived
 * here. That loader derives it once for exactly this reason: four scorers each
 * re-deriving one rule is how two implementations end up disagreeing about the
 * rule.
 */
export function scoreDueWeight(task: BenchTask, report: ScoredReport): DueWeightScore {
  const normalised = normaliseForMatch(report.text);
  const mentions = extractNumericMentions(normalised);
  // Extracted from the ORIGINAL text: normalisation lower-cases, and a URL path
  // is case-sensitive.
  const cited = report.citedUrls ?? extractCitedUrls(report.text);
  const citedCanonical = new Set(cited.map((u) => sourceIdentity(u)));

  const dissentRecall = scoreDissent(task, normalised, citedCanonical);
  const conflictAcknowledgement = scoreConflicts(task, normalised, mentions);
  const falseBalance = scoreFalseBalance(task, normalised, citedCanonical);

  const limits: string[] = [];
  if (dissentRecall.measured) {
    limits.push(DUE_WEIGHT_LIMITS.literalTerm, DUE_WEIGHT_LIMITS.urlIdentity);
  }
  if (conflictAcknowledgement.measured) {
    limits.push(DUE_WEIGHT_LIMITS.unitNotGating, DUE_WEIGHT_LIMITS.disagreementVocabulary);
  }
  if (falseBalance.measured) {
    limits.push(DUE_WEIGHT_LIMITS.rejectionProximity, DUE_WEIGHT_LIMITS.fringeTermOnly);
    // A claim with no recorded cues cannot be distinguished from one presented
    // as contested, so any mention scores zero. Said out loud, because a score
    // over a check that could not discriminate must not read like one that could.
    const uncued = task.fringeClaims.filter((c) => c.rejectionCues.length === 0);
    for (const claim of uncued) {
      limits.push(
        `Task "${task.id}" records no rejectionCues for the fringe term "${claim.distinguishingTerm}", so any mention of it is scored as false balance.`,
      );
    }
  }

  return {
    taskId: task.id,
    category: task.category,
    dissentRecall,
    conflictAcknowledgement,
    falseBalance,
    limits,
  };
}

export interface MetricMean {
  /** `null` when no task in the set could support the metric. Never zero. */
  readonly mean: number | null;
  readonly tasks: number;
}

export interface DueWeightSummary {
  readonly tasks: number;
  readonly dissentRecall: MetricMean;
  readonly conflictAcknowledgement: MetricMean;
  readonly falseBalance: MetricMean;
  /** Harmonic mean of the measured metric means. `null` when it cannot be trusted. */
  readonly overall: number | null;
  readonly overallReason: string;
  /** False when no task supplied a fringe claim, which is when `overall` is withheld. */
  readonly guardApplied: boolean;
  /**
   * Whether any fringe claim was actually raised by the report under test.
   *
   * A guard that scores 1 without this being true passed without being
   * exercised: nothing the report wrote ever put it to the question. That is the
   * *correct* outcome for a backend that did not hedge, and it is also what a
   * backend that said nothing at all produces, so the two are only separable by
   * reading dissent recall beside it. Surfaced here rather than left for a
   * reader to infer from a clean column.
   */
  readonly guardExercised: boolean;
  readonly limits: readonly string[];
}

function meanOf(values: readonly number[]): MetricMean {
  if (values.length === 0) return { mean: null, tasks: 0 };
  return { mean: values.reduce((a, b) => a + b, 0) / values.length, tasks: values.length };
}

function harmonicMean(values: readonly number[]): number {
  // Unreachable today, because every caller has at least one measured metric.
  // Left explicit rather than relying on that: `0 / 0` is NaN, and a NaN score
  // propagates silently through every comparison downstream.
  if (values.length === 0) return 0;
  if (values.some((v) => v <= 0)) return 0;
  return values.length / values.reduce((sum, v) => sum + 1 / v, 0);
}

/**
 * Combine per-task results into the suite-level answer.
 *
 * The two rules that make this metric mean anything are both here: each metric
 * counts once rather than once per task, and the combination is harmonic rather
 * than arithmetic. See the module comment for why either alternative hands a
 * perfect hedger a passing grade.
 */
export function aggregateDueWeight(scores: readonly DueWeightScore[]): DueWeightSummary {
  const dissentRecall = meanOf(
    scores.flatMap((s) => (s.dissentRecall.measured ? [s.dissentRecall.score] : [])),
  );
  const conflictAcknowledgement = meanOf(
    scores.flatMap((s) =>
      s.conflictAcknowledgement.measured ? [s.conflictAcknowledgement.score] : [],
    ),
  );
  const falseBalance = meanOf(
    scores.flatMap((s) => (s.falseBalance.measured ? [s.falseBalance.score] : [])),
  );

  const limits = [...new Set(scores.flatMap((s) => s.limits))];
  const guardApplied = falseBalance.tasks > 0;
  const guardExercised = scores.some((s) => s.falseBalance.measured && s.falseBalance.surfaced > 0);
  if (guardApplied && !guardExercised) {
    limits.push(DUE_WEIGHT_LIMITS.guardNotExercised);
  }

  const parts = [dissentRecall, conflictAcknowledgement, falseBalance].flatMap((m) =>
    m.mean === null ? [] : [m.mean],
  );

  if (scores.length === 0) {
    return {
      tasks: 0,
      dissentRecall,
      conflictAcknowledgement,
      falseBalance,
      overall: null,
      overallReason: 'No results were supplied, so there is nothing to aggregate.',
      guardApplied,
      guardExercised,
      limits,
    };
  }
  if (!guardApplied) {
    return {
      tasks: scores.length,
      dissentRecall,
      conflictAcknowledgement,
      falseBalance,
      overall: null,
      overallReason:
        'Withheld: no task in this set recorded a fringe claim, so the false-balance guard did not run. Dissent recall and conflict acknowledgement reward hedging on their own, so an overall computed without the counterweight would rank a backend that calls every question contested above one that does not. Add a settled-with-fringe task to make the overall meaningful.',
      guardApplied,
      guardExercised,
      limits,
    };
  }

  // A guard that scored without being exercised is the only thing measured here,
  // so the number says nothing about the backend: an empty report scored 1.0
  // overall on a fringe-only corpus, which an out-of-family reviewer found. The
  // withholding rule that already covers a missing guard covers this too.
  if (!guardExercised && parts.length < 2) {
    return {
      tasks: scores.length,
      dissentRecall,
      conflictAcknowledgement,
      falseBalance,
      overall: null,
      overallReason:
        'Withheld: the false-balance guard is the only metric this set could measure, and no report raised any recorded fringe claim, so it scored without being exercised. A report that said nothing at all would score the same. Add a contested task, or a report that engages with the question, for the overall to mean anything.',
      guardApplied,
      guardExercised,
      limits,
    };
  }

  const overall = harmonicMean(parts);
  const measuredNames = [
    dissentRecall.mean === null ? null : 'dissent recall',
    conflictAcknowledgement.mean === null ? null : 'conflict acknowledgement',
    'the false-balance guard',
  ].filter((n): n is string => n !== null);

  return {
    tasks: scores.length,
    dissentRecall,
    conflictAcknowledgement,
    falseBalance,
    overall,
    overallReason: `The harmonic mean of ${measuredNames.join(', ')}, each counting once regardless of how many tasks fed it. ${DUE_WEIGHT_LIMITS.harmonicOverall}`,
    guardApplied,
    guardExercised,
    limits: [...limits, DUE_WEIGHT_LIMITS.harmonicOverall],
  };
}
