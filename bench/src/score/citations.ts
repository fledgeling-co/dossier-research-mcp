import { canonicaliseUrl } from '../../../src/research/corroborate.js';
import {
  anchorHonesty,
  containment,
  type AnchorVerdict,
  type SourceEvidence,
  type SupportVerdict,
} from './containment.js';
import { IDENTIFIER_KINDS, type IdentifierKind } from './identifiers.js';
import {
  matrixMetrics,
  segmentStatements,
  sourceUniverse,
  type MatrixMetrics,
  type Statement,
  type SupportCell,
} from './matrix.js';

/**
 * Citation integrity, scored.
 *
 * **This file must never import `node:fs` and must never reach a network.** It
 * is handed a report and an evidence snapshot that `bench/src/citations/`
 * collected earlier, and it is pure and synchronous over the two. That split is
 * what makes a stored report score the same twice: `docs/plan/benchmark.md`
 * keeps raw reports so a metric added in three months can be applied to runs
 * already paid for, and a scorer that fetched the live web could never deliver
 * that, because the web moved.
 *
 * Two things this module refuses to do, and both are the point.
 *
 * **It never collapses accuracy and volume into one number.** A backend citing
 * a hundred sources at eighty percent and one citing ten at eighty percent are
 * not the same product, and the published work found citation count and
 * citation correctness to be close to orthogonal in current systems while human
 * preference tracks the count. Volume therefore rides on every result including
 * the unmeasurable arm, which is the one place this deliberately diverges from
 * the shape of its sibling scorers.
 *
 * **It never calls containment claim verification.** The default oracle asks
 * whether a page contains the numbers, years, identifiers and names a statement
 * asserts. A page can contain "28.6%" while saying something else entirely
 * about it. The oracle's name rides on every result so no number can be read
 * without knowing which produced it.
 */

/**
 * How support was decided.
 *
 * A named interface with two shipped implementations rather than an
 * unimplemented slot, because BENCH-10 has to score the two against one
 * labelled corpus and cannot compare against something that does not exist.
 * `judgedOracle` takes the judgement as an injected function, so the judged
 * variant is a real contract while no model is imported anywhere on the default
 * path.
 */
export interface SupportOracle {
  readonly name: 'containment' | 'judged';
  judge(statement: Statement, source: SourceEvidence | undefined): SupportVerdict;
}

/** The default. Free, exact, repeatable, and weaker than a reader on purpose. */
export function containmentOracle(): SupportOracle {
  return {
    name: 'containment',
    judge: (statement, source) => containment(statement.text, source).verdict,
  };
}

/** The identity of one (statement, source) pair in a recorded verdict table. */
export function supportPairKey(statementIndex: number, sourceUrl: string): string {
  return `${String(statementIndex)} ${sourceUrl}`;
}

/**
 * The judged variant, as a lookup over verdicts recorded earlier.
 *
 * Deliberately **not** a live model call. A model call is asynchronous and this
 * scorer is synchronous and pure, so wiring one in here would break both
 * properties and make the judged path unrepeatable over a stored report. The
 * judging belongs in a collection pass, beside the fetching, with its verdicts
 * persisted; this turns those verdicts back into an oracle so BENCH-10 can run
 * the two against one corpus and score the gap.
 *
 * A pair with no recorded verdict is `unchecked`, never `unsupported`. The same
 * rule as everywhere else: a judgement nobody made is not evidence against a
 * citation.
 */
export function judgedOracle(recorded: ReadonlyMap<string, SupportVerdict>): SupportOracle {
  return {
    name: 'judged',
    judge: (statement, source) =>
      source === undefined
        ? 'unchecked'
        : (recorded.get(supportPairKey(statement.index, source.url)) ?? 'unchecked'),
  };
}

/**
 * What the scorer needs from a snapshot, structurally.
 *
 * Declared here rather than imported from `bench/src/citations/`, so the pure
 * scorers carry no dependency on the collector and a test can hand in a
 * literal. The collector's own types satisfy this by shape.
 */
