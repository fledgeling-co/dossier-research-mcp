import { mkdtempSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { CliStatus } from '../../../src/local/cli.js';
import { resolveTsx, spawnEntry, TSX_MISSING } from '../spawn-entry.js';
import { argvFor, parseArgs, runFailCheck, type FailCheckIo, type Options } from './cli.js';

/**
 * The gate, and the wiring.
 *
 * This file exists because `bench:failcheck` spent a subscription quota with no
 * confirmation of any kind, while its sibling `bench/src/detector/cli.ts`
 * refused the same class of run without one. Its own header said never to point
 * it at a paid backend, which is a comment rather than a check.
 *
 * Two halves, and both are needed for different reasons:
 *
 * - **The refusals**, which is what the item is for. Every one asserts that
 *   `ask` and `identify` were never reached, because "refused" and "refused
 *   before spawning anything" are different claims and only the second is the
 *   acceptance criterion.
 * - **The confirmed run**, which is the half a refusal-only suite would miss
 *   entirely. An implementation that refused unconditionally would pass every
 *   case above and leave the script dead, so one case drives the whole loop
 *   over scripted seams and asserts the evidence file and the tally.
 *
 * Plus one real spawn, on BENCH-14's judgement: nothing an import can see
 * proves that anything calls the entry point. It takes the refusal path, so it
 * is hermetic by construction.
 */

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

const TSX_CLI = resolveTsx();

const roots: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-failcheck-'));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const TASK_YAML = (id: string): string =>
  [
    `id: ${id}`,
    'category: technical',
    `question: what version of containerd was published, and on what date, for ${id}`,
    'asOf: "2026-07-01"',
    'reverifiedAt: "2026-07-01"',
    'goldFacts:',
    '  - id: f1',
    '    kind: name',
    '    value: containerd',
    '    source:',
    '      url: https://example.test/a',
    'requiredTerms:',
    '  - containerd',
  ].join('\n');

/** A corpus of `n` tasks on disk, so the count in a refusal is a real count. */
function corpusOf(n: number): string {
  const dir = temp();
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i += 1) {
    writeFileSync(join(dir, `task-${String(i)}.yaml`), TASK_YAML(`task-${String(i)}`), 'utf8');
  }
  return dir;
}

const READY: CliStatus = {
  id: 'claude',
  label: 'Claude Code',
  state: 'ready',
  detail: 'installed (1.2.3) and signed in',
  version: '1.2.3',
  billing: 'covered by a subscription',
};

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Every question the command asked. Empty is the assertion that matters most. */
  readonly asked: string[];
  /** The executable each question was actually asked through. */
  readonly spawnedPaths: string[];
  /** Every binary it tried to identify. A `--version` probe is still a spawn. */
  readonly identified: string[];
  readonly written: { path: string; text: string }[];
}

/** Drive the command in this process, recording everything it reached for. */
async function run(
  args: readonly string[],
  over: { readonly answer?: string; readonly status?: CliStatus } = {},
): Promise<Ran> {
  let stdout = '';
  let stderr = '';
  const asked: string[] = [];
  const spawnedPaths: string[] = [];
  const identified: string[] = [];
  const written: { path: string; text: string }[] = [];

  const io: FailCheckIo = {
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
    ask: (question: string, _options: Options, binPath: string) => {
      asked.push(question);
      spawnedPaths.push(binPath);
      return Promise.resolve(over.answer ?? '');
    },
    identify: (bin) => {
      identified.push(bin);
      return Promise.resolve(over.status ?? READY);
    },
    writeEvidence: (path, text) => {
      written.push({ path, text });
    },
  };
  const code = await runFailCheck(args, io);
  return { code, stdout, stderr, asked, spawnedPaths, identified, written };
}

