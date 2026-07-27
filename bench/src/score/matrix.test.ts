import { describe, expect, it } from 'vitest';
import {
  matrixMetrics,
  segmentStatements,
  sourceUniverse,
  type MatrixInput,
  type Statement,
  type SupportCell,
} from './matrix.js';

/**
 * Segmentation and the published algebra.
 *
 * The algebra tests are hand-computed rather than golden: every expected number
 * below can be checked against the paper's formulas with a pencil, which is the
 * only way to notice that an implementation is computing a different quantity
 * under a published name.
 */

function statement(index: number, text: string, urls: string[] = [], inSourceList = false): Statement {
  return { index, text, citedUrls: urls, inSourceList };
}

/** Build the two matrices from a compact literal, so a case reads at a glance. */
function build(
  statements: readonly Statement[],
  sources: readonly string[],
  cites: readonly (readonly boolean[])[],
  support: readonly (readonly SupportCell[])[],
  exceeded = false,
): MatrixInput {
  return {
    statements,
    sources,
    cites,
    support,
    budget: { pairs: statements.length * sources.length, limit: 1000, exceeded },
  };
}

describe('segmentation (INTEG-25)', () => {
  it('does not split on a decimal or a common abbreviation', () => {
    const found = segmentStatements('Adoption hit 28.6% in 2024. Growth continued, e.g. in retail. Done.');
    expect(found).toHaveLength(3);
    expect(found[0]?.text).toBe('Adoption hit 28.6% in 2024.');
    // The whole of the second sentence, rather than two fragments split on the
    // abbreviation, which is the failure this guard exists to prevent.
    expect(found[1]?.text).toBe('Growth continued, e.g. in retail.');
  });

  it('ignores fenced code, headings and horizontal rules', () => {
    const found = segmentStatements(
      '# A heading\n\n```\nconst x = 1. And more.\n```\n\n---\n\nReal claim here.',
    );
    expect(found.map((s) => s.text)).toEqual(['Real claim here.']);
  });

  it('skips a table separator row and the header above it', () => {
    const found = segmentStatements('| Name | Value |\n| --- | --- |\n| Alpha | 12 |\n| Beta | 14 |');
    expect(found).toHaveLength(2);
    expect(found.map((s) => s.text)).toEqual(['| Alpha | 12 |', '| Beta | 14 |']);
  });

  it('makes each list item its own statement', () => {
    const found = segmentStatements('- First point.\n- Second point.\n- Third point.');
    expect(found).toHaveLength(3);
  });

  it('drops a piece carrying no letter or digit', () => {
    expect(segmentStatements('...\n\n***\n\nA claim.')).toHaveLength(1);
  });
});

describe('citation attachment (INTEG-26)', () => {
  it('attaches a citation written after the full stop to the sentence before it', () => {
    const found = segmentStatements(
      'Revenue reached 1.2 billion. [Filing](https://example.com/a) Growth then slowed.',
    );
    expect(found).toHaveLength(2);
    expect(found[0]?.citedUrls).toEqual(['https://example.com/a']);
    expect(found[1]?.citedUrls).toEqual([]);
  });

  it('keeps a citation whose scheme the renderer refuses to link', () => {
    // The report is segmented raw for exactly this reason: normalising first
    // rewrites this citation into inert prose and loses the address with it.
    const found = segmentStatements('The archive holds it <cite url="ftp://example.com/x">source</cite>.');
    expect(found[0]?.citedUrls).toEqual(['ftp://example.com/x']);
  });
});

describe('the source list is not a set of claims (INTEG-31)', () => {
  it('marks rows under an evidence-table heading', () => {
    const found = segmentStatements(
      'Adoption rose [a](https://example.com/a).\n\n## Evidence Table\n\n| Claim | Source |\n| --- | --- |\n| Adoption | https://example.com/a |',
    );
    const claim = found.find((s) => s.text.startsWith('Adoption rose'));
    const row = found.find((s) => s.text.startsWith('| Adoption'));
    expect(claim?.inSourceList).toBe(false);
    expect(row?.inSourceList).toBe(true);
  });

  it('marks a bare bibliography row that carries no heading of its own', () => {
    const found = segmentStatements('- https://example.com/a\n- https://example.com/b');
    expect(found.every((s) => s.inSourceList)).toBe(true);
  });

  it('keeps the listed addresses in the source universe', () => {
    const markdown =
      'Adoption rose [a](https://example.com/a).\n\n## Sources\n\n- https://example.com/b';
    expect(sourceUniverse(markdown)).toEqual(['https://example.com/a', 'https://example.com/b']);
  });
});

