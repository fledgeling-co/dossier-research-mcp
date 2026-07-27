import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isEntryPoint } from '../entry.js';
import { loadCorpusFromDirectory } from '../tasks/index.js';
import type { BenchTask } from '../tasks/corpus.js';
import { probeTask, summariseProbes, type TaskProbe } from './verdict.js';

/**
 * `npm run bench:failcheck` — prove a task is not already passed.
 *
 * **This runs a local coding CLI, which spends subscription quota, and is
 * deliberately outside `npm run gate`.** It is bounded on purpose: closed-book
 * runs are short, and the search-enabled layer is meant to be run over a sample
 * rather than the whole corpus, which is what `--limit` and `--category` are
 * for. Never point this at a paid API backend to satisfy an admission rule.
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
 *   npm run bench:failcheck -- --mode closed-book
 *   npm run bench:failcheck -- --mode search --ids a,b,c --concurrency 3
 */

const CORPUS_DIR = 'bench/tasks';
const CLOSED_BOOK_TOOLS = ['WebSearch', 'WebFetch', 'Bash', 'Read', 'Glob', 'Grep', 'Task'];

/** Long enough for a real search run, short enough that one hung child cannot stall a batch. */
const TIMEOUT_MS = { 'closed-book': 120_000, search: 600_000 } as const;

const CLOSED_BOOK_SUFFIX =
  '\n\nAnswer only from what you already know. Do not use any tool. If you do not know, say so plainly rather than guessing.';

interface Options {
  readonly mode: 'closed-book' | 'search';
  readonly bin: string;
  readonly limit: number;
  readonly concurrency: number;
  readonly category?: string | undefined;
  /** Exact task ids, comma-separated. How a stratified sample is named. */
  readonly ids?: readonly string[] | undefined;
  readonly out: string;
}

function parseArgs(argv: readonly string[]): Options {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const mode = get('--mode') === 'search' ? 'search' : 'closed-book';
  return {
    mode,
    bin: get('--bin') ?? 'claude',
    limit: Number.parseInt(get('--limit') ?? '1000', 10),
    concurrency: Math.max(1, Number.parseInt(get('--concurrency') ?? '4', 10)),
    category: get('--category'),
    ids: get('--ids')
      ?.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    out: get('--out') ?? `bench/evidence/failcheck-${mode}.json`,
  };
}

/**
 * Run one question through the CLI.
 *
 * `spawn` with an argv array and no shell, matching `src/providers/local.ts`:
 * the question is author-written text and passing it through a shell would make
 * a quoting mistake into command execution.
 */
async function ask(question: string, options: Options): Promise<string> {
  const args =
    options.mode === 'closed-book'
      ? ['-p', '--disallowedTools', ...CLOSED_BOOK_TOOLS, '--', `${question}${CLOSED_BOOK_SUFFIX}`]
      : ['-p', '--', question];

  return new Promise<string>((resolvePromise) => {
    const child = spawn(options.bin, args, {
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

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  const corpus = loadCorpusFromDirectory(resolve(CORPUS_DIR), { now: new Date() });

  const selected: BenchTask[] = corpus.tasks
    .filter((t) => options.category === undefined || t.category === options.category)
    .filter((t) => options.ids === undefined || options.ids.includes(t.id))
    .slice(0, options.limit);

  process.stderr.write(
    `Fail-first check: ${String(selected.length)} task(s), mode=${options.mode}, backend=${options.bin}, concurrency=${String(options.concurrency)}.\n`,
  );

  const probes = await pooled(selected, options.concurrency, async (task): Promise<TaskProbe> => {
    const response = await ask(task.question, options);
    const probe = probeTask(task, response, { mode: options.mode });
    process.stderr.write(
      `  ${probe.verdict === 'already-passed' ? 'PASSED' : probe.verdict.padEnd(6)} ${task.id} · ${String(probe.factsPresent)}/${String(probe.factsTotal)} facts${probe.refusalAcknowledged === undefined ? '' : ` · refusal=${String(probe.refusalAcknowledged)}`}\n`,
    );
    return probe;
  });

  const report = summariseProbes(probes, {
    mode: options.mode,
    backend: options.bin,
    checkedAt: new Date().toISOString().slice(0, 10),
  });
  const out = resolve(options.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  process.stderr.write(
    `\nalready-passed=${String(report.alreadyPassed)} partial=${String(report.partial)} fails=${String(report.fails)} no-response=${String(report.noResponse)} not-applicable=${String(report.notApplicable)}\nEvidence written to ${options.out}\n`,
  );
  // Non-zero when a task is already passed: that is a task to remove or
  // sharpen, and it should stop a corpus change the way a red test does.
  return report.alreadyPassed > 0 ? 1 : 0;
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    });
}
