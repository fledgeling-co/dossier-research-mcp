import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * A corpus that never leaves the machine.
 *
 * `corpus_add_file` uploads to Google, which is the right trade for most work
 * and the wrong one for anything you cannot hand to a third party. This is the
 * other option: files are read here, matched here, and no byte of their content
 * reaches any provider, reranker or model. What a research run gets back is a
 * badged section the caller can read; what the *provider* gets is nothing.
 *
 * ## The security boundary, and why it is where it is
 *
 * This reads local files and returns their contents, which makes it an
 * exfiltration primitive in the wrong hands. The hands in question are an
 * agent's: an agent that has just read a hostile web page is exactly the thing
 * that must not be able to point a file reader at `~/.ssh`.
 *
 * So the roots are granted by the operator through the environment and there is
 * no tool that adds one. Everything below that grant is defence in depth:
 * symlinks are resolved and re-checked against the root (a symlink out of a
 * granted directory is the obvious escape), dotfiles and dependency directories
 * are skipped, the walk is bounded in depth and file count, and only text-ish
 * extensions are read at all.
 */

export interface LocalMatch {
  /** Path relative to its granted root, so a response never leaks the layout above it. */
  readonly file: string;
  readonly root: string;
  readonly line: number;
  readonly snippet: string;
}

export interface LocalSearchOptions {
  readonly maxMatches?: number;
  readonly maxFiles?: number;
  readonly maxDepth?: number;
  readonly maxFileBytes?: number;
}

const DEFAULTS = {
  maxMatches: 40,
  maxFiles: 2_000,
  maxDepth: 8,
  maxFileBytes: 2 * 1024 * 1024,
} as const;

/** Text formats worth searching. Anything else is skipped unread. */
const READABLE = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.rst',
  '.org',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.html',
  '.htm',
  '.xml',
  '.log',
]);

/** Never worth walking, and in two cases actively dangerous to surface. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.ssh',
  '.gnupg',
]);

export class LocalCorpus {
  constructor(private readonly roots: readonly string[]) {}

  get configured(): boolean {
    return this.roots.length > 0;
  }

  /** The granted roots, with whether each one currently exists. */
  async describe(): Promise<{ root: string; exists: boolean; files: number }[]> {
    const out: { root: string; exists: boolean; files: number }[] = [];
    for (const root of this.roots) {
      try {
        const s = await stat(root);
        if (!s.isDirectory()) {
          out.push({ root, exists: false, files: 0 });
          continue;
        }
        const walked = await this.walk(root, DEFAULTS.maxFiles, DEFAULTS.maxDepth);
        out.push({ root, exists: true, files: walked.files.length });
      } catch {
        out.push({ root, exists: false, files: 0 });
      }
    }
    return out;
  }

  /**
   * Literal, case-insensitive substring search.
   *
   * Deliberately not regex: a caller-supplied pattern is a denial-of-service
   * vector against the event loop, and the same lesson is already recorded in
   * `research_read`'s grep. Deliberately not embeddings either, because every
   * embedding API call would send the file contents to a provider, which is the
   * one thing this class promises not to do.
   */
  async search(query: string, opts: LocalSearchOptions = {}): Promise<LocalMatch[]> {
    const limits = { ...DEFAULTS, ...opts };
    const needle = query.trim().toLowerCase();
    if (!needle) return [];

    const matches: LocalMatch[] = [];
    for (const root of this.roots) {
      // Paths come back resolved, so relativise against the REAL root: a
      // granted path that is itself a symlink (every temp directory on macOS)
      // would otherwise report every match as `../../../private/var/...`.
      const { realRoot, files } = await this.walk(root, limits.maxFiles, limits.maxDepth);
      for (const file of files) {
        if (matches.length >= limits.maxMatches) return matches;
        let text: string;
        try {
          const s = await stat(file);
          if (s.size > limits.maxFileBytes) continue;
          text = await readFile(file, 'utf8');
        } catch {
          continue; // unreadable is not an error worth failing a search over
        }
        const lines = text.split('\n');
        for (const [i, line] of lines.entries()) {
          if (!line.toLowerCase().includes(needle)) continue;
          matches.push({
            file: relative(realRoot, file),
            root,
            line: i + 1,
            snippet: line.trim().slice(0, 400),
          });
          if (matches.length >= limits.maxMatches) break;
        }
      }
    }
    return matches;
  }

  /** Bounded walk. Symlinks are resolved and re-checked against the root. */
  private async walk(
    root: string,
    maxFiles: number,
    maxDepth: number,
  ): Promise<{ realRoot: string; files: string[] }> {
    const real: string = await realpath(root, 'utf8').catch(() => resolve(root));
    const found: string[] = [];

    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > maxDepth || found.length >= maxFiles) return;
      // Inferred, not annotated: `typeof readdir` resolves to the Buffer
      // overload, which silently types every `entry.name` as a Buffer.
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
      if (!entries) return;
      for (const entry of entries) {
        if (found.length >= maxFiles) return;
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        // Resolve before deciding: a symlink is how a granted directory
        // becomes a path out of it, and `readdir` reports the link, not
        // where it points.
        const target: string | null = await realpath(full, 'utf8').catch(() => null);
        if (!target || !isInside(real, target)) continue;
        // Re-apply every rule to the RESOLVED path, not just the alias.
        //
        // `safe-notes.md -> .env` passed the extension check on the link name
        // while the read went to the target, so a rename was enough to walk
        // straight past the skip list. Staying inside the root is not
        // sufficient: the interesting secrets are inside it.
        if (!permitted(real, target)) continue;
        const info = await stat(target).catch(() => null);
        if (!info) continue;
        if (info.isDirectory()) await visit(target, depth + 1);
        else if (info.isFile() && READABLE.has(extname(target).toLowerCase())) found.push(target);
      }
    };

    await visit(real, 0);
    return { realRoot: real, files: found };
  }
}

/**
 * Does every segment of the resolved path clear the same rules the entry name
 * had to?
 *
 * Checking the alias and reading the target is the whole bug: the alias is
 * attacker-chosen and the target is what gets returned. So the resolved path is
 * re-checked segment by segment, which also catches a directory link pointing
 * into `.ssh` or `node_modules` from somewhere innocuous.
 */
function permitted(root: string, resolved: string): boolean {
  // Only the part BELOW the granted root. The root itself is the operator's
  // deliberate choice and may perfectly well be `~/.notes`; rejecting its own
  // dot segment would make that grant match nothing at all.
  for (const segment of relative(root, resolved).split(sep)) {
    if (!segment) continue;
    if (SKIP_DIRS.has(segment)) return false;
    // A dotfile anywhere in the resolved path, not merely as the entry name.
    if (segment.startsWith('.') && segment !== '.' && segment !== '..') return false;
  }
  return true;
}

/**
 * Containment check on path segments, so `/a/bc` is not "inside" `/a/b`.
 *
 * `relative` returns an *absolute* path when the two are on different roots
 * (different Windows drives), which is the case `isAbsolute` catches here.
 */
function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}