describe('GATE-01 nothing is spawned without --confirm', () => {
  it('refuses, and neither asks nor identifies anything', async () => {
    const ran = await run(['--dir', corpusOf(3)]);
    expect(ran.code).toBe(1);
    // The half that matters. "Refused" and "refused before spawning anything"
    // are different claims, and a `--version` probe is a spawn as much as a
    // question is.
    expect(ran.asked).toEqual([]);
    expect(ran.identified).toEqual([]);
    expect(ran.written).toEqual([]);
    expect(ran.stderr).toContain('--confirm');
    expect(ran.stderr).toContain('Nothing has been spawned');
  });

  it('names the count, the mode, the binary and the concurrency it would use', async () => {
    const ran = await run(['--dir', corpusOf(3), '--concurrency', '2']);
    expect(ran.stderr).toContain('3 selected task(s)');
    expect(ran.stderr).toContain('closed-book mode');
    expect(ran.stderr).toContain('`claude`');
    expect(ran.stderr).toContain('2 at a time');
  });

  it('the count is the count after filtering, not the whole corpus', async () => {
    const dir = corpusOf(5);
    const ran = await run(['--dir', dir, '--ids', 'task-0,task-1']);
    expect(ran.stderr).toContain('2 selected task(s)');
  });
});

describe('GATE-02 the refusal quotes what is recorded, not what is assumed', () => {
  it('says the quota is a subscription rather than a metered balance', async () => {
    const ran = await run(['--dir', corpusOf(1)]);
    expect(ran.stderr).toMatch(/subscription quota rather than a metered balance/);
  });

  it("carries that backend's dated coverage claim from the product's own catalogue", async () => {
    const ran = await run(['--dir', corpusOf(1)]);
    // Dated and sourced, per CLAUDE.md, rather than a sentence written here.
    expect(ran.stderr).toContain('Pro/Max/Team subscription');
    expect(ran.stderr).toMatch(/verified \d{1,2} July 2026/);
  });

  it('carries the caution that a key in the environment converts this to per-token billing', async () => {
    // This is the exact hazard the file's old header described in prose while
    // the code cleared the key and said nothing to the operator.
    const ran = await run(['--dir', corpusOf(1)]);
    expect(ran.stderr).toContain('ANTHROPIC_API_KEY');
  });
});

describe('GATE-03 a backend it has no headless form for is refused', () => {
  it('refuses a name that is not a CLI this product knows at all', async () => {
    const ran = await run(['--dir', corpusOf(1), '--bin', './my-wrapper', '--confirm']);
    expect(ran.code).toBe(1);
    expect(ran.asked).toEqual([]);
    expect(ran.identified).toEqual([]);
    expect(ran.stderr).toContain('not a CLI this product knows about');
    expect(ran.stderr).toContain('claude, codex');
  });

  it('refuses a CLI the product does know but this check has no argv for, and says which', async () => {
    const ran = await run(['--dir', corpusOf(1), '--bin', 'grok', '--confirm']);
    expect(ran.code).toBe(1);
    expect(ran.asked).toEqual([]);
    expect(ran.stderr).toContain('Grok Build');
    expect(ran.stderr).toMatch(/dies at argument parsing/);
  });

  it('refuses before it counts anything, so no corpus is even read', async () => {
    // A directory that does not exist. Reaching the loader would throw; the
    // refusal has to come first.
    const ran = await run(['--dir', join(tmpdir(), 'no-such-corpus-dir'), '--bin', 'nonsense']);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('not a backend this check can run');
  });
});

describe('GATE-04 a mode the backend cannot support is refused before the count', () => {
  it('refuses closed-book on codex, and does not print a task count it could not have run', async () => {
    const ran = await run(['--dir', corpusOf(4), '--bin', 'codex', '--confirm']);
    expect(ran.code).toBe(1);
    expect(ran.asked).toEqual([]);
    expect(ran.identified).toEqual([]);
    expect(ran.stderr).toContain('closed-book mode is implemented for claude only');
    // The defect this ordering fixes: a refusal naming four tasks for a
    // combination capable of none of them.
    expect(ran.stderr).not.toContain('4 selected');
  });

  it('accepts codex in search mode', async () => {
    const ran = await run(['--dir', corpusOf(1), '--mode', 'search', '--bin', 'codex']);
    expect(ran.stderr).toContain('search mode');
    expect(ran.stderr).toContain('--confirm');
  });
});