export interface CitationEvidenceView {
  readonly pages: readonly SourceEvidence[];
  readonly registry: readonly {
    readonly kind: IdentifierKind;
    readonly id: string;
    readonly status: 'present' | 'absent' | 'unchecked' | 'invalid';
    readonly detail: string;
  }[];
}

/**
 * Counted separately from every rate, always.
 *
 * Every field is a count or a ratio of counts, and none of them is a quality
 * score. `statements` excludes the rows of an evidence table or bibliography,
 * which are listed in `sourceListRows` instead: a bibliography row is not a
 * claim, and counting it as one both inflates this number and makes every
 * source look cited.
 */
export interface CitationVolume {
  readonly statements: number;
  readonly sourceListRows: number;
  readonly citedStatements: number;
  readonly sources: number;
  readonly citationEdges: number;
  readonly citationsPerStatement: number | null;
  readonly citationsPerCitedStatement: number | null;
}

export interface ResolvabilityTally {
  readonly checked: number;
  readonly live: number;
  readonly notFound: number;
  readonly blocked: number;
  readonly unreachable: number;
  readonly invalid: number;
  readonly unverified: number;
  readonly liveRate: number | null;
}

export interface RegistryTally {
  readonly present: number;
  readonly absent: number;
  readonly unchecked: number;
  readonly invalid: number;
  /**
   * Over `present + absent` only. `unchecked` and `invalid` leave the
   * denominator, which is the first rule of the slice expressed as arithmetic:
   * a registry that could not be reached must not lower anybody's score.
   */
  readonly presentRate: number | null;
}

export interface AnchorTally {
  readonly checked: number;
  readonly honest: number;
  readonly missing: number;
  readonly notApplicable: number;
  readonly unchecked: number;
  readonly honestRate: number | null;
}

/** A published dimension this path cannot compute, and why. */
export interface UnavailableDimension {
  readonly dimension: string;
  readonly why: string;
}

export interface CitationIntegrityUnmeasurable {
  readonly status: 'unmeasurable';
  readonly reason: 'no-citations' | 'no-evidence';
  readonly why: string;
  readonly volume: CitationVolume;
  readonly supportOracle: SupportOracle['name'];
}

export interface CitationIntegrityScored extends MatrixMetrics {
  readonly status: 'scored';
  readonly volume: CitationVolume;
  readonly resolvability: ResolvabilityTally;
  readonly registry: Readonly<Record<IdentifierKind, RegistryTally>>;
  readonly registryTotal: RegistryTally;
  readonly anchors: AnchorTally;
  readonly supportOracle: SupportOracle['name'];
  readonly supportOracleMeans: string;
  readonly unavailable: readonly UnavailableDimension[];
  readonly notes: readonly string[];
}

export type CitationIntegrityResult = CitationIntegrityUnmeasurable | CitationIntegrityScored;

/**
 * How many (statement, source) pairs the support matrix may cover.
 *
 * Thoroughness needs the support matrix over every pair rather than only the
 * cited ones, which is quadratic. Past the budget the uncited pairs are left
 * uncomputed and thoroughness reports null with the reason, rather than being
 * computed over a corner of the matrix and published as though it covered all
 * of it.
 */
export const MAX_SUPPORT_PAIRS = 60_000;

export interface ScoreCitationOptions {
  readonly oracle?: SupportOracle | undefined;
  readonly maxSupportPairs?: number | undefined;
}

const CONTAINMENT_MEANS =
  'containment: the cited page contains every number, year, identifier and name the statement asserts. It is not claim verification, and a page can contain a figure while saying something else about it.';
const JUDGED_MEANS =
  'judged: an injected judge read the statement against the page. Not the default path, and not free.';

function emptyRegistryTally(): RegistryTally {
  return { present: 0, absent: 0, unchecked: 0, invalid: 0, presentRate: null };
}

function withRate(t: Omit<RegistryTally, 'presentRate'>): RegistryTally {
  const denominator = t.present + t.absent;
  return { ...t, presentRate: denominator === 0 ? null : t.present / denominator };
}

