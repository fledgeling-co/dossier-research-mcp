import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { adapterFor, probeCli, type CliStatus } from '../../../src/local/cli.js';
import { isEntryPoint } from '../entry.js';
import { loadCorpusFromDirectory } from '../tasks/index.js';
import type { BenchTask } from '../tasks/corpus.js';
import { probeTask, summariseProbes, type TaskProbe } from './verdict.js';

/**
 * `npm run bench:failcheck` — prove a task is not already passed.
 *
 * **This runs a local coding CLI and spends its subscription quota, so it
 * refuses to start without `--confirm`, and it is deliberately outside
 * `npm run gate`.** It is bounded on purpose: closed-book runs are short, and
 * the search-enabled layer is meant to be run over a sample rather than the
 * whole corpus, which is what `--limit` and `--category` are for.
 *
 * The gate is the one `bench/src/detector/cli.ts` puts on its judged pass, in
 * the same shape and the same words. It used to be a sentence in this comment
 * saying never to point the script at a paid backend, which is a wish rather
 * than a check: `--bin` took any string and `spawn` ran it.
 *
 * Three refusals, in this order, and the order is the design. **Nothing is
 * spawned until `--confirm` has been given**, including the `--version` probe
 * that establishes what the binary is, because a probe is a spawn too.
 *
 * 1. **A backend this script has no headless form for.** Guessing argv is how
 *    `local-codex` went 0-for-3 in this repo's own ledger, on an invalid
 *    `--search` flag, so a binary whose form is not written down here is
 *    refused rather than run with somebody else's flags.
 * 2. **A mode that backend cannot support.** Checked before the task count is
 *    printed, so the number in the refusal is a number that could really have
 *    run.
 * 3. **No `--confirm`.** Names the count, the mode, the binary, and that
 *    binary's *recorded* billing and caution from `src/local/cli.ts`, rather
 *    than asserting something about an executable nobody has identified.
 *
 * After confirmation and before the first paid child, the binary is resolved
 * and identified through the product's own `probeCli`. `CLAUDE.md`: a binary's
 * name on `PATH` is not its identity, and an unidentified one is never run.
 * `plan-BENCH-09.md` committed this script to that posture and it was never
 * built.
 *
 * Two modes, proving two different things:
 *
 * - `--mode closed-book` (default) disables every tool, so the answer can only
 *   come from the model's weights. A task the model answers here is measuring
 *   recall of training data rather than research, and BENCH-09's exclusion rule
 *   says it does not go in.
 * - `--mode search` leaves the CLI's own web search on, which is the free lane
 *   of a real research backend. A task already answered in full here has no
 *   headroom, so its score cannot move and it is admitting nothing.
 *
 * Usage:
 *   npm run bench:failcheck -- --mode closed-book --confirm
 *   npm run bench:failcheck -- --mode search --ids a,b,c --concurrency 3 --confirm
 */

const CORPUS_DIR = 'bench/tasks';
const CLOSED_BOOK_TOOLS = ['WebSearch', 'WebFetch', 'Bash', 'Read', 'Glob', 'Grep', 'Task'];

/**
 * The backends this script has a headless form written down for.
 *
 * A subset of the product's `CLI_IDS` on purpose. The others are real CLIs the
 * product routes to and this script has no argv for; running one with
 * `claude`'s flags produces a process that dies at argument parsing and gets
 * recorded as a task that failed, which is a wrong admission decision rather
 * than an error anybody notices.
 */
const SUPPORTED_BINS = ['claude', 'codex'] as const;
type SupportedBin = (typeof SUPPORTED_BINS)[number];

/** Backends whose closed-book form is implemented; see `argvFor`. */
const CLOSED_BOOK_BINS: readonly SupportedBin[] = ['claude'];

/** Long enough for a real search run, short enough that one hung child cannot stall a batch. */
const TIMEOUT_MS = { 'closed-book': 120_000, search: 600_000 } as const;

const CLOSED_BOOK_SUFFIX =
  '\n\nAnswer only from what you already know. Do not use any tool. If you do not know, say so plainly rather than guessing.';

const USAGE = `bench:failcheck - prove a task is not already passed

  npm run bench:failcheck -- --confirm
  npm run bench:failcheck -- --mode search --ids a,b,c --confirm

This spawns a coding CLI once per task and spends that CLI's quota. It refuses
to start without --confirm, and prints what it would spend first.

  --mode <m>          closed-book (default) or search
  --bin <name>        ${SUPPORTED_BINS.join(' or ')} (default: claude). closed-book is
                      implemented for ${CLOSED_BOOK_BINS.join(', ')} only
  --dir <path>        corpus directory (default: ${CORPUS_DIR})
  --limit <n>         stop after n tasks
  --category <name>   only tasks in this category
  --ids <a,b,c>       exact task ids; how a stratified sample is named
  --concurrency <n>   probes in flight (default: 4)
  --out <file>        evidence file (default: bench/evidence/failcheck-<mode>.json)
  --confirm           required. Without it nothing is spawned at all.
`;

