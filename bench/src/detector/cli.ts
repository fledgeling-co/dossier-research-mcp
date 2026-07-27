import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

/** Read the whole of stdin, for the page text a constructed fixture is built from. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY === true) return '';
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += String(chunk);
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

async function main(): Promise<void> {
  if (has('--help') || has('-h')) {
    process.stdout.write(USAGE);
    return;
  }

  const root = arg('--corpus') ?? defaultCorpusRoot();

  if (process.argv[2] === 'capture') {
    const url = process.argv[3];
    const name = process.argv[4];
    if (url === undefined || name === undefined || !/^[a-z0-9-]+$/.test(name)) {
      process.stderr.write(
        'usage: bench:detector capture <url> <name>, where name is lowercase letters, digits and hyphens\n',
      );
      process.exitCode = 1;
      return;
    }
    const captured = await capturePage(url);
    // The block goes to stdout so it can be redirected; the summary to stderr,
    // because stdout here is the thing being pasted into a case file.
    process.stderr.write(
      `fetched ${captured.url}\n  verdict ${captured.verdict}, ${String(captured.chars)} characters${captured.truncated ? ', cut short at the byte cap' : ''}\n\n`,
    );
    process.stdout.write(`${writeFixture(root, name, captured)}\n`);
    return;
  }

  if (process.argv[2] === 'construct') {
    const name = process.argv[3];
    const note = arg('--note');
    if (name === undefined || !/^[a-z0-9-]+$/.test(name) || note === undefined) {
      process.stderr.write(
        'usage: bench:detector construct <name> --note "why this page is written rather than captured" < page.txt\n',
      );
      process.exitCode = 1;
      return;
    }
    const text = await readStdin();
    if (text === '') {
      process.stderr.write('nothing arrived on stdin; pipe the page text in\n');
      process.exitCode = 1;
      return;
    }
    const block = writeConstructedFixture(root, name, {
      text,
      capturedAt: new Date().toISOString().slice(0, 10),
      verdict: (arg('--verdict') ?? 'live') as PageVerdict,
      httpStatus: Number(arg('--status') ?? 200),
      completeHtml: has('--html'),
      note,
    });
    process.stderr.write(`wrote a constructed fixture, ${String(text.length)} characters\n\n`);
    process.stdout.write(`${block}\n`);
    return;
  }

  // Loaded after `capture`, since capture is how a corpus that does not load
  // yet gets its missing fixture.
  const corpus = readDetectorCorpus(root);

  if (process.argv[2] === 'judge') {
    if (!has('--confirm')) {
      process.stderr.write(
        `The judged pass calls a model once for each of the ${String(corpus.support.length)} support cases.\n` +
          'On the default path that spends the coding CLI subscription quota you already pay for, not a metered balance.\n' +
          'Re-run with --confirm to go ahead.\n',
      );
      process.exitCode = 1;
      return;
    }
    const bin = arg('--bin') ?? 'claude';
    const timeoutMs = Number(arg('--timeout') ?? 180_000);
    const limit = Number(arg('--limit') ?? corpus.support.length);
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
        process.stderr.write(`  judged ${String(done)}/${String(cases.length)}\n`);
        return answer;
      },
    });

    const target = detectorPaths(root).judgedFile;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    process.stderr.write(
      `\nwrote ${target}\n  ${String(evidence.verdicts.length)} verdicts, ${String(evidence.failures.length)} failures\n`,
    );
    return;
  }

  process.stdout.write(renderReport(await scoreDetector(corpus)));
}

await main();
