import { canonicaliseUrl } from '../../../src/research/corroborate.js';
import { extractCitedUrls, normaliseCitations } from '../../../src/research/report.js';

/**
 * The statement-by-source matrices the published citation dimensions are built
 * on, and the algebra over them.
 *
 * **This file must never import `node:fs` and must never reach a network.**
 *
 * DeepTRACE (arXiv 2509.04499, ICLR 2026) defines its citation dimensions as
 * elementwise products of two binary matrices over (statement, source): a
 * citation matrix, did the report cite source `j` for statement `i`, and a
 * factual-support matrix, does source `j` actually support statement `i`. Both
 * accuracy and thoroughness fall straight out of those, and so does the
 * necessity term that catches over-citing. Adopting the published algebra is
 * what makes a number here comparable with everybody else's; inventing a
 * private one destroys that for no gain.
 *
 * Where this departs from the paper it says so, in the result and in
 * `docs/bench/citation-integrity.md`, rather than quietly publishing a
 * different number under a known name:
 *
 * - The paper's support matrix comes from a model judge. This one comes from an
 *   injected oracle whose default is token containment, which is weaker and
 *   exact. That disagreement is deliberate and BENCH-10 measures its size.
 * - The paper counts unsupported statements over *relevant* statements. Deciding
 *   relevance needs a judgement this path does not have, so the denominator here
 *   is *cited* statements and the result names the substitution.
 * - Two of the paper's eight dimensions need a relevance or stance judgement and
 *   are reported unavailable rather than approximated.
 */

