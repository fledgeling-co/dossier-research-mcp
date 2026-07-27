import type { BenchTaskFile, GoldFact, GoldFactKind } from '../tasks/schema.js';
import type { FactRecovery } from './calibration.js';
import { findAllMentions, normaliseForSearch } from './confidence.js';
import { goldDay, readDates } from './dates.js';
import { isZeroWidthTolerance, readNumbers, shiftDecimal, toPlainString, withinTolerance } from './numbers.js';
import { extractProse, isNegated } from './prose.js';
import {
  foldScaleWord,
  matchUnitBefore,
  UNIT_LOOKBEHIND_CHARS,
  unitFamilyToken,
  unitSurfaceForms,
} from './units.js';

/**
 * Accuracy: did the report actually state the answers the gold set records.
 *
 * The share recovered, per task, computed by code from a gold set fixed before
 * the run. No model, no network, no filesystem.
 *
 * What makes this harder than a string search, and what the whole module is for:
 *
 * **Formatting is not an answer.** `1.2 billion`, `1,200,000,000` and `1.2B` are
 * one figure. A scorer that knows one spelling reports every backend as worse
 * than it is, and reports nothing about why, which is the silent failure the
 * brief calls out first.
 *
 * **A unit changes the answer.** A report stating the right figure with the
 * wrong unit scores zero for that fact, not partial credit. That is the reason
 * the task format requires a unit on every numeric answer, and `units.ts` is the
 * whole of the rule.
 *
 * **A citation is not prose.** A backend that pasted a URL containing the figure
 * did no reasoning, so matching runs over `extractProse` output rather than the
 * raw report.
 *
 * **A denied figure is still a figure.** A value appearing only inside a
 * negation is not recovered.
 *
 * The output is the record `scoreCalibration` takes as its input, keyed by the
 * stable answer id that the task format requires for exactly this seam. The type
 * is imported from that module rather than redeclared, because two declarations
 * of one contract eventually disagree about what the contract is.
 */

/** Why a fact was or was not recovered, in the scorer's own terms. */
export interface AccuracyFact {
  readonly id: string;
  readonly kind: GoldFactKind;
  readonly label: string | null;
  readonly recovered: boolean;
  /** The text that matched, as it appears in the searched prose. */
  readonly matchedText: string | null;
  readonly matchedAt: number | null;
  /** Which recorded string matched: the answer itself, or one of its aliases. */
  readonly via: 'value' | 'alias' | null;
  readonly alias: string | null;
  /**
   * Whether the report stated a unit next to the figure it matched.
   *
   * `unstated` is a match on the value alone and is deliberately permitted: the
   * corpus carries units like `CVSS v3.1 base score` that no report will ever
   * write out, and refusing those would be a false negative in the category the
   * brief says false negatives are most expensive. `stated` is a stronger
   * result, and reporting can discount the weaker one. Numbers only.
   */
  readonly unitEvidence: 'stated' | 'unstated' | null;
  /** True when the only occurrences found were inside a denial. */
  readonly negatedOnly: boolean;
  readonly why: string;
}

interface AccuracyCommon {
  /** What this score cannot see, in plain words. Always present, often empty. */
  readonly notes: readonly string[];
}

export interface AccuracyNotApplicable extends AccuracyCommon {
  readonly status: 'not-applicable';
  readonly why: string;
  /** Empty, so a caller threading this into calibration needs no special case. */
  readonly recovery: FactRecovery;
}

export interface AccuracyScored extends AccuracyCommon {
  readonly status: 'scored';
  /** Recovered over total. The number the design calls the share recovered. */
  readonly share: number;
  readonly recovered: number;
  readonly total: number;
  readonly facts: readonly AccuracyFact[];
  /** Exactly what `scoreCalibration` takes as its `recovered` argument. */
  readonly recovery: FactRecovery;
  /** Answers whose only occurrence was denied. Named, because it is arguable. */
  readonly negatedOnly: readonly string[];
  /** Answers matched with no unit stated beside them. */
  readonly unitUnstated: readonly string[];
}

