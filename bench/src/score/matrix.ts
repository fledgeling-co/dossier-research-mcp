import { canonicaliseUrl } from '../../../src/research/corroborate.js';
import { extractCitedUrls } from '../../../src/research/report.js';

/**
 * The statement-by-source matrices the published citation dimensions are built
 * on, and the algebra over them.
 *
 * **This file must never import `node:fs` and must never reach a network.**
 *
 * DeepTRACE (arXiv 2509.04499, ICLR 2026) defines its citation dimensions as
 * elementwise products of two binary matrices over (statement, source): a
 * citation matrix, did the report cite source `j` for statement `i`, and a
 * factual-support matrix, does source `j` actually support statement `i`.
 * Adopting the published algebra is what makes a number here comparable with
 * everybody else's; inventing a private one destroys that for no gain. The
 * formulas were read from the paper itself, not from a summary of it.
 *
 * Three departures, each named in the result rather than quietly published
 * under the paper's names:
 *
 * - The paper's support matrix comes from a model judge. This one comes from an
 *   injected oracle whose default is token containment, which is weaker and
 *   exact. That disagreement is deliberate and BENCH-10 measures its size.
 * - The paper's denominators are **relevant** statements. Deciding relevance
 *   needs a judgement this path does not have, so the denominators here are
 *   the statements that could be checked, and every result says so.
 * - The oracle is ternary and the paper's matrices are binary. An `unchecked`
 *   pair leaves every denominator instead of counting as unsupported. That is
 *   the first rule of the slice as arithmetic: a page that could not be
 *   fetched must not lower a backend's citation accuracy.
 */

/** One assertion in a report, with whatever it cited for itself. */
export interface Statement {
  readonly index: number;
  readonly text: string;
  /** Exactly as cited, fragments intact, so anchor honesty can still be checked. */
  readonly citedUrls: readonly string[];
  /**
   * True for a row of an evidence table, a bibliography or a source registry.
   *
   * These are excluded from the citation matrix and carry the whole weight of
   * the uncited-sources dimension. This product instructs a report to end with
   * an evidence table listing every source, so without the exclusion each
   * listed source appears in a row that "cites" it, no column of the citation
   * matrix is ever empty, and uncited sources is zero for every backend
   * forever. The URLs stay in the source universe; only the pseudo-citation
   * goes.
   */
  readonly inSourceList: boolean;
}

/**
 * Sentence-ending punctuation that is not a sentence ending.
 *
 * Without this list a report splits mid-citation on "et al." and mid-figure on
 * "No. 4", and every fragment becomes a statement that cites nothing, which
 * quietly inflates the denominator of every rate in the module.
 */
const ABBREVIATIONS = [
  'e.g', 'i.e', 'etc', 'vs', 'cf', 'approx', 'est', 'al', 'ibid', 'viz',
  'dr', 'mr', 'mrs', 'ms', 'prof', 'sr', 'jr', 'st', 'no', 'nos', 'vol', 'pp',
  'fig', 'figs', 'eq', 'ref', 'refs', 'ch', 'sec', 'inc', 'ltd', 'corp', 'co',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
];

const ABBREVIATION_TAIL = new RegExp(`(?:^|[\\s(\\[])(?:${ABBREVIATIONS.join('|')})\\.$`, 'i');

/**
 * A run of citations, which belongs to the sentence it follows.
 *
 * Covers all three forms a report writes: a markdown link, a `<cite url>` tag
 * and a bare URL. The tag form matters because segmentation deliberately runs
 * over the **raw** report rather than a normalised copy: normalisation rewrites
 * a citation whose scheme it will not link into inert backticked text, taking
 * the URL with it, so a report whose only citation was of that kind would come
 * back carrying none at all.
 */
const TRAILING_CITATIONS =
  /^[\s]*(?:(?:\[[^\]\n]*\]\([^)\s]*\)|<cite\s+[^>]*>(?:[\s\S]*?<\/cite>)?|https?:\/\/\S+)[.,;]?[ \t]*)+/;