function volumeOf(
  statements: readonly Statement[],
  sources: readonly string[],
  citationEdges: number,
  citedStatements: number,
): CitationVolume {
  const considered = statements.filter((s) => !s.inSourceList).length;
  return {
    statements: considered,
    sourceListRows: statements.length - considered,
    citedStatements,
    sources: sources.length,
    citationEdges,
    citationsPerStatement: considered === 0 ? null : citationEdges / considered,
    citationsPerCitedStatement: citedStatements === 0 ? null : citationEdges / citedStatements,
  };
}

/**
 * Score one report's citation integrity against one evidence snapshot.
 *
 * Deterministic: the same report and the same snapshot produce the same numbers
 * on any machine, twice. Nothing here reads a clock, a disk or a network.
 */
export function scoreCitationIntegrity(
  report: string,
  evidence: CitationEvidenceView | undefined,
  options: ScoreCitationOptions = {},
): CitationIntegrityResult {
  const oracle = options.oracle ?? containmentOracle();
  const statements = segmentStatements(report);
  const sources = sourceUniverse(report);

  const sourceIndex = new Map<string, number>();
  sources.forEach((url, j) => sourceIndex.set(url, j));

  const cites: boolean[][] = statements.map(() => new Array<boolean>(sources.length).fill(false));
  let citationEdges = 0;
  let citedStatements = 0;
  statements.forEach((statement, i) => {
    // A bibliography row lists a source; it does not cite one for a claim.
    if (statement.inSourceList) return;
    let any = false;
    for (const raw of statement.citedUrls) {
      const j = sourceIndex.get(canonicaliseUrl(raw));
      if (j === undefined) continue;
      const row = cites[i];
      if (row === undefined || row[j] === true) continue;
      row[j] = true;
      citationEdges += 1;
      any = true;
    }
    if (any) citedStatements += 1;
  });

  const volume = volumeOf(statements, sources, citationEdges, citedStatements);

  if (evidence === undefined) {
    return {
      status: 'unmeasurable',
      reason: 'no-evidence',
      why: 'no evidence snapshot was supplied, so nothing about these citations has been established. This is a gap in the pipeline and never a result about the backend.',
      volume,
      supportOracle: oracle.name,
    };
  }
  if (citationEdges === 0) {
    return {
      status: 'unmeasurable',
      reason: 'no-citations',
      why: 'the report attaches no source to any statement, so there is no citation to be right or wrong about. This is a finding about the backend, and the volume figures beside it are the finding.',
      volume,
      supportOracle: oracle.name,
    };
  }

  const pageByUrl = new Map<string, SourceEvidence>();
  for (const page of evidence.pages) pageByUrl.set(page.url, page);

  const pairs = statements.length * sources.length;
  const limit = options.maxSupportPairs ?? MAX_SUPPORT_PAIRS;
  const exceeded = pairs > limit;
  const budget = { pairs, limit, exceeded };

  const support: SupportCell[][] = statements.map((statement, i) =>
    sources.map((url, j) => {
      // Past the budget only the cited pairs are judged. Thoroughness reports
      // null in that case rather than being computed over a corner of the
      // matrix and published as though it covered all of it.
      if (statement.inSourceList) return 'unchecked';
      if (exceeded && cites[i]?.[j] !== true) return 'unchecked';
      return oracle.judge(statement, pageByUrl.get(url));
    }),
  );

  const metrics = matrixMetrics({ statements, sources, cites, support, budget });

  const resolvability = ((): ResolvabilityTally => {
    const count = (v: string): number => evidence.pages.filter((p) => p.verdict === v).length;
    const checked = evidence.pages.length;
    const live = count('live');
    return {
      checked,
      live,
      notFound: count('not_found'),
      blocked: count('blocked'),
      unreachable: count('unreachable'),
      invalid: count('invalid_url'),
      unverified: count('unverified'),
      liveRate: checked === 0 ? null : live / checked,
    };
  })();

  const registryCounts: Record<IdentifierKind, { present: number; absent: number; unchecked: number; invalid: number }> = {
    doi: { present: 0, absent: 0, unchecked: 0, invalid: 0 },
    arxiv: { present: 0, absent: 0, unchecked: 0, invalid: 0 },
    pmid: { present: 0, absent: 0, unchecked: 0, invalid: 0 },
    isbn: { present: 0, absent: 0, unchecked: 0, invalid: 0 },
    cve: { present: 0, absent: 0, unchecked: 0, invalid: 0 },
  };
  for (const answer of evidence.registry) {
    const bucket = registryCounts[answer.kind];
    bucket[answer.status] += 1;
  }
  const registry = Object.fromEntries(
    IDENTIFIER_KINDS.map((kind) => [kind, withRate(registryCounts[kind])]),
  ) as Record<IdentifierKind, RegistryTally>;
  const registryTotal = withRate(
    IDENTIFIER_KINDS.reduce(
      (acc, kind) => ({
        present: acc.present + registryCounts[kind].present,
        absent: acc.absent + registryCounts[kind].absent,
        unchecked: acc.unchecked + registryCounts[kind].unchecked,
        invalid: acc.invalid + registryCounts[kind].invalid,
      }),
      { present: 0, absent: 0, unchecked: 0, invalid: 0 },
    ),
  );

  const anchors = ((): AnchorTally => {
    const tally: Record<AnchorVerdict, number> = {
      honest: 0,
      missing: 0,
      'not-applicable': 0,
      unchecked: 0,
    };
    const seen = new Set<string>();
    for (const statement of statements) {
      for (const raw of statement.citedUrls) {
        if (seen.has(raw)) continue;
        seen.add(raw);
        tally[anchorHonesty(raw, pageByUrl.get(canonicaliseUrl(raw))).verdict] += 1;
      }
    }
    const decided = tally.honest + tally.missing;
    return {
      checked: seen.size,
      honest: tally.honest,
      missing: tally.missing,
      notApplicable: tally['not-applicable'],
      unchecked: tally.unchecked,
      honestRate: decided === 0 ? null : tally.honest / decided,
    };
  })();

  const notes: string[] = [];
  if (metrics.citationThoroughness === null) {
    notes.push(
      exceeded
        ? `thoroughness is not reported: the support matrix would have been ${String(pairs)} pairs against a budget of ${String(limit)}, so only cited pairs were judged and a figure over all pairs would be a figure over a corner of one`
        : 'thoroughness is not reported: no (statement, source) pair was judged supported, so its denominator is zero',
    );
  }
  if (registryTotal.presentRate === null && registryTotal.unchecked > 0) {
    notes.push(
      `every one of the ${String(registryTotal.unchecked)} identifier lookups came back unchecked, so no registry rate is reported. An unreachable registry is never evidence that a reference was fabricated`,
    );
  }
  if (metrics.citationsUnchecked > 0) {
    notes.push(
      `${String(metrics.citationsUnchecked)} of ${String(metrics.citationEdges)} citations could not be checked at all, usually because the cited page did not load or was cut short, and they are excluded from citation accuracy rather than counted as wrong`,
    );
  }
  notes.push(
    'the published denominators are RELEVANT statements. Deciding relevance needs a judgement this path deliberately does not have, so the denominators here are the statements whose support could be decided, and statements nothing could be decided about are reported separately',
  );
  notes.push(
    'source necessity is computed over the SUPPORT matrix, as the paper defines it, and is the source side of one minimum vertex cover. A minimum cover is not unique and its source side can differ between two covers of equal size, so the figure reproduces but is not canonical; uniquelyCitedSources is reported beside it and cannot vary',
  );

  return {
    status: 'scored',
    volume,
    resolvability,
    registry,
    registryTotal,
    anchors,
    supportOracle: oracle.name,
    supportOracleMeans: oracle.name === 'containment' ? CONTAINMENT_MEANS : JUDGED_MEANS,
    unavailable: [
      {
        dimension: 'relevantStatements',
        why: 'deciding whether a statement is relevant to the question needs a judgement, and no model sits in this scoring loop',
      },
      {
        dimension: 'oneSidedAnswer and overconfidentAnswer',
        why: 'both need a stance judgement over the answer text. Due weight is BENCH-05 and calibration is BENCH-06',
      },
    ],
    notes,
    ...metrics,
  };
}

export { emptyRegistryTally };