describe('GATE-05 an unidentified or unauthenticated binary is never run', () => {
  it('refuses when the probe cannot identify the binary, after --confirm', async () => {
    const ambiguous: CliStatus = {
      id: 'claude',
      label: 'Claude Code',
      state: 'ambiguous',
      detail: '`claude` resolves to /usr/local/bin/claude but reports "claude 0.1", which does not identify it',
      billing: 'covered by a subscription',
    };
    const ran = await run(['--dir', corpusOf(3), '--confirm'], { status: ambiguous });
    expect(ran.code).toBe(1);
    // It probed, which is the point of confirming, and then asked nothing.
    expect(ran.identified).toEqual(['claude']);
    expect(ran.asked).toEqual([]);
    expect(ran.written).toEqual([]);
    expect(ran.stderr).toContain('is ambiguous');
    expect(ran.stderr).toContain('Nothing was spawned');
  });

  it('refuses when the binary is present but not signed in', async () => {
    const unauthed: CliStatus = {
      id: 'claude',
      label: 'Claude Code',
      state: 'present-unauthed',
      detail: 'installed (1.2.3) but no sign-in state found',
      billing: 'covered by a subscription',
    };
    const ran = await run(['--dir', corpusOf(3), '--confirm'], { status: unauthed });
    expect(ran.code).toBe(1);
    expect(ran.asked).toEqual([]);
    // Because the alternative is worse than an error: an unauthenticated CLI
    // answers nothing, and an empty answer scores as a task that failed, which
    // is a wrong admission decision nobody would notice.
    expect(ran.stderr).toContain('answers nothing');
  });
});

describe('GATE-06 with --confirm it actually runs', () => {
  it('probes every selected task, writes the evidence file and reports the tally', async () => {
    const out = join(temp(), 'evidence.json');
    const ran = await run(['--dir', corpusOf(3), '--out', out, '--confirm']);

    expect(ran.code).toBe(0);
    expect(ran.identified).toEqual(['claude']);
    expect(ran.asked).toHaveLength(3);
    expect(ran.asked[0]).toContain('containerd');
    expect(ran.written).toHaveLength(1);
    expect(ran.written[0]?.path).toBe(out);

    const evidence: unknown = JSON.parse(ran.written[0]?.text ?? '{}');
    const report = evidence as { mode: string; backend: string; noResponse: number };
    expect(report.mode).toBe('closed-book');
    expect(report.backend).toBe('claude');
    expect(report.noResponse).toBe(3);
    expect(ran.stderr).toContain('no-response=3');
  });

  it('exits non-zero when a task is already passed, the way a red test stops a change', async () => {
    const ran = await run(['--dir', corpusOf(2), '--out', join(temp(), 'e.json'), '--confirm'], {
      answer: 'The answer is containerd, obviously.',
    });
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('already-passed=2');
  });

  it('asks through the executable the probe resolved, not the id it was asked about', async () => {
    // The product gives the id `cursor` the binary `cursor-agent`, so spawning
    // the id would run something else. Spawning the resolved path also closes
    // the gap between establishing what a binary is and running it.
    const resolved: CliStatus = { ...READY, path: '/opt/homebrew/bin/claude' };
    const ran = await run(['--dir', corpusOf(2), '--out', join(temp(), 'e.json'), '--confirm'], {
      status: resolved,
    });
    expect(ran.spawnedPaths).toEqual(['/opt/homebrew/bin/claude', '/opt/homebrew/bin/claude']);
  });

  it('respects --limit, so a confirmed run cannot exceed what the refusal named', async () => {
    const ran = await run(['--dir', corpusOf(5), '--limit', '2', '--out', join(temp(), 'e.json'), '--confirm']);
    expect(ran.asked).toHaveLength(2);
  });
});

