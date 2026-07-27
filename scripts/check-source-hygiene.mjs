#!/usr/bin/env node
/**
 * Refuse to ship source files containing control characters that make them
 * invisible to ordinary tooling.
 *
 * `src/research/contract.ts` shipped in v0.2.1 with a NUL byte inside a string
 * literal (`].join('\0')`). Nothing caught it: `tsgo` compiled it, ESLint
 * passed it, every test passed, and it was published to npm. What it did do was
 * make `git diff` treat the file as **binary**, so the file was never reviewable
 * in a diff, and make `grep` skip it silently, so searches for symbols inside it
 * returned nothing at all rather than an error.
 *
 * A file the toolchain quietly refuses to read is worse than a file that fails
 * to compile. This check is cheap and runs in the gate.
 */
import { readFileSync, globSync } from 'node:fs';

const FILES = [
  ...globSync('src/**/*.ts'),
  ...globSync('tests/**/*.ts'),
  ...globSync('bench/**/*.ts'),
  ...globSync('scripts/*.mjs'),
].sort();

// Tab (0x09), LF (0x0a) and CR (0x0d) are legitimate. Everything else below
// 0x20, plus DEL (0x7f), is not. Checked by code point rather than by regex:
// a regex literal containing control characters is itself the thing this
// script exists to prevent, and `no-control-regex` rightly rejects it.
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d]);
const isForbidden = (code) => (code < 0x20 && !ALLOWED_CONTROL.has(code)) || code === 0x7f;

const bad = [];
for (const file of FILES) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      const code = ch.codePointAt(0);
      if (isForbidden(code)) {
        bad.push(`${file}:${i + 1}  contains U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
        break;
      }
    }
  }
}

console.log(`Checked ${FILES.length} source files for control characters.`);
if (bad.length === 0) {
  console.log('Clean.');
  process.exit(0);
}
for (const line of bad) console.error(`BAD  ${line}`);
console.error('\nControl characters make files binary to git and invisible to grep. Remove them.');
process.exit(1);