describe('citation accuracy and thoroughness (INTEG-27, INTEG-28)', () => {
  const sources = ['https://a', 'https://b'];
  const statements = [statement(0, 's0'), statement(1, 's1')];

  it('is the elementwise product over the citations that could be checked', () => {
    const m = matrixMetrics(
      build(
        statements,
        sources,
        [
          [true, true],
          [true, false],
        ],
        [
          ['supported', 'unsupported'],
          ['supported', 'unsupported'],
        ],
      ),
    );
    expect(m.citationEdges).toBe(3);
    expect(m.citationsChecked).toBe(3);
    expect(m.citedAndSupported).toBe(2);
    expect(m.citationAccuracy).toBeCloseTo(2 / 3);
    // Support is over every pair: (0,a) and (1,a) are supported, so 2.
    expect(m.supportedPairs).toBe(2);
    expect(m.citationThoroughness).toBeCloseTo(2 / 2);
  });

  it('is null when nothing was cited', () => {
    const m = matrixMetrics(
      build(statements, sources, [[false, false], [false, false]], [
        ['unchecked', 'unchecked'],
        ['unchecked', 'unchecked'],
      ]),
    );
    expect(m.citationAccuracy).toBeNull();
  });

  it('reports thoroughness null when the pair budget bound', () => {
    const m = matrixMetrics(
      build(statements, sources, [[true, false], [false, false]], [
        ['supported', 'unchecked'],
        ['unchecked', 'unchecked'],
      ], true),
    );
    expect(m.citationThoroughness).toBeNull();
    expect(m.supportMatrixComplete).toBe(false);
  });
});

describe('an unchecked pair leaves every denominator (INTEG-05)', () => {
  it('does not count a citation nobody could check as a wrong citation', () => {
    const m = matrixMetrics(
      build(
        [statement(0, 's0'), statement(1, 's1')],
        ['https://a', 'https://b'],
        [
          [true, false],
          [false, true],
        ],
        [
          ['supported', 'unchecked'],
          ['unchecked', 'unchecked'],
        ],
      ),
    );
    expect(m.citationEdges).toBe(2);
    expect(m.citationsChecked).toBe(1);
    expect(m.citationsUnchecked).toBe(1);
    // One of two citations was checkable and it was supported, so accuracy is
    // 1.0, not 0.5. A page that would not load is not a wrong citation.
    expect(m.citationAccuracy).toBe(1);
  });

  it('does not count a statement nobody could check as unsupported', () => {
    const m = matrixMetrics(
      build(
        [statement(0, 's0'), statement(1, 's1')],
        ['https://a'],
        [[true], [true]],
        [['supported'], ['unchecked']],
      ),
    );
    expect(m.supportedStatements).toBe(1);
    expect(m.unsupportedStatements).toBe(0);
    expect(m.statementsUnchecked).toBe(1);
    expect(m.unsupportedStatementRate).toBe(0);
  });
});

describe('uncited sources (INTEG-31)', () => {
  it('counts the empty columns of the citation matrix', () => {
    const m = matrixMetrics(
      build(
        [statement(0, 's0')],
        ['https://a', 'https://b', 'https://c'],
        [[true, false, false]],
        [['supported', 'unchecked', 'unchecked']],
      ),
    );
    expect(m.uncitedSources).toBe(2);
    expect(m.uncitedSourceRate).toBeCloseTo(2 / 3);
  });

  it('does not let a source-list row cite its own source', () => {
    const m = matrixMetrics(
      build(
        [statement(0, 'claim', ['https://a']), statement(1, 'row', ['https://b'], true)],
        ['https://a', 'https://b'],
        [
          [true, false],
          [false, true],
        ],
        [
          ['supported', 'unchecked'],
          ['unchecked', 'unchecked'],
        ],
      ),
    );
    // b is listed and never cited for a claim, so it is an uncited source.
    expect(m.statementsConsidered).toBe(1);
    expect(m.uncitedSources).toBe(1);
  });
});

describe('source necessity (INTEG-29, INTEG-30)', () => {
  it('is computed over the support matrix, not the citation matrix', () => {
    // Nothing is cited at all, so a citation-matrix reading would give zero.
    const m = matrixMetrics(
      build(
        [statement(0, 's0'), statement(1, 's1'), statement(2, 's2')],
        ['https://a', 'https://b'],
        [
          [false, false],
          [false, false],
          [false, false],
        ],
        [
          ['supported', 'unsupported'],
          ['supported', 'unsupported'],
          ['unsupported', 'supported'],
        ],
      ),
    );
    expect(m.necessarySources).toBeGreaterThan(0);
    expect(m.sourceNecessity).toBeCloseTo(m.necessarySources / 2);
  });

  it('reports that it is tie-dependent, rather than leaving the reader to find out', () => {
    const m = matrixMetrics(
      build([statement(0, 's0')], ['https://a'], [[true]], [['supported']]),
    );
    expect(m.sourceNecessityTieDependent).toBe(true);
  });

  it('reports uniquelyCitedSources beside it, which cannot vary', () => {
    const m = matrixMetrics(
      build(
        [statement(0, 's0'), statement(1, 's1')],
        ['https://a', 'https://b'],
        [
          [true, false],
          [true, true],
        ],
        [
          ['supported', 'unchecked'],
          ['supported', 'supported'],
        ],
      ),
    );
    // Only s0 relies on a single source, and that source is `a`.
    expect(m.uniquelyCitedSources).toBe(1);
  });
});

describe('determinism (INTEG-38)', () => {
  it('produces an identical source ordering on repeated calls', () => {
    const markdown = 'A [x](https://z.example/1) and [y](https://a.example/2) and [z](https://m.example/3).';
    expect(sourceUniverse(markdown)).toEqual(sourceUniverse(markdown));
    expect(sourceUniverse(markdown)).toEqual([
      'https://a.example/2',
      'https://m.example/3',
      'https://z.example/1',
    ]);
  });
});
