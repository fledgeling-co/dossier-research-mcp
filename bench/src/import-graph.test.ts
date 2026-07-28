import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findImpureImports, importGraph, IMPURE_MODULES } from './import-graph.js';

/**
 * The walk itself, on synthetic files.
 *
 * Two purity guards decide what they assert from this module, so a defect here
 * is a defect that makes both of them green over a false claim. The guards
 * exercise it against the real tree; these cases exercise the shapes the real
 * tree does not currently contain, which is where a walker quietly stops
 * working.
 *
 * The property being defended throughout: **an edge this cannot follow must
 * fail loudly, never be skipped.** A walker that silently drops an import it
 * cannot parse or resolve returns a clean graph for the one module that
 * mattered, and every guard downstream reports success.
 */

const roots: string[] = [];
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'import-graph-'));
  roots.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, text, 'utf8');
  }
  return dir;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('importGraph follows every form a relative import can take', () => {
  it('follows static imports, re-exports, dynamic imports and side-effect imports', () => {
    const dir = tree({
      'entry.ts': [
        "import { a } from './static.js';",
        "export { b } from './reexport.js';",
        "export type { C } from './type-only.js';",
        "void import('./dynamic.js');",
        "import './side-effect.js';",
      ].join('\n'),
      'static.ts': 'export const a = 1;\n',
      'reexport.ts': 'export const b = 2;\n',
      'type-only.ts': 'export interface C { x: number }\n',
      'dynamic.ts': 'export const d = 3;\n',
      'side-effect.ts': 'globalThis.touched = true;\n',
    });

    const graph = importGraph(join(dir, 'entry.ts'));
    for (const name of ['static', 'reexport', 'type-only', 'dynamic', 'side-effect']) {
      expect(graph, name).toContain(join(dir, `${name}.ts`));
    }
  });

  it('follows a chain to its end rather than stopping at the first hop', () => {
    const dir = tree({
      'a.ts': "import './b.js';\n",
      'b.ts': "import './c.js';\n",
      'c.ts': "import './d.js';\n",
      'd.ts': 'export const end = 1;\n',
    });
    expect(importGraph(join(dir, 'a.ts'))).toHaveLength(4);
  });

  it('terminates on a cycle rather than walking forever', () => {
    const dir = tree({
      'a.ts': "import './b.js';\n",
      'b.ts': "import './a.js';\n",
    });
    expect(importGraph(join(dir, 'a.ts'))).toHaveLength(2);
  });

  it('does not walk into a bare specifier, which has no repo-local source', () => {
    const dir = tree({ 'a.ts': "import { z } from 'zod';\n" });
    expect(importGraph(join(dir, 'a.ts'))).toEqual([join(dir, 'a.ts')]);
  });
});

describe('an edge it cannot follow fails loudly', () => {
  it('throws naming the specifier and the parent, rather than skipping it', () => {
    const dir = tree({ 'a.ts': "import './missing.js';\n" });
    // The whole point. A skipped edge is not a clean edge, and a walker that
    // swallowed this would report `a.ts` pure whatever `missing.ts` did.
    expect(() => importGraph(join(dir, 'a.ts'))).toThrow(/could not follow "\.\/missing\.js"/);
    expect(() => importGraph(join(dir, 'a.ts'))).toThrow(/a\.ts/);
  });
});

