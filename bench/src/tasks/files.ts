import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_TASK_FILE_BYTES } from './schema.js';
import {
  loadCorpus,
  type LoadCorpusOptions,
  type TaskCorpus,
  type TaskFileEntry,
  type TaskFileFailure,
} from './corpus.js';

/**
 * The only file in this slice that touches a disk.
 *
 * Kept apart from `corpus.ts` so the loader's purity is structural rather than a
 * promise: a scorer can be tested against file *contents* with no filesystem at
 * all, and this adapter exists solely to produce those contents.
 *
 * Synchronous throughout. The corpus is a few hundred small files read once at
 * the start of a batch, so there is nothing to gain from async, and a fully
 * synchronous surface is simpler for every scorer that consumes it.
 */

const TASK_EXTENSIONS = ['.yaml', '.yml'];

export interface ReadTaskEntriesResult {
  readonly entries: readonly TaskFileEntry[];
  /** Non-task files found under the directory, named rather than dropped. */
  readonly ignoredFiles: readonly string[];
  /** Files that exist but could not be read, in the loader's failure shape. */
  readonly failures: readonly TaskFileFailure[];
}

/**
 * Read every task file under `dir`, recursively.
 *
 * Recursive on purpose: a corpus of a hundred tasks will very likely be grouped
 * into per-category subdirectories, and a flat walk would silently ignore every
 * one of them. `.yml` is accepted alongside `.yaml` for the same reason — a
 * whole task lost to an extension the reader did not expect is precisely the
 * quietly-dropped task this item exists to prevent. Anything else is reported in
 * `ignoredFiles`, so a `.yam` typo shows up in the corpus summary instead of
 * vanishing.
 *
 * Results are sorted by their normalised relative path. Node does not guarantee
 * directory order, so an unsorted walk would make the task list, the stale ids
 * and the failure list come out in a different order on a different machine,
 * while the loader claims to be reproducible.
 *
 * The walk is written out rather than delegated to `readdirSync`'s `recursive`
 * option, and every entry is inspected with `lstat` rather than `stat`, because
 * the built-in recursive walk **follows symbolic links out of the directory it
 * was given**: a link to `/etc` inside the corpus produced entries under it, and
 * a link named `task.yaml` pointing anywhere would have been read as a task.
 * Verified, not assumed. A corpus is hand-authored YAML, so a symlink in one is
 * either a mistake or an escape; it is reported in `ignoredFiles` and never
 * followed. This is the same posture as the rule in `CLAUDE.md` that nothing
 * reading local files may be pointed somewhere else by its input.
 */
export function readTaskEntries(dir: string): ReadTaskEntriesResult {
  const entries: TaskFileEntry[] = [];
  const ignoredFiles: string[] = [];
  const failures: TaskFileFailure[] = [];

  const files: string[] = [];

  const walk = (relDir: string): void => {
    let names: string[];
    try {
      names = readdirSync(relDir === '' ? dir : join(dir, relDir));
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'could not be read';
      failures.push({
        file: relDir === '' ? dir : relDir,
        issues: [{ path: '', message: `directory ${message}` }],
      });
      return;
    }

    // Sorted at every level, so the walk order is identical on every platform
    // rather than merely stable on this one.
    for (const name of [...names].sort()) {
      // A dotfile is never a task: `.gitkeep`, `.DS_Store` and friends would
      // otherwise show up in `ignoredFiles` as if somebody had mistyped them.
      if (name.startsWith('.')) continue;
      const rel = relDir === '' ? name : `${relDir}/${name}`;

      let stats: ReturnType<typeof lstatSync>;
      try {
        stats = lstatSync(join(dir, rel));
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'could not be inspected';
        failures.push({ file: rel, issues: [{ path: '', message }] });
        continue;
      }

      if (stats.isSymbolicLink()) {
        // Never followed, in either direction: a linked directory would walk
        // outside the corpus, and a linked file named `task.yaml` would be read
        // as one. Reported so it is visible rather than silently absent.
        ignoredFiles.push(rel);
        continue;
      }
      if (stats.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!stats.isFile()) continue;

      if (!TASK_EXTENSIONS.some((ext) => rel.endsWith(ext))) {
        ignoredFiles.push(rel);
        continue;
      }

      if (stats.size > MAX_TASK_FILE_BYTES) {
        failures.push({
          file: rel,
          issues: [
            {
              path: '',
              message: `is ${String(stats.size)} bytes, over the ${String(MAX_TASK_FILE_BYTES)}-byte limit for one task file`,
            },
          ],
        });
        continue;
      }
      files.push(rel);
    }
  };

  walk('');

  for (const rel of files) {
    try {
      entries.push({ file: rel, text: readFileSync(join(dir, rel), 'utf8') });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'could not be read';
      failures.push({ file: rel, issues: [{ path: '', message }] });
    }
  }

  ignoredFiles.sort();
  failures.sort((a, b) => a.file.localeCompare(b.file));
  return { entries, ignoredFiles, failures };
}

/**
 * Read a corpus directory and load it.
 *
 * Adapter failures — an oversized file, an unreadable one — are handed to
 * `loadCorpus` rather than thrown here, so a directory holding one oversized
 * file and one malformed file names both in a single failure. Stopping at the
 * first would reintroduce the fix-one-error-per-run loop the single throw exists
 * to avoid.
 */
export function loadCorpusFromDirectory(
  dir: string,
  options: Omit<LoadCorpusOptions, 'ignoredFiles' | 'priorFailures'>,
): TaskCorpus {
  const { entries, ignoredFiles, failures } = readTaskEntries(dir);
  return loadCorpus(entries, { ...options, ignoredFiles, priorFailures: failures });
}
