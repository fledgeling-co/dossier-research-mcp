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

/**
 * Anything that opens a file, a socket or a process.
 *
 * Both spellings of every builtin. `node:fs` and `fs` are the same module, and
 * a list carrying only the prefixed form is a list a one-character edit walks
 * straight past. The regex this replaced had `(?:node:)?` for exactly that
 * reason, and losing it would have been a silent weakening.
 */
export const IMPURE_MODULES = [
  'node:fs',
  'fs',
  'node:fs/promises',
  'fs/promises',
  'node:net',
  'net',
  'node:dns',
  'dns',
  'node:dns/promises',
  'dns/promises',
  'node:http',
  'http',
  'node:https',
  'https',
  'node:child_process',
  'child_process',
  'undici',
] as const;

/**
 * Ways out of the static graph, which a static walk by definition cannot follow.
 *
 * `createRequire` hands a module the CommonJS resolver, so anything after it is
 * invisible here. A bare `fetch(` needs no import at all, because it is a
 * global. A walker that ignored either would return a clean graph for a module
 * that requires `node:fs` by a computed name or opens a socket with no import
 * to see, and the guarantee would be worth nothing.
 *
 * Both were checked by the regex guards this walk replaces, so they are carried
 * rather than quietly dropped: an upgrade that loses a check is a downgrade
 * with better prose.
 */
const ESCAPE_HATCHES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'createRequire', pattern: /\bcreateRequire\b/ },
  { name: 'fetch()', pattern: /\bfetch\s*\(/ },
];

/** One forbidden import, and how the entry module reaches it. */
export interface ImpureReach {
  /** The forbidden specifier, e.g. `undici`, or an escape hatch by name. */
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

/**
 * Source with comments removed and string literals left intact.
 *
 * Written as a scanner rather than two regexes, and the reason is a defect the
 * regex version really had. Stripping `//` to end of line without knowing what
 * a string is deletes the rest of any line containing a URL, so
 * `const base = 'https://example.com'; return fetch(base);` had everything from
 * the `//` onwards removed and the `fetch(` with it. That is the one check able
 * to see the global `fetch`, which has no import to walk to, so the walk
 * returned a clean graph for a module that opens sockets.
 *
 * It has to run in both directions at once. Comments must go, because several
 * modules here explain at length why they do *not* reach for these things and a
 * check that cannot tell an explanation from a call would force the reason out
 * of the file to keep the rule. `bench/src/detector/report.ts` is now exactly
 * such a module. And strings must stay, because the specifier in
 * `from 'node:fs'` is a string and removing it would remove the graph.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (two === '/*') {
      i += 2;
      while (i < source.length && source.slice(i, i + 2) !== '*/') i += 1;
      i += 2;
      continue;
    }
    const ch = source[i] ?? '';
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        const c = source[i] ?? '';
        out += c;
        i += 1;
        if (c === '\\') {
          out += source[i] ?? '';
          i += 1;
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Every relative specifier `source` imports, in the order they appear.
 *
 * Four forms. `from '...'` covers static imports and re-exports,
 * `import('...')` the dynamic form, `import '...'` on its own a side-effect
 * import with no bindings, and `require('...')` the CommonJS form. The last two
 * are the ones a walker forgets, and a walker that could not see one would
 * return a clean graph for a module that reached an impure one through it,
 * which is precisely the unfollowed edge this module exists to make impossible.
 */
function relativeSpecifiers(source: string): string[] {
  const found: string[] = [];
  const pattern =
    /from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of source.matchAll(pattern)) {
    const specifier = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
    if (specifier.startsWith('.')) found.push(specifier);
  }
  return found;
}

/**
 * Whether `source` reaches `module`, in every form this repo can write it.
 *
 * Regex rather than `String.includes`, and matching the same whitespace the
 * edge finder tolerates. The two used to disagree: a `from` and its specifier
 * split across a line break was followed as an edge and not seen as a forbidden
 * import, so one construct had two answers depending on which question was
 * being asked.
 */
function imports(source: string, module: string): boolean {
  const quoted = `['"]${module.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}['"]`;
  return (
    new RegExp(`from\\s*${quoted}`).test(source) ||
    new RegExp(`require\\s*\\(\\s*${quoted}\\s*\\)`).test(source) ||
    new RegExp(`import\\s*\\(\\s*${quoted}\\s*\\)`).test(source) ||
    new RegExp(`import\\s+${quoted}`).test(source)
  );
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
    for (const specifier of relativeSpecifiers(stripComments(readFileSync(file, 'utf8')))) {
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

    // One stripped source for every question asked of this file. The two used
    // to disagree: forbidden modules were matched against the raw text and the
    // escape hatches against the stripped text, so a comment naming `node:fs`
    // was reported as a reach while a comment naming a relative specifier that
    // does not resolve threw and took the whole walk down with it.
    const source = stripComments(readFileSync(next.file, 'utf8'));
    for (const module of forbidden) {
      if (imports(source, module)) {
        reaches.push({ module, file: next.file, path: next.path });
      }
    }
    for (const hatch of ESCAPE_HATCHES) {
      if (hatch.pattern.test(source)) {
        reaches.push({ module: hatch.name, file: next.file, path: next.path });
      }
    }
    for (const specifier of relativeSpecifiers(source)) {
      const target = resolveEdge(next.file, specifier);
      queue.push({ file: target, path: [...next.path, target] });
    }
  }
  return reaches;
}