describe('findImpureImports reports what is reached and how', () => {
  it('finds an impure import several hops away and gives the path to it', () => {
    const dir = tree({
      'entry.ts': "import './mid.js';\n",
      'mid.ts': "import './deep.js';\n",
      'deep.ts': "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n",
    });

    const reaches = findImpureImports(join(dir, 'entry.ts'));
    expect(reaches).toHaveLength(1);
    expect(reaches[0]?.module).toBe('node:fs');
    expect(reaches[0]?.file).toBe(join(dir, 'deep.ts'));
    expect(reaches[0]?.path).toEqual([
      join(dir, 'entry.ts'),
      join(dir, 'mid.ts'),
      join(dir, 'deep.ts'),
    ]);
  });

  it('returns nothing for a graph that reaches nothing forbidden', () => {
    const dir = tree({
      'entry.ts': "import './pure.js';\n",
      'pure.ts': 'export const add = (a: number, b: number): number => a + b;\n',
    });
    expect(findImpureImports(join(dir, 'entry.ts'))).toEqual([]);
  });

  it('catches every module on the forbidden list, so none of them is decoration', () => {
    for (const module of IMPURE_MODULES) {
      const dir = tree({ 'a.ts': `import x from '${module}';\nexport default x;\n` });
      expect(findImpureImports(join(dir, 'a.ts')).map((r) => r.module), module).toEqual([module]);
    }
  });

  it('catches the escape hatches a static walk cannot follow past', () => {
    const hatches = {
      'require.ts': "import { createRequire } from 'node:module';\nexport const r = createRequire;\n",
      'fetch.ts': 'export const go = async (u: string): Promise<Response> => fetch(u);\n',
    };
    for (const [name, text] of Object.entries(hatches)) {
      const dir = tree({ [name]: text });
      expect(findImpureImports(join(dir, name)).length, name).toBeGreaterThan(0);
    }
  });

  it('a commented-out impure import does not trip the guard', () => {
    // Direction one. Every form of comment, each naming something forbidden.
    const dir = tree({
      'a.ts': [
        "// import { readFileSync } from 'node:fs';",
        '/* import { connect } from "node:net"; */',
        '/**',
        " * Historically this did `const x = require('child_process')`.",
        ' */',
        'export const noop = (): void => undefined;',
      ].join('\n'),
    });
    expect(findImpureImports(join(dir, 'a.ts'))).toEqual([]);
  });

  it('a real impure import on the same line as a comment still trips it', () => {
    // Direction two, and the one that matters more. A guard that went quiet
    // whenever a comment appeared nearby would be worse than no guard, because
    // it would be green. Both orders, since a scanner can get one right and the
    // other wrong.
    const cases = {
      'after.ts': "import { readFileSync } from 'node:fs'; // why this is here\nexport const r = readFileSync;\n",
      'before.ts': "/* justified below */ import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n",
      'between.ts': "import /* still an import */ { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n",
    };
    for (const [name, text] of Object.entries(cases)) {
      const dir = tree({ [name]: text });
      expect(findImpureImports(join(dir, name)).map((r) => r.module), name).toContain('node:fs');
    }
  });

  it('a URL in a string does not truncate the line and hide a real call', () => {
    // The defect that made the scanner necessary. Stripping `//` to end of line
    // without knowing what a string is deleted everything after the `//` in
    // `https://`, taking the `fetch(` with it, and `fetch` is a global with no
    // import to walk to. The walk returned clean for a module that opens
    // sockets.
    const dir = tree({
      'a.ts': [
        "const base = 'https://example.com/api';",
        'export const go = async (): Promise<Response> => fetch(base);',
      ].join('\n'),
    });
    expect(findImpureImports(join(dir, 'a.ts')).map((r) => r.module)).toContain('fetch()');
  });

  it('a URL in a string does not hide a forbidden import further down the file', () => {
    const dir = tree({
      'a.ts': [
        "const docs = 'https://nodejs.org/api/fs.html';",
        "import { readFileSync } from 'node:fs';",
        'export const r = { docs, readFileSync };',
      ].join('\n'),
    });
    expect(findImpureImports(join(dir, 'a.ts')).map((r) => r.module)).toContain('node:fs');
  });

  it('follows an edge whose specifier sits in a string beside a URL comment', () => {
    const dir = tree({
      'a.ts': "// see https://example.com/why\nimport './b.js';\n",
      'b.ts': "import { readFileSync } from 'fs';\nexport const r = readFileSync;\n",
    });
    expect(findImpureImports(join(dir, 'a.ts')).map((r) => r.module)).toEqual(['fs']);
  });

  it('catches the bare builtin spellings, not only the node: ones', () => {
    // `node:fs` and `fs` are the same module. The regex this walk replaced had
    // `(?:node:)?`; a list carrying only the prefixed form is one a
    // one-character edit walks straight past.
    for (const [module, text] of Object.entries({
      fs: "const fs = require('fs');\nexport default fs;\n",
      child_process: "import { spawn } from 'child_process';\nexport default spawn;\n",
      net: "import { connect } from 'net';\nexport default connect;\n",
    })) {
      const dir = tree({ 'a.ts': text });
      expect(findImpureImports(join(dir, 'a.ts')).map((r) => r.module), module).toContain(module);
    }
  });

  it('sees a forbidden import split across lines, the way the edge finder does', () => {
    // The two used to disagree: the edge finder tolerated whitespace and the
    // forbidden-module check did an exact `includes`, so one construct had two
    // answers depending on which question was asked.
    const dir = tree({ 'a.ts': "import { readFileSync }\n  from 'node:fs';\nexport const r = readFileSync;\n" });
    expect(findImpureImports(join(dir, 'a.ts')).map((r) => r.module)).toContain('node:fs');
  });

  it('follows a relative require, not only a relative import', () => {
    const dir = tree({
      'a.ts': "const b = require('./b.js');\nexport default b;\n",
      'b.ts': "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n",
    });
    expect(findImpureImports(join(dir, 'a.ts')).map((r) => r.module)).toEqual(['node:fs']);
  });

  it('does not mistake an explanation for a call', () => {
    // Several modules in this repo document at length why they do NOT call
    // `fetch` directly. A check that could not tell prose from code would force
    // the reason out of the file to keep the rule, which is a worse codebase.
    const dir = tree({
      'a.ts': [
        '/**',
        ' * Never call fetch( here; everything goes through the injected fetcher.',
        ' */',
        '// createRequire is also banned in this file.',
        'export const noop = (): void => undefined;',
      ].join('\n'),
    });
    expect(findImpureImports(join(dir, 'a.ts'))).toEqual([]);
  });

  it('reports one reach per forbidden module in a file, with the shortest path', () => {
    const dir = tree({
      'entry.ts': "import './short.js';\nimport './long.js';\n",
      'short.ts': "import './shared.js';\n",
      'long.ts': "import './hop.js';\n",
      'hop.ts': "import './shared.js';\n",
      'shared.ts': "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n",
    });
    const reaches = findImpureImports(join(dir, 'entry.ts'));
    expect(reaches).toHaveLength(1);
    // Breadth-first, so the two-hop route is the one reported and a guard that
    // asserts on the path is asserting on a stable answer.
    expect(reaches[0]?.path).toEqual([
      join(dir, 'entry.ts'),
      join(dir, 'short.ts'),
      join(dir, 'shared.ts'),
    ]);
  });
});
