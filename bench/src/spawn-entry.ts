import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * Running a benchmark entry point as a real process, for a wiring test.
 *
 * **Test support.** Nothing in a shipped path imports this.
 *
 * Four entry points in `bench/src/` guard their own invocation, and a guard
 * that silently stopped firing would make `npm run bench:<x>` print nothing and
 * exit 0 while every in-process test stayed green. That is the defect BENCH-14
 * was created for, so each of them keeps one case that spawns the real thing.
 * This is the one copy of how, because four hand-written copies of a spawn
 * helper is four chances for one of them to resolve its interpreter the way the
 * original did: by a literal path into `node_modules`, which does not exist in
 * a git worktree and cost eleven red tests to find.
 */

/**
 * tsx, through Node's own resolution rather than an assumed layout.
 *
 * `createRequire` walks ancestor `node_modules` directories exactly as an
 * `import` would, so a worktree inside the repo finds the root install. A
 * literal relative path finds nothing there, which was the defect.
 */
export function resolveTsx(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve('tsx/cli');
  } catch {
    return undefined;
  }
}

/**
 * Why a process-dependent case skipped, when it does.
 *
 * A constant rather than an inline string so it can be asserted on. A skip
 * reason only ever prints in the environment that cannot check it, which is
 * exactly the wording nobody notices going wrong.
 */
export const TSX_MISSING =
  'tsx could not be resolved from this checkout, so the entry point cannot be run as a ' +
  'process. Run `npm install` here or in any directory above this one, then re-run. ' +
  'Every other case in this file runs in-process and still covers the command logic.';

export interface SpawnedEntry {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run one entry point as a process, the way a person runs it.
 *
 * `process.execPath` and tsx's own entry rather than the `.bin` shim, so this
 * does not depend on a shim existing or being executable either. The
 * environment is inherited so paths resolve as they do for a person, and
 * `DOSSIER_HERMETIC` is set so nothing can reach a model.
 */
export function spawnEntry(
  tsx: string,
  entry: string,
  args: readonly string[] = [],
  cwd?: string,
): Promise<SpawnedEntry> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [tsx, entry, ...args], {
      ...(cwd === undefined ? {} : { cwd }),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DOSSIER_HERMETIC: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}