export type AccuracyResult = AccuracyNotApplicable | AccuracyScored;

export interface AccuracyOptions {
  /**
   * Treat a value found only inside a denial as recovered anyway.
   *
   * Off by default. Here so the negation rule's effect can be measured rather
   * than argued about: running a corpus both ways says what it actually changed.
   */
  readonly ignoreNegation?: boolean | undefined;
}

const NEGATION_NOTE =
  'Negation is detected from a fixed cue list scoped to a clause, not by reading the sentence. It cannot see a denial phrased without one of those cues, and it is reported as the crude check it is rather than as comprehension.';

const UNSTATED_UNIT_NOTE =
  'Some answers matched a figure with no unit written beside it. That counts as recovered, because a report may leave an implied unit unwritten, but it is weaker evidence than a figure whose unit the report stated and belongs beside the score rather than inside it.';

/**
 * Score one report's accuracy against one task.
 *
 * Staleness is deliberately not consulted. A stale task loads, is scored, and is
 * counted as stale by the run harness, which prints the count before the run;
 * skipping one here would silently narrow the sample a score is computed over.
 */
export function scoreAccuracy(
  report: string,
  task: BenchTaskFile,
  options: AccuracyOptions = {},
): AccuracyResult {
  const notes: string[] = [];

  // Agrees with `ApplicableMetrics.accuracy` rather than re-deriving it: a
  // refusal task carries no answers, so its accuracy is not applicable and must
  // never reach a denominator as a zero.
  if (task.goldFacts.length === 0) {
    return {
      status: 'not-applicable',
      why: 'the task records no gold facts, so there is no answer to look for',
      recovery: {},
      notes,
    };
  }

  const prose = normaliseForSearch(extractProse(report));
  const facts: AccuracyFact[] = [];
  const recovery: Record<string, boolean> = {};
  const negatedOnly: string[] = [];
  const unitUnstated: string[] = [];
  let sawNegation = false;
  let sawZeroWidth = false;

  for (const fact of task.goldFacts) {
    const result = scoreOne(prose, fact, options.ignoreNegation === true);
    facts.push(result);
    recovery[fact.id] = result.recovered;
    if (result.negatedOnly) {
      sawNegation = true;
      negatedOnly.push(fact.id);
    }
    if (result.recovered && result.unitEvidence === 'unstated') unitUnstated.push(fact.id);
    if (fact.kind === 'number' && isZeroWidthTolerance(fact.value, fact.tolerance)) {
      sawZeroWidth = true;
    }
  }

  if (sawNegation) notes.push(NEGATION_NOTE);
  if (unitUnstated.length > 0) notes.push(UNSTATED_UNIT_NOTE);
  if (sawZeroWidth) {
    notes.push(
      'An answer carries a relative tolerance against a gold value of zero, which has no width and therefore behaves as an exact comparison. That is arithmetic rather than a decision made here, and the task file is where it would be changed.',
    );
  }

  const recovered = facts.filter((f) => f.recovered).length;
  return {
    status: 'scored',
    share: recovered / facts.length,
    recovered,
    total: facts.length,
    facts,
    recovery,
    negatedOnly,
    unitUnstated,
    notes,
  };
}

/** The recovery record on its own, for a caller feeding calibration directly. */
export function factRecovery(result: AccuracyResult): FactRecovery {
  return result.recovery;
}

function scoreOne(prose: string, fact: GoldFact, ignoreNegation: boolean): AccuracyFact {
  const base = {
    id: fact.id,
    kind: fact.kind,
    label: fact.label ?? null,
  } as const;

  switch (fact.kind) {
    case 'number':
      return scoreNumber(prose, fact, ignoreNegation, base);
    case 'date':
      return scoreDate(prose, fact, ignoreNegation, base);
    case 'name':
    case 'identifier':
      return scoreText(prose, fact, ignoreNegation, base);
    default: {
      const exhaustive: never = fact;
      return exhaustive;
    }
  }
}

