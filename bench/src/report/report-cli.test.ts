import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appendCell } from '../run/store.js';
import { evidencePath, writeEvidence } from '../citations/store.js';
import { emptyEvidence } from '../citations/evidence.js';
import { parseArgs, renderFromDisk } from './cli.js';
import { cell } from './fixtures.js';

const roots: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-report-'));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const TASK_YAML = (id: string, category: string): string =>
  [
    `id: ${id}`,
    `category: ${category}`,
    `question: what was the recorded figure for ${id}, and when was it published`,
    'asOf: "2026-07-01"',
    'reverifiedAt: "2026-07-01"',
    'goldFacts:',
    '  - id: f1',
    '    kind: name',
    '    value: containerd',
    '    source:',
    '      url: https://example.test/a',
    'requiredTerms:',
    '  - containerd',
  ].join('\n');

const REPORT = [
  '# Findings',
  '',
  'The component is containerd, as the advisory states. [source](https://example.test/a)',
].join('\n');

/** A store on disk holding one corpus, one cell file and one report. */
function scaffold(options: { readonly outcome?: 'ok' | 'failed' } = {}) {
  const root = temp();
  const tasksDir = join(root, 'tasks', 'technical');
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, 't1.yaml'), TASK_YAML('t1', 'technical'), 'utf8');

  const cellsPath = join(root, 'results', 'cells.jsonl');
  const record = cell('t1', 'gemini', 1, options.outcome === 'failed' ? { outcome: 'failed' } : {});
  appendCell(cellsPath, record);

  const storeDir = join(root, 'store');
  if (record.outcome === 'ok') {
    mkdirSync(join(storeDir, 'reports'), { recursive: true });
    writeFileSync(join(storeDir, record.reportPath), REPORT, 'utf8');
  }

  const evidenceDir = join(root, 'evidence');
  return { root, tasksDir: join(root, 'tasks'), cellsPath, storeDir, evidenceDir, record };
}

function args(overrides: Partial<ReturnType<typeof parseArgs>>): ReturnType<typeof parseArgs> {
  return {
    cellsPath: '',
    tasksDir: '',
    storeDir: '',
    evidenceDir: '',
    minTasksPerCategory: undefined,
    format: 'markdown',
    asOf: '2026-07-27',
    ...overrides,
  };
}

