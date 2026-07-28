import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

    const forbidden = [
      /from 'node:fs'/,
      /from 'node:https?'/,
      /from 'node:net'/,
      /from 'node:child_process'/,
      /safe-fetch/,
      /\.\.\/citations\//,
      /\.\.\/\.\.\/\.\.\/src\//,
      /\bfetch\s*\(/,
      /Math\.random/,
    ];
    for (const file of sources) {
      const src = readFileSync(`${dir}${file}`, 'utf8');
      // Comments are stripped before the whole-file checks, because `random.ts`
      // documents at length why `Math.random` is the wrong answer here, and a
      // check that cannot tell an explanation from a call would force the
      // reason out of the file to keep the rule.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      const imports = [...src.matchAll(/^import[\s\S]*?from\s+'[^']+';/gm)].map((m) => m[0]).join('\n');
      for (const pattern of forbidden) {
        expect(`${file}: ${imports}`).not.toMatch(pattern);
        if (pattern.source.includes('fetch\\s*\\(') || pattern.source.includes('Math')) {
          expect(`${file}: ${code}`).not.toMatch(pattern);
        }
      }
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