type FactBase = { readonly id: string; readonly kind: GoldFactKind; readonly label: string | null };

type NumberFact = Extract<GoldFact, { kind: 'number' }>;
type DateFact = Extract<GoldFact, { kind: 'date' }>;
type TextFact = Extract<GoldFact, { kind: 'name' | 'identifier' }>;

function scoreNumber(
  prose: string,
  fact: NumberFact,
  ignoreNegation: boolean,
  base: FactBase,
): AccuracyFact {
  const folded = foldScaleWord(fact.unit);
  const goldValue = folded.exponent === 0 ? fact.value : shiftDecimal(toPlainString(fact.value), folded.exponent);
  const goldUnit = folded.canonical;
  const forms = unitSurfaceForms(goldUnit, folded.rest === '' ? fact.unit : folded.rest);

  const mentions = readNumbers(prose, forms);
  // A multi-word author unit is normally written *before* its figure: a report
  // says "the CVSS v3.1 base score was 8.8", never "8.8 CVSS v3.1 base score".
  // The family token is what separates "named a different member of this family"
  // from "stated no unit at all"; see `unitFamilyToken`.
  const family = unitFamilyToken(folded.rest === '' ? fact.unit : folded.rest);

  let best: { at: number; text: string; evidence: 'stated' | 'unstated' } | null = null;
  let deniedOnly = false;
  let wrongFamilyMember = false;

  for (const mention of mentions) {
    const before = matchUnitBefore(prose, mention.start, forms);
    for (const reading of mention.readings) {
      // The unit veto, and the whole of the second acceptance rule. A reading
      // carrying a recognised unit that is not the gold's is not a match at
      // all, which makes "right figure, wrong unit scores zero" structural
      // rather than a check somebody has to remember. It cuts both ways: a gold
      // of `dimensionless` is a real unit rather than a wildcard, so a report
      // writing `42 percent` against a gold of plain `42` stated a different
      // thing and is refused here too.
      //
      // A reading with nothing attached is compatible with any gold unit. That
      // is the deliberate asymmetry: unstated is not wrong.
      if (reading.unit !== null && reading.unit !== goldUnit) continue;

      // The unit may also be written before the figure. When it is, it is as
      // binding as one written after: a stated unit that disagrees vetoes, and
      // one that agrees upgrades the evidence from unstated to stated.
      let evidence: 'stated' | 'unstated' = reading.unit === null ? 'unstated' : 'stated';
      if (reading.unit === null) {
        if (before !== null && before.canonical === goldUnit) {
          evidence = 'stated';
        } else if (family !== null && namesFamily(prose, mention.start, family)) {
          // The report named this measurement family and did not name *this*
          // member of it, so it is quoting a different unit. Without this, a
          // report stating the CVSS v4.0 score would be credited with the v3.1
          // gold, which is the second acceptance rule failing on a real corpus
          // task rather than on a fixture.
          wrongFamilyMember = true;
          continue;
        }
      }

      if (!withinTolerance(reading.value, goldValue, fact.tolerance)) continue;

      const denied = !ignoreNegation && isNegated(prose, mention.start);
      if (denied) {
        deniedOnly = true;
        continue;
      }
      // A stated unit is stronger evidence, so it wins even if found later.
      if (best === null || (best.evidence === 'unstated' && evidence === 'stated')) {
        best = { at: mention.start, text: mention.text, evidence };
      }
    }
  }

  if (best !== null) {
    return {
      ...base,
      recovered: true,
      matchedText: best.text,
      matchedAt: best.at,
      via: 'value',
      alias: null,
      unitEvidence: best.evidence,
      negatedOnly: false,
      why:
        best.evidence === 'stated'
          ? `the report states ${best.text}, whose unit matches the gold's "${goldUnit}"`
          : `the report states ${best.text} with no unit written beside it, which matches the gold value within its tolerance`,
    };
  }

  return {
    ...base,
    recovered: false,
    matchedText: null,
    matchedAt: null,
    via: null,
    alias: null,
    unitEvidence: null,
    negatedOnly: deniedOnly,
    why: deniedOnly
      ? `every occurrence of ${toPlainString(goldValue)} sits inside a denial, so the report does not assert it`
      : wrongFamilyMember
        ? `the report states ${toPlainString(goldValue)} against a different member of the "${family ?? ''}" family than the gold's "${goldUnit}", which is a wrong unit rather than an unstated one`
        : `no figure in the report's prose matches ${toPlainString(goldValue)} "${goldUnit}" within its tolerance`,
  };
}

