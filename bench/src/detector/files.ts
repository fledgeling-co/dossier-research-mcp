import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_CASE_FILE_BYTES, MAX_PAGE_FILE_BYTES } from './schema.js';
import {
  loadDetectorCorpus,
  type CorpusFailure,
  type CorpusFileEntry,
  type DetectorCorpus,
} from './corpus.js';

/**
 * The only file in this directory that touches a disk.
 *
 * Kept apart from `corpus.ts` so the loader's purity is structural rather than
 * promised: every rule about what a case must carry, including the digest check
 * that makes the frozen fixtures trustworthy, is testable with no filesystem at
 * all, and this adapter exists solely to produce the contents.
 *
 * The walk is BENCH-01's, deliberately: `lstat` rather than `stat`, symbolic
 * links reported and never followed, sorted at every level so the order is the
 * same on every machine. Node's own recursive `readdirSync` follows a link out
 * of the directory it was given, and a corpus is hand-authored files, so a link
 * inside one is either a mistake or an escape.
 */

const CASE_EXTENSIONS = ['.yaml', '.yml'];

export interface ReadDirResult {
  readonly entries: readonly CorpusFileEntry[];
  readonly ignoredFiles: readonly string[];
  readonly failures: readonly CorpusFailure[];
}

function walk(dir: string, accept: (name: string) => boolean, maxBytes: number): ReadDirResult {
  const entries: CorpusFileEntry[] = [];
  const ignoredFiles: string[] = [];
  const failures: CorpusFailure[] = [];

  if (!existsSync(dir)) return { entries, ignoredFiles, failures };

  const files: string[] = [];
  const descend = (relDir: string): void => {
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
    for (const name of [...names].sort()) {
      const rel = relDir === '' ? name : `${relDir}/${name}`;
      let stat;
      try {
        stat = lstatSync(join(dir, rel));
      } catch {
        ignoredFiles.push(rel);
        continue;
      }
      if (stat.isSymbolicLink()) {
        ignoredFiles.push(`${rel} (symbolic link, not followed)`);
        continue;
      }
      if (stat.isDirectory()) {
        descend(rel);
        continue;
      }
      if (!stat.isFile()) {
        ignoredFiles.push(rel);
        continue;
      }
      if (!accept(name)) {
        ignoredFiles.push(rel);
        continue;
      }
      if (stat.size > maxBytes) {
        failures.push({
          file: rel,
          issues: [
            {
              path: '',
              message: `is ${String(stat.size)} bytes, over the ${String(maxBytes)} byte cap`,
            },
          ],
        });
        continue;
      }
      files.push(rel);
    }
  };
  descend('');

  for (const rel of files) {
    try {
      entries.push({ file: rel, text: readFileSync(join(dir, rel), 'utf8') });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'could not be read';
      failures.push({ file: rel, issues: [{ path: '', message }] });
    }
  }

  return { entries, ignoredFiles, failures };
}

export interface DetectorCorpusPaths {
  readonly root: string;
  readonly supportDir: string;
  readonly registryDir: string;
  readonly pagesDir: string;
  readonly judgedFile: string;
}

/** Where the corpus lives, relative to a root. One place, so nothing guesses. */
export function detectorPaths(root: string): DetectorCorpusPaths {
  return {
    root,
    supportDir: join(root, 'support'),
    registryDir: join(root, 'registry'),
    pagesDir: join(root, 'pages'),
    judgedFile: join(root, 'evidence', 'judged-verdicts.json'),
  };
}

/** The corpus directory in this repository. */
export function defaultCorpusRoot(): string {
  return new URL('../../detector/', import.meta.url).pathname;
}

/**
 * Read the corpus from a directory and load it.
 *
 * Throws `DetectorCorpusError` naming every rejected file, which includes a page
 * fixture that no longer matches the digest its case recorded.
 */
export function readDetectorCorpus(root: string = defaultCorpusRoot()): DetectorCorpus {
  const paths = detectorPaths(root);
  const isCase = (name: string): boolean =>
    CASE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
  const isPage = (name: string): boolean => name.toLowerCase().endsWith('.txt');

  const support = walk(paths.supportDir, isCase, MAX_CASE_FILE_BYTES);
  const registry = walk(paths.registryDir, isCase, MAX_CASE_FILE_BYTES);
  const pageFiles = walk(paths.pagesDir, isPage, MAX_PAGE_FILE_BYTES);

  const pages = new Map<string, string>();
  for (const entry of pageFiles.entries) {
    // Keyed by the bare name, which is all a case may refer to: a case that
    // could name a path could name one outside the corpus.
    const bare = entry.file.split('/').pop() ?? entry.file;
    pages.set(bare, entry.text);
  }

  let judgedJson: string | undefined;
  if (existsSync(paths.judgedFile)) {
    judgedJson = readFileSync(paths.judgedFile, 'utf8');
  }

  return loadDetectorCorpus({
    supportFiles: support.entries,
    registryFiles: registry.entries,
    pages,
    ...(judgedJson === undefined ? {} : { judgedJson }),
    ignoredFiles: [
      ...support.ignoredFiles,
      ...registry.ignoredFiles,
      ...pageFiles.ignoredFiles.filter((f) => !f.endsWith('.txt')),
    ],
    priorFailures: [...support.failures, ...registry.failures, ...pageFiles.failures],
  });
}
