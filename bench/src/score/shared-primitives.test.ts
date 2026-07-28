import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../import-graph.js';
import { readNumbers, withinTolerance } from './numbers.js';
import { maskDateShapes } from './noise-shapes.js';
import { normaliseForSearch } from './confidence.js';
import { extractProse } from './prose.js';
import { SCALE_WORDS } from './units.js';
import { sourceIdentity } from './source-identity.js';
import { sourceIdentity as combineSourceIdentity } from '../combine/identity.js';
import {
  extractNumericMentions,
  MAGNITUDE_ATTACHED_EXCLUSIONS,
  SPACED_MAGNITUDES,
} from './due-weight/numbers.js';
import { normaliseForMatch } from './due-weight/text.js';

/**
 * BENCH-15: one implementation each, and the decisions where there could not be.
 *
 * Four primitives existed twice with different answers. Unifying them is only
 * half the deliverable; the other half is that the resolved vocabulary and the
 * resolved boundaries are **visible**, so the next reader meets a failing test
 * rather than a paragraph they can skim. That is what this file is.
 *
 * Source is read with comments stripped wherever a rule is being checked,
 * because several of these modules explain at length what they deliberately do
 * *not* do, and a check that could not tell an explanation from a call would
 * force the reason out of the file to keep the rule. `stripComments` is
 * `bench/src/import-graph.ts`'s, so there is one spelling of that too.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const BENCH_SRC = join(HERE, '..');

const raw = (relative: string): string => readFileSync(join(BENCH_SRC, relative), 'utf8');
const code = (relative: string): string => stripComments(raw(relative));

/** Every non-test source file under `bench/src`, so a sweep cannot miss a directory. */
function everySource(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...everySource(path));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** What the accuracy scorer reads, through the real path its caller uses. */
const accuracyValues = (text: string): number[] =>
  readNumbers(normaliseForSearch(extractProse(text))).flatMap((m) =>
    m.readings.map((r) => r.value),
  );

/** What the due-weight scorer reads, through the real path its caller uses. */
const dueWeightValues = (text: string): number[] =>
  extractNumericMentions(normaliseForMatch(text)).map((m) => m.value);

describe('one date mask (DUP-01)', () => {
  it('is the only place a date shape is written down', () => {
    // The pattern lives in `noise-shapes.ts` and nowhere else. Both readers
    // held their own until BENCH-15, and each missed exactly what the other
    // caught, which is what two implementations of one rule always come to.
    for (const file of ['score/numbers.ts', 'score/due-weight/numbers.ts']) {
      expect(`${file}: ${code(file)}`).not.toMatch(/\\d\{4\}/);
      expect(`${file}: ${code(file)}`).toMatch(/from '\.\.?\/(?:\.\.\/)?noise-shapes\.js'/);
    }
  });

  it('is reached by both readers, so neither can drift from it', () => {
    // Behavioural rather than textual: mask a shape only one author ever
    // masked, and both readers must now agree it states no figure.
    expect(maskDateShapes('2026-07')).toBe('#######');
    expect(accuracyValues('2026-07')).toEqual([]);
    expect(dueWeightValues('2026-07')).toEqual([]);
  });
});

describe('the two readers now answer the divergence table identically (DUP-05)', () => {
  // Every row is from the brief's measured table. The third column was the
  // accuracy scorer's answer before this item and it was the wrong one: a gold
  // value within tolerance of 26 or 30 was recoverable from a date.
  const rows: readonly { readonly input: string; readonly wasAccuracy: number[] }[] = [
    { input: '03/04/26', wasAccuracy: [3, 4, 26] },
    { input: '2026-07', wasAccuracy: [2026, 7] },
    { input: '10:30:00', wasAccuracy: [10, 30, 0] },
    { input: 'JULY 8, 2026', wasAccuracy: [] },
    { input: 'July  8,  2026', wasAccuracy: [] },
  ];

  it('yields no figure from any of them, on either side', () => {
    for (const row of rows) {
      expect(accuracyValues(row.input), row.input).toEqual([]);
      expect(dueWeightValues(row.input), row.input).toEqual([]);
    }
    // The row that made this urgent, spelled out: two of those old readings
    // are values a gold fact really carries.
    expect(rows.flatMap((r) => r.wasAccuracy)).toContain(26);
    expect(rows.flatMap((r) => r.wasAccuracy)).toContain(30);
  });

  it('still reads a real figure that merely sits beside a date', () => {
    // The union widens the mask, and a wider mask is a false-negative machine.
    // Both directions are asserted, on both sides.
    expect(accuracyValues('filed 03/04/26 with 12 items')).toEqual([12]);
    expect(dueWeightValues('filed 03/04/26 with 12 items')).toEqual([12]);
    expect(accuracyValues('as of 2026-07-27T10:30:00Z the count was 12')).toEqual([12]);
    expect(dueWeightValues('as of 2026-07-27T10:30:00Z the count was 12')).toEqual([12]);
  });
});