export interface Options {
  readonly mode: 'closed-book' | 'search';
  readonly bin: SupportedBin;
  readonly limit: number;
  readonly concurrency: number;
  readonly category?: string | undefined;
  /** Exact task ids, comma-separated. How a stratified sample is named. */
  readonly ids?: readonly string[] | undefined;
  readonly dir: string;
  readonly out: string;
  readonly confirm: boolean;
}

/** Parsed arguments, or the refusal to print instead. */
export type ParsedArgs =
  | { readonly ok: true; readonly options: Options }
  | { readonly ok: false; readonly message: string };

/**
 * Where this command's output goes, and everything in it that touches outside.
 *
 * Injected rather than reached for, on the same shape as `DetectorIo`. The
 * point is not only speed: with `ask` and `identify` behind the seam, a test
 * can drive the **confirmed** path end to end and prove the command still runs.
 * Without that, an implementation which refused unconditionally would satisfy
 * every refusal test while leaving the script dead.
 */
export interface FailCheckIo {
  /**
   * Usage, and only usage.
   *
   * Everything else this command says is a diagnostic and goes to `err`, but a
   * `--help` a caller asked for is the command's output and belongs where they
   * can redirect it. `bench/src/detector/cli.ts` splits them the same way.
   */
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /**
   * Ask the backend one question. The only thing here that spends.
   *
   * `binPath` is the executable the identity probe actually resolved, not the
   * id it was asked about. The two are not always the same string: the product
   * gives the id `cursor` the binary `cursor-agent`, so spawning the id would
   * run something else, or nothing, and an empty answer is scored as a task
   * that failed. Spawning the resolved path also closes the gap between
   * checking a binary's identity and running it.
   */
  readonly ask: (question: string, options: Options, binPath: string) => Promise<string>;
  /** Resolve and identify the backend binary. A `--version` spawn; not a spend. */
  readonly identify: (bin: SupportedBin) => Promise<CliStatus>;
  readonly writeEvidence: (path: string, text: string) => void;
}

/** Flags taking a value, and flags that are switches. Nothing else is accepted. */
const VALUE_FLAGS = new Set(['mode', 'bin', 'dir', 'limit', 'category', 'ids', 'concurrency', 'out']);
const SWITCH_FLAGS = new Set(['confirm', 'help', 'h']);

