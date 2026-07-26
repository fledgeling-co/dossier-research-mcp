import { describe, expect, it } from 'vitest';
import { describeOverlap, mergeEvidence, renderMergedRegistry, type RunEvidence } from '../src/research/synthesise.js';

/** A report citing the given URLs, in the citation form the extractor reads. */
function reportCiting(urls: readonly string[]): string {
  return [
    '# A report',
    '',
    '## Executive Summary',
    '',
    ...urls.map((u, i) => `- A claim <cite url="${u}">${String(i + 1)}</cite>.`),
  ].join('\n');
}

const run = (provider: string, urls: readonly string[]): RunEvidence => ({
  runId: `dr_${provider}`,
  provider,
  markdown: reportCiting(urls),
});

describe('mergeEvidence', () => {
  it('deduplicates one page reached three different ways into one source', () => {
    // The arithmetic that turns a single source into apparent corroboration.
    const merged = mergeEvidence([
      run('gemini', ['https://example.org/a?utm_source=x']),
      run('perplexity', ['https://www.example.org/a/']),
      run('xai', ['https://example.org/a#section']),
    ]);
    expect(merged.sources).toHaveLength(1);
    expect(merged.sources[0]?.citedBy).toEqual(['gemini', 'perplexity', 'xai']);
    expect(merged.independentDomains).toBe(1);
  });

  it('counts independent domains, not backends', () => {
    const merged = mergeEvidence([
      run('gemini', ['https://a.org/1', 'https://b.org/1']),
      run('perplexity', ['https://a.org/1', 'https://c.org/1']),
    ]);
    expect(merged.independentDomains).toBe(3);
    expect(merged.citedByAll).toEqual([1]);
  });

  it('reports what each backend found alone', () => {
    const merged = mergeEvidence([
      run('gemini', ['https://a.org/1', 'https://only-gemini.org/x']),
      run('xai', ['https://a.org/1']),
    ]);
    const gem = merged.uniqueByProvider.find((u) => u.provider === 'gemini');
    const xai = merged.uniqueByProvider.find((u) => u.provider === 'xai');
    expect(gem?.count).toBe(1);
    expect(xai?.count).toBe(0);
  });
});

describe('describeOverlap', () => {
  it('warns when the fan-out mostly re-read the same pages', () => {
    // The expensive failure: three backends, one set of sources, triple the
    // bill and almost no extra breadth. Saying so is the point.
    const shared = ['https://a.org/1', 'https://b.org/1', 'https://c.org/1'];
    const text = describeOverlap(
      mergeEvidence([run('gemini', shared), run('perplexity', shared), run('xai', [...shared, 'https://d.org/1'])]),
    );
    expect(text).toMatch(/mostly re-read the same pages/);
    expect(text).toMatch(/several hats/);
    expect(text).toMatch(/WARNING/);
  });

  it('says merging earned its cost when the backends read different material', () => {
    const text = describeOverlap(
      mergeEvidence([
        run('gemini', ['https://a.org/1', 'https://b.org/1', 'https://c.org/1', 'https://d.org/1']),
        run('perplexity', ['https://e.org/1', 'https://f.org/1', 'https://g.org/1', 'https://h.org/1']),
      ]),
    );
    expect(text).toMatch(/genuinely earns its cost/);
    expect(text).toMatch(/uncorroborated rather than agreed/);
  });

  it('has nothing to cross-check with a single backend', () => {
    expect(describeOverlap(mergeEvidence([run('gemini', ['https://a.org/1'])]))).toMatch(/nothing to cross-check/);
  });
});

describe('renderMergedRegistry', () => {
  it('records which backend found each source', () => {
    const text = renderMergedRegistry(
      mergeEvidence([run('gemini', ['https://a.org/1']), run('xai', ['https://a.org/1', 'https://b.org/1'])]),
    );
    expect(text).toMatch(/found by: gemini, xai/);
    expect(text).toMatch(/found by: xai/);
  });

  it('says so plainly when there is nothing to cite', () => {
    expect(renderMergedRegistry(mergeEvidence([run('gemini', []), run('xai', [])]))).toMatch(/No cited sources/);
  });
});

describe('several runs from the same backend', () => {
  // Four Gemini runs is an ordinary thing to merge, and keying provenance on
  // the provider name collapsed them: every source read as unique to "gemini"
  // and the overlap read 0% however much the runs actually shared. Found by
  // running this against four real reports rather than by reasoning about it.
  const a = { runId: 'dr_aaaaaa1111', provider: 'gemini', markdown: reportCiting(['https://a.org/1', 'https://b.org/1']) };
  const b = { runId: 'dr_bbbbbb2222', provider: 'gemini', markdown: reportCiting(['https://a.org/1', 'https://c.org/1']) };

  it('distinguishes the runs rather than merging them into one label', () => {
    const merged = mergeEvidence([a, b]);
    const labels = merged.uniqueByProvider.map((u) => u.provider).sort();
    expect(labels).toEqual(['gemini/aaaaaa', 'gemini/bbbbbb']);
  });

  it('measures overlap between the runs instead of reporting none', () => {
    const merged = mergeEvidence([a, b]);
    expect(merged.citedByAll).toEqual([1]);
    expect(merged.overlapRatio).toBeCloseTo(1 / 3);
  });

  it('says overlap here is about the questions, not about independent agreement', () => {
    expect(describeOverlap(mergeEvidence([a, b]))).toMatch(/same backend, so overlap measures how much the questions differed/);
  });
});