describe('the mask fill is not whitespace, and that moved a score (DUP-03)', () => {
  it('no longer reads a magnitude word from the far side of a masked date', () => {
    // Measured against the pre-change code, which filled with spaces: the
    // scale-word probe in `readNumbers` skips whitespace looking for the
    // magnitude attached to a figure, so it skipped the whole masked date and
    // read `1.2` as one point two billion. The report wrote neither.
    expect(accuracyValues('revenue was 1.2 2026-07-27 billion')).toEqual([1.2]);
    expect(dueWeightValues('revenue was 1.2 2026-07-27 billion')).toEqual([1.2]);
  });

  it('still reads a magnitude word that really is attached to its figure', () => {
    expect(accuracyValues('revenue was 1.2 billion')).toContain(1200000000);
    expect(dueWeightValues('revenue was 1.2 billion')).toEqual([1200000000]);
  });
});

describe('one magnitude vocabulary, and one place it is written (DUP-06)', () => {
  it('is exactly this, by name', () => {
    // The brief's acceptance criterion, literally: the resolved set is visible
    // rather than implied. BENCH-04's table was already the union plus `mm`;
    // BENCH-05's lacked every plural, which was a live false negative.
    expect([...SCALE_WORDS.entries()].sort((a, b) => a[0].localeCompare(b[0]))).toEqual([
      ['b', 9],
      ['billion', 9],
      ['billions', 9],
      ['bn', 9],
      ['k', 3],
      ['m', 6],
      ['million', 6],
      ['millions', 6],
      ['mm', 6],
      ['mn', 6],
      ['t', 12],
      ['thousand', 3],
      ['thousands', 3],
      ['tn', 12],
      ['trillion', 12],
      ['trillions', 12],
    ]);
  });

  it('is not written down a second time in the due-weight reader', () => {
    const source = code('score/due-weight/numbers.ts');
    expect(source).not.toMatch(/MAGNITUDE_PLACES/);
    // No exponent table of any spelling: a magnitude word beside a number is
    // how the deleted one was written, and how a replacement would be.
    expect(source).not.toMatch(/\b(?:thousand|million|billion|trillion)\s*:\s*\d/);
    expect(source).toMatch(/import \{ SCALE_WORDS \} from '\.\.\/units\.js'/);
  });

  it('names the one word the two scorers refuse to share, and why', () => {
    // Where they genuinely disagree the decision is recorded rather than split.
    // Accuracy has a unit model and reads an ambiguous suffix both ways at no
    // cost; due-weight has one reading and no unit, and its own header states
    // the opposite error preference.
    expect([...MAGNITUDE_ATTACHED_EXCLUSIONS]).toEqual(['mm']);
    expect(SCALE_WORDS.has('mm')).toBe(true);

    expect(accuracyValues('a 5mm gap')).toEqual([5000000, 5]);
    expect(dueWeightValues('a 5mm gap')).toEqual([]);
  });

  it('names which spellings may sit after a space, on the side that has to choose', () => {
    expect([...SPACED_MAGNITUDES].sort((a, b) => a.localeCompare(b))).toEqual([
      'billion',
      'billions',
      'bn',
      'million',
      'millions',
      'mn',
      'thousand',
      'thousands',
      'tn',
      'trillion',
      'trillions',
    ]);
    // The asymmetry the sets encode. `$1.2 bn` names no unit and is a
    // magnitude; `5 m` is metres far more often than five million, and this
    // scorer cannot say which, so it declines to guess.
    expect(dueWeightValues('about 1.2 bn')).toEqual([1200000000]);
    expect(dueWeightValues('about 5 m')).toEqual([5]);
    // Accuracy reads the same `5 m` both ways and lets the gold unit decide.
    expect(accuracyValues('about 5 m')).toEqual([5000000, 5]);
  });

  it('closes the plural gap that was the live false negative on this row', () => {
    // Before this item the due-weight reader dropped the magnitude entirely and
    // reported 1.2 against a gold of 1,200,000.
    expect(dueWeightValues('a 1.2 millions figure')).toEqual([1200000]);
    expect(accuracyValues('a 1.2 millions figure')).toContain(1200000);
  });
});

