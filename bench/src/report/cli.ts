import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { argv, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadCorpusFromDirectory, type BenchTask } from '../tasks/index.js';
import { readCells } from '../run/store.js';
import { readEvidence } from '../citations/store.js';
import { evidenceMatchesReport } from '../citations/store.js';
import { harvestCell, type ScoredCell } from './harvest.js';
import { aggregate } from './aggregate.js';
import { render, type ReportFormat } from './render.js';

/**
 * The entry point. A report nobody can render is not one.
 *
 * The **only** file in this slice that opens anything. Everything it reads it
 * hands to a pure function, which is what keeps the property
 * `docs/plan/benchmark.md` bought by separating the run from the scoring: a
 * metric added in three months applies to research already paid for, because
 * nothing on this path needs a network, a model or a wallet.
 *
 * There is deliberately no code path from here to `Runner.start`. This tool
 * cannot spend money, and that is a structural fact rather than a promise.
 *
 * The rendered report goes to **stdout**, which is what a caller pipes into a
 * file; every diagnostic goes to stderr. `bench/src/run/cli.ts` says a later
 * `--json` flag should own stdout alone, and this is that tool.
 */

export interface ReportCliArgs {
  readonly cellsPath: string;
  readonly tasksDir: string;
  /** The Dossier store root. `CellOk.reportPath` is relative to it. */
  readonly storeDir: string;
  /** BENCH-03's evidence snapshots, keyed by cell key. */
  readonly evidenceDir: string;
  readonly minTasksPerCategory: number | undefined;
  readonly format: ReportFormat;
  /** The date staleness is measured against, `YYYY-MM-DD`. */
  readonly asOf: string;
}

const USAGE = `Usage: bench-report [options]

  --cells <file>      cell store to read (default bench/results/cells.jsonl)
  --tasks <dir>       corpus directory (default bench/tasks)
  --store <dir>       Dossier store root, holding reports/ (default $DOSSIER_STORE_DIR)
  --evidence <dir>    citation evidence snapshots (default beside the registry cache)
  --min-tasks <n>     tasks a category needs before it is scored at all (default 5)
  --format <fmt>      markdown (default) or json
  --as-of <date>      YYYY-MM-DD the corpus staleness is measured against (default today)

Reads stored results and renders them. Runs no research, calls no model, spends nothing.`;

const VALUE_FLAGS = new Set(['cells', 'tasks', 'store', 'evidence', 'min-tasks', 'format', 'as-of']);

/** Exported for the arg-parsing tests. An ignored typo here renders the wrong store. */
export function parseArgs(args: readonly string[]): ReportCliArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument "${arg}".\n\n${USAGE}`);
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    // Refused rather than ignored, exactly as the run CLI does. A dropped
    // `--min-taks` would silently render against the default floor and publish
    // a score the operator thought they had withheld.
    if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown flag "--${name}".\n\n${USAGE}`);
    if (inline !== undefined) {
      flags.set(name, inline);
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`--${name} needs a value.\n\n${USAGE}`);
    }
    flags.set(name, next);
    i += 1;
  }

  const formatRaw = flags.get('format') ?? 'markdown';
  if (formatRaw !== 'markdown' && formatRaw !== 'json') {
    throw new Error(`--format must be markdown or json; got "${formatRaw}".`);
  }

  const asOf = flags.get('as-of') ?? new Date().toISOString().slice(0, 10);
  // Both checks are needed: the shape check rejects `2026-7-1`, and the parse
  // check rejects `2026-02-31`, which matches the shape and is not a date.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`))) {
    throw new Error(`--as-of must be a real date as YYYY-MM-DD; got "${asOf}".`);
  }

  const minRaw = flags.get('min-tasks');
  let minTasksPerCategory: number | undefined;
  if (minRaw !== undefined) {
    minTasksPerCategory = Number(minRaw);
    if (!Number.isInteger(minTasksPerCategory) || minTasksPerCategory < 1) {
      throw new Error(`--min-tasks must be a positive integer; got "${minRaw}".`);
    }
  }

  const storeDir = flags.get('store') ?? process.env['DOSSIER_STORE_DIR'];

  return {
    cellsPath: resolve(flags.get('cells') ?? join('bench', 'results', 'cells.jsonl')),
    tasksDir: resolve(flags.get('tasks') ?? join('bench', 'tasks')),
    storeDir: resolve(
      storeDir === undefined || storeDir === ''
        ? join(homedir(), '.dossier-research-mcp')
        : storeDir,
    ),
    evidenceDir: resolve(
      flags.get('evidence') ?? join(homedir(), '.dossier-research-mcp', 'citation-evidence'),
    ),
    minTasksPerCategory,
    format: formatRaw,
    asOf,
  };
}

