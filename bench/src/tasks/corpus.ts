import { parse as parseYaml, type DocumentOptions, type SchemaOptions } from 'yaml';
import {
  STALE_AFTER_DAYS,
  taskFileSchema,
  utcDayOrdinal,
  utcDayOrdinalFromIsoDate,
  type BenchTaskFile,
} from './schema.js';

/**
 * The pure half of the loader.
 *
 * **This file must never import `node:fs`.** That is the mechanical guarantee
 * behind "the loader is pure and synchronous, so scorers can be tested without a
 * filesystem", and a test asserts it by reading this module's own source. All
 * disk access lives in `files.ts`, which hands entries in here.
 *
 * Everything below is deterministic given its inputs. In particular the
 * reference date is a required argument and is never read from the clock:
 * loading the same corpus twice must produce the same answer, and a raw result
 * stored today must be re-scorable in six months against the date it was scored
 * under rather than against whenever somebody re-runs the scorer.
 */

/** One task file's contents, already read by somebody else. */
export interface TaskFileEntry {
  /** A path, used only to name the file in an error. Never opened. */
  readonly file: string;
  readonly text: string;
}

export interface TaskFileIssue {
  /** The field path inside the file, dotted. Empty for a whole-file problem. */
  readonly path: string;
  readonly message: string;
}

export interface TaskFileFailure {
  readonly file: string;
  readonly issues: readonly TaskFileIssue[];
}

/**
 * Which measures a task can support, derived from what it actually records.
 *
 * Derived once, here, on purpose. Four later items each need to know whether a
 * given task is eligible for a given measure, and four independent derivations
 * of the same rule eventually disagree about what the rule is — which is the
 * argument `docs/plan/benchmark.md` already makes for implementing the
 * benchmark in this repo rather than beside it.
 *
 * The refusal case is the one that matters most: a refusal task carries no gold
 * facts, so its accuracy is `not_applicable`, never zero. A denominator that
 * quietly counts it would report every backend as worse than it is.
 */
export interface ApplicableMetrics {
  readonly accuracy: boolean;
  readonly relevance: boolean;
  /**
   * Eligible when there are gold facts to pair a stated confidence against.
   * Pairing a marker to a fact, and turning that into a Brier score, is the
   * calibration item's rule; what this format owes it is the eligibility flag
   * and a stable id per fact.
   */
  readonly calibration: boolean;
  readonly dissentRecall: boolean;
  readonly conflictAcknowledgement: boolean;
  readonly falseBalance: boolean;
  readonly refusal: boolean;
  readonly enumerationCompleteness: boolean;
}

export interface BenchTask extends BenchTaskFile {
  /** The file it came from, for adjudicating a disputed score. */
  readonly file: string;
  /** Whole UTC days between `reverifiedAt` and the reference date. */
  readonly reverifiedAgeDays: number;
  /** True once the gold has gone unchecked for `STALE_AFTER_DAYS`. */
  readonly stale: boolean;
  readonly applicableMetrics: ApplicableMetrics;
}

export interface TaskCorpus {
  readonly tasks: readonly BenchTask[];
  readonly staleCount: number;
  readonly staleIds: readonly string[];
  readonly staleAfterDays: number;
  /** The reference date the caller supplied, as `YYYY-MM-DD`. */
  readonly evaluatedAt: string;
  /**
   * Files under the corpus directory that were not read as tasks. Reported
   * rather than dropped: a `.yam` typo is exactly the quietly-missing task this
   * whole item exists to prevent.
   */
  readonly ignoredFiles: readonly string[];
}

/**
 * Every rejected file, in one throw.
 *
 * Deliberately fatal rather than skip-and-continue. The store's rule in
 * `CLAUDE.md` is the opposite for a *listing*, where one bad record must not
 * break the page; here a dropped task means the reported score covers a sample
 * nobody chose, and a benchmark that silently narrows its own corpus is worse
 * than one that refuses to run.
 *
 * Every bad file is collected before throwing, not just the first. A hundred
 * hand-authored files fixed one error per run is a hundred rounds.
 */
export class TaskCorpusError extends Error {
  readonly failures: readonly TaskFileFailure[];

  constructor(failures: readonly TaskFileFailure[]) {
    const detail = failures
      .map((f) => {
        const lines = f.issues.map((i) => `    ${i.path === '' ? '(file)' : i.path}: ${i.message}`);
        return [`  ${f.file}`, ...lines].join('\n');
      })
      .join('\n');
    super(
      `${String(failures.length)} task file(s) could not be loaded, so the corpus was not loaded at all:\n${detail}`,
    );
    this.name = 'TaskCorpusError';
    this.failures = failures;
  }
}