describe('REPORT-26 the flags are refused rather than ignored', () => {
  it('refuses an unknown flag', () => {
    expect(() => parseArgs(['--min-taks', '3'])).toThrow(/Unknown flag "--min-taks"/);
  });

  it('refuses a bare argument', () => {
    expect(() => parseArgs(['cells.jsonl'])).toThrow(/Unexpected argument/);
  });

  it('refuses a flag with no value', () => {
    expect(() => parseArgs(['--cells'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--cells', '--format'])).toThrow(/needs a value/);
  });

  it('refuses a format it cannot render', () => {
    expect(() => parseArgs(['--format', 'html'])).toThrow(/markdown or json/);
  });

  it('refuses a date of the wrong shape and a date that does not exist', () => {
    expect(() => parseArgs(['--as-of', '2026-7-1'])).toThrow(/YYYY-MM-DD/);
    expect(() => parseArgs(['--as-of', '2026-02-31'])).toThrow(/YYYY-MM-DD/);
    expect(parseArgs(['--as-of', '2026-02-28']).asOf).toBe('2026-02-28');
  });

  it('refuses a nonsense task floor', () => {
    expect(() => parseArgs(['--min-tasks', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--min-tasks', 'five'])).toThrow(/positive integer/);
    expect(parseArgs(['--min-tasks', '3']).minTasksPerCategory).toBe(3);
  });

  it('accepts the inline form, because a caller who types it and is ignored gets the wrong report', () => {
    expect(parseArgs(['--format=json']).format).toBe('json');
  });

  it('defaults the as-of date to today rather than leaving staleness undefined', () => {
    expect(parseArgs([]).asOf).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe('REPORT-27 the CLI renders end to end from a real store', () => {
  it('reads the corpus, the cells and the report, and renders markdown', () => {
    const s = scaffold();
    const markdown = renderFromDisk({
      args: args({
        cellsPath: s.cellsPath,
        tasksDir: s.tasksDir,
        storeDir: s.storeDir,
        evidenceDir: s.evidenceDir,
      }),
      log: () => undefined,
    });
    expect(markdown).toContain('# Benchmark report');
    expect(markdown).toContain('**Corpus** 1 tasks');
    expect(markdown).toMatch(/\| gemini \| 1 \| 1 \| 100\.0% \(1\/1\)/);
    // One task in one category is far below the floor, so nothing is scored.
    expect(markdown).toMatch(/Under-sampled and therefore unscored:\*\* technical \(1 task\)/);
    expect(markdown).toMatch(/\*\*No ranking is stated\.\*\*/);
  });

  it('renders json carrying the same aggregate', () => {
    const s = scaffold();
    const json: unknown = JSON.parse(
      renderFromDisk({
        args: args({
          cellsPath: s.cellsPath,
          tasksDir: s.tasksDir,
          storeDir: s.storeDir,
          evidenceDir: s.evidenceDir,
          format: 'json',
        }),
        log: () => undefined,
      }),
    );
    expect(json).toMatchObject({ aggregate: { corpus: { tasks: 1 }, providers: ['gemini'] } });
  });

  it('measures staleness against the as-of date the caller gave, not the clock', () => {
    const s = scaffold();
    const fresh = renderFromDisk({
      args: args({
        cellsPath: s.cellsPath,
        tasksDir: s.tasksDir,
        storeDir: s.storeDir,
        evidenceDir: s.evidenceDir,
        asOf: '2026-07-27',
      }),
      log: () => undefined,
    });
    const later = renderFromDisk({
      args: args({
        cellsPath: s.cellsPath,
        tasksDir: s.tasksDir,
        storeDir: s.storeDir,
        evidenceDir: s.evidenceDir,
        asOf: '2027-07-27',
      }),
      log: () => undefined,
    });
    expect(fresh).toMatch(/\*\*0 of 1 tasks are stale\*\*/);
    expect(later).toMatch(/\*\*1 of 1 tasks are stale\*\*/);
  });

  it('renders byte-identically twice from the same store', () => {
    const s = scaffold();
    const call = () =>
      renderFromDisk({
        args: args({
          cellsPath: s.cellsPath,
          tasksDir: s.tasksDir,
          storeDir: s.storeDir,
          evidenceDir: s.evidenceDir,
        }),
        log: () => undefined,
      });
    expect(call()).toBe(call());
  });
});

describe('REPORT-28 a missing report is a pipeline gap, not a backend failure', () => {
  it('names it as ours', () => {
    const s = scaffold();
    rmSync(join(s.storeDir, s.record.outcome === 'ok' ? s.record.reportPath : ''), { force: true });
    const markdown = renderFromDisk({
      args: args({
        cellsPath: s.cellsPath,
        tasksDir: s.tasksDir,
        storeDir: s.storeDir,
        evidenceDir: s.evidenceDir,
      }),
      log: () => undefined,
    });
    expect(markdown).toContain('### Gaps in this pipeline, not in the backends');
    expect(markdown).toContain('could not be read');
    // Still counted as a completed cell, because it was: the backend delivered.
    expect(markdown).toMatch(/100\.0% \(1\/1\)/);
  });

  it('keeps a failed cell as a failure rather than a gap', () => {
    const s = scaffold({ outcome: 'failed' });
    const markdown = renderFromDisk({
      args: args({
        cellsPath: s.cellsPath,
        tasksDir: s.tasksDir,
        storeDir: s.storeDir,
        evidenceDir: s.evidenceDir,
      }),
      log: () => undefined,
    });
    expect(markdown).toMatch(/0\.0% \(0\/1\)/);
    expect(markdown).not.toContain('### Gaps in this pipeline');
  });
});

describe('the store is read defensively', () => {
  it('warns about a torn line and renders the rest', () => {
    const s = scaffold();
    writeFileSync(s.cellsPath, `{"key":"broken"\n`, { flag: 'a' });
    const warnings: string[] = [];
    const markdown = renderFromDisk({
      args: args({
        cellsPath: s.cellsPath,
        tasksDir: s.tasksDir,
        storeDir: s.storeDir,
        evidenceDir: s.evidenceDir,
      }),
      log: (line) => warnings.push(line),
    });
    expect(warnings.join(' ')).toMatch(/could not be read and are not in this report/);
    expect(markdown).toContain('# Benchmark report');
  });

  it('names a cell whose task the corpus no longer holds', () => {
    const s = scaffold();
    appendCell(s.cellsPath, cell('vanished', 'gemini', 1));
    const markdown = renderFromDisk({
      args: args({
        cellsPath: s.cellsPath,
        tasksDir: s.tasksDir,
        storeDir: s.storeDir,
        evidenceDir: s.evidenceDir,
      }),
      log: () => undefined,
    });
    expect(markdown).toMatch(/name a task the corpus no longer holds/);
    expect(markdown).toContain('vanished/gemini/1');
  });

  it('renders a report from a store with no cells at all', () => {
    const s = scaffold();
    const markdown = renderFromDisk({
      args: args({
        cellsPath: join(s.root, 'results', 'nothing.jsonl'),
        tasksDir: s.tasksDir,
        storeDir: s.storeDir,
        evidenceDir: s.evidenceDir,
      }),
      log: () => undefined,
    });
    expect(markdown).toContain('_No cells recorded._');
  });
});

describe('an evidence snapshot collected from another report is not scored against', () => {
  it('treats a mismatched snapshot as no evidence rather than as numbers', () => {
    const s = scaffold();
    const snapshot = {
      ...emptyEvidence('2026-07-27T00:00:00.000Z'),
      // A digest of some other text. `live.ts` makes the same check for the
      // same reason: a snapshot from a different report produces a full set of
      // plausible numbers with nothing behind them.
      reportSha256: 'a'.repeat(64),
    };
    writeEvidence(s.evidenceDir, s.record.key, snapshot);
    const markdown = renderFromDisk({
      args: args({
        cellsPath: s.cellsPath,
        tasksDir: s.tasksDir,
        storeDir: s.storeDir,
        evidenceDir: s.evidenceDir,
      }),
      log: () => undefined,
    });
    expect(markdown).toMatch(/No identifier was checked against a registry/);
  });

  it('warns rather than crashing when a snapshot on disk is malformed', () => {
    const s = scaffold();
    mkdirSync(s.evidenceDir, { recursive: true });
    // Written straight to the path the reader will look at, so the parse fails
    // where a real corrupted snapshot would. One damaged snapshot must not
    // make the other 3,999 cells unreportable.
    writeFileSync(evidencePath(s.evidenceDir, s.record.key), '{not json', 'utf8');
    const warnings: string[] = [];
    const markdown = renderFromDisk({
      args: args({
        cellsPath: s.cellsPath,
        tasksDir: s.tasksDir,
        storeDir: s.storeDir,
        evidenceDir: s.evidenceDir,
      }),
      log: (line) => warnings.push(line),
    });
    expect(warnings.join(' ')).toMatch(/not valid JSON/);
    expect(markdown).toContain('# Benchmark report');
  });
});
