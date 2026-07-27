import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultCorpusRoot, detectorPaths, readDetectorCorpus } from './files.js';
import { askCli, judgePass } from './judge.js';
import { renderReport, scoreDetector } from './report.js';

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

const USAGE = `bench:detector - does Dossier's own checking actually work

  bench:detector                      score the corpus offline and print the report
  bench:detector judge --confirm      run the judged pass and write the evidence file

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