export interface LoadCorpusOptions {
  /**
   * The date staleness is measured against. Required, never defaulted from the
   * clock: a defaulted `now` makes the loader impure and makes a stored result
   * un-re-scorable.
   */
  readonly now: Date;
  /** Carried onto the corpus unchanged; `files.ts` supplies it. */
  readonly ignoredFiles?: readonly string[];
  /** Failures raised before parsing, merged into the single throw. */
  readonly priorFailures?: readonly TaskFileFailure[];
}

/**
 * YAML parse options, pinned rather than left to the library default.
 *
 * Under YAML 1.1 an unquoted `2026-01-15` becomes a `Date`, `NO` / `ON` / `yes`
 * become booleans, and `0755` becomes octal 493 — the Norway problem, arriving
 * inside a gold set. Under 1.2 core all of those stay what the author typed, and
 * the schema sees the text rather than the library's interpretation of it.
 *
 * Two traps survive both versions and are the reason the string-valued arms of
 * `GoldFactSchema` are strict about type: an unquoted `1.20` arrives as the
 * number `1.2`, and an unquoted `0755` arrives as the number `755`. A version
 * string or a leading-zero identifier must be quoted; if it is not, the schema
 * rejects it with a readable message instead of silently scoring against a
 * corrupted value.
 *
 * Pinned explicitly so a dependency bump that changes the default cannot
 * silently re-open any of this.
 */
export const YAML_OPTIONS = {
  version: '1.2',
  schema: 'core',
} as const satisfies DocumentOptions & SchemaOptions;

const DAY_MS = 86_400_000;

function deriveMetrics(task: BenchTaskFile): ApplicableMetrics {
  const hasFacts = task.goldFacts.length > 0;
  return {
    accuracy: hasFacts,
    relevance: task.requiredTerms.length > 0,
    calibration: hasFacts,
    dissentRecall: task.knownDissent.length > 0,
    conflictAcknowledgement: task.conflictingFigures.length > 0,
    falseBalance: task.fringeClaims.length > 0,
    refusal: task.expectedRefusal !== undefined,
    enumerationCompleteness: task.enumeration !== undefined,
  };
}

function isoDay(date: Date): string {
  return new Date(utcDayOrdinal(date) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Parse and validate a set of task files.
 *
 * Throws `TaskCorpusError` naming every file it rejected. Returns a corpus
 * carrying the stale count, because a score computed over a corpus that is a
 * third stale is a different claim from one that is not, and the number has to
 * travel with the data for a later report to be able to say so.
 */
export function loadCorpus(
  entries: readonly TaskFileEntry[],
  options: LoadCorpusOptions,
): TaskCorpus {
  // `taskFileSchema` rejects an Invalid Date too; doing it here as well means a
  // corpus of zero entries, which never reaches the schema, still refuses a
  // reference date that would have made every staleness answer nonsense.
  if (Number.isNaN(options.now.getTime())) {
    throw new TypeError('loadCorpus needs a valid reference date; received an Invalid Date');
  }
  const schema = taskFileSchema(options.now);
  const nowDay = utcDayOrdinal(options.now);

  const failures: TaskFileFailure[] = [...(options.priorFailures ?? [])];
  const tasks: BenchTask[] = [];
  const seenIds = new Map<string, string>();

  for (const entry of entries) {
    let raw: unknown;
    try {
      raw = parseYaml(entry.text, YAML_OPTIONS);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message.split('\n')[0] : 'could not be parsed as YAML';
      failures.push({ file: entry.file, issues: [{ path: '', message: message ?? 'invalid YAML' }] });
      continue;
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      failures.push({
        file: entry.file,
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      continue;
    }

    const task = parsed.data;
    const previous = seenIds.get(task.id);
    if (previous !== undefined) {
      failures.push({
        file: entry.file,
        issues: [
          {
            path: 'id',
            message: `task id "${task.id}" is already used by ${previous}; two tasks sharing an id would silently halve a category`,
          },
        ],
      });
      continue;
    }
    seenIds.set(task.id, entry.file);

    const reverifiedAgeDays = nowDay - utcDayOrdinalFromIsoDate(task.reverifiedAt);
    tasks.push({
      ...task,
      file: entry.file,
      reverifiedAgeDays,
      stale: reverifiedAgeDays >= STALE_AFTER_DAYS,
      applicableMetrics: deriveMetrics(task),
    });
  }

  if (failures.length > 0) throw new TaskCorpusError(failures);

  const staleIds = tasks.filter((t) => t.stale).map((t) => t.id);
  return {
    tasks,
    staleCount: staleIds.length,
    staleIds,
    staleAfterDays: STALE_AFTER_DAYS,
    evaluatedAt: isoDay(options.now),
    ignoredFiles: options.ignoredFiles ?? [],
  };
}
