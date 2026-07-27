import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STALE_AFTER_DAYS } from './schema.js';
import { loadCorpus, TaskCorpusError, YAML_OPTIONS, type TaskFileEntry } from './corpus.js';

/**
 * The loader, driven entirely from strings.
 *
 * Every test here builds YAML inline and never opens a file, which is the point:
 * a scorer must be testable without a filesystem, so the loader has to be usable
 * without one. `files.test.ts` is the only place that touches a disk.
 */

const NOW = new Date('2026-07-27T00:00:00.000Z');

/** `n` whole UTC days before the reference date, as `YYYY-MM-DD`. */
function daysBefore(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);
}

const NUMBER_FACT = [
  '  - id: revenue',
  '    kind: number',
  '    value: 1200000000',
  '    unit: USD',
  '    tolerance:',
  '      kind: significantFigures',
  '      digits: 3',
  '    source:',
  '      url: https://example.gov/report',
].join('\n');

/** An identifier fact whose value is written exactly as the caller passes it. */
function identifierFact(value: string): string {
  return [
    '  - id: version',
    '    kind: identifier',
    `    value: ${value}`,
    '    source:',
    '      url: https://example.gov/report',
  ].join('\n');
}

function yaml(over: Partial<Record<string, string>> = {}): string {
  const id = over['id'] ?? 'acme-fy25-revenue';
  const reverifiedAt = over['reverifiedAt'] ?? daysBefore(10);
  const facts = over['facts'] ?? NUMBER_FACT;
  return [
    `id: ${id}`,
    'category: technical',
    'question: What was the reported revenue for the year?',
    'asOf: 2026-01-10',
    `reverifiedAt: ${reverifiedAt}`,
    'goldFacts:',
    facts,
    '',
  ].join('\n');
}

const entry = (file: string, text: string): TaskFileEntry => ({ file, text });