describe('GATE-07 the argument parser', () => {
  it('defaults to the mode, backend and concurrency the docs promise', () => {
    const parsed = parseArgs([]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.mode).toBe('closed-book');
    expect(parsed.options.bin).toBe('claude');
    expect(parsed.options.concurrency).toBe(4);
    expect(parsed.options.confirm).toBe(false);
  });

  it('never defaults confirm to true, whatever else is passed', () => {
    for (const args of [[], ['--mode', 'search'], ['--limit', '1'], ['--bin', 'codex']]) {
      const parsed = parseArgs(args);
      expect(parsed.ok && parsed.options.confirm, args.join(' ')).toBe(false);
    }
  });

  it('builds the documented argv for each backend and mode', () => {
    const base = parseArgs(['--mode', 'search', '--bin', 'codex']);
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    expect(argvFor('q', base.options)).toEqual(['exec', 'q']);

    const claude = parseArgs(['--mode', 'search']);
    if (!claude.ok) return;
    expect(argvFor('q', claude.options)).toEqual(['-p', '--', 'q']);

    const closed = parseArgs([]);
    if (!closed.ok) return;
    expect(argvFor('q', closed.options)[0]).toBe('-p');
    expect(argvFor('q', closed.options)).toContain('--disallowedTools');
  });
});

describe('GATE-08 usage', () => {
  it('prints usage naming the confirmation flag and what it spends', async () => {
    const ran = await run(['--help']);
    expect(ran.code).toBe(0);
    // Usage is the command's output, so it goes to stdout where a caller can
    // redirect it. Every other line this command writes is a diagnostic.
    expect(ran.stdout).toContain('--confirm');
    expect(ran.stdout).toContain('spends that CLI');
    expect(ran.stderr).toBe('');
    expect(ran.asked).toEqual([]);
  });

  it('a refusal is a diagnostic and stays off stdout', async () => {
    const ran = await run(['--dir', corpusOf(1)]);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toContain('--confirm');
  });
});

describe('GATE-09 importing the entry point does not run it', () => {
  it('spawns nothing and reads no corpus as an import side effect', () => {
    // This file imported `./cli.js` at the top. Without the entry-point guard
    // that import would have started a fail-check against the real corpus, and
    // spent a subscription quota, before any case ran.
    expect(typeof runFailCheck).toBe('function');
  });
});

describe('GATE-10 the entry point is wired', () => {
  it('the real CLI, spawned over its real argv, refuses and writes nothing', async (ctx) => {
    const tsx = TSX_CLI;
    if (tsx === undefined) {
      ctx.skip(TSX_MISSING);
      return;
    }
    // One spawn, not several. The wiring property needs exactly one process,
    // and each extra one is real load on a suite that also runs a file-lock
    // contention test measured in wall-clock time. Every assertion this case
    // could want is available from the same run.
    //
    // Hermetic by construction: the refusal path is the one that spawns
    // nothing, so proving the entry point runs costs no quota at all.
    const out = join(temp(), 'must-not-exist.json');
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const ran = await spawnEntry(tsx, CLI, ['--dir', corpusOf(2), '--out', out], repoRoot);

    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('2 selected task(s)');
    expect(ran.stderr).toContain('--confirm');
    // stdout is reserved; everything this command says is a diagnostic.
    expect(ran.stdout).toBe('');
    // And it stopped before the work, not after it.
    expect(existsSync(out)).toBe(false);
  }, 60_000);

  it('names the missing binary and the fix in its skip reason', () => {
    expect(TSX_MISSING).toContain('tsx');
    expect(TSX_MISSING).toContain('npm install');
    expect(TSX_MISSING).toMatch(/in-process/);
  });
});

describe('GATE-11 the corpus the script ships still loads through this path', () => {
  it('counts the real corpus in its refusal, so the gate is not only exercised on fixtures', async () => {
    const repoTasks = fileURLToPath(new URL('../../tasks', import.meta.url));
    const ran = await run(['--dir', repoTasks]);
    expect(ran.code).toBe(1);
    // However many tasks are admitted, the refusal states a real number.
    expect(ran.stderr).toMatch(/\d+ selected task\(s\)/);
    expect(readFileSync(new URL('./cli.ts', import.meta.url), 'utf8')).toContain('--confirm');
  });
});
