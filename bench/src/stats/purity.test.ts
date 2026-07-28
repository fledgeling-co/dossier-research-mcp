import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findImpureImports, stripComments } from '../import-graph.js';
import { describe, expect, it } from 'vitest';
import * as stats from './index.js';

/**
 * STAT-15: nothing here can reach a disk, a network, a model or a wallet.
 *
 * Read off the source rather than off behaviour, and both matter for different
 * reasons: "it happened not to fetch this time" is a different claim from "it
 * cannot fetch". The property being protected is the one
 * `docs/plan/benchmark.md` bought by separating the run from the scoring, that a
 * statistic invented in three months applies to research already paid for. That
 * is only real if nothing on this path needs a network.
 */
describe('STAT-15 the statistics are pure over stored numbers', () => {
  it('imports nothing that opens a file, fetches, spawns or spends', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(sources.length).toBeGreaterThan(4);

    for (const file of sources) {
      // **Transitively**, since BENCH-15. This read each file's own text, which
      // proves only that the file does not import a filesystem *directly*, and
      // every module here imports siblings. The walk is
      // `bench/src/import-graph.ts`, which is `detector/`'s and `citations`',
      // because a second wording of one rule is how two guards end up
      // enforcing different things. It also carries the two escape hatches a
      // static walk cannot follow, `createRequire` and a bare `fetch(`.
      const reaches = findImpureImports(join(dir, file));
      expect(reaches.map((r) => `${r.module} via ${r.path.join(' -> ')}`), file).toEqual([]);
    }
  });

  it('would notice an impurity rather than being green because it sees nothing', () => {
    // Driven at a module that really does open a file. A purity check that
    // cannot fail is not a purity check.
    const reaches = findImpureImports(
      fileURLToPath(new URL('../tasks/files.ts', import.meta.url)),
    );
    expect(reaches.map((r) => r.module)).toContain('node:fs');
  });

  it('imports no product code and draws no unseeded randomness', () => {
    // Two rules the impurity walk does not answer and which are this
    // directory's own. `../../../src/` is a design boundary rather than a
    // purity one: the statistics are pure over stored numbers and must not
    // acquire the product's opinions. `Math.random` is determinism, which is
    // what makes a bootstrap reproducible from a stored cell.
    //
    // Read off the text, with comments stripped, because `random.ts` documents
    // at length why `Math.random` is the wrong answer here and a check that
    // could not tell an explanation from a call would force the reason out of
    // the file to keep the rule.
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    for (const file of sources) {
      const code = stripComments(readFileSync(join(dir, file), 'utf8'));
      expect(`${file}: ${code}`).not.toMatch(/\.\.\/citations\//);
      expect(`${file}: ${code}`).not.toMatch(/\.\.\/\.\.\/\.\.\/src\//);
      expect(`${file}: ${code}`).not.toMatch(/safe-fetch/);
      expect(`${file}: ${code}`).not.toMatch(/Math\.random/);
    }
  });

  it('exports the four statistics under one barrel, with no name colliding with the scorers', () => {
    // A name collision through an append-only merge already nearly shipped on
    // this fleet, when two slices both exported `containment` over different
    // objects and a keep-both resolution put them in one barrel under one name.
    expect(Object.keys(stats).sort()).toEqual([
      'DEFAULT_CONFIDENCE',
      'DEFAULT_PASS_THRESHOLD',
      'DEFAULT_RESAMPLES',
      'NO_MEASURED_DIFFERENCE',
      'byCluster',
      'clusterBootstrap',
      'clusteredError',
      'millerClusteredVariance',
      'mulberry32',
      'pairedDifference',
      'passRates',
      'quantile',
      'seedFrom',
    ]);
  });
});
