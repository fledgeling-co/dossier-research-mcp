import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findImpureImports, importGraph } from '../../bench/src/import-graph.js';

function dir(): string { return mkdtempSync(join(tmpdir(), 'probe-')); }

describe('holes', () => {
  it('H1 bare fs specifier (no node: prefix)', () => {
    const d = dir();
    const f = join(d, 'a.ts');
    writeFileSync(f, "import { readFileSync } from 'fs';\n", 'utf8');
    console.log('H1 bare fs ->', JSON.stringify(findImpureImports(f)));
  });

  it('H1b bare child_process / https / net', () => {
    const d = dir();
    const f = join(d, 'a.ts');
    writeFileSync(f, "import { spawn } from 'child_process';\nimport https from 'https';\nimport net from 'net';\n", 'utf8');
    console.log('H1b bare ->', JSON.stringify(findImpureImports(f)));
  });

  it('H2 side-effect import edge not followed', () => {
    const d = dir();
    const a = join(d, 'a.ts');
    const b = join(d, 'b.ts');
    writeFileSync(b, "import { readFileSync } from 'node:fs';\n", 'utf8');
    writeFileSync(a, "import './b.js';\n", 'utf8');
    console.log('H2 graph ->', JSON.stringify(importGraph(a)));
    console.log('H2 impure ->', JSON.stringify(findImpureImports(a)));
  });

  it('H3 dynamic import with whitespace', () => {
    const d = dir();
    const f = join(d, 'a.ts');
    writeFileSync(f, "void import( 'node:fs' );\n", 'utf8');
    console.log('H3 ->', JSON.stringify(findImpureImports(f)));
  });

  it('H4 export-from edge', () => {
    const d = dir();
    const a = join(d, 'a.ts');
    const b = join(d, 'b.ts');
    writeFileSync(b, "import { readFileSync } from 'node:fs';\nexport const x = 1;\n", 'utf8');
    writeFileSync(a, "export * from './b.js';\n", 'utf8');
    console.log('H4 ->', JSON.stringify(findImpureImports(a).map(r=>r.module)));
  });

  it('H5 relative require edge not followed', () => {
    const d = dir();
    const a = join(d, 'a.ts');
    const b = join(d, 'b.ts');
    writeFileSync(b, "import { readFileSync } from 'node:fs';\n", 'utf8');
    writeFileSync(a, "const b = require('./b.js');\n", 'utf8');
    console.log('H5 ->', JSON.stringify(findImpureImports(a).map(r=>r.module)), JSON.stringify(importGraph(a)));
  });

  it('H6 comment mentioning a relative import creates a phantom edge', () => {
    const d = dir();
    const a = join(d, 'a.ts');
    writeFileSync(a, "// we deliberately do not import from './nope.js' here\nexport const x = 1;\n", 'utf8');
    let msg = 'no throw';
    try { findImpureImports(a); } catch (e: unknown) { msg = e instanceof Error ? e.message : String(e); }
    console.log('H6 ->', msg);
  });

  it('H7 comment mentioning a forbidden import is a false positive', () => {
    const d = dir();
    const a = join(d, 'a.ts');
    writeFileSync(a, "// this module never does: import x from 'node:fs'\nexport const x = 1;\n", 'utf8');
    console.log('H7 ->', JSON.stringify(findImpureImports(a).map(r=>r.module)));
  });

  it('H8 import with double-quoted dynamic + require of forbidden with spaces', () => {
    const d = dir();
    const a = join(d, 'a.ts');
    writeFileSync(a, "const fs = require( 'node:fs' );\n", 'utf8');
    console.log('H8 ->', JSON.stringify(findImpureImports(a).map(r=>r.module)));
  });

  it('H9 alternate paths: file reached via two parents', () => {
    const d = dir();
    const a = join(d, 'a.ts');
    const b = join(d, 'b.ts');
    const c = join(d, 'c.ts');
    const imp = join(d, 'imp.ts');
    writeFileSync(imp, "import { readFileSync } from 'node:fs';\n", 'utf8');
    writeFileSync(b, "import './imp.js';\nexport {};\n", 'utf8');
    writeFileSync(c, "import x from './imp.js';\nexport {};\n", 'utf8');
    writeFileSync(a, "import b from './b.js';\nimport c from './c.js';\nimport i from './imp.js';\nexport {};\n", 'utf8');
    console.log('H9 ->', JSON.stringify(findImpureImports(a), null, 1));
  });
});
