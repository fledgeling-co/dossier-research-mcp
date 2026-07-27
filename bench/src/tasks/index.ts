/**
 * The benchmark task format, in one import.
 *
 * `schema.ts` is the contract, `corpus.ts` is the pure loader over file
 * contents, `files.ts` is the only part that reads a disk. A scorer normally
 * wants the first two and can be tested without ever touching the third.
 */
export {
  GOLD_FACT_KINDS,
  MAX_FLAT_GOLD_FACTS,
  MAX_GRID_GOLD_FACTS,
  MAX_TASK_FILE_BYTES,
  STALE_AFTER_DAYS,
  TASK_CATEGORIES,
  taskFileSchema,
  utcDayOrdinal,
  utcDayOrdinalFromIsoDate,
} from './schema.js';
export type {
  BenchTaskFile,
  CellRef,
  ConflictingFigure,
  ConflictingValue,
  Enumeration,
  ExpectedRefusal,
  FringeClaim,
  GoldFact,
  GoldFactKind,
  KnownDissent,
  SourceRef,
  TaskCategory,
  Tolerance,
} from './schema.js';

export { loadCorpus, TaskCorpusError, YAML_OPTIONS } from './corpus.js';
export type {
  ApplicableMetrics,
  BenchTask,
  LoadCorpusOptions,
  TaskCorpus,
  TaskFileEntry,
  TaskFileFailure,
  TaskFileIssue,
} from './corpus.js';

export { loadCorpusFromDirectory, readTaskEntries } from './files.js';
export type { ReadTaskEntriesResult } from './files.js';
