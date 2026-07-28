import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, stderr, stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { capturePage, writeConstructedFixture, writeFixture } from './capture.js';
import { defaultCorpusRoot, detectorPaths, readDetectorCorpus } from './files.js';
import { askCli, judgePass } from './judge.js';
import { renderReport, scoreDetector } from './report.js';
import type { PageVerdict } from './schema.js';

/**
 * The entry point.
 *
 * `score` is free, offline and the default. `judge` spends a quota and says so
 * before it does anything, which is the same posture every money-spending
 * surface in this repo takes.
 *
 * Diagnostics go to stderr and the report to stdout, so the report can be
 * redirected into a file without the progress lines landing in it.
 *
 * The command is a function of its arguments and its sinks, returning an exit
 * code rather than assigning one, so a test can drive every branch without a
 * subprocess. `bench/src/report/cli.ts` has the same shape for the same reason.
 * What that buys is not only speed: a test that spawns has to find an
 * interpreter on disk, and this file's used to be found by a literal path into
 * `node_modules`, so eleven cases failed in any git worktree until somebody ran
 * `npm install` inside it (BENCH-14).
 */

/** Where a command's output goes, and where its stdin comes from. */
export interface DetectorIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** The page text a constructed fixture is frozen from. */
  readonly readStdin: () => Promise<string>;
}

function arg(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function has(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

/** Read the whole of stdin, for the page text a constructed fixture is built from. */
async function readRealStdin(): Promise<string> {
  if (stdin.isTTY === true) return '';
  let text = '';
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) text += String(chunk);
  return text;
}

const USAGE = `bench:detector - does Dossier's own checking actually work

  bench:detector                      score the corpus offline and print the report
  bench:detector capture <url> <name> fetch a page and freeze it as a fixture
  bench:detector construct <name>     freeze text from stdin as a fixture, for a
                                      page the live web will not hold still
  bench:detector judge --confirm      run the judged pass and write the evidence file

capture prints the YAML block to paste into a case file. It reaches the network
through the production collector, so the fixture is the text the scorer would
have been handed live.

Options for judge:
  --bin <name>       the coding CLI to ask (default: claude). Spends its
                     subscription quota rather than a metered balance.
  --timeout <ms>     per case (default: 180000)
  --confirm          required. The pass calls a model once per case.
  --limit <n>        stop after n cases, for a dry run.
`;

/**
 * The whole command, over the arguments that follow the script name.
 *
 * Exported so a test can call it directly. It returns the exit code instead of
 * setting `process.exitCode`, because a function that mutates the process
 * cannot be called twice in one suite without the second call inheriting the
 * first one's answer.
 */
export async function runDetector(args: readonly string[], io: DetectorIo): Promise<number> {
  if (has(args, '--help') || has(args, '-h')) {
    io.out(USAGE);
    return 0;
  }

  const root = arg(args, '--corpus') ?? defaultCorpusRoot();

  if (args[0] === 'capture') {
    const url = args[1];
    const name = args[2];
    if (url === undefined || name === undefined || !/^[a-z0-9-]+$/.test(name)) {
      io.err(
        'usage: bench:detector capture <url> <name>, where name is lowercase letters, digits and hyphens\n',
      );
      return 1;
    }
    const captured = await capturePage(url);
    // The block goes to stdout so it can be redirected; the summary to stderr,
    // because stdout here is the thing being pasted into a case file.
    io.err(
      `fetched ${captured.url}\n  verdict ${captured.verdict}, ${String(captured.chars)} characters${captured.truncated ? ', cut short at the byte cap' : ''}\n\n`,
    );
    io.out(`${writeFixture(root, name, captured)}\n`);
    return 0;
  }

  if (args[0] === 'construct') {
    const name = args[1];
    const note = arg(args, '--note');
    if (name === undefined || !/^[a-z0-9-]+$/.test(name) || note === undefined) {
      io.err(
        'usage: bench:detector construct <name> --note "why this page is written rather than captured" < page.txt\n',
      );
      return 1;
    }
    const text = await io.readStdin();
    if (text === '') {
      io.err('nothing arrived on stdin; pipe the page text in\n');
      return 1;
    }
    const block = writeConstructedFixture(root, name, {
      text,
      capturedAt: new Date().toISOString().slice(0, 10),
      verdict: (arg(args, '--verdict') ?? 'live') as PageVerdict,
      httpStatus: Number(arg(args, '--status') ?? 200),
      completeHtml: has(args, '--html'),
      note,
    });
    io.err(`wrote a constructed fixture, ${String(text.length)} characters\n\n`);
    io.out(`${block}\n`);
    return 0;
  }

  // Loaded after `capture`, since capture is how a corpus that does not load
  // yet gets its missing fixture.
  const corpus = readDetectorCorpus(root);

  if (args[0] === 'judge') {
    if (!has(args, '--confirm')) {
      io.err(
        `The judged pass calls a model once for each of the ${String(corpus.support.length)} support cases.\n` +
          'On the default path that spends the coding CLI subscription quota you already pay for, not a metered balance.\n' +
          'Re-run with --confirm to go ahead.\n',
      );
      return 1;
    }
    const bin = arg(args, '--bin') ?? 'claude';
    const timeoutMs = Number(arg(args, '--timeout') ?? 180_000);
    const limit = Number(arg(args, '--limit') ?? corpus.support.length);
    const cases = corpus.support.slice(0, Math.max(0, limit));

    let done = 0;
    const evidence = await judgePass(cases, {
      model: bin,
      judgedAt: new Date().toISOString().slice(0, 10),
      note:
        `Run through the ${bin} CLI, which spends a subscription quota rather than a metered balance. ` +
        'The CLI is not the utility model the product itself would call, so this measures a model of that class answering the product’s own question, not that exact model.',
      ask: async (prompt) => {
        const answer = await askCli(prompt, { bin, timeoutMs });
        done += 1;
        io.err(`  judged ${String(done)}/${String(cases.length)}\n`);
        return answer;
      },
    });

    const target = detectorPaths(root).judgedFile;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    io.err(
      `\nwrote ${target}\n  ${String(evidence.verdicts.length)} verdicts, ${String(evidence.failures.length)} failures\n`,
    );
    return 0;
  }

  io.out(renderReport(await scoreDetector(corpus)));
  return 0;
}

/**
 * Run only when invoked directly, never on import.
 *
 * A test that imports this module to drive the commands must not score the
 * corpus and write to stdout as a side effect of the import.
 *
 * This guard is also the one way the split above could break the CLI silently:
 * if it ever stopped firing, `npm run bench:detector` would print nothing and
 * exit 0, and every in-process test would stay green while it did. That is why
 * one case in `cli.test.ts` still spawns the real thing.
 */
const invokedDirectly = argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await runDetector(argv.slice(2), {
    out: (text) => {
      stdout.write(text);
    },
    err: (text) => {
      stderr.write(text);
    },
    readStdin: readRealStdin,
  });
}