describe('one tolerance comparator (DUP-07)', () => {
  it('leaves no second implementation anywhere in bench/src', async () => {
    // Two checks, because neither is enough alone. The export is gone from the
    // module that held it, and nothing anywhere still calls or declares it.
    //
    // Matched as a call or a declaration rather than as a bare word, on
    // purpose: `stripComments` cannot see a regular-expression literal, so a
    // file holding one with a quote inside it (`due-weight/numbers.ts` has
    // `/[\s([{<"']/u`) leaks its later comments into the stripped text. That is
    // the safe direction, since it can only ever produce a false positive, but
    // a check written as a bare word would have fired on this module's own
    // comment explaining what was removed.
    const module_ = await import('./due-weight/numbers.js');
    expect(Object.keys(module_)).not.toContain('matchesTolerance');
    for (const file of everySource(BENCH_SRC)) {
      const source = stripComments(readFileSync(file, 'utf8'));
      expect(`${file}: ${source}`).not.toMatch(
        /(?:function|const|let|export)\s+matchesTolerance|\bmatchesTolerance\s*\(/,
      );
    }
  });

  it('answers the four arms the way the deleted copy did, including a zero gold', () => {
    expect(withinTolerance(100, 100, { kind: 'exact' })).toBe(true);
    expect(withinTolerance(100.5, 100, { kind: 'absolute', value: 0.5 })).toBe(true);
    expect(withinTolerance(101, 100, { kind: 'relative', fraction: 0.01 })).toBe(true);
    expect(withinTolerance(1234567, 1230000, { kind: 'significantFigures', digits: 3 })).toBe(true);
    // The one place the two spellings could have diverged: the deleted copy
    // short-circuited a zero before calling `toPrecision`.
    expect(withinTolerance(0, 0, { kind: 'significantFigures', digits: 3 })).toBe(true);
    expect(withinTolerance(0, 1e-13, { kind: 'exact' })).toBe(false);
  });
});

describe('one scheme fold, and a boundary it deliberately does not cross (DUP-08, DUP-09)', () => {
  it('is one function, reached from both callers', () => {
    expect(combineSourceIdentity).toBe(sourceIdentity);
    expect(sourceIdentity('http://www.example.org/a/?utm_source=x#frag')).toBe(
      'https://example.org/a',
    );
    expect(sourceIdentity('https://example.org/a')).toBe('https://example.org/a');
  });

  it('is written in exactly one file', () => {
    const writers = everySource(BENCH_SRC).filter((file) =>
      /\.replace\(\s*\/\^http/.test(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(writers.map((f) => f.slice(BENCH_SRC.length + 1))).toEqual(['score/source-identity.ts']);
  });

  it('is applied by the two modules asking whether two citations name one document', () => {
    expect(code('combine/identity.ts')).toMatch(/sourceIdentity/);
    expect(code('score/due-weight/index.ts')).toMatch(/sourceIdentity/);
  });

  it('is NOT applied by the three modules asking the product independent-source question', () => {
    // A decision, not an oversight. Two of these hand their canonical list to
    // the product's own `assessSupport`, which is the rule the whole product
    // turns on, and folding here would make the benchmark's count diverge from
    // the number the product computes. Registrable-domain counts are unaffected
    // either way, since both schemes fold to one domain.
    for (const file of [
      'score/source-quality.ts',
      'score/citations.ts',
      'score/matrix.ts',
    ]) {
      expect(`${file}: ${code(file)}`).not.toMatch(/sourceIdentity/);
      expect(`${file}: ${code(file)}`).toMatch(/canonicaliseUrl/);
    }
  });
});

describe('the two containments are not duplicates, and each says so (DUP-11)', () => {
  it('names the other, its object and why they cannot merge', () => {
    const token = raw('score/containment.ts');
    const shingle = raw('score/syndication.ts');
    expect(token).toMatch(/shingleContainment/);
    expect(token).toMatch(/must not be merged/);
    expect(shingle).toMatch(/tokenContainment/);
    expect(shingle).toMatch(/must not be merged/);
  });

  it('is still two different signatures at the barrel', async () => {
    const barrel = await import('./index.js');
    expect(typeof barrel.tokenContainment).toBe('function');
    expect(typeof barrel.shingleContainment).toBe('function');
    expect(barrel.tokenContainment).not.toBe(barrel.shingleContainment);
  });
});