const say = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/**
 * Read a report from the Dossier store.
 *
 * `undefined` rather than a throw when it is missing: `harvestCell` turns that
 * into a named pipeline gap, which is a more useful answer than a crashed
 * render over four thousand cells because one report was tidied away.
 */
function readReport(storeDir: string, reportPath: string): string | undefined {
  try {
    return readFileSync(resolve(storeDir, reportPath), 'utf8');
  } catch {
    return undefined;
  }
}

export interface RenderFromDiskOptions {
  readonly args: ReportCliArgs;
  /** Injected so a test can drive the whole path without a store. */
  readonly log?: ((line: string) => void) | undefined;
}

/** Everything between the flags and the string, so a test can call it directly. */
export function renderFromDisk(options: RenderFromDiskOptions): string {
  const { args } = options;
  const log = options.log ?? say;

  const corpus = loadCorpusFromDirectory(args.tasksDir, {
    now: new Date(`${args.asOf}T00:00:00Z`),
  });
  const recorded = readCells(args.cellsPath);
  if (recorded.unreadableLines.length > 0) {
    log(
      `Warning: ${String(recorded.unreadableLines.length)} line(s) of ${args.cellsPath} could not be read and are not in this report: ` +
        recorded.unreadableLines.map((l) => `line ${String(l.line)} (${l.reason})`).join('; '),
    );
  }
  if (recorded.supersededRows > 0) {
    log(
      `Note: ${String(recorded.supersededRows)} row(s) were superseded by a later row for the same cell; only the later one is counted.`,
    );
  }

  const tasks = new Map<string, BenchTask>(corpus.tasks.map((t) => [t.id, t]));
  const scored: ScoredCell[] = [];
  const orphanCells: string[] = [];
  for (const cell of recorded.cells) {
    const task = tasks.get(cell.taskId);
    if (task === undefined) {
      // Named rather than dropped, and never fabricated into a `ScoredCell`: a
      // category invented to make one fit would put a wrong value in the
      // report's own data. A corpus that moved under a stored result is
      // information, and a silently narrower denominator is exactly what the
      // loader refuses at the other end of the pipeline.
      orphanCells.push(cell.key);
      continue;
    }

    const report = cell.outcome === 'ok' ? readReport(args.storeDir, cell.reportPath) : undefined;
    let evidence;
    if (report !== undefined) {
      try {
        const snapshot = readEvidence(args.evidenceDir, cell.key);
        // A snapshot collected from a different text produces a full set of
        // plausible numbers with nothing behind them, and the mismatch is
        // silent unless somebody checks. `live.ts` makes the same check for the
        // same reason; treated here as no evidence at all.
        evidence =
          snapshot !== undefined && evidenceMatchesReport(snapshot, report) ? snapshot : undefined;
      } catch (e: unknown) {
        log(`Warning: ${cell.key}: ${e instanceof Error ? e.message : String(e)}`);
        evidence = undefined;
      }
    }

    scored.push(harvestCell({ cell, task, report, evidence }));
  }

  const agg = aggregate({
    cells: scored,
    corpus,
    minTasksPerCategory: args.minTasksPerCategory,
    orphanCells,
  });
  return render(agg, args.format);
}

export function main(args: readonly string[] = process.argv.slice(2)): number {
  const parsed = parseArgs(args);
  stdout.write(renderFromDisk({ args: parsed }));
  return 0;
}

/**
 * Run only when invoked directly, never on import.
 *
 * A test that imports this module to check the argument parsing must not read a
 * store and write to stdout as a side effect of the import.
 */
const invokedDirectly = argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href;
if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (e: unknown) {
    say(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
