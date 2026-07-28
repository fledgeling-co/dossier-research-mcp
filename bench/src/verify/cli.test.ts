import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveTsx, spawnEntry, TSX_MISSING } from '../spawn-entry.js';
import type { FetchedSource } from './verify.js';
import { runVerify, type VerifyIo } from './cli.js';

/**
 * The wiring, and the fetch this command exists to make.
 *
 * `bench:verify` had no test of any kind. It carried exactly the defect
 * BENCH-14 was created to fix, and nobody noticed because BENCH-14 was scoped
 * to the one file that had already broken. `verify.ts` and `match.ts` are well
 * covered; nothing proved anything ever called them.
 *
 * Two properties are asserted that a unit test over `verify.ts` cannot see:
 *
 * - **The command runs.** One case spawns the real entry point over real argv.
 *   It is hermetic because it is handed an empty corpus, so the fetch loop has
 *   nothing to fetch.
 * - **It writes where it was told.** `--out` defaults to a committed evidence
 *   file, `bench/evidence/gold-verification.json`, and the write is
 *   unconditional. A test that drove this command without redirecting the
 *   output would overwrite the record of what was proven with an empty report
 *   and stay green while doing it, so the write is behind a seam and every case
 *   here asserts the path.
 */

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const TSX_CLI = resolveTsx();

const roots: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-verify-'));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const QUOTE = 'containerd 2.1.4 was published on 8 July 2026.';

const TASK_YAML = [
  'id: containerd-release',
  'category: technical',
  'question: which version of containerd was published on 8 July 2026, and on what date',
  'asOf: "2026-07-08"',
  'reverifiedAt: "2026-07-08"',
  'goldFacts:',
  '  - id: version',
  '    kind: identifier',
  "    value: '2.1.4'",
  '    source:',
  '      url: https://example.test/containerd',
  `      quote: ${QUOTE}`,
  'requiredTerms:',
  '  - containerd',
].join('\n');

function corpus(withTask: boolean): string {
  const dir = temp();
  mkdirSync(dir, { recursive: true });
  if (withTask) writeFileSync(join(dir, 'containerd.yaml'), TASK_YAML, 'utf8');
  return dir;
}

interface Ran {
  readonly code: number;
  readonly stderr: string;
  readonly fetched: string[];
  readonly written: { path: string; text: string }[];
}

/** Drive the command in this process, over a scripted fetcher. */
async function run(args: readonly string[], body = QUOTE): Promise<Ran> {
  let stderr = '';
  const fetched: string[] = [];
  const written: { path: string; text: string }[] = [];

  const io: VerifyIo = {
    err: (text) => {
      stderr += text;
    },
    fetcher: (url: string): Promise<FetchedSource> => {
      fetched.push(url);
      return Promise.resolve({
        url,
        status: 200,
        ok: true,
        body,
        contentType: 'text/plain',
        truncated: false,
      });
    },
    writeEvidence: (path, text) => {
      written.push({ path, text });
    },
  };
  const code = await runVerify(args, io);
  return { code, stderr, fetched, written };
}

describe('VERIFY-01 the command runs a real verification', () => {
  it('fetches every cited source and reports each fact proven', async () => {
    const out = join(temp(), 'evidence.json');
    const ran = await run(['--dir', corpus(true), '--out', out]);

    expect(ran.code).toBe(0);
    expect(ran.fetched).toEqual(['https://example.test/containerd']);
    expect(ran.stderr).toContain('Verifying 1 task(s)');
    expect(ran.stderr).toContain('1/1 source checks proven');
  });

  it('exits non-zero when a fact is not in the source it cites', async () => {
    const ran = await run(
      ['--dir', corpus(true), '--out', join(temp(), 'e.json')],
      'A page about something else entirely.',
    );
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('Unproven:');
  });

  it('writes the evidence file where it was told, and nowhere else', async () => {
    const out = join(temp(), 'nested', 'evidence.json');
    const ran = await run(['--dir', corpus(true), '--out', out]);
    expect(ran.written).toHaveLength(1);
    expect(ran.written[0]?.path).toBe(out);

    const report: unknown = JSON.parse(ran.written[0]?.text ?? '{}');
    expect((report as { proven: number }).proven).toBe(1);
  });

  it('--quiet suppresses the per-check lines but keeps the summary', async () => {
    const loud = await run(['--dir', corpus(true), '--out', join(temp(), 'a.json')]);
    const quiet = await run(['--dir', corpus(true), '--out', join(temp(), 'b.json'), '--quiet']);
    expect(loud.stderr).toContain('ok  ');
    expect(quiet.stderr).not.toContain('ok  ');
    expect(quiet.stderr).toContain('source checks proven');
  });

  it('an empty corpus fetches nothing and passes, which is what makes the spawn below hermetic', async () => {
    const ran = await run(['--dir', corpus(false), '--out', join(temp(), 'e.json')]);
    expect(ran.code).toBe(0);
    expect(ran.fetched).toEqual([]);
  });
});

describe('VERIFY-02 importing the entry point does not run it', () => {
  it('reaches no network and reads no corpus as an import side effect', () => {
    // This file imported `./cli.js` at the top. Without the entry-point guard
    // that import would have fetched every source in the shipped corpus before
    // any case ran, and overwritten the committed evidence file with the
    // result.
    expect(typeof runVerify).toBe('function');
  });
});

describe('VERIFY-03 the entry point is wired', () => {
  it('the real CLI, spawned over its real argv, verifies an empty corpus and writes only where told', async (ctx) => {
    const tsx = TSX_CLI;
    if (tsx === undefined) {
      ctx.skip(TSX_MISSING);
      return;
    }
    // One spawn, not several. The wiring property needs exactly one process,
    // and each extra one is real load on a suite that also runs a file-lock
    // contention test measured in wall-clock time.
    //
    // An empty corpus and a temp `--out`, so this proves the entry point runs
    // without reaching a network and without touching the committed evidence.
    // That second half is the specific hazard: the default `--out` is a file
    // under version control and the write is unconditional, so a spawn that
    // forgot to redirect it would erase the record of what the gold set proved.
    const committed = fileURLToPath(
      new URL('../../evidence/gold-verification.json', import.meta.url),
    );
    const before = existsSync(committed);
    const out = join(temp(), 'spawned-evidence.json');
    const ran = await spawnEntry(tsx, CLI, ['--dir', corpus(false), '--out', out]);

    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stderr).toContain('Verifying 0 task(s)');
    expect(ran.stderr).toContain('0/0 source checks proven');
    // Everything this command says is a diagnostic; stdout is left clear.
    expect(ran.stdout).toBe('');
    expect(existsSync(out)).toBe(true);
    expect(existsSync(committed)).toBe(before);
  }, 60_000);

  it('names the missing binary and the fix in its skip reason', () => {
    expect(TSX_MISSING).toContain('tsx');
    expect(TSX_MISSING).toContain('npm install');
    expect(TSX_MISSING).toMatch(/in-process/);
  });
});
