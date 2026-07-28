import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { NO_SEARCH_CLIS } from '../../../src/providers/loop.js';
import { HONOURS_TOOLS, parseArgs, refusesNoSearch } from './cli.js';

/**
 * Argument parsing, tested on its own because every defect in it is a spend
 * defect. A flag that is silently ignored is not a usability problem here: a
 * dropped `--dry-run` starts a batch the caller believed was a rehearsal.
 *
 * Importing this module runs no batch. `cli.ts` only calls `main()` when it is
 * the process entry point, which under vitest it is not.
 */

const ok = ['--providers', 'gemini', '--ceiling', '100'];

describe('parseArgs', () => {
  it('parses the required flags and applies the documented defaults', () => {
    const args = parseArgs(ok);
    expect(args.providers).toEqual(['gemini']);
    expect(args.ceilingUsd).toBe(100);
    expect(args.repetitions).toBe(5);
    expect(args.concurrency).toBe(3);
    expect(args.dryRun).toBe(false);
    expect(args.includeFailed).toBe(false);
  });

  it('accepts --flag=value as well as --flag value', () => {
    expect(parseArgs(['--providers=gemini', '--ceiling=50', '--dry-run']).ceilingUsd).toBe(50);
    expect(parseArgs([...ok, '--dry-run=true']).dryRun).toBe(true);
  });

  // A ceiling is the only thing standing between a mistyped repetition count
  // and four figures of research.
  it('refuses to run without a ceiling, and refuses a nonsensical one', () => {
    expect(() => parseArgs(['--providers', 'gemini'])).toThrow(/--ceiling is required/);
    for (const bad of ['0', '-5', 'abc', '']) {
      expect(() => parseArgs(['--providers', 'gemini', '--ceiling', bad]), bad).toThrow();
    }
  });

  it('refuses a batch with no backends', () => {
    expect(() => parseArgs(['--ceiling', '10'])).toThrow(/--providers is required/);
    expect(() => parseArgs(['--providers', ' , ', '--ceiling', '10'])).toThrow(/--providers/);
  });

  // Checked against the authoritative id list rather than cast into it, so a
  // typo cannot reach the planner as a backend nothing can cost.
  it('refuses a backend id that does not exist, naming the ones that do', () => {
    expect(() => parseArgs(['--providers', 'gemni', '--ceiling', '10'])).toThrow(
      /Unknown backend "gemni"/,
    );
    expect(() => parseArgs(['--providers', 'gemini,nope', '--ceiling', '10'])).toThrow(
      /Known ids: /,
    );
  });

  // An unknown flag silently ignored is a typo that spends money: `--dry-rnu`
  // parsed as nothing at all left `dryRun` false and started the batch.
  it('refuses an unknown or malformed flag rather than ignoring it', () => {
    expect(() => parseArgs([...ok, '--dry-rnu'])).toThrow(/Unknown flag "--dry-rnu"/);
    expect(() => parseArgs([...ok, '--dry-run', 'true'])).toThrow(/Unexpected argument "true"/);
    expect(() => parseArgs([...ok, '--dry-run=yes'])).toThrow(/takes no value/);
    expect(() => parseArgs(['--providers'])).toThrow(/--providers needs a value/);
    expect(() => parseArgs(['stray', ...ok])).toThrow(/Unexpected argument "stray"/);
  });

  // The same backend twice would give two cells the same coordinates, so one
  // would overwrite the other in the store and the matrix would silently be
  // smaller than the plan reported.
  it('de-duplicates repeated backends', () => {
    expect(parseArgs(['--providers', 'gemini,perplexity,gemini', '--ceiling', '10']).providers).toEqual([
      'gemini',
      'perplexity',
    ]);
  });

  it('reads the switches and the optional values', () => {
    const args = parseArgs([...ok, '--repeat', '3', '--concurrency', '2', '--include-failed', '--dry-run']);
    expect(args).toMatchObject({
      repetitions: 3,
      concurrency: 2,
      includeFailed: true,
      dryRun: true,
    });
  });

  describe('the no-search flag', () => {
    it('is a switch, and defaults to off', () => {
      expect(parseArgs(['--providers', 'openai', '--ceiling', '5']).noSearch).toBe(false);
      expect(parseArgs(['--providers', 'openai', '--ceiling', '5', '--no-search']).noSearch).toBe(true);
    });

    it('separates a backend that refuses a no-search run from one that ignores the flag', () => {
      // Three states, not two. `gemini` ignores the request and answers with
      // search on; `loop-codex` throws. Both fail to honour it, and collapsing
      // them queues a batch that dies one spawn at a time instead of being
      // refused once, up front, with a reason.
      expect(refusesNoSearch('loop-codex')).toBe(true);
      expect(refusesNoSearch('loop-claude')).toBe(false);
      expect(refusesNoSearch('gemini')).toBe(false);
      expect(refusesNoSearch('local-claude')).toBe(false);
    });

    it('HONOURS_TOOLS names exactly the providers whose source reads args.tools', () => {
      // The printed reassurance is only as true as this set. A provider that
      // grows tool support and is not added here would be reported as
      // closed-book while it searched; one that loses it would be reported as
      // having searched when it did not. Both are the benchmark lying about
      // its own conditions, so the set is re-derived rather than trusted.
      const CANDIDATES = ['gemini', 'openai', 'perplexity', 'xai', 'local'] as const;
      const reads = new Set<string>();
      for (const id of CANDIDATES) {
        const src = readFileSync(new URL(`../../../src/providers/${id}.ts`, import.meta.url), 'utf8');
        // Comments describe intent, not behaviour: a provider that only
        // mentions tools in prose does not send them.
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        if (/\btools\b/.test(code)) reads.add(id);
      }
      // The loop backends read the declared tools too, and act on them by
      // choosing the CLI's argv, so they belong in the set for the CLIs that
      // can be denied their tools and nowhere else. This half was wrong when
      // first written: the flag reached `loop-claude` while the run printed
      // that it did not, which is the same false reassurance in the opposite
      // direction. It is derived from the provider now.
      for (const cli of NO_SEARCH_CLIS) reads.add(`loop-${cli}`);
      expect([...reads].sort()).toEqual([...HONOURS_TOOLS].sort());
    });
  });
});
