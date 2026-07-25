import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { LocalCorpus } from '../src/corpus/local.js';

/**
 * The local corpus reads files off the machine and hands their contents back,
 * which makes every one of its limits a security control rather than a
 * performance tweak. The tests are written accordingly: the interesting cases
 * are all the ones where it must refuse.
 */

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dossier-local-'));
  outside = await mkdtemp(join(tmpdir(), 'dossier-outside-'));
  await writeFile(join(root, 'notes.md'), '# Notes\n\nWe agreed the migration lands in Q3.\nUnrelated line.\n');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'sub', 'deal.txt'), 'The migration budget is 40k.\n');
  await writeFile(join(outside, 'secrets.md'), 'The migration password is hunter2.\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('the grant is the boundary', () => {
  it('is off until an operator grants a directory', () => {
    const config = loadConfig({ DOSSIER_STORE_DIR: '/tmp/x' });
    expect(config.localCorpusDirs).toEqual([]);
    expect(new LocalCorpus(config.localCorpusDirs).configured).toBe(false);
  });

  it('takes colon-separated and comma-separated absolute paths', () => {
    const config = loadConfig({ DOSSIER_STORE_DIR: '/tmp/x', DOSSIER_LOCAL_CORPUS_DIRS: `${root},${outside}` });
    expect(config.localCorpusDirs).toEqual([root, outside]);
    const colon = loadConfig({ DOSSIER_STORE_DIR: '/tmp/x', DOSSIER_LOCAL_CORPUS_DIRS: `${root}:${outside}` });
    expect(colon.localCorpusDirs).toEqual([root, outside]);
  });
});

describe('searching stays inside the grant', () => {
  it('finds matches with file and line, across subdirectories', async () => {
    const matches = await new LocalCorpus([root]).search('migration');
    expect(matches.map((m) => m.file).sort()).toEqual(['notes.md', join('sub', 'deal.txt')]);
    expect(matches.find((m) => m.file === 'notes.md')?.line).toBe(3);
  });

  it('will not follow a symlink out of a granted directory', async () => {
    // The obvious escape: a link inside the grant pointing anywhere else.
    await symlink(outside, join(root, 'escape'));
    const matches = await new LocalCorpus([root]).search('migration');
    expect(matches.some((m) => m.snippet.includes('hunter2'))).toBe(false);
  });

  it('skips dotfiles, credentials directories and dependency trees unread', async () => {
    await mkdir(join(root, '.ssh'), { recursive: true });
    await writeFile(join(root, '.ssh', 'id_rsa.txt'), 'migration key material\n');
    await writeFile(join(root, '.env.txt'), 'migration secret\n');
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'x.md'), 'migration noise\n');
    const matches = await new LocalCorpus([root]).search('migration');
    expect(matches.every((m) => !m.file.includes('.ssh'))).toBe(true);
    expect(matches.every((m) => !m.file.includes('node_modules'))).toBe(true);
    expect(matches.every((m) => !m.file.includes('.env'))).toBe(true);
  });

  it('reads only text-ish extensions', async () => {
    await writeFile(join(root, 'binary.bin'), 'migration inside a binary\n');
    const matches = await new LocalCorpus([root]).search('migration');
    expect(matches.some((m) => m.file === 'binary.bin')).toBe(false);
  });

  it('treats the query as a literal, never a pattern', async () => {
    // A caller-supplied regex is a denial-of-service vector against the loop.
    await writeFile(join(root, 'regex.md'), 'literal .*+ text\n');
    const matches = await new LocalCorpus([root]).search('.*+');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.file).toBe('regex.md');
  });

  it('caps what it returns', async () => {
    for (let i = 0; i < 30; i += 1) await writeFile(join(root, `f${String(i)}.md`), 'migration\n');
    expect(await new LocalCorpus([root]).search('migration', { maxMatches: 5 })).toHaveLength(5);
  });

  it('reports a missing granted directory rather than throwing', async () => {
    const rows = await new LocalCorpus([join(root, 'nope')]).describe();
    expect(rows[0]?.exists).toBe(false);
    expect(await new LocalCorpus([join(root, 'nope')]).search('migration')).toEqual([]);
  });

  it('returns nothing for an empty query rather than everything', async () => {
    expect(await new LocalCorpus([root]).search('   ')).toEqual([]);
  });
});
