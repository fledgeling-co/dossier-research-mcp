import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { safeFetch } from '../../../src/net/safe-fetch.js';
import { isEntryPoint } from '../entry.js';
import { loadCorpusFromDirectory } from '../tasks/index.js';
import { verifyCorpus, type FetchedSource, type VerificationReport } from './verify.js';

/**
 * `npm run bench:verify` — prove the gold set against its own sources.
 *
 * **This makes network calls and is deliberately outside `npm run gate`.** The
 * gate is hermetic by construction and must stay that way; what it covers here
 * is the matching rules in `match.ts`, which is where every decision this script
 * makes actually lives.
 *
 * It fetches through `safeFetch` rather than `fetch`. The URLs are
 * author-supplied, and `CLAUDE.md`'s rule is that a dereference of a
 * caller-supplied URL gets per-hop SSRF validation whoever the caller is; an
 * author is not a smaller threat than a model, just a slower one.
 *
 * Exit codes: 0 when every fact is proven, 1 when any is not. A run that cannot
 * reach a source exits 1 as well, and says `unreachable` rather than `absent`,
 * because "the publisher would not answer" and "the fact is not there" are
 * different findings and only one of them is about the corpus.
 */

const CORPUS_DIR = 'bench/tasks';
const EVIDENCE_FILE = 'bench/evidence/gold-verification.json';

/** Bigger than `safeFetch`'s default: a registry document for one package can run to megabytes. */
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

async function fetchSource(url: string): Promise<FetchedSource> {
  try {
    const result = await safeFetch(url, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
    return {
      url: result.url,
      status: result.status,
      ok: result.ok,
      body: result.body,
      // `safeFetch` does not surface headers, and the extractor sniffs a JSON
      // body from its first characters anyway. Left blank rather than guessed
      // from the URL, which would be wrong for every API that omits `.json`.
      contentType: '',
    };
  } catch (e: unknown) {
    return {
      url,
      status: 0,
      ok: false,
      body: '',
      contentType: '',
      error: e instanceof Error ? e.message : 'fetch failed',
    };
  }
}

function isoDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function summarise(report: VerificationReport): string {
  const lines: string[] = [];
  for (const check of report.checks) {
    if (check.verdict === 'proven') continue;
    lines.push(
      `  ${check.taskId} · ${check.factId} · ${check.verdict} · quote=${check.quote} value=${check.value} · ${check.url}${check.note === undefined ? '' : ` · ${check.note}`}`,
    );
  }
  return lines.join('\n');
}

export async function main(argv: readonly string[] = []): Promise<number> {
  const quiet = argv.includes('--quiet');
  const now = new Date();
  const corpus = loadCorpusFromDirectory(resolve(CORPUS_DIR), { now });

  process.stderr.write(
    `Verifying ${String(corpus.tasks.length)} task(s) from ${CORPUS_DIR} against their cited sources.\n`,
  );

  const report = await verifyCorpus(corpus.tasks, {
    fetcher: fetchSource,
    checkedAt: isoDay(now),
    onCheck: (check) => {
      if (quiet) return;
      const mark = check.verdict === 'proven' ? 'ok  ' : 'FAIL';
      process.stderr.write(`  ${mark} ${check.taskId} · ${check.factId} · ${check.verdict}\n`);
    },
  });

  const out = resolve(EVIDENCE_FILE);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  process.stderr.write(
    `\n${String(report.proven)}/${String(report.checks.length)} source checks proven; ${String(report.unreachable)} unreachable.\nEvidence written to ${EVIDENCE_FILE}\n`,
  );
  if (report.unproven > 0) {
    process.stderr.write(`\nUnproven:\n${summarise(report)}\n`);
    return 1;
  }
  return 0;
}

// Run only when this file is the process entry point, so importing it from a
// test cannot fire a live network run.
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