/**
 * Parse the arguments, or return the refusal to print.
 *
 * Every branch here is a spend branch, which is why nothing is tolerated. Two
 * defects this shape exists to prevent, both found by review after the first
 * version shipped without it:
 *
 * - **An unknown flag was ignored.** `--limt 2 --confirm` ran the whole corpus
 *   while the caller believed they had asked for two. `run/cli.ts` and
 *   `report/cli.ts` both refuse an unknown flag for exactly this reason.
 * - **A non-numeric value became `NaN`.** `--concurrency abc` made the worker
 *   pool zero lanes wide, so it probed nothing, wrote an evidence file saying
 *   no task was already passed, and exited 0. An admission gate that answers
 *   "nothing is already passed" having checked nothing fails open on the one
 *   decision it exists to make, and it overwrites the committed evidence while
 *   doing it.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const bare = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith('-')) {
      return { ok: false, message: `Unexpected argument "${arg}".\n\n${USAGE}` };
    }
    const eq = arg.indexOf('=');
    const name = (eq === -1 ? arg : arg.slice(0, eq)).replace(/^-+/, '');
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);

    if (!VALUE_FLAGS.has(name) && !SWITCH_FLAGS.has(name)) {
      return { ok: false, message: `Unknown flag "--${name}".\n\n${USAGE}` };
    }
    if (SWITCH_FLAGS.has(name)) {
      bare.add(name);
      continue;
    }
    if (inline !== undefined) {
      flags.set(name, inline);
      continue;
    }
    const next = argv[i + 1];
    // A value that is itself a flag means the value was forgotten. Swallowing
    // it silently drops the following flag too, so `--category --confirm` used
    // to run unconfirmed against a category literally named "--confirm".
    if (next === undefined || next.startsWith('--')) {
      return { ok: false, message: `--${name} needs a value.\n\n${USAGE}` };
    }
    flags.set(name, next);
    i += 1;
  }

  const mode = flags.get('mode') ?? 'closed-book';
  if (mode !== 'closed-book' && mode !== 'search') {
    return { ok: false, message: `--mode must be closed-book or search; got "${mode}".\n` };
  }

  // Checked against the list this script implements rather than cast into it
  // (CP §1), the same way `run/cli.ts` refuses a provider id that does not
  // exist. A typo here does not fail loudly, it runs some other binary.
  const requestedBin = flags.get('bin') ?? 'claude';
  const bin = SUPPORTED_BINS.find((b) => b === requestedBin);
  if (bin === undefined) {
    const known = adapterFor(requestedBin);
    return {
      ok: false,
      message:
        `--bin "${requestedBin}" is not a backend this check can run. Supported: ${SUPPORTED_BINS.join(', ')}.\n` +
        (known === null
          ? 'It is not a CLI this product knows about either, and an unidentified binary is never run.\n'
          : `${known.label} is a CLI the product routes to, but the argv a headless run needs is a property of that binary and none is written down here. Guessing it produces a run that dies at argument parsing and is recorded as a task that failed.\n`),
    };
  }

  /** A positive whole number, or the refusal. Never `NaN`, never zero lanes. */
  const positiveInt = (name: string, fallback: number): number | string => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      return `--${name} must be a whole number of at least 1; got "${raw}".\n`;
    }
    return value;
  };

  const limit = positiveInt('limit', 1000);
  if (typeof limit === 'string') return { ok: false, message: limit };
  const concurrency = positiveInt('concurrency', 4);
  if (typeof concurrency === 'string') return { ok: false, message: concurrency };

  return {
    ok: true,
    options: {
      mode,
      bin,
      limit,
      concurrency,
      category: flags.get('category'),
      ids: flags
        .get('ids')
        ?.split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      dir: flags.get('dir') ?? CORPUS_DIR,
      out: flags.get('out') ?? `bench/evidence/failcheck-${mode}.json`,
      confirm: bare.has('confirm'),
    },
  };
}

/**
 * The argv one question is asked with.
 *
 * Mirrors `src/local/cli.ts`: a CLI's headless form is a property of that
 * binary, and `codex` in particular takes a bare positional after `exec` rather
 * than `-p`. That is why `SUPPORTED_BINS` is a short list rather than every id
 * the product knows.
 *
 * The closed-book throw is defence in depth and is deliberately kept even
 * though `runFailCheck` refuses the combination earlier. This function is
 * exported and reachable on its own, and the failure it prevents is silent: a
 * binary handed another vendor's tool-disabling flags does not error, it
 * answers with its tools still on, and the run is recorded as a closed-book
 * result that was nothing of the kind.
 */
export function argvFor(question: string, options: Options): readonly string[] {
  if (options.mode === 'closed-book') {
    if (!CLOSED_BOOK_BINS.includes(options.bin)) {
      throw new Error(
        `closed-book mode is implemented for ${CLOSED_BOOK_BINS.join(', ')} only; got "${options.bin}".`,
      );
    }
    return ['-p', '--disallowedTools', ...CLOSED_BOOK_TOOLS, '--', `${question}${CLOSED_BOOK_SUFFIX}`];
  }
  return options.bin === 'codex' ? ['exec', question] : ['-p', '--', question];
}

/**
 * Ask one question by spawning the CLI.
 *
 * `spawn` with an argv array and no shell, matching `src/providers/local.ts`:
 * the question is author-written text and passing it through a shell would make
 * a quoting mistake into command execution.
 */
function askViaSpawn(question: string, options: Options, binPath: string): Promise<string> {
  const args = argvFor(question, options);

  return new Promise<string>((resolvePromise) => {
    const child = spawn(binPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // A key in the environment outranks the subscription and silently
      // converts every call to per-token billing. This check must not spend
      // money, so the key is removed for the child rather than trusted absent.
      env: { ...process.env, ANTHROPIC_API_KEY: '' },
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, TIMEOUT_MS[options.mode]);
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', () => undefined);
    child.on('error', () => {
      clearTimeout(timer);
      resolvePromise('');
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolvePromise(out);
    });
  });
}

/** The real sinks: stderr, a spawned CLI, the product's own probe, and a file. */
export function realIo(): FailCheckIo {
  return {
    out: (text) => {
      process.stdout.write(text);
    },
    err: (text) => {
      process.stderr.write(text);
    },
    ask: askViaSpawn,
    identify: async (bin) => {
      const adapter = adapterFor(bin);
      // Unreachable while `SUPPORTED_BINS` is a subset of `CLI_IDS`, and thrown
      // rather than defaulted because the alternative is running an unidentified
      // binary, which is the one thing this path exists to prevent.
      if (adapter === null) throw new Error(`no CLI adapter is registered for "${bin}"`);
      return probeCli(adapter);
    },
    writeEvidence: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, 'utf8');
    },
  };
}

