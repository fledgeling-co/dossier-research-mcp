import { join, resolve } from 'node:path';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';
import { buildDeps } from '../../../src/server.js';
import type { ProviderId } from '../../../src/providers/types.js';
import type { StartRunArgs } from '../../../src/research/runner.js';
import { loadCorpusFromDirectory, type BenchTask } from '../tasks/index.js';
import { boundedConcurrency, DEFAULT_CONCURRENCY, runBatch } from './harness.js';
import { planBatch } from './plan.js';
import { appendCell, readCells } from './store.js';
import { createCellExecutor } from './dossier.js';

/**
 * The entry point. A harness nobody can start is not one.
 *
 * Two properties are deliberate and both are about spend. **The ceiling is
 * required**, because a batch with no ceiling is the one that quietly buys four
 * figures of research, and `CLAUDE.md`'s rule is to fail closed on anything
 * that gates spend. And **the plan is printed before anything starts**, so the
 * cell count and the projected worst case are on screen before the first
 * dollar, not after it.
 *
 * Everything printed here goes to stderr. This is not the MCP server, but the
 * habit is worth keeping: a later `--json` flag should own stdout alone.
 */

interface CliArgs {
  readonly tasksDir: string;
  readonly outPath: string;
  readonly providers: readonly ProviderId[];
  readonly repetitions: number;
  readonly ceilingUsd: number;
  readonly concurrency: number;
  readonly includeFailed: boolean;
  readonly dryRun: boolean;
}

const USAGE = `Usage: bench-run --providers <a,b> --repeat <n> --ceiling <usd> [options]

  --providers <ids>   comma-separated backend ids (required)
  --repeat <n>        repetitions per task per backend (default 5, floor for a spread is 3)
  --ceiling <usd>     refuse the batch if the remainder projects above this (required)
  --tasks <dir>       corpus directory (default bench/tasks)
  --out <file>        cell store (default bench/results/cells.jsonl)
  --concurrency <n>   cells in flight (default ${String(DEFAULT_CONCURRENCY)})
  --include-failed    re-queue cells whose recorded outcome was a failure
  --dry-run           plan and print, start nothing`;

function parseArgs(argv: readonly string[]): CliArgs {
  const flags = new Map<string, string>();
  const bare = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      i += 1;
    } else {
      bare.add(name);
    }
  }

  const providers = (flags.get('providers') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (providers.length === 0) throw new Error(`--providers is required.\n\n${USAGE}`);

  const ceilingRaw = flags.get('ceiling');
  if (ceilingRaw === undefined) {
    throw new Error(
      `--ceiling is required. A batch with no ceiling is the one that quietly buys four figures of research.\n\n${USAGE}`,
    );
  }
  const ceilingUsd = Number(ceilingRaw);
  if (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0) {
    throw new Error(`--ceiling must be a positive number of dollars; got "${ceilingRaw}".`);
  }

  const repetitions = Number(flags.get('repeat') ?? '5');
  const concurrency = Number(flags.get('concurrency') ?? String(DEFAULT_CONCURRENCY));

  return {
    tasksDir: resolve(flags.get('tasks') ?? join('bench', 'tasks')),
    outPath: resolve(flags.get('out') ?? join('bench', 'results', 'cells.jsonl')),
    providers: providers as ProviderId[],
    repetitions,
    ceilingUsd,
    concurrency,
    includeFailed: bare.has('include-failed'),
    dryRun: bare.has('dry-run'),
  };
}

