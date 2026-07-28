import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * The repo-local import graph of one module, and what impure thing it can reach.
 *
 * **Test support.** Nothing in a shipped path imports this; it exists so a
 * purity guard can check the claim it makes rather than the first line of it.
 *
 * The distinction is the whole point and it is worth stating once, here, rather
 * than in each guard. Reading a module's own source proves only that the module
 * does not import a filesystem *directly*. Every scorer in this benchmark
 * imports siblings, and several import shared modules from the product's `src/`,
 * so a check that stops at the entry file passes on a module whose second hop
 * opens a socket. That is not hypothetical: `bench/src/detector/report.ts`
 * declared itself pure and passed a same-file check for as long as it existed,
 * while reaching `undici`, `node:net`, `node:dns/promises` and `node:fs` through
 * one unguarded edge.
 *
 * Lifted out of `bench/src/score/citations.test.ts`, which had the only copy.
 * It lives here so there is one spelling: a second wording of the same rule is
 * how two guards end up enforcing different things, which is exactly the note
 * `bench/src/detector/corpus.test.ts` already carries about its own regex.
 *
 * What it deliberately does not do: resolve bare specifiers. A bare specifier is
 * a builtin or a package, and it has no repo-local source to walk into, so the
 * graph stops there and the specifier itself is what gets matched against the
 * forbidden list.
 */

/** Anything that opens a file, a socket or a process. */
export const IMPURE_MODULES = [
  'node:fs',
  'node:fs/promises',
  'node:net',
  'node:dns',
  'node:dns/promises',
  'node:http',
  'node:https',
  'node:child_process',
  'undici',
] as const;

/** One forbidden import, and how the entry module reaches it. */
export interface ImpureReach {
  /** The forbidden specifier, e.g. `undici`. */
  readonly module: string;
  /** Absolute path of the file that imports it. */
  readonly file: string;
  /**
   * Entry first, importer last. What makes a finding actionable: "reaches
   * `undici`" names a problem nobody can locate, and "reaches it through
   * `./arms.js` then `../citations/collect.js`" names the edge to change.
   */
  readonly path: readonly string[];
}

/** Every relative specifier `source` imports, in the order they appear. */
function relativeSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/from\s+'([^']+)'|import\('([^']+)'\)/g)) {
    const specifier = m[1] ?? m[2] ?? '';
    if (specifier.startsWith('.')) found.push(specifier);
  }
  return found;
}

/** Whether `source` imports `module`, in either of the two forms this repo uses. */
function imports(source: string, module: string): boolean {
  return source.includes(`from '${module}'`) || source.includes(`require('${module}')`);
}

/**
 * Resolve a relative specifier to the TypeScript file it names.
 *
 * ESM specifiers in this repo are written with a `.js` extension and compiled
 * from `.ts`, so the rewrite is the resolution. A specifier that resolves to
 * nothing throws **by name**, because a walker that silently skipped an edge it
 * could not follow would report a clean graph for the one import that mattered,
 * which is the defect class this module exists to close.
 */
function resolveEdge(from: string, specifier: string): string {
  const target = resolve(dirname(from), specifier.replace(/\.js$/, '.ts'));
  try {
    readFileSync(target, 'utf8');
  } catch {
    throw new Error(
      `import-graph could not follow "${specifier}" from ${from}: expected ${target}. ` +
        'An edge that cannot be followed is not an edge that is clean; fix the resolution rather than skipping it.',
    );
  }
  return target;
}

/**
 * Every repo-local file reachable from `entry`, including `entry` itself.
 *
 * Breadth-first over relative imports only. Returned sorted, so a guard that
 * prints the graph prints the same thing on every machine.
 */
export function importGraph(entry: string): readonly string[] {
  const seen = new Set<string>();
  const queue: string[] = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    for (const specifier of relativeSpecifiers(readFileSync(file, 'utf8'))) {
      queue.push(resolveEdge(file, specifier));
    }
  }
  return [...seen].sort();
}

/**
 * Every forbidden import reachable from `entry`, each with the path to it.
 *
 * Breadth-first, so the path reported for a file reached two ways is the
 * shortest one. A guard asserting emptiness gets the same answer either way;
 * a guard asserting *where* the impurity comes from wants the short path.
 */
export function findImpureImports(
  entry: string,
  forbidden: readonly string[] = IMPURE_MODULES,
): readonly ImpureReach[] {
  const reaches: ImpureReach[] = [];
  const seen = new Set<string>();
  const queue: { readonly file: string; readonly path: readonly string[] }[] = [
    { file: entry, path: [entry] },
  ];

  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || seen.has(next.file)) continue;
    seen.add(next.file);

    const source = readFileSync(next.file, 'utf8');
    for (const module of forbidden) {
      if (imports(source, module)) {
        reaches.push({ module, file: next.file, path: next.path });
      }
    }
    for (const specifier of relativeSpecifiers(source)) {
      const target = resolveEdge(next.file, specifier);
      queue.push({ file: target, path: [...next.path, target] });
    }
  }
  return reaches;
}
