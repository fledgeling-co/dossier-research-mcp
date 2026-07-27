import { createHash } from 'node:crypto';
import { parse as parseYaml, type DocumentOptions, type SchemaOptions } from 'yaml';
import {
  JudgedVerdictsSchema,
  RegistryCaseSchema,
  SupportCaseSchema,
  type JudgedVerdicts,
  type RegistryCase,
  type SupportCase,
} from './schema.js';

/**
 * The pure half of the corpus loader.
 *
 * **This file must never import `node:fs` and must never reach a network**, and
 * a test proves it by walking this module's import graph rather than reading its
 * first line. All disk access lives in `files.ts`, which hands contents in here.
 *
 * `node:crypto` is the one exception and is not one: hashing a string is a pure
 * function of that string. It is here because the digest check is the thing that
 * makes a frozen corpus trustworthy, and doing it in the disk adapter would put
 * the check on the wrong side of the seam, where no test could reach it without
 * a filesystem.
 */

/** One file's contents, already read by somebody else. */
export interface CorpusFileEntry {
  /** A path, used only to name the file in an error. Never opened. */
  readonly file: string;
  readonly text: string;
}

export interface CorpusIssue {
  readonly path: string;
  readonly message: string;
}

export interface CorpusFailure {
  readonly file: string;
  readonly issues: readonly CorpusIssue[];
}

/**
 * Every rejected file, in one throw.
 *
 * Fatal rather than skip-the-bad-record, and deliberately the opposite of the
 * store's rule for a listing. A listing that drops a row still shows the rest; a
 * confusion matrix computed over a corpus that quietly lost a third of its
 * `not_addressed` cases is a number about a sample nobody chose, and it would
 * read as a detector doing well.
 */
export class DetectorCorpusError extends Error {
  readonly failures: readonly CorpusFailure[];

  constructor(failures: readonly CorpusFailure[]) {
    const detail = failures
      .map((f) => {
        const lines = f.issues.map((i) => `    ${i.path === '' ? '(file)' : i.path}: ${i.message}`);
        return [`  ${f.file}`, ...lines].join('\n');
      })
      .join('\n');
    super(
      `${String(failures.length)} detector corpus file(s) could not be loaded, so the corpus was not loaded at all:\n${detail}`,
    );
    this.name = 'DetectorCorpusError';
    this.failures = failures;
  }
}

/**
 * Pinned rather than left to the library default, for BENCH-01's reason.
 *
 * Under YAML 1.1 an unquoted `2026-01-15` becomes a `Date` and `NO` becomes
 * `false`. Under 1.2 core the schema sees what the author typed. Restated here
 * as a reference to the rule rather than as a second opinion about it.
 */
export const YAML_OPTIONS = {
  version: '1.2',
  schema: 'core',
} as const satisfies DocumentOptions & SchemaOptions;

/** A support case with its page text joined on, which is what a detector is handed. */
export interface LoadedSupportCase extends SupportCase {
  readonly file: string;
  readonly pageText: string;
}

export interface LoadedRegistryCase extends RegistryCase {
  readonly file: string;
}

export interface DetectorCorpus {
  readonly support: readonly LoadedSupportCase[];
  readonly registry: readonly LoadedRegistryCase[];
  /**
   * What a judged pass recorded, or `null` when none has been run.
   *
   * Null is a legitimate state and is reported as one. The judged arm then
   * abstains on every case, which is the honest reading of "nobody asked a
   * model", and is very deliberately not the same as the model getting them
   * wrong.
   */
  readonly judged: JudgedVerdicts | null;
  readonly ignoredFiles: readonly string[];
}

export interface LoadDetectorCorpusInput {
  readonly supportFiles: readonly CorpusFileEntry[];
  readonly registryFiles: readonly CorpusFileEntry[];
  /** Page fixtures, keyed by the bare file name a case refers to. */
  readonly pages: ReadonlyMap<string, string>;
  /** The judged evidence file's raw JSON, when one exists. */
  readonly judgedJson?: string | undefined;
  readonly ignoredFiles?: readonly string[] | undefined;
  readonly priorFailures?: readonly CorpusFailure[] | undefined;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function parseOne<T>(
  entry: CorpusFileEntry,
  schema: { safeParse: (raw: unknown) => { success: true; data: T } | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } } },
  failures: CorpusFailure[],
): T | null {
  let raw: unknown;
  try {
    raw = parseYaml(entry.text, YAML_OPTIONS);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message.split('\n')[0] : 'could not be parsed as YAML';
    failures.push({ file: entry.file, issues: [{ path: '', message: message ?? 'invalid YAML' }] });
    return null;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    failures.push({
      file: entry.file,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map((p) => String(p)).join('.'),
        message: issue.message,
      })),
    });
    return null;
  }
  return parsed.data;
}

