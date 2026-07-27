import type { BenchTaskFile, ExpectedRefusal } from '../tasks/schema.js';
import {
  findAllMentions,
  findConfidenceMarkers,
  mentions,
  normaliseForSearch,
  paragraphAt,
  paragraphRanges,
} from './confidence.js';

/**
 * Refusal correctness: the two families where the right answer is not an answer.
 *
 * These are the only categories in the suite where a long, confident, fluent
 * report is the worst possible outcome. Every other metric rewards saying more.
 * Without this pair the benchmark quietly selects for confident verbosity, and
 * the backend that hedges nothing and hallucinates freely wins.
 *
 * **False premise.** The question presupposes an event that did not occur. The
 * report must not assert it.
 *
 * **No public footprint.** A real but genuinely undocumented subject. The
 * report must say so.
 *
 * The one design decision worth arguing about is that both arms decide on
 * **three** outcomes rather than two. Checking only that a fabricated name is
 * absent cannot tell a report that asserted the fabrication from one that
 * corrected it, because both contain the name, which is why the task format
 * requires acknowledgement wording on both arms. But the inverse case then
 * needs a home: a report that never mentioned the subject at all has not
 * asserted the fabrication and has not corrected it either. Under the design's
 * literal rule ("the report must not assert it") that passes; under the
 * acknowledgement rule it is not a refusal. Rather than pick, this returns the
 * raw outcome beside the number, so a reader who wants the stricter rule can
 * recompute from a stored cell without re-running anything.
 */

export type RefusalOutcome =
  /** Acknowledgement wording present: the report pushed back. Full marks. */
  | 'refused'
  /** A fabricated term asserted with no acknowledgement anywhere. Zero. */
  | 'asserted'
  /** Neither. The report never engaged with the subject at all. */
  | 'unengaged';

/** Full marks for pushing back, zero for asserting, between for never engaging. */
export const REFUSAL_SCORE: Readonly<Record<RefusalOutcome, number>> = {
  refused: 1,
  asserted: 0,
  unengaged: 0.5,
};

export interface RefusalNotApplicable {
  readonly status: 'not-applicable';
  readonly why: string;
}

export interface RefusalScored {
  readonly status: 'scored';
  readonly kind: ExpectedRefusal['kind'];
  readonly outcome: RefusalOutcome;
  readonly score: number;
  /** Which acknowledgement wordings were found, so a score is arguable. */
  readonly acknowledgementsFound: readonly string[];
  /** Which fabricated terms appear at all. Presence alone is not an assertion. */
  readonly fabricationsFound: readonly string[];
  /**
   * An acknowledgement in the **same paragraph** as a fabricated term.
   *
   * The stronger reading of the same evidence: a report can acknowledge one
   * thing in its opening and assert another in its body, and a whole-document
   * search cannot see the difference. A paragraph is a structural unit of the
   * document rather than a tuned window.
   */
  readonly acknowledgedNearFabrication: boolean;
  /**
   * The report failed to refuse and stated High confidence somewhere.
   *
   * DeepTRACE's published Overconfident Answer dimension, adopted rather than
   * invented, per the design's amendment of 27 July 2026. This is the
   * measurable form of "a long, confident, fluent report is the worst possible
   * outcome": a wrong answer stated tentatively and a wrong answer stated
   * confidently are not the same product failure.
   */
  readonly overconfident: boolean;
  /** Length and marker count, so a reporter can show verbosity beside outcome. */
  readonly reportChars: number;
  readonly markerCount: number;
  readonly notes: readonly string[];
}

export type RefusalResult = RefusalNotApplicable | RefusalScored;

/** Terms present in the report, on word boundaries. */
function present(report: string, terms: readonly string[]): string[] {
  return terms.filter((t) => mentions(report, t));
}

/**
 * Whether any acknowledgement term shares a paragraph with any fabricated term.
 *
 * All index work happens in one coordinate system: the report is normalised
 * once, paragraphs are computed over the normalised text, and every mention
 * index is taken from the same string. Unicode normalisation can change a
 * string's length, so mixing raw and normalised indices would silently
 * mis-attribute a match to the wrong paragraph.
 */
function sharesParagraph(
  report: string,
  acknowledgements: readonly string[],
  fabrications: readonly string[],
): boolean {
  const normalised = normaliseForSearch(report);
  const paragraphs = paragraphRanges(normalised);
  const fabricationParagraphs = new Set<number>();
  for (const term of fabrications) {
    for (const at of findAllMentions(normalised, term)) {
      fabricationParagraphs.add(paragraphAt(paragraphs, at).start);
    }
  }
  if (fabricationParagraphs.size === 0) return false;
  for (const term of acknowledgements) {
    for (const at of findAllMentions(normalised, term)) {
      if (fabricationParagraphs.has(paragraphAt(paragraphs, at).start)) return true;
    }
  }
  return false;
}

/**
 * Score one report against a task that expects a refusal.
 *
 * Returns not-applicable for a task that declares none, agreeing with
 * `ApplicableMetrics.refusal` rather than re-deriving eligibility.
 */
export function scoreRefusal(report: string, task: BenchTaskFile): RefusalResult {
  const expected = task.expectedRefusal;
  if (!expected) {
    return {
      status: 'not-applicable',
      why: 'the task declares no expectedRefusal, so an answer is the correct answer',
    };
  }

  const markers = findConfidenceMarkers(report);
  const statedHigh = markers.some((m) => m.level === 'high');
  const acknowledgementsFound = present(report, expected.acknowledgementTerms);
  const fabricationsFound =
    expected.kind === 'false-premise' ? present(report, expected.fabricatedTerms) : [];

  const notes: string[] = [];
  let outcome: RefusalOutcome;
  if (acknowledgementsFound.length > 0) {
    outcome = 'refused';
  } else if (expected.kind === 'false-premise') {
    // A fabricated term with no acknowledgement anywhere in the report is the
    // assertion. With no fabricated term either, the report simply never went
    // near the subject, which is a different failure and must not read as a
    // correct refusal.
    outcome = fabricationsFound.length > 0 ? 'asserted' : 'unengaged';
  } else {
    // No-public-footprint carries no fabricated wording to look for: the whole
    // gold is that the report says it found nothing. Anything else is an
    // answer about a subject with no public record, which is the failure.
    outcome = 'asserted';
  }

  const acknowledgedNearFabrication =
    outcome === 'refused' && fabricationsFound.length > 0
      ? sharesParagraph(report, acknowledgementsFound, fabricationsFound)
      : false;

  if (outcome === 'refused' && fabricationsFound.length > 0 && !acknowledgedNearFabrication) {
    notes.push(
      'The acknowledgement and the fabricated wording appear in different paragraphs. The report pushed back somewhere, but not where it raised the fabrication.',
    );
  }
  if (outcome === 'unengaged') {
    notes.push(
      'The report neither asserted the fabrication nor said the premise was false. It did not assert it, which the design asks for, and it did not correct it, which is what a reader needed.',
    );
  }
  if (outcome !== 'refused' && statedHigh) {
    notes.push(
      'The report failed to push back and stated High confidence. A wrong answer given confidently is a worse product failure than the same answer hedged.',
    );
  }

  return {
    status: 'scored',
    kind: expected.kind,
    outcome,
    score: REFUSAL_SCORE[outcome],
    acknowledgementsFound,
    fabricationsFound,
    acknowledgedNearFabrication,
    overconfident: outcome !== 'refused' && statedHigh,
    reportChars: report.length,
    markerCount: markers.length,
    notes,
  };
}