describe('TASKFMT-01 and TASKFMT-22 the loader is pure and needs no filesystem', () => {
  it('loads a corpus from strings alone', () => {
    const corpus = loadCorpus([entry('technical/acme.yaml', yaml())], { now: NOW });
    expect(corpus.tasks).toHaveLength(1);
    expect(corpus.tasks[0]?.id).toBe('acme-fy25-revenue');
    expect(corpus.tasks[0]?.file).toBe('technical/acme.yaml');
    expect(corpus.tasks[0]?.goldFacts[0]?.kind).toBe('number');
  });

  /**
   * Any way a module can reach the filesystem, not just the static import.
   *
   * The first version of this check tested one quoted form and would have gone
   * on passing after somebody added `await import('node:fs/promises')`, which
   * makes it a check that reads as enforcement and is not.
   */
  const FS_REACH =
    /(?:from|import|require)\s*\(?\s*['"](?:node:)?fs(?:\/promises)?['"]|createRequire/;

  it('imports nothing from the filesystem, so purity is structural rather than promised', () => {
    const source = readFileSync(new URL('./corpus.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(FS_REACH);
  });

  it('would catch a filesystem import added later, in any of its forms', () => {
    for (const smuggled of [
      "import { readFileSync } from 'node:fs';",
      'import { readFileSync } from "node:fs";',
      "import { readFile } from 'node:fs/promises';",
      "void import('node:fs/promises');",
      "const fs = require('fs');",
      "import { createRequire } from 'node:module';",
    ]) {
      expect(smuggled).toMatch(FS_REACH);
    }
  });

  it('loads an empty corpus rather than failing on one', () => {
    const corpus = loadCorpus([], { now: NOW });
    expect(corpus.tasks).toEqual([]);
    expect(corpus.staleCount).toBe(0);
  });
});

describe('TASKFMT-02 and TASKFMT-03 a malformed file is fatal and every one is named', () => {
  it('throws naming the file and the failing field path', () => {
    const broken = yaml().replace('unit: USD', 'unit:');
    let thrown: unknown;
    try {
      loadCorpus([entry('technical/acme.yaml', broken)], { now: NOW });
    } catch (e: unknown) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TaskCorpusError);
    const error = thrown as TaskCorpusError;
    expect(error.failures).toHaveLength(1);
    expect(error.failures[0]?.file).toBe('technical/acme.yaml');
    expect(error.failures[0]?.issues[0]?.path).toBe('goldFacts.0.unit');
    expect(error.message).toContain('technical/acme.yaml');
  });

  it('never silently skips: one bad file stops the whole corpus', () => {
    const good = yaml({ id: 'good-task' });
    const bad = yaml({ id: 'bad-task' }).replace('kind: number', 'kind: numbre');
    expect(() =>
      loadCorpus([entry('a.yaml', good), entry('b.yaml', bad)], { now: NOW }),
    ).toThrow(TaskCorpusError);
  });

  it('reports every bad file in one throw, not just the first', () => {
    const first = yaml({ id: 'first' }).replace('unit: USD', 'unit:');
    const second = yaml({ id: 'second' }).replace('category: technical', 'category: made-up');
    const third = yaml({ id: 'third' });
    try {
      loadCorpus(
        [entry('one.yaml', first), entry('two.yaml', second), entry('three.yaml', third)],
        { now: NOW },
      );
      throw new Error('expected a TaskCorpusError');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(TaskCorpusError);
      const failures = (e as TaskCorpusError).failures;
      expect(failures.map((f) => f.file)).toEqual(['one.yaml', 'two.yaml']);
      expect((e as TaskCorpusError).message).toContain('2 task file(s)');
    }
  });
});

describe('TASKFMT-25 a file that is not a task document', () => {
  it('rejects an empty file, naming it', () => {
    try {
      loadCorpus([entry('empty.yaml', '')], { now: NOW });
      throw new Error('expected a TaskCorpusError');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(TaskCorpusError);
      expect((e as TaskCorpusError).failures[0]?.file).toBe('empty.yaml');
    }
  });

  it('rejects a comment-only file', () => {
    expect(() => loadCorpus([entry('notes.yaml', '# nothing here yet\n')], { now: NOW })).toThrow(
      TaskCorpusError,
    );
  });

  it('rejects a bare scalar document', () => {
    expect(() => loadCorpus([entry('scalar.yaml', 'just a sentence\n')], { now: NOW })).toThrow(
      TaskCorpusError,
    );
  });

  it('rejects duplicate keys inside one file', () => {
    const dup = `${yaml()}category: technical\n`;
    try {
      loadCorpus([entry('dup.yaml', dup)], { now: NOW });
      throw new Error('expected a TaskCorpusError');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(TaskCorpusError);
      expect((e as TaskCorpusError).failures[0]?.issues[0]?.message).toMatch(/unique/i);
    }
  });

  it('rejects a syntax error, carrying the parser message', () => {
    try {
      loadCorpus([entry('broken.yaml', 'id: [1, 2\ncategory: technical\n')], { now: NOW });
      throw new Error('expected a TaskCorpusError');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(TaskCorpusError);
      expect((e as TaskCorpusError).failures[0]?.issues[0]?.path).toBe('');
    }
  });
});

describe('TASKFMT-11 two files must not claim one task id', () => {
  it('fails the load and names both files', () => {
    try {
      loadCorpus([entry('a.yaml', yaml()), entry('b.yaml', yaml())], { now: NOW });
      throw new Error('expected a TaskCorpusError');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(TaskCorpusError);
      const failure = (e as TaskCorpusError).failures[0];
      expect(failure?.file).toBe('b.yaml');
      expect(failure?.issues[0]?.message).toContain('a.yaml');
    }
  });
});

describe('TASKFMT-08 and TASKFMT-09 staleness', () => {
  it('is false one day inside the horizon, true on it, and true past it', () => {
    const inside = loadCorpus([entry('a.yaml', yaml({ reverifiedAt: daysBefore(182) }))], {
      now: NOW,
    });
    expect(inside.tasks[0]?.stale).toBe(false);
    expect(inside.tasks[0]?.reverifiedAgeDays).toBe(182);

    const onIt = loadCorpus([entry('a.yaml', yaml({ reverifiedAt: daysBefore(183) }))], {
      now: NOW,
    });
    expect(onIt.tasks[0]?.stale).toBe(true);

    const past = loadCorpus([entry('a.yaml', yaml({ reverifiedAt: daysBefore(184) }))], {
      now: NOW,
    });
    expect(past.tasks[0]?.stale).toBe(true);
  });

  it('does not change with the time of day, which naive rounding gets wrong', () => {
    // 182 whole days before 27 July. Rounding (now - at) / DAY on a midday
    // reference gives 182.5, which rounds to 183 and marks this stale a day
    // early. Whole UTC days give 182 whatever the clock says.
    const text = yaml({ reverifiedAt: daysBefore(182) });
    for (const time of ['00:00:00.000Z', '12:00:00.000Z', '23:59:59.999Z']) {
      const corpus = loadCorpus([entry('a.yaml', text)], {
        now: new Date(`2026-07-27T${time}`),
      });
      expect(corpus.tasks[0]?.reverifiedAgeDays).toBe(182);
      expect(corpus.tasks[0]?.stale).toBe(false);
    }
  });

  it('surfaces the count, the ids and the horizon it used', () => {
    const corpus = loadCorpus(
      [
        entry('a.yaml', yaml({ id: 'fresh-one', reverifiedAt: daysBefore(5) })),
        entry('b.yaml', yaml({ id: 'stale-one', reverifiedAt: daysBefore(400) })),
        entry('c.yaml', yaml({ id: 'stale-two', reverifiedAt: daysBefore(200) })),
      ],
      { now: NOW },
    );
    expect(corpus.staleCount).toBe(2);
    expect(corpus.staleIds).toEqual(['stale-one', 'stale-two']);
    expect(corpus.staleAfterDays).toBe(STALE_AFTER_DAYS);
    expect(corpus.evaluatedAt).toBe('2026-07-27');
  });
});

describe('TASKFMT-21 the reference date comes from the caller', () => {
  it('produces an identical corpus twice', () => {
    const entries = [entry('a.yaml', yaml())];
    const first = loadCorpus(entries, { now: NOW });
    const second = loadCorpus(entries, { now: NOW });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('changes its answer only when the caller changes the date', () => {
    const text = yaml({ reverifiedAt: daysBefore(182) });
    const atNow = loadCorpus([entry('a.yaml', text)], { now: NOW });
    const aYearLater = loadCorpus([entry('a.yaml', text)], {
      now: new Date('2027-07-27T00:00:00.000Z'),
    });
    expect(atNow.tasks[0]?.stale).toBe(false);
    expect(aYearLater.tasks[0]?.stale).toBe(true);
  });

  it('reads no clock: a task re-verified today is not future-dated at a later reference date', () => {
    const corpus = loadCorpus([entry('a.yaml', yaml({ reverifiedAt: '2026-07-27' }))], {
      now: NOW,
    });
    expect(corpus.tasks[0]?.reverifiedAgeDays).toBe(0);
  });
});

describe('TASKFMT-23 and TASKFMT-24 the YAML version is pinned', () => {
  it('leaves dates as strings rather than turning them into timestamps', () => {
    const corpus = loadCorpus([entry('a.yaml', yaml())], { now: NOW });
    expect(corpus.tasks[0]?.asOf).toBe('2026-01-10');
    expect(typeof corpus.tasks[0]?.asOf).toBe('string');
  });

  it('leaves NO, ON and yes as strings, which YAML 1.1 would turn into booleans', () => {
    const text = yaml().replace(
      'goldFacts:',
      'requiredTerms: [NO, ON, yes]\ngoldFacts:',
    );
    const corpus = loadCorpus([entry('a.yaml', text)], { now: NOW });
    expect(corpus.tasks[0]?.requiredTerms).toEqual(['NO', 'ON', 'yes']);
  });

  it('rejects an unquoted version-like identifier rather than scoring against 1.2', () => {
    const text = yaml({ facts: identifierFact('1.20') });
    try {
      loadCorpus([entry('a.yaml', text)], { now: NOW });
      throw new Error('expected a TaskCorpusError');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(TaskCorpusError);
      const issue = (e as TaskCorpusError).failures[0]?.issues[0];
      expect(issue?.path).toBe('goldFacts.0.value');
      expect(issue?.message).toMatch(/string/i);
    }
  });

  it('rejects an unquoted leading-zero identifier, which arrives as a number', () => {
    const text = yaml({ facts: identifierFact('0755') });
    expect(() => loadCorpus([entry('a.yaml', text)], { now: NOW })).toThrow(TaskCorpusError);
  });

  it('accepts the same values once quoted', () => {
    const corpus = loadCorpus([entry('a.yaml', yaml({ facts: identifierFact("'1.20'") }))], {
      now: NOW,
    });
    expect(corpus.tasks[0]?.goldFacts[0]?.value).toBe('1.20');
  });
});

describe('the pinned YAML options are a lock, not a comment', () => {
  it('states the exact version and schema the format depends on', () => {
    expect(YAML_OPTIONS).toEqual({ version: '1.2', schema: 'core' });
  });
});

describe('an invalid reference date is refused rather than silently ignored', () => {
  it('refuses it even for an empty corpus, which never reaches the schema', () => {
    expect(() => loadCorpus([], { now: new Date('not a date') })).toThrow(TypeError);
  });

  it('refuses it for a real corpus too', () => {
    expect(() => loadCorpus([entry('a.yaml', yaml())], { now: new Date(NaN) })).toThrow(TypeError);
  });
});

describe('TASKFMT-20 each task reports which measures it can support', () => {
  it('marks a plain factual task accuracy-and-calibration eligible and nothing else', () => {
    const corpus = loadCorpus([entry('a.yaml', yaml())], { now: NOW });
    expect(corpus.tasks[0]?.applicableMetrics).toEqual({
      accuracy: true,
      relevance: false,
      calibration: true,
      dissentRecall: false,
      conflictAcknowledgement: false,
      falseBalance: false,
      refusal: false,
      enumerationCompleteness: false,
    });
  });

  it('marks a refusal task refusal-only, so accuracy is never scored 0 over no facts', () => {
    const text = [
      'id: nonexistent-merger',
      'category: false-premise',
      'question: What were the terms of the 2025 Acme and Globex merger?',
      'asOf: 2026-01-10',
      `reverifiedAt: ${daysBefore(5)}`,
      'expectedRefusal:',
      '  kind: false-premise',
      '  fabricatedTerms:',
      '    - Acme Globex merger',
      '  acknowledgementTerms:',
      '    - no such merger',
      '',
    ].join('\n');
    const corpus = loadCorpus([entry('a.yaml', text)], { now: NOW });
    const metrics = corpus.tasks[0]?.applicableMetrics;
    expect(metrics?.refusal).toBe(true);
    expect(metrics?.accuracy).toBe(false);
    expect(metrics?.calibration).toBe(false);
  });

  it('marks enumeration completeness eligible only for a task that declares a grid', () => {
    const text = [
      'id: founding-dates',
      'category: enumeration',
      'question: When were each of these companies founded?',
      'asOf: 2026-01-10',
      `reverifiedAt: ${daysBefore(5)}`,
      'enumeration:',
      '  entities: [acme, globex]',
      '  fields: [founded]',
      '  unknownCells:',
      '    - { entity: globex, field: founded }',
      'goldFacts:',
      '  - id: acme-founded',
      '    kind: date',
      "    value: '1998-04-01'",
      '    cell: { entity: acme, field: founded }',
      '    source:',
      '      url: https://example.gov/report',
      '',
    ].join('\n');
    const corpus = loadCorpus([entry('a.yaml', text)], { now: NOW });
    expect(corpus.tasks[0]?.applicableMetrics.enumerationCompleteness).toBe(true);
    expect(loadCorpus([entry('b.yaml', yaml())], { now: NOW }).tasks[0]?.applicableMetrics
      .enumerationCompleteness).toBe(false);
  });

  it('marks relevance eligible only when the task recorded required terms', () => {
    const text = yaml().replace('goldFacts:', 'requiredTerms: [revenue]\ngoldFacts:');
    const corpus = loadCorpus([entry('a.yaml', text)], { now: NOW });
    expect(corpus.tasks[0]?.applicableMetrics.relevance).toBe(true);
  });
});
