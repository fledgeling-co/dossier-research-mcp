import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_TASK_FILE_BYTES } from './schema.js';
import { TaskCorpusError } from './corpus.js';
import { loadCorpusFromDirectory, readTaskEntries } from './files.js';

/**
 * The only tests here that touch a disk, which is the whole point of keeping the
 * adapter in its own file. Each gets its own `mkdtemp` directory, matching the
 * isolation convention the acceptance suite already uses.
 */

const NOW = new Date('2026-07-27T00:00:00.000Z');
const dirs: string[] = [];

function corpusDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-tasks-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function taskYaml(id: string): string {
  return [
    `id: ${id}`,
    'category: technical',
    'question: What was the reported revenue for the year?',
    'asOf: 2026-01-10',
    'reverifiedAt: 2026-07-01',
    'goldFacts:',
    '  - id: revenue',
    '    kind: number',
    '    value: 1200000000',
    '    unit: USD',
    '    tolerance:',
    '      kind: exact',
    '    source:',
    '      url: https://example.gov/report',
    '',
  ].join('\n');
}

function write(dir: string, rel: string, text: string): void {
  const path = join(dir, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

describe('TASKFMT-26 reading a corpus directory', () => {
  it('finds tasks in subdirectories, which a flat walk would silently ignore', () => {
    const dir = corpusDir();
    write(dir, 'technical/one.yaml', taskYaml('one'));
    write(dir, 'contested/deep/two.yml', taskYaml('two'));

    const { entries } = readTaskEntries(dir);
    expect(entries.map((e) => e.file)).toEqual(['contested/deep/two.yml', 'technical/one.yaml']);
  });

  it('names a non-task file rather than dropping it, so a mistyped extension is visible', () => {
    const dir = corpusDir();
    write(dir, 'one.yaml', taskYaml('one'));
    write(dir, 'two.yam', taskYaml('two'));
    write(dir, 'README.md', '# notes\n');

    const { entries, ignoredFiles } = readTaskEntries(dir);
    expect(entries).toHaveLength(1);
    expect(ignoredFiles).toEqual(['README.md', 'two.yam']);
  });

  it('skips dotfiles without listing them as suspicious', () => {
    const dir = corpusDir();
    write(dir, '.gitkeep', '');
    write(dir, 'one.yaml', taskYaml('one'));

    const { entries, ignoredFiles } = readTaskEntries(dir);
    expect(entries).toHaveLength(1);
    expect(ignoredFiles).toEqual([]);
  });

  it('returns a stable order, because directory order is not guaranteed', () => {
    const dir = corpusDir();
    for (const name of ['zeta', 'alpha', 'mid']) write(dir, `${name}.yaml`, taskYaml(name));

    const first = readTaskEntries(dir).entries.map((e) => e.file);
    const second = readTaskEntries(dir).entries.map((e) => e.file);
    expect(first).toEqual(['alpha.yaml', 'mid.yaml', 'zeta.yaml']);
    expect(second).toEqual(first);
  });

  it('carries the ignored files through onto the loaded corpus', () => {
    const dir = corpusDir();
    write(dir, 'one.yaml', taskYaml('one'));
    write(dir, 'notes.txt', 'scratch');

    const corpus = loadCorpusFromDirectory(dir, { now: NOW });
    expect(corpus.tasks).toHaveLength(1);
    expect(corpus.ignoredFiles).toEqual(['notes.txt']);
  });
});

describe('a symlink never takes the walk outside the corpus directory', () => {
  it('does not follow a linked file, even when it is named like a task', () => {
    const outside = corpusDir();
    writeFileSync(join(outside, 'secret.yaml'), 'id: not-a-task\n', 'utf8');
    const dir = corpusDir();
    write(dir, 'one.yaml', taskYaml('one'));
    symlinkSync(join(outside, 'secret.yaml'), join(dir, 'linked.yaml'));

    const { entries, ignoredFiles } = readTaskEntries(dir);
    expect(entries.map((e) => e.file)).toEqual(['one.yaml']);
    expect(ignoredFiles).toEqual(['linked.yaml']);
  });

  it('does not descend through a linked directory', () => {
    const outside = corpusDir();
    mkdirSync(join(outside, 'nested'), { recursive: true });
    writeFileSync(join(outside, 'nested', 'elsewhere.yaml'), 'id: not-a-task\n', 'utf8');
    const dir = corpusDir();
    write(dir, 'one.yaml', taskYaml('one'));
    symlinkSync(outside, join(dir, 'linkdir'));

    const { entries, ignoredFiles } = readTaskEntries(dir);
    expect(entries.map((e) => e.file)).toEqual(['one.yaml']);
    expect(ignoredFiles).toEqual(['linkdir']);
    expect(ignoredFiles.some((f) => f.includes('elsewhere'))).toBe(false);
  });

  it('reports a broken link rather than failing the whole load on it', () => {
    const dir = corpusDir();
    write(dir, 'one.yaml', taskYaml('one'));
    symlinkSync(join(dir, 'does-not-exist'), join(dir, 'dangling.yaml'));

    const { entries, ignoredFiles, failures } = readTaskEntries(dir);
    expect(entries).toHaveLength(1);
    expect(ignoredFiles).toEqual(['dangling.yaml']);
    expect(failures).toEqual([]);
  });
});

describe('TASKFMT-27 an adapter failure joins the loader failures', () => {
  it('refuses a file over the size limit, naming it and its size', () => {
    const dir = corpusDir();
    write(dir, 'huge.yaml', `# ${'x'.repeat(MAX_TASK_FILE_BYTES + 1)}\n`);

    try {
      loadCorpusFromDirectory(dir, { now: NOW });
      throw new Error('expected a TaskCorpusError');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(TaskCorpusError);
      const failure = (e as TaskCorpusError).failures[0];
      expect(failure?.file).toBe('huge.yaml');
      expect(failure?.issues[0]?.message).toMatch(/over the .* limit/);
    }
  });

  it('names an oversized file and a malformed file in one throw, not just the first', () => {
    const dir = corpusDir();
    write(dir, 'huge.yaml', `# ${'x'.repeat(MAX_TASK_FILE_BYTES + 1)}\n`);
    write(dir, 'broken.yaml', taskYaml('broken').replace('unit: USD', 'unit:'));
    write(dir, 'fine.yaml', taskYaml('fine'));

    try {
      loadCorpusFromDirectory(dir, { now: NOW });
      throw new Error('expected a TaskCorpusError');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(TaskCorpusError);
      const files = (e as TaskCorpusError).failures.map((f) => f.file);
      expect(files).toContain('huge.yaml');
      expect(files).toContain('broken.yaml');
      expect(files).toHaveLength(2);
    }
  });

  it('reports an unreadable directory rather than throwing a raw filesystem error', () => {
    const { failures } = readTaskEntries(join(corpusDir(), 'does-not-exist'));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.issues[0]?.message).toMatch(/directory/);
  });
});

describe('TASKFMT-28 an empty corpus directory', () => {
  it('loads as an empty corpus rather than failing', () => {
    const corpus = loadCorpusFromDirectory(corpusDir(), { now: NOW });
    expect(corpus.tasks).toEqual([]);
    expect(corpus.staleCount).toBe(0);
    expect(corpus.ignoredFiles).toEqual([]);
    expect(corpus.evaluatedAt).toBe('2026-07-27');
  });

  it('loads a directory holding only a placeholder as empty', () => {
    const dir = corpusDir();
    write(dir, '.gitkeep', '');
    expect(loadCorpusFromDirectory(dir, { now: NOW }).tasks).toEqual([]);
  });
});

describe('the shipped corpus directory', () => {
  it('holds nothing but its placeholder, because authoring the corpus is a separate item', () => {
    const shipped = new URL('../../tasks/', import.meta.url);
    const names = readdirSync(shipped);
    expect(names).toEqual(['.gitkeep']);
  });
});