/** Run `worker` over `items` with a fixed number in flight. */
async function pooled<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      const item = items[i];
      if (item === undefined) return;
      results[i] = await worker(item);
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * The whole command, over the arguments that follow the script name.
 *
 * Returns the exit code rather than setting `process.exitCode`, so a suite can
 * call it twice without the second call inheriting the first one's answer.
 */
export async function runFailCheck(argv: readonly string[], io: FailCheckIo): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.out(USAGE);
    return 0;
  }

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.err(parsed.message);
    return 1;
  }
  const options = parsed.options;

  // Before the count, so the number in the refusal below is a number that could
  // really have run. This used to be discovered inside `argvFor`, after the
  // selection, so a refusal could name twenty-seven tasks for a combination
  // capable of none of them.
  if (options.mode === 'closed-book' && !CLOSED_BOOK_BINS.includes(options.bin)) {
    io.err(
      `closed-book mode is implemented for ${CLOSED_BOOK_BINS.join(', ')} only, and --bin is ${options.bin}.\n` +
        "There is no documented way to disable that binary's web access per invocation, so the mode is refused rather than run without the thing that defines it.\n",
    );
    return 1;
  }

  const corpus = loadCorpusFromDirectory(resolve(options.dir), { now: new Date() });
  const selected: BenchTask[] = corpus.tasks
    .filter((t) => options.category === undefined || t.category === options.category)
    .filter((t) => options.ids === undefined || options.ids.includes(t.id))
    .slice(0, options.limit);

  if (!options.confirm) {
    const adapter = adapterFor(options.bin);
    io.err(
      `This spawns \`${options.bin}\` once for each of the ${String(selected.length)} selected task(s), in ${options.mode} mode, ${String(options.concurrency)} at a time.\n` +
        `It spends that CLI's subscription quota rather than a metered balance. ${adapter?.billing ?? 'Coverage for this backend is not recorded.'}\n` +
        (adapter?.caution === undefined ? '' : `Caution: ${adapter.caution}\n`) +
        'Re-run with --confirm to go ahead. Nothing has been spawned.\n',
    );
    return 1;
  }

  // Only now, and this is the first spawn of any kind: a `--version` probe,
  // which costs nothing, establishing that the binary on PATH under this name
  // is the vendor whose quota the refusal above describes.
  const status = await io.identify(options.bin);
  if (status.state !== 'ready') {
    io.err(
      `\`${options.bin}\` is ${status.state}: ${status.detail}\n` +
        'Nothing was spawned. A binary whose identity cannot be established is a different vendor\'s bill, and one that is not signed in answers nothing, which this check would score as a task that failed.\n',
    );
    return 1;
  }

  io.err(
    `Fail-first check: ${String(selected.length)} task(s), mode=${options.mode}, backend=${options.bin} (${status.version ?? 'version not reported'}), concurrency=${String(options.concurrency)}.\n`,
  );

  const probes = await pooled(selected, options.concurrency, async (task): Promise<TaskProbe> => {
    const response = await io.ask(task.question, options, status.path ?? options.bin);
    const probe = probeTask(task, response, { mode: options.mode });
    io.err(
      `  ${probe.verdict === 'already-passed' ? 'PASSED' : probe.verdict.padEnd(6)} ${task.id} · ${String(probe.factsPresent)}/${String(probe.factsTotal)} facts${probe.refusalAcknowledged === undefined ? '' : ` · refusal=${String(probe.refusalAcknowledged)}`}\n`,
    );
    return probe;
  });

  const report = summariseProbes(probes, {
    mode: options.mode,
    backend: options.bin,
    checkedAt: new Date().toISOString().slice(0, 10),
  });
  io.writeEvidence(resolve(options.out), `${JSON.stringify(report, null, 2)}\n`);

  io.err(
    `\nalready-passed=${String(report.alreadyPassed)} partial=${String(report.partial)} fails=${String(report.fails)} no-response=${String(report.noResponse)} not-applicable=${String(report.notApplicable)}\nEvidence written to ${options.out}\n`,
  );
  // Non-zero when a task is already passed: that is a task to remove or
  // sharpen, and it should stop a corpus change the way a red test does.
  return report.alreadyPassed > 0 ? 1 : 0;
}

// Run only when this file is the process entry point, so importing it from a
// test cannot fire a live run.
if (isEntryPoint(import.meta.url)) {
  runFailCheck(process.argv.slice(2), realIo())
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    });
}