const say = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const deps = await buildDeps();

  // The reference date is the caller's, never the clock read twice: the corpus
  // loader is deliberately pure, and a batch that spans midnight must not
  // change its own staleness answers halfway through.
  const now = new Date();
  const corpus = loadCorpusFromDirectory(args.tasksDir, { now });
  if (corpus.tasks.length === 0) {
    say(`No tasks found under ${args.tasksDir}. Nothing to run.`);
    return 1;
  }

  // Stale tasks are loaded and scored, and counted as stale. The rule lives in
  // docs/bench/task-format.md; this is the surface that has to show it, because
  // a score over a corpus that is a third stale is a different claim.
  say(
    `Corpus: ${String(corpus.tasks.length)} tasks from ${args.tasksDir}` +
      (corpus.staleCount > 0
        ? `, ${String(corpus.staleCount)} of them stale (unverified for ${String(corpus.staleAfterDays)}+ days): ${corpus.staleIds.join(', ')}`
        : ', none stale'),
  );

  const recorded = readCells(args.outPath);
  if (recorded.unreadableLines.length > 0) {
    say(
      `Warning: ${String(recorded.unreadableLines.length)} line(s) of ${args.outPath} could not be read and their cells will be re-run: ` +
        recorded.unreadableLines.map((l) => `line ${String(l.line)} (${l.reason})`).join('; '),
    );
  }

  const budget = await deps.runner.budget();
  const plan = planBatch({
    taskIds: corpus.tasks.map((t) => t.id),
    providers: args.providers,
    repetitions: args.repetitions,
    completedKeys: recorded.completedKeys,
    failedKeys: recorded.failedKeys,
    includeFailed: args.includeFailed,
    // The same estimate the runner will reserve, so the projection and the gate
    // cannot drift apart.
    estimateCellUsd: (provider) =>
      deps.providers.get(provider as ProviderId)?.estimate({ tier: 'fast', tools: ['google_search'] })
        .cost.highUsd ?? 0,
    ceilingUsd: args.ceilingUsd,
    rollingRemainingUsd: budget.remainingUsd,
  });

  say('');
  say(`Matrix:    ${String(plan.totalCells)} cells (${String(corpus.tasks.length)} tasks x ${String(args.providers.length)} backends x ${String(args.repetitions)} repetitions)`);
  say(`Recorded:  ${String(plan.alreadyDone)}`);
  say(`Remaining: ${String(plan.queue.length)}`);
  say(`Projected: $${plan.projectedUsd.toFixed(2)} at worst case, against a ceiling of $${plan.ceilingUsd.toFixed(2)} (an estimate band, never a quote)`);
  say(`Spread:    ${plan.spreadIfComplete.reason}`);
  if (plan.rollingWindowWarning !== '') say(`Note:      ${plan.rollingWindowWarning}`);

  if (plan.refused) {
    say('');
    say(plan.refusal);
    return 2;
  }
  if (args.dryRun) {
    say('');
    say('Dry run: nothing started.');
    return 0;
  }
  if (plan.queue.length === 0) {
    say('');
    say('Every cell already has a recorded outcome. Nothing to do.');
    return 0;
  }

  const concurrency = boundedConcurrency(args.concurrency, deps.config.maxConcurrent);
  say('');
  say(`Running ${String(plan.queue.length)} cells at ${String(concurrency)} at a time. Appending to ${args.outPath}.`);

  const tasks = new Map<string, BenchTask>(corpus.tasks.map((t) => [t.id, t]));
  const execute = createCellExecutor({
    runner: deps.runner,
    store: deps.store,
    tasks,
    startArgs: (task, cell): StartRunArgs => ({
      question: task.question,
      prompt: task.question,
      archetype: 'technical',
      tier: 'fast',
      tools: [{ type: 'google_search' }],
      collaborativePlanning: false,
      thinkingSummaries: false,
      visualization: false,
      preEngineered: false,
      provider: cell.provider as ProviderId,
      repeat: cell.repeat,
      label: `bench ${cell.taskId} r${String(cell.repeat)}`,
      tags: ['bench'],
    }),
  });

  deps.runner.startPolling();
  try {
    const outcome = await runBatch({
      queue: plan.queue,
      concurrency,
      execute,
      record: async (cell) => {
        appendCell(args.outPath, cell);
      },
      onCell: (cell, done, total) => {
        say(
          `[${String(done)}/${String(total)}] ${cell.key} ${cell.outcome} in ${String(Math.round(cell.wallClockMs / 1000))}s` +
            (cell.outcome === 'failed' ? `: ${cell.reason.slice(0, 160)}` : ''),
        );
      },
    });
    say('');
    say(`Done. ${String(outcome.ok)} ok, ${String(outcome.failed)} failed, out of ${String(outcome.attempted)}.`);
    // A failed cell is a recorded result, not a crashed batch: the exit code
    // reports the batch ran, and the store carries which cells did not.
    return 0;
  } finally {
    deps.runner.stopPolling();
  }
}

/**
 * Run only when invoked directly, never on import.
 *
 * A test that imports this module to check the argument parsing must not
 * start a batch as a side effect of the import, which is the one way a
 * hermetic suite could be made to spend money.
 */
const invokedDirectly = argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href;
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      say(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    });
}
