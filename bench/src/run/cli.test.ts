import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { NO_SEARCH_CLIS } from '../../../src/providers/loop.js';
import { HONOURS_TOOLS, NO_SEARCH_UNVERIFIED, parseArgs, refusesNoSearch } from './cli.js';

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

    it('HONOURS_TOOLS names exactly the backends whose REQUEST carries the tool set', () => {
      // Derived from the code path, not the file name, because the file name
      // got this wrong twice in one session and in both directions.
      //
      // `src/providers/gemini.ts` has no reference to `tools` and looked like a
      // backend that ignored them. It is a thin wrapper: the request is built
      // in `src/gemini/client.ts`, which maps `google_search` straight through.
      // So the map below names, per backend, the file that actually builds its
      // request, and a wrapper that merely forwards is followed rather than
      // grepped.
      const BUILDS_REQUEST: Record<string, string> = {
        gemini: '../../../src/gemini/client.ts',
        openai: '../../../src/providers/openai.ts',
        perplexity: '../../../src/providers/perplexity.ts',
        xai: '../../../src/providers/xai.ts',
        local: '../../../src/providers/local.ts',
      };
      const reads = new Set<string>();
      for (const [id, rel] of Object.entries(BUILDS_REQUEST)) {
        const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
        // Comments describe intent, not behaviour: a provider that only
        // mentions tools in prose does not send them.
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        if (/\btools\b/.test(code)) reads.add(id);
      }
      // The loop backends choose the CLI's argv, so they honour it for the CLIs
      // that can be denied their tools, and nowhere else.
      for (const cli of NO_SEARCH_CLIS) reads.add(`loop-${cli}`);
      expect([...reads].sort()).toEqual([...HONOURS_TOOLS].sort());
    });

    it('does not claim a Gemini no-search cell is closed-book', () => {
      // Receiving the request is not the same as obeying it. Deep Research is a
      // search agent whose own cost band is quoted as ~80 searches for fast and
      // ~160 for max, and nobody has tested what it does with no search tool
      // declared. Sorting it into either bucket would be a claim this benchmark
      // exists to catch.
      expect(HONOURS_TOOLS.has('gemini')).toBe(true);
      expect(NO_SEARCH_UNVERIFIED.has('gemini')).toBe(true);
      for (const p of ['openai', 'perplexity', 'xai', 'loop-claude']) {
        expect(NO_SEARCH_UNVERIFIED.has(p), p).toBe(false);
      }
    });
  });
});
