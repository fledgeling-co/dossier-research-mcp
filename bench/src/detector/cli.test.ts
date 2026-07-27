import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from './corpus.js';

/**
 * The wiring, proved by running the entry point rather than by importing it.
 *
 * This file exists because of a defect this repo shipped: a module with nine
 * passing unit tests, imported nowhere, plus a changelog entry claiming the
 * feature worked. It ran never. **Passing tests over dead code look identical to
 * passing tests over live code**, and the only difference an import-based test
 * can never see is whether anything calls the thing at all.
 *
 * So every case below spawns the real CLI, over the real argv, and asserts on
 * what actually came out. Nothing here imports a command handler.
 *
 * Two commands reach the network and neither is exercised here: `capture`
 * fetches a page and `judge` calls a model. What is proved instead is that both
 * are **reachable and refuse correctly**, which is the half a hermetic gate can
 * honestly check.
 */

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: readonly string[], stdin?: string): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [CLI, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Inherited, so the corpus resolves the same way it does for a person
      // running the command, and hermetic so nothing can reach a model.
      env: { ...process.env, DOSSIER_HERMETIC: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe('the entry point actually runs (SELF-23)', () => {
  it('scores the corpus that ships, and prints both families', async () => {
    const ran = await run([]);
    expect(ran.stderr, ran.stderr).toBe('');
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain('# The support family');
    expect(ran.stdout).toContain('# The registry family');
    expect(ran.stdout).toContain('## containment');
    expect(ran.stdout).toContain('## judged');
  }, 60_000);

  it('prints the full confusion matrix for both modes, not a summary of it', async () => {
    const ran = await run([]);
    // Every true label appears as a row, with a cell per predicted label plus
    // the abstain column. A report that collapsed the matrix would pass a
    // "contains the arm name" check and fail this one.
    for (const label of [
      'supports',
      'partially_supports',
      'contradicts',
      'not_addressed',
      'unreadable',
    ]) {
      expect(ran.stdout, label).toContain(label);
    }
    expect(ran.stdout).toContain('true \\ said');
    expect(ran.stdout).toContain('False reassurance');
  }, 60_000);

  it('says what the numbers cannot mean, in the output and not only in a doc', async () => {
    const ran = await run([]);
    expect(ran.stdout).toContain('# What none of these numbers can mean');
    expect(ran.stdout).toMatch(/[Cc]ontainment is not entailment/);
  }, 60_000);

  it('the report goes to stdout and diagnostics to stderr, so it can be redirected', async () => {
    const ran = await run([]);
    expect(ran.stdout.length).toBeGreaterThan(1000);
    expect(ran.stderr).toBe('');
  }, 60_000);

  it('prints usage naming every command', async () => {
    const ran = await run(['--help']);
    expect(ran.code).toBe(0);
    for (const command of ['capture', 'construct', 'judge']) {
      expect(ran.stdout, command).toContain(`bench:detector ${command}`);
    }
  }, 60_000);
});

describe('judge is reachable and refuses without confirmation', () => {
  it('refuses to spend anything without --confirm, and says what it would spend', async () => {
    const ran = await run(['judge']);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('--confirm');
    expect(ran.stderr).toMatch(/subscription quota/);
    // Nothing was written, which is the half that matters.
    expect(ran.stdout).toBe('');
  }, 60_000);
});

describe('capture is reachable and validates before it reaches a network', () => {
  it('refuses a name that is not a plain slug, without fetching anything', async () => {
    const ran = await run(['capture', 'https://example.com/', '../escape']);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('lowercase letters, digits and hyphens');
  }, 60_000);

  it('refuses a missing name the same way', async () => {
    const ran = await run(['capture', 'https://example.com/']);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('usage:');
  }, 60_000);
});

describe('construct writes a fixture whose digest the loader will accept', () => {
  it('freezes text from stdin, and the block it prints matches the file it wrote', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detector-cli-'));
    const text = 'We value your privacy. Accept all. Reject all.';
    const ran = await run(
      ['construct', 'a-consent-wall', '--note', 'a wall that will not hold still', '--corpus', root],
      text,
    );
    expect(ran.code, ran.stderr).toBe(0);

    const written = readFileSync(join(root, 'pages', 'a-consent-wall.txt'), 'utf8');
    expect(written).toBe(text);

    // The digest in the printed block is the digest of the file on disk. This
    // is the one thing that must be right, because the loader refuses the whole
    // corpus on a mismatch and a hand-copied hash is how that happens.
    expect(ran.stdout).toContain(`textSha256: "${sha256Hex(text)}"`);
    expect(ran.stdout).toContain(`textChars: ${String(text.length)}`);
    expect(ran.stdout).toContain('provenance: constructed');
    expect(ran.stdout).toContain('a wall that will not hold still');
  }, 60_000);

  it('refuses without a note, since a constructed page has to say why it is one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detector-cli-'));
    const ran = await run(['construct', 'nameless', '--corpus', root], 'some text');
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('--note');
    expect(readdirSync(root)).toEqual([]);
  }, 60_000);

  it('refuses an empty stdin rather than freezing a blank page', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detector-cli-'));
    const ran = await run(['construct', 'empty', '--note', 'a note long enough to be real', '--corpus', root], '');
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('nothing arrived on stdin');
  }, 60_000);
});
