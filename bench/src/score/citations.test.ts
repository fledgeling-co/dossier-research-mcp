import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findImpureImports, importGraph } from '../import-graph.js';
import {
  containmentOracle,
  judgedOracle,
  scoreCitationIntegrity,
  supportPairKey,
  type CitationEvidenceView,
  type CitationIntegrityScored,
} from './citations.js';

/**
 * The whole scorer, over a report and a snapshot.
 *
 * Two properties get their own sections because they are what the slice is
 * for. Volume rides on every result, including the arm that cannot compute a
 * rate, because a hundred sources at eighty percent and ten at eighty percent
 * are different products and a result that hides the count when the rate is
 * unmeasurable cannot tell them apart. And the whole of `bench/src/score/` is
 * proved pure by walking its own import graph, not merely its own file: the
 * scorers import shared modules from `src/`, so reading one file would prove
 * nothing about what those pull in.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function evidence(over: Partial<CitationEvidenceView> = {}): CitationEvidenceView {
  return {
    pages: [
      {
        url: 'https://example.com/a',
        text: 'Adoption reached 28.6% in 2024.',
        truncated: false,
        verdict: 'live',
        completeHtml: true,
        anchors: ['results'],
      },
    ],
    registry: [],
    ...over,
  };
}

function scored(result: ReturnType<typeof scoreCitationIntegrity>): CitationIntegrityScored {
  if (result.status !== 'scored') throw new Error(`expected a scored result, got ${result.status}`);
  return result;
}

describe('volume is always separate from accuracy (INTEG-34)', () => {
  it('reports both on a scored result', () => {
    const result = scored(
      scoreCitationIntegrity(
        'Adoption reached 28.6% in 2024 [a](https://example.com/a).',
        evidence(),
      ),
    );
    expect(result.volume.sources).toBe(1);
    expect(result.volume.citationEdges).toBe(1);
    expect(result.citationAccuracy).toBe(1);
  });

  it('reports volume even when nothing can be scored (INTEG-39)', () => {
    const result = scoreCitationIntegrity('A report that cites nothing at all.', evidence());
    expect(result.status).toBe('unmeasurable');
    if (result.status !== 'unmeasurable') return;
    expect(result.reason).toBe('no-citations');
    expect(result.volume.statements).toBe(1);
    expect(result.volume.citationEdges).toBe(0);
    expect(result.why).toMatch(/finding about the backend/);
  });

  it('separates a missing snapshot from a backend result', () => {
    const result = scoreCitationIntegrity('A claim [a](https://example.com/a).', undefined);
    expect(result.status).toBe('unmeasurable');
    if (result.status !== 'unmeasurable') return;
    expect(result.reason).toBe('no-evidence');
    expect(result.why).toMatch(/never a result about the backend/);
    // The volume figures survive, so the pipeline gap does not erase the count.
    expect(result.volume.sources).toBe(1);
  });
});

describe('the registry denominator (INTEG-05)', () => {
  const report = 'See 10.1038/nature12373 and 10.1038/nature99999999 and 10.1145/3442188.';

  it('leaves unchecked and invalid out of the present rate', () => {
    const result = scored(
      scoreCitationIntegrity(`${report} [a](https://example.com/a)`, {
        ...evidence(),
        registry: [
          { kind: 'doi', id: '10.1038/nature12373', status: 'present', detail: '' },
          { kind: 'doi', id: '10.1038/nature99999999', status: 'absent', detail: '' },
          { kind: 'doi', id: '10.1145/3442188', status: 'unchecked', detail: '' },
          { kind: 'isbn', id: '9780262033847', status: 'invalid', detail: '' },
        ],
      }),
    );
    expect(result.registry.doi).toMatchObject({ present: 1, absent: 1, unchecked: 1 });
    expect(result.registry.doi.presentRate).toBe(0.5);
    expect(result.registryTotal.presentRate).toBe(0.5);
  });

  it('reports no rate at all when every lookup came back unchecked', () => {
    const result = scored(
      scoreCitationIntegrity(`${report} [a](https://example.com/a)`, {
        ...evidence(),
        registry: [{ kind: 'doi', id: '10.1038/nature12373', status: 'unchecked', detail: '' }],
      }),
    );
    expect(result.registryTotal.presentRate).toBeNull();
    expect(result.notes.join(' ')).toMatch(/never evidence that a reference was fabricated/);
  });
});

describe('what the numbers are allowed to claim (INTEG-22, INTEG-33, INTEG-35)', () => {
  const result = scored(
    scoreCitationIntegrity('Adoption reached 28.6% in 2024 [a](https://example.com/a).', evidence()),
  );

  it('names the oracle on the result', () => {
    expect(result.supportOracle).toBe('containment');
  });

  it('says containment is not claim verification', () => {
    expect(result.supportOracleMeans).toMatch(/not claim verification/);
  });

  it('reports the relevance-dependent dimensions unavailable, with a reason', () => {
    expect(result.unavailable.map((u) => u.dimension)).toEqual([
      'relevantStatements',
      'oneSidedAnswer and overconfidentAnswer',
    ]);
    expect(result.unavailable.every((u) => u.why.length > 20)).toBe(true);
  });

  it('names the substitution it made in the published denominator (INTEG-32)', () => {
    expect(result.notes.join(' ')).toMatch(/published denominators are RELEVANT statements/);
  });
});

describe('the judged oracle (INTEG-36)', () => {
  const report = 'Adoption reached 28.6% in 2024 [a](https://example.com/a).';

  it('is reachable by injection and rides on the result', () => {
    const recorded = new Map([[supportPairKey(0, 'https://example.com/a'), 'supported' as const]]);
    const result = scored(
      scoreCitationIntegrity(report, evidence(), { oracle: judgedOracle(recorded) }),
    );
    expect(result.supportOracle).toBe('judged');
    expect(result.citationAccuracy).toBe(1);
  });

  it('treats a pair nobody judged as unchecked, never unsupported', () => {
    const result = scored(
      scoreCitationIntegrity(report, evidence(), { oracle: judgedOracle(new Map()) }),
    );
    expect(result.citationsUnchecked).toBe(1);
    expect(result.citationAccuracy).toBeNull();
  });

  it('disagrees with containment on the same report, which is what BENCH-10 measures', () => {
    const page = { ...evidence().pages[0], text: 'a page about the right topic with no figures' };
    const withNoFigure = { ...evidence(), pages: [page] };
    const byContainment = scored(
      scoreCitationIntegrity(report, withNoFigure as CitationEvidenceView, {
        oracle: containmentOracle(),
      }),
    );
    const byJudge = scored(
      scoreCitationIntegrity(report, withNoFigure as CitationEvidenceView, {
        oracle: judgedOracle(
          new Map([[supportPairKey(0, 'https://example.com/a'), 'supported' as const]]),
        ),
      }),
    );
    expect(byContainment.citationAccuracy).toBe(0);
    expect(byJudge.citationAccuracy).toBe(1);
  });
});

describe('anchors', () => {
  it('tallies honest, missing and not-applicable separately', () => {
    const report =
      'One [a](https://example.com/a#results). Two [b](https://example.com/a#nowhere). Three [c](https://example.com/a).';
    const result = scored(scoreCitationIntegrity(report, evidence()));
    expect(result.anchors).toMatchObject({ honest: 1, missing: 1, notApplicable: 1 });
    expect(result.anchors.honestRate).toBe(0.5);
  });
});

describe('determinism (INTEG-38)', () => {
  it('scores a report and a snapshot identically twice', () => {
    const report =
      'Adoption reached 28.6% in 2024 [a](https://example.com/a). Growth slowed [a](https://example.com/a).';
    const first = scoreCitationIntegrity(report, evidence());
    const second = scoreCitationIntegrity(report, evidence());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe('purity (INTEG-37)', () => {
  /**
   * The walk lives in `bench/src/import-graph.ts` now.
   *
   * It was written here, and it was the only copy, so the detector's own purity
   * guard grew a same-file regex instead and could not see a four-hop leak that
   * really existed. Lifting it out is what let both guards ask the same
   * question; the assertions below are unchanged.
   */
  const entries = ['citations.ts', 'containment.ts', 'matrix.ts', 'identifiers.ts'];

  it('the walk actually follows edges, or every check below is vacuous', () => {
    // `citations.ts` imports three siblings which import two shared modules, so
    // a walker that reached only the entry file would still pass every purity
    // assertion while proving nothing at all.
    const graph = importGraph(join(HERE, 'citations.ts'));
    expect(graph.length).toBeGreaterThan(4);
    expect(graph.some((f) => f.includes(join('src', 'research')))).toBe(true);
  });

  it('the walker would notice an impure import if one appeared', () => {
    // Drive it at a module that really does touch a disk, so a permanently
    // green purity check cannot be mistaken for a working one.
    const reaches = findImpureImports(join(HERE, '..', 'citations', 'collect.ts'));
    expect(reaches.length).toBeGreaterThan(0);
  });

  for (const entry of entries) {
    it(`${entry} reaches no filesystem and no network, transitively`, () => {
      const reaches = findImpureImports(join(HERE, entry));
      expect(reaches.map((r) => `${r.module} via ${r.path.join(' -> ')}`)).toEqual([]);
    });
  }
});