/** One assertion in a report, with whatever it cited for itself. */
export interface Statement {
  readonly index: number;
  readonly text: string;
  /** Exactly as cited, fragments intact, so anchor honesty can still be checked. */
  readonly citedUrls: readonly string[];
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

/** A run of markdown links, which belongs to the sentence it follows. */
const TRAILING_CITATIONS = /^[\s]*(?:\[[^\]\n]*\]\([^)\s]*\)[.,;]?[ \t]*)+/;

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
    const nextWord = /^\s*(\S)/.exec(after);
    if (nextWord === null) continue;
    // A citation written after the full stop is part of the sentence it
    // supports, which is how people write. Pull it back before cutting.
    const trailing = TRAILING_CITATIONS.exec(after);
    if (trailing !== null) end += trailing[0].length;
    const rest = block.slice(end);
    const opener = /^\s*(\S)/.exec(rest);
    if (opener !== null && !/[A-Z0-9[("'*_#|]/.test(opener[1] ?? '')) continue;
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

/** Anything that carries no letter and no digit is punctuation, not a statement. */
function isSubstantive(text: string): boolean {
  return /[A-Za-z0-9]/.test(text);
}

/**
 * Break a report into the statements the matrices are indexed by.
 *
 * Deterministic, and that is the requirement rather than linguistic accuracy: a
 * denominator that shifts between two runs over the same text makes every rate
 * in this module incomparable with itself.
 */
export function segmentStatements(markdown: string): Statement[] {
  const normalised = normaliseCitations(markdown)
    .replace(FENCED_CODE, '\n')
    .replace(HTML_COMMENT, ' ');

  const pieces: string[] = [];
  for (const block of normalised.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const isTable = lines.filter((l) => l.trim().startsWith('|')).length >= 2;

    if (isTable) {
      const separatorAt = lines.findIndex((l) => l.trim().startsWith('|') && TABLE_SEPARATOR.test(l));
      lines.forEach((line, i) => {
        // The separator row and the header above it are structure, not claims.
        if (separatorAt >= 0 && (i === separatorAt || i === separatorAt - 1)) return;
        const text = line.trim();
        if (text.length > 0 && !TABLE_SEPARATOR.test(text)) pieces.push(text);
      });
      continue;
    }

    if (lines.some((l) => LIST_ITEM.test(l))) {
      let current = '';
      for (const line of lines) {
        if (LIST_ITEM.test(line)) {
          if (current.trim().length > 0) pieces.push(current.trim());
          current = line.replace(LIST_ITEM, '');
          continue;
        }
        current += ` ${line}`;
      }
      if (current.trim().length > 0) pieces.push(current.trim());
      continue;
    }

    const prose = lines
      .filter((l) => !/^\s{0,3}#{1,6}\s/.test(l) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(l))
      .join('\n')
      .trim();
    if (prose.length === 0) continue;
    pieces.push(...splitSentences(prose));
  }

  return pieces
    .filter(isSubstantive)
    .map((text, index) => ({ index, text, citedUrls: extractCitedUrls(text) }));
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
  /** Sigma over the support matrix, across every pair, not only cited ones. */
  readonly supportedPairs: number;
  /** Sigma over the elementwise product: cited and supported. */
  readonly citedAndSupported: number;
  readonly citationAccuracy: number | null;
  readonly citationThoroughness: number | null;
  readonly uncitedSources: number;
  readonly uncitedSourceRate: number | null;
  readonly citedStatements: number;
  readonly unsupportedStatements: number;
  readonly unsupportedStatementRate: number | null;
  /**
   * The size of a minimum vertex cover of the citation graph, which is the
   * quantity the published necessity term is built on. Canonical: no tie-break
   * can move it.
   */
  readonly necessarySources: number;
  readonly sourceNecessity: number | null;
  /**
   * Sources that are the only citation on at least one statement.
   *
   * Reported beside necessity because it answers a plainer question with no
   * appeal to a published formula: how many of these sources is the report
   * relying on alone. Also canonical.
   */
  readonly uniquelyCitedSources: number;
  readonly budget: PairBudget;
}

/**
 * A maximum matching of the bipartite citation graph, by augmenting paths.
 *
 * The published method names Hopcroft-Karp. This is Kuhn's, which finds a
 * matching of the same maximum size and is merely slower, on a graph capped at
 * a few hundred a side where the difference is unmeasurable. The simpler
 * algorithm is chosen deliberately: the number it feeds is already tie-dependent
 * (below), so the thing worth buying here is obvious correctness rather than
 * asymptotics.
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
 * The size of a minimum vertex cover of the bipartite citation graph.
 *
 * This is DeepTRACE's necessity term, and getting to it took one wrong turn
 * worth recording, because the wrong version is the version a careful reader
 * would write first.
 *
 * The published description is terse: necessary over listed sources, "via
 * minimum vertex cover over the bipartite (statement, source) graph using
 * Hopcroft-Karp". The obvious reading is to construct an actual cover by
 * Konig's theorem and count its source-side vertices. That reading is wrong,
 * and a two-statement example kills it: over statements {s1, s2} and sources
 * {A, B} with edges s1-A, s2-A and s2-B, every statement is matched, so the
 * alternating-path set is empty and Konig's cover is {s1, s2}, whose source
 * side is **zero**. It would report that no source is necessary in a graph
 * where dropping both plainly breaks both statements, and it would do it
 * whenever there are at least as many sources as statements, which is most
 * reports. The source side of a cover is also not unique, so the number would
 * have depended on a tie-break.
 *
 * The quantity the paper actually names is the cover's **size**, which by
 * Konig's theorem equals the size of a maximum matching, which is the only
 * reason naming Hopcroft-Karp makes sense at all: Hopcroft-Karp computes a
 * maximum matching and nothing else. That quantity is canonical, so no
 * tie-break can move it, and it behaves the way the dimension is described.
 * Ten statements each citing all hundred sources gives a matching of ten and a
 * necessity of 0.10, which is the over-citing this term exists to catch; ten
 * statements citing one source each gives ten over ten, which is 1.00.
 *
 * `maximumMatching` above is Kuhn's rather than Hopcroft-Karp. It finds a
 * matching of the same maximum size and is merely slower, on a graph capped at
 * a few hundred a side where the difference is unmeasurable, and the size is
 * all that is read from it.
 */
function minimumVertexCoverSize(
  adjacency: readonly (readonly number[])[],
  rightCount: number,
): number {
  const { matchLeft } = maximumMatching(adjacency, rightCount);
  return matchLeft.filter((right) => right !== -1).length;
}

/** Compute every matrix-derived dimension from the two matrices. */
export function matrixMetrics(input: MatrixInput): MatrixMetrics {
  const { statements, sources, cites, support, budget } = input;

  let citationEdges = 0;
  let supportedPairs = 0;
  let citedAndSupported = 0;
  let citedStatements = 0;
  let unsupportedStatements = 0;

  const columnCited = new Array<boolean>(sources.length).fill(false);
  const soleCitation = new Array<boolean>(sources.length).fill(false);
  const adjacency: number[][] = [];

  for (let i = 0; i < statements.length; i += 1) {
    const citeRow = cites[i] ?? [];
    const supportRow = support[i] ?? [];
    const row: number[] = [];
    let rowCites = 0;
    let rowSupportedAndCited = 0;
    let onlyColumn = -1;

    for (let j = 0; j < sources.length; j += 1) {
      const cited = citeRow[j] === true;
      const supported = supportRow[j] === 'supported';
      if (supported) supportedPairs += 1;
      if (cited) {
        citationEdges += 1;
        rowCites += 1;
        columnCited[j] = true;
        onlyColumn = rowCites === 1 ? j : -1;
        row.push(j);
        if (supported) {
          citedAndSupported += 1;
          rowSupportedAndCited += 1;
        }
      }
    }

    if (rowCites > 0) {
      citedStatements += 1;
      adjacency.push(row);
      if (rowSupportedAndCited === 0) unsupportedStatements += 1;
      if (rowCites === 1 && onlyColumn >= 0) soleCitation[onlyColumn] = true;
    }
  }

  const uniquelyCitedSources = soleCitation.filter(Boolean).length;
  const uncitedSources = columnCited.filter((c) => !c).length;
  const necessarySources = minimumVertexCoverSize(adjacency, sources.length);

  return {
    citationEdges,
    supportedPairs,
    citedAndSupported,
    citationAccuracy: citationEdges === 0 ? null : citedAndSupported / citationEdges,
    // Thoroughness asks what share of everything a source could have supported
    // was actually cited for it, so it is only meaningful when the support
    // matrix was computed over every pair rather than a sampled corner of it.
    citationThoroughness:
      budget.exceeded || supportedPairs === 0 ? null : citedAndSupported / supportedPairs,
    uncitedSources,
    uncitedSourceRate: sources.length === 0 ? null : uncitedSources / sources.length,
    citedStatements,
    unsupportedStatements,
    unsupportedStatementRate: citedStatements === 0 ? null : unsupportedStatements / citedStatements,
    necessarySources,
    sourceNecessity: sources.length === 0 ? null : necessarySources / sources.length,
    uniquelyCitedSources,
    budget,
  };
}