/**
 * Whether the family token is named close before the figure.
 *
 * Word-boundary matched inside the same window `matchUnitBefore` searches, so a
 * family named in an earlier sentence cannot veto a figure it has nothing to do
 * with.
 */
function namesFamily(prose: string, at: number, family: string): boolean {
  const from = Math.max(0, at - UNIT_LOOKBEHIND_CHARS);
  return findAllMentions(prose.slice(from, at), family).length > 0;
}

function scoreDate(
  prose: string,
  fact: DateFact,
  ignoreNegation: boolean,
  base: FactBase,
): AccuracyFact {
  const target = goldDay(fact.value);
  const mentions = readDates(prose);

  let deniedOnly = false;
  for (const mention of mentions) {
    if (!mention.days.includes(target)) continue;
    if (!ignoreNegation && isNegated(prose, mention.start)) {
      deniedOnly = true;
      continue;
    }
    return {
      ...base,
      recovered: true,
      matchedText: mention.text,
      matchedAt: mention.start,
      via: 'value',
      alias: null,
      unitEvidence: null,
      negatedOnly: false,
      why: mention.ambiguous
        ? `the report writes "${mention.text}", which is ${fact.value} on one of its two possible readings; the form is ambiguous and either reading is accepted`
        : `the report writes "${mention.text}", which is ${fact.value}`,
    };
  }

  return {
    ...base,
    recovered: false,
    matchedText: null,
    matchedAt: null,
    via: null,
    alias: null,
    unitEvidence: null,
    negatedOnly: deniedOnly,
    why: deniedOnly
      ? `every occurrence of ${fact.value} sits inside a denial, so the report does not assert it`
      : `no date in the report's prose resolves to ${fact.value}`,
  };
}

function scoreText(
  prose: string,
  fact: TextFact,
  ignoreNegation: boolean,
  base: FactBase,
): AccuracyFact {
  const candidates: { text: string; via: 'value' | 'alias' }[] = [
    { text: fact.value, via: 'value' },
    ...fact.aliases.map((a) => ({ text: a, via: 'alias' as const })),
  ];

  let deniedOnly = false;
  for (const candidate of candidates) {
    const at = findAllMentions(prose, candidate.text);
    if (at.length === 0) continue;
    const plain = ignoreNegation ? at : at.filter((i) => !isNegated(prose, i));
    if (plain.length === 0) {
      deniedOnly = true;
      continue;
    }
    const first = plain[0] ?? 0;
    return {
      ...base,
      recovered: true,
      matchedText: candidate.text,
      matchedAt: first,
      via: candidate.via,
      alias: candidate.via === 'alias' ? candidate.text : null,
      unitEvidence: null,
      negatedOnly: false,
      why:
        candidate.via === 'alias'
          ? `the report writes "${candidate.text}", a recorded alternate wording of the answer`
          : `the report writes "${candidate.text}"`,
    };
  }

  return {
    ...base,
    recovered: false,
    matchedText: null,
    matchedAt: null,
    via: null,
    alias: null,
    unitEvidence: null,
    negatedOnly: deniedOnly,
    why: deniedOnly
      ? `the answer appears only inside a denial, so the report does not assert it`
      : `neither the answer nor any recorded alternate wording appears in the report's prose`,
  };
}

/** Re-exported so a consumer can name the calibration seam from one import. */
export type { FactRecovery };