/**
 * Split prose into sentences.
 *
 * A decimal never splits, for free: the boundary pattern requires whitespace
 * after the stop, and `28.6` has none. An abbreviation is guarded by the list
 * above, and a boundary is only taken when what follows looks like the start of
 * something, which keeps an ellipsis or a stray full stop from producing an
 * empty statement.
 */
function splitSentences(block: string): string[] {
  const out: string[] = [];
  let start = 0;
  const boundary = /[.!?]["')\]]?(?=\s)/g;
  for (const m of block.matchAll(boundary)) {
    let end = m.index + m[0].length;
    const before = block.slice(start, end);
    if (ABBREVIATION_TAIL.test(before.trimEnd())) continue;
    const after = block.slice(end);
    if (!/\S/.test(after)) continue;
    // A citation written after the full stop is part of the sentence it
    // supports, which is how people write. Pull it back before cutting.
    const trailing = TRAILING_CITATIONS.exec(after);
    if (trailing !== null) end += trailing[0].length;
    const rest = block.slice(end);
    const opener = /^\s*(\S)/.exec(rest);
    if (opener !== null && !/[A-Z0-9[("'*_#|<]/.test(opener[1] ?? '')) continue;
    const piece = block.slice(start, end).trim();
    if (piece.length > 0) out.push(piece);
    start = end;
  }
  const tail = block.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

const FENCED_CODE = /^```[\s\S]*?^```/gm;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
const LIST_ITEM = /^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+)/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;

/**
 * Headings under which a listed source is not a claim about anything.
 *
 * The product's own prompt asks for an "Evidence Table" and the local loop
 * builds a numbered "source registry", so both spellings are here alongside the
 * ordinary academic ones.
 */
const SOURCE_LIST_HEADING =
  /\b(evidence\s+table|source\s+registry|sources?|references?|bibliography|citations?|works\s+cited|appendix)\b/i;

/** Anything that carries no letter and no digit is punctuation, not a statement. */
function isSubstantive(text: string): boolean {
  return /[A-Za-z0-9]/.test(text);
}

/**
 * A row whose content is essentially just a link.
 *
 * Catches a bibliography that carries no heading of its own, which is common in
 * a list of sources at the end of a section.
 */
function isBareCitationRow(text: string): boolean {
  const withoutCitations = text
    .replace(/\[[^\]\n]*\]\([^)\s]*\)/g, ' ')
    .replace(/<cite\s+[^>]*>[\s\S]*?<\/cite>/g, ' ')
    .replace(/<cite\s+[^>]*\/?>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[|\s\d.,;:()[\]-]/g, '');
  return extractCitedUrls(text).length > 0 && withoutCitations.length <= 12;
}

interface Piece {
  readonly text: string;
  readonly inSourceList: boolean;
}

/**
 * Break a report into the statements the matrices are indexed by.
 *
 * Deterministic, and that is the requirement rather than linguistic accuracy: a
 * denominator that shifts between two runs over the same text makes every rate
 * in this module incomparable with itself.
 *
 * Runs over the raw report. An earlier version normalised citations first, for
 * readability, and that quietly destroyed any citation whose scheme the
 * renderer refuses to link: the URL becomes backticked prose and the statement
 * that carried it reads as citing nothing.
 */
export function segmentStatements(markdown: string): Statement[] {
  const cleaned = markdown.replace(FENCED_CODE, '\n').replace(HTML_COMMENT, ' ');

  const pieces: Piece[] = [];
  let underSourceHeading = false;

  for (const block of cleaned.split(/\n\s*\n/)) {
    const lines = block.split('\n');

    for (const line of lines) {
      const heading = HEADING.exec(line);
      if (heading) underSourceHeading = SOURCE_LIST_HEADING.test(heading[1] ?? '');
    }

    const push = (text: string): void => {
      pieces.push({ text, inSourceList: underSourceHeading || isBareCitationRow(text) });
    };

    const isTable = lines.filter((l) => l.trim().startsWith('|')).length >= 2;
    if (isTable) {
      const separatorAt = lines.findIndex(
        (l) => l.trim().startsWith('|') && TABLE_SEPARATOR.test(l),
      );
      lines.forEach((line, i) => {
        // The separator row and the header above it are structure, not claims.
        if (separatorAt >= 0 && (i === separatorAt || i === separatorAt - 1)) return;
        const text = line.trim();
        if (text.length > 0 && !TABLE_SEPARATOR.test(text)) push(text);
      });
      continue;
    }

    if (lines.some((l) => LIST_ITEM.test(l))) {
      let current = '';
      for (const line of lines) {
        if (HEADING.test(line)) continue;
        if (LIST_ITEM.test(line)) {
          if (current.trim().length > 0) push(current.trim());
          current = line.replace(LIST_ITEM, '');
          continue;
        }
        current += ` ${line}`;
      }
      if (current.trim().length > 0) push(current.trim());
      continue;
    }

    const prose = lines
      .filter((l) => !HEADING.test(l) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(l))
      .join('\n')
      .trim();
    if (prose.length === 0) continue;
    for (const sentence of splitSentences(prose)) push(sentence);
  }

  return pieces
    .filter((p) => isSubstantive(p.text))
    .map((p, index) => ({
      index,
      text: p.text,
      citedUrls: extractCitedUrls(p.text),
      inSourceList: p.inSourceList,
    }));
}

/** The distinct sources a report cites, canonicalised and ordered for reproducibility. */
export function sourceUniverse(markdown: string): string[] {
  const canonical = extractCitedUrls(markdown).map(canonicaliseUrl);
  return [...new Set(canonical)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export type SupportCell = 'supported' | 'unsupported' | 'unchecked';

/** How the pair budget landed, so a null thoroughness is never a mystery. */
export interface PairBudget {
  readonly pairs: number;
  readonly limit: number;
  readonly exceeded: boolean;
}

export interface MatrixInput {
  readonly statements: readonly Statement[];
  readonly sources: readonly string[];
  /** `cites[i][j]`: statement `i` cited source `j`. */
  readonly cites: readonly (readonly boolean[])[];
  /** `support[i][j]`: the oracle's reading. `unchecked` counts as neither. */
  readonly support: readonly (readonly SupportCell[])[];
  readonly budget: PairBudget;
}

export interface MatrixMetrics {
  /** Sigma over the citation matrix: how many (statement, source) citations exist. */
  readonly citationEdges: number;
  /** Of those, how many had a support answer at all. The accuracy denominator. */
  readonly citationsChecked: number;
  /** The rest. They leave every denominator rather than counting as wrong. */
  readonly citationsUnchecked: number;
  /** Sigma over the support matrix, across every pair, not only cited ones. */
  readonly supportedPairs: number;
  /** Sigma over the elementwise product: cited and supported. */
  readonly citedAndSupported: number;
  /** False when the pair budget bound and only cited pairs were judged. */
  readonly supportMatrixComplete: boolean;
  readonly citationAccuracy: number | null;
  readonly citationThoroughness: number | null;
  readonly uncitedSources: number;
  readonly uncitedSourceRate: number | null;
  /** Statements eligible for the matrices: everything outside a source list. */
  readonly statementsConsidered: number;
  readonly citedStatements: number;
  readonly supportedStatements: number;
  readonly unsupportedStatements: number;
  /** Statements whose every cell came back unchecked. They leave the denominator. */
  readonly statementsUnchecked: number;
  readonly unsupportedStatementRate: number | null;
  /**
   * The source side of a minimum vertex cover of the **support** graph, which
   * is what the paper computes it over. See the note on tie dependence.
   */
  readonly necessarySources: number;
  readonly sourceNecessity: number | null;
  /** Always true, and stated on the result rather than buried in a doc. */
  readonly sourceNecessityTieDependent: true;
  /**
   * Sources that are the only citation on at least one statement.
   *
   * Reported beside necessity because it answers a plainer question with no
   * appeal to a published formula and cannot vary with a tie-break: how many of
   * these sources is the report relying on alone.
   */
  readonly uniquelyCitedSources: number;
  readonly budget: PairBudget;
}

/**
 * A maximum matching of a bipartite graph, by augmenting paths.
 *
 * The paper names Hopcroft-Karp. This is Kuhn's, which finds a matching of the
 * same maximum size on a graph capped at a few hundred a side where the
 * difference is unmeasurable. The cover built from it below is one of possibly
 * several minimum covers either way, so the thing worth buying here is obvious
 * correctness rather than asymptotics.
 */
function maximumMatching(
  adjacency: readonly (readonly number[])[],
  rightCount: number,
): { matchLeft: number[]; matchRight: number[] } {
  const matchLeft = new Array<number>(adjacency.length).fill(-1);
  const matchRight = new Array<number>(rightCount).fill(-1);

  const augment = (left: number, seen: boolean[]): boolean => {
    for (const right of adjacency[left] ?? []) {
      if (seen[right] === true) continue;
      seen[right] = true;
      const held = matchRight[right] ?? -1;
      if (held === -1 || augment(held, seen)) {
        matchRight[right] = left;
        matchLeft[left] = right;
        return true;
      }
    }
    return false;
  };

  for (let left = 0; left < adjacency.length; left += 1) {
    augment(left, new Array<boolean>(rightCount).fill(false));
  }
  return { matchLeft, matchRight };
}

/**
 * The source-side vertices of a minimum vertex cover, by Konig's construction.
 *
 * The paper builds this over the **factual-support** matrix rather than the
 * citation matrix, and covers the supported statements: a necessary source is
 * one you cannot drop without leaving a supported statement with nothing behind
 * it. Getting the matrix wrong here would publish a different quantity under a
 * published name, which is the one thing adopting a published metric is
 * supposed to prevent.
 *
 * **The number depends on which minimum cover the construction lands on.** A
 * minimum cover is not unique, and two covers of equal size can have different
 * source sides. Over statements {s1, s2} and sources {A, B} with support edges
 * s1-A, s2-A and s2-B, both {A, s2} and {A, B} are minimum covers, with source
 * sides of one and two; and where every statement is matched the construction
 * returns a cover made entirely of statements, whose source side is zero. The
 * ordering is pinned so the answer reproduces, and it is not canonical, so a
 * comparison between backends must not rest on this number alone.
 * `uniquelyCitedSources` is reported beside it for exactly that reason.
 */
function necessarySourceCount(
  adjacency: readonly (readonly number[])[],
  rightCount: number,
): number {
  const { matchLeft, matchRight } = maximumMatching(adjacency, rightCount);
  const leftSeen = new Array<boolean>(adjacency.length).fill(false);
  const rightSeen = new Array<boolean>(rightCount).fill(false);

  const walk = (left: number): void => {
    if (leftSeen[left] === true) return;
    leftSeen[left] = true;
    for (const right of adjacency[left] ?? []) {
      if (right === matchLeft[left]) continue;
      if (rightSeen[right] === true) continue;
      rightSeen[right] = true;
      const held = matchRight[right] ?? -1;
      if (held !== -1) walk(held);
    }
  };

  for (let left = 0; left < adjacency.length; left += 1) {
    if ((matchLeft[left] ?? -1) === -1) walk(left);
  }
  // The cover is (unreached left vertices) union (reached right vertices). The
  // source side is the second half.
  return rightSeen.filter(Boolean).length;
}

/** Compute every matrix-derived dimension from the two matrices. */
export function matrixMetrics(input: MatrixInput): MatrixMetrics {
  const { statements, sources, cites, support, budget } = input;

  let citationEdges = 0;
  let citationsChecked = 0;
  let citedAndSupported = 0;
  let supportedPairs = 0;
  let statementsConsidered = 0;
  let citedStatements = 0;
  let supportedStatements = 0;
  let unsupportedStatements = 0;
  let statementsUnchecked = 0;

  const columnCited = new Array<boolean>(sources.length).fill(false);
  const soleCitation = new Array<boolean>(sources.length).fill(false);
  /** Support-graph adjacency, which is what necessity is computed over. */
  const supportAdjacency: number[][] = [];

  for (let i = 0; i < statements.length; i += 1) {
    // A bibliography row is not a claim, and counting it as one makes every
    // source look cited and every uncited-source figure zero.
    if (statements[i]?.inSourceList === true) continue;
    statementsConsidered += 1;

    const citeRow = cites[i] ?? [];
    const supportRow = support[i] ?? [];
    let rowCites = 0;
    /** Cells in this row the oracle could actually answer, cited or not. */
    let rowCellsDecided = 0;
    let onlyColumn = -1;
    const supportedColumns: number[] = [];

    for (let j = 0; j < sources.length; j += 1) {
      const cited = citeRow[j] === true;
      const cell = supportRow[j] ?? 'unchecked';
      if (cell !== 'unchecked') rowCellsDecided += 1;
      if (cell === 'supported') {
        supportedPairs += 1;
        supportedColumns.push(j);
      }
      if (cited) {
        citationEdges += 1;
        rowCites += 1;
        columnCited[j] = true;
        onlyColumn = rowCites === 1 ? j : -1;
        if (cell !== 'unchecked') citationsChecked += 1;
        if (cell === 'supported') citedAndSupported += 1;
      }
    }

    if (rowCites > 0) {
      citedStatements += 1;
      if (rowCites === 1 && onlyColumn >= 0) soleCitation[onlyColumn] = true;
    }

    // The paper's rule: a row of the support matrix with no checked cell is an
    // unsupported statement. The ternary oracle adds the case a binary matrix
    // has no room for, and it is the case that matters most here: a row where
    // nothing could be decided at all is neither supported nor unsupported, and
    // leaves the denominator rather than counting against the backend.
    if (supportedColumns.length > 0) {
      supportedStatements += 1;
      supportAdjacency.push(supportedColumns);
    } else if (rowCellsDecided > 0) {
      unsupportedStatements += 1;
    } else {
      statementsUnchecked += 1;
    }
  }

  const uniquelyCitedSources = soleCitation.filter(Boolean).length;
  const uncitedSources = columnCited.filter((c) => !c).length;
  const necessarySources = necessarySourceCount(supportAdjacency, sources.length);
  const decidedStatements = supportedStatements + unsupportedStatements;

  return {
    citationEdges,
    citationsChecked,
    citationsUnchecked: citationEdges - citationsChecked,
    supportedPairs,
    citedAndSupported,
    supportMatrixComplete: !budget.exceeded,
    // The denominator is the citations whose support could actually be decided.
    // A cited page that would not load must not read as a wrong citation.
    citationAccuracy: citationsChecked === 0 ? null : citedAndSupported / citationsChecked,
    // Thoroughness needs the support matrix over every pair rather than a
    // sampled corner of it, so it is null when the budget bound.
    citationThoroughness:
      budget.exceeded || supportedPairs === 0 ? null : citedAndSupported / supportedPairs,
    uncitedSources,
    uncitedSourceRate: sources.length === 0 ? null : uncitedSources / sources.length,
    statementsConsidered,
    citedStatements,
    supportedStatements,
    unsupportedStatements,
    statementsUnchecked,
    unsupportedStatementRate:
      decidedStatements === 0 ? null : unsupportedStatements / decidedStatements,
    necessarySources,
    sourceNecessity: sources.length === 0 ? null : necessarySources / sources.length,
    sourceNecessityTieDependent: true,
    uniquelyCitedSources,
    budget,
  };
}
