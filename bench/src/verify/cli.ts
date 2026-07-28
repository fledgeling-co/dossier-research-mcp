import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { safeFetch } from '../../../src/net/safe-fetch.js';
import { isEntryPoint } from '../entry.js';
import { loadCorpusFromDirectory } from '../tasks/index.js';
import { verifyCorpus, type FetchedSource, type SourceFetcher, type VerificationReport } from './verify.js';

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

const DEFAULT_CORPUS_DIR = 'bench/tasks';
const DEFAULT_EVIDENCE_FILE = 'bench/evidence/gold-verification.json';

/**
 * Far bigger than `safeFetch`'s 512 KB default, and the reason is measured
 * rather than guessed: npm's registry document for `typescript` is 15.5 MB,
 * because every nightly is an entry, and the publish timestamp this corpus
 * cites sits past the eight-megabyte cap the first version of this script used.
 * A cap that truncates is not a safety property here, it is a source of false
 * "the fact is not there" verdicts, which is the one answer the verifier must
 * never give wrongly. Truncation is also reported now, so a future document
 * that outgrows even this fails loudly instead of lying.
 */
const MAX_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

async function fetchSource(url: string): Promise<FetchedSource> {
  try {
    const result = await safeFetch(url, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
    return {
      url: result.url,
      status: result.status,
      ok: result.ok,
      body: result.body,
      truncated: Buffer.byteLength(result.body, 'utf8') >= MAX_BYTES,
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
      truncated: false,
      error: e instanceof Error ? e.message : 'fetch failed',
    };
  }
}

function isoDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Where this command's output goes, and everything in it that touches outside.
 *
 * Injected on the same shape as `FailCheckIo` and `DetectorIo`. The **write**
 * seam is not tidiness: `--out` defaults to a committed evidence file, so a
 * test that drove this command over a temp corpus without redirecting it would
 * overwrite `bench/evidence/gold-verification.json` with an empty report, and
 * the gate would go green while destroying the record of what was proven.
 */
export interface VerifyIo {
  readonly err: (text: string) => void;
  readonly fetcher: SourceFetcher;
  readonly writeEvidence: (path: string, text: string) => void;
}

/** The real sinks: stderr, an SSRF-safe fetch, and a file. */
export function realIo(): VerifyIo {
  return {
    err: (text) => {
      process.stderr.write(text);
    },
    fetcher: fetchSource,
    writeEvidence: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, 'utf8');
    },
  };
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

/**
 * The whole command, over the arguments that follow the script name.
 *
 * Returns the exit code rather than setting `process.exitCode`, so a suite can
 * call it twice without the second call inheriting the first one's answer.
 */
export async function runVerify(argv: readonly string[], io: VerifyIo): Promise<number> {
  const quiet = argv.includes('--quiet');
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  // The directory is selectable so a quarantined gold set stays checkable. A
  // task is quarantined for being too easy, never for being wrong, and letting
  // its facts rot unchecked would throw away the expensive half of the work.
  const corpusDir = flag('--dir') ?? DEFAULT_CORPUS_DIR;
  const evidenceFile = flag('--out') ?? DEFAULT_EVIDENCE_FILE;
  const now = new Date();
  const corpus = loadCorpusFromDirectory(resolve(corpusDir), { now });

  io.err(
    `Verifying ${String(corpus.tasks.length)} task(s) from ${corpusDir} against their cited sources.\n`,
  );

  const report = await verifyCorpus(corpus.tasks, {
    fetcher: io.fetcher,
    checkedAt: isoDay(now),
    onCheck: (check) => {
      if (quiet) return;
      const mark = check.verdict === 'proven' ? 'ok  ' : 'FAIL';
      io.err(`  ${mark} ${check.taskId} · ${check.factId} · ${check.verdict}\n`);
    },
  });

  io.writeEvidence(resolve(evidenceFile), `${JSON.stringify(report, null, 2)}\n`);

  io.err(
    `\n${String(report.proven)}/${String(report.checks.length)} source checks proven; ${String(report.unreachable)} unreachable.\nEvidence written to ${evidenceFile}\n`,
  );
  if (report.unproven > 0) {
    io.err(`\nUnproven:\n${summarise(report)}\n`);
    return 1;
  }
  return 0;
}

// Run only when this file is the process entry point, so importing it from a
// test cannot fire a live network run.
if (isEntryPoint(import.meta.url)) {
  runVerify(process.argv.slice(2), realIo())
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    });
}