/**
 * Parse and validate the whole corpus, and check every fixture against its digest.
 *
 * The digest check is the point of the whole function. The corpus is a frozen
 * snapshot of real pages, which is what makes it reproducible and what the
 * prior art says a live-web evaluation can never be; a snapshot nobody can
 * vouch for buys none of that. So a page whose text no longer hashes to what the
 * case recorded fails the load outright rather than being scored against, and
 * the failure names the file so a genuine re-capture is a two-line fix rather
 * than a mystery.
 */
export function loadDetectorCorpus(input: LoadDetectorCorpusInput): DetectorCorpus {
  const failures: CorpusFailure[] = [...(input.priorFailures ?? [])];
  const support: LoadedSupportCase[] = [];
  const registry: LoadedRegistryCase[] = [];
  const seenIds = new Map<string, string>();

  const claimId = (id: string, file: string): boolean => {
    const previous = seenIds.get(id);
    if (previous !== undefined) {
      failures.push({
        file,
        issues: [{ path: 'id', message: `duplicate id, already used by ${previous}` }],
      });
      return false;
    }
    seenIds.set(id, file);
    return true;
  };

  for (const entry of input.supportFiles) {
    const parsed = parseOne(entry, SupportCaseSchema, failures);
    if (parsed === null) continue;
    if (!claimId(parsed.id, entry.file)) continue;

    const text = input.pages.get(parsed.page.textFile);
    if (text === undefined) {
      failures.push({
        file: entry.file,
        issues: [
          {
            path: 'page.textFile',
            message: `no page fixture named ${parsed.page.textFile} was found`,
          },
        ],
      });
      continue;
    }

    const digest = sha256Hex(text);
    if (digest !== parsed.page.textSha256) {
      failures.push({
        file: entry.file,
        issues: [
          {
            path: 'page.textSha256',
            message: `the fixture ${parsed.page.textFile} hashes to ${digest}, not to the recorded ${parsed.page.textSha256}. Re-capture it and update the case, or restore the file; a page edited after labelling would change a score with nothing to show for it.`,
          },
        ],
      });
      continue;
    }

    if (text.length !== parsed.page.textChars) {
      failures.push({
        file: entry.file,
        issues: [
          {
            path: 'page.textChars',
            message: `the fixture is ${String(text.length)} characters, not the recorded ${String(parsed.page.textChars)}`,
          },
        ],
      });
      continue;
    }

    support.push({ ...parsed, file: entry.file, pageText: text });
  }

  for (const entry of input.registryFiles) {
    const parsed = parseOne(entry, RegistryCaseSchema, failures);
    if (parsed === null) continue;
    if (!claimId(parsed.id, entry.file)) continue;
    registry.push({ ...parsed, file: entry.file });
  }

  let judged: JudgedVerdicts | null = null;
  if (input.judgedJson !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(input.judgedJson);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'could not be parsed as JSON';
      failures.push({ file: 'judged verdicts', issues: [{ path: '', message }] });
      raw = undefined;
    }
    if (raw !== undefined) {
      const parsed = JudgedVerdictsSchema.safeParse(raw);
      if (parsed.success) {
        judged = parsed.data;
      } else {
        failures.push({
          file: 'judged verdicts',
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map((p) => String(p)).join('.'),
            message: issue.message,
          })),
        });
      }
    }
  }

  // A recorded verdict for a case that does not exist is a stale evidence file,
  // and scoring against it would quietly count a judgement about something else.
  if (judged !== null) {
    const known = new Set(support.map((c) => c.id));
    const unknown = [...judged.verdicts, ...judged.failures]
      .map((v) => v.caseId)
      .filter((id) => !known.has(id));
    if (unknown.length > 0) {
      failures.push({
        file: 'judged verdicts',
        issues: [
          {
            path: 'verdicts',
            message: `recorded judgements for ${String(unknown.length)} case(s) that are not in the corpus: ${unknown.slice(0, 5).join(', ')}`,
          },
        ],
      });
    }
  }

  if (failures.length > 0) throw new DetectorCorpusError(failures);

  return {
    support: [...support].sort((a, b) => a.id.localeCompare(b.id)),
    registry: [...registry].sort((a, b) => a.id.localeCompare(b.id)),
    judged,
    ignoredFiles: input.ignoredFiles ?? [],
  };
}

/** How many cases carry each label. The corpus balance, which R3 constrains. */
export function labelCounts<T extends { readonly label: string }>(
  cases: readonly T[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const c of cases) counts.set(c.label, (counts.get(c.label) ?? 0) + 1);
  return counts;
}
