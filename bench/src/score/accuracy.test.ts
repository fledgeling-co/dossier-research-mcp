import { describe, expect, it } from 'vitest';
import { loadCorpusFromDirectory } from '../tasks/files.js';
import { GOLD_FACT_KINDS, type BenchTaskFile, type GoldFact } from '../tasks/schema.js';
import { scoreAccuracy, factRecovery } from './accuracy.js';
import { scoreCalibration } from './calibration.js';
import { toPlainString } from './numbers.js';

/**
 * A task carrying exactly the answers a case needs.
 *
 * Built as a literal rather than through the loader so a case states only what
 * it is about; the loader's own rules already have their own suite, and the
 * corpus test at the bottom exercises the real path.
 */
function task(facts: readonly GoldFact[], extra: Partial<BenchTaskFile> = {}): BenchTaskFile {
  return {
    id: 'case',
    category: 'technical',
    question: 'a question long enough to be valid',
    asOf: '2026-07-01',
    reverifiedAt: '2026-07-01',
    goldFacts: facts,
    requiredTerms: [],
    driftTerms: [],
    knownDissent: [],
    conflictingFigures: [],
    fringeClaims: [],
    ...extra,
  };
}

const number = (over: Partial<Extract<GoldFact, { kind: 'number' }>> = {}): GoldFact => ({
  id: 'f1',
  kind: 'number',
  value: 1_200_000_000,
  unit: 'USD',
  tolerance: { kind: 'exact' },
  source: { url: 'https://example.test/a' },
  ...over,
});

const scored = (report: string, t: BenchTaskFile) => {
  const result = scoreAccuracy(report, t);
  if (result.status !== 'scored') throw new Error(`expected a scored result, got ${result.status}`);
  return result;
};

const recovers = (report: string, fact: GoldFact): boolean =>
  scored(report, task([fact])).facts[0]?.recovered === true;

describe('one figure, many spellings (ACCREL-01)', () => {
  it.each([
    'Revenue reached 1.2 billion.',
    'Revenue reached 1,200,000,000.',
    'Revenue reached 1.2B.',
    'Revenue reached 1.2bn.',
    'Revenue reached $1.2B.',
    'Revenue reached USD 1.2 billion.',
    'Revenue reached 1.2 billion dollars.',
    'Revenue reached 1.2e9.',
    'Revenue reached $1,200,000,000.',
  ])('recovers the gold from %p', (report) => {
    expect(recovers(report, number())).toBe(true);
  });

  it('recovers a figure a multiplication would have missed', () => {
    // 1.005 * 1e6 is 1004999.9999999999, so a scorer that multiplied would
    // score this correct answer zero under an exact tolerance.
    expect(
      recovers('The count was 1.005 million.', number({ value: 1_005_000, unit: 'dimensionless' })),
    ).toBe(true);
  });
});

describe('the unit rule (ACCREL-02, ACCREL-03)', () => {
  it('scores zero for the right figure in a recognised wrong unit', () => {
    const fact = number({ value: 28.6, unit: 'percent' });
    expect(recovers('Share rose 28.6 percentage points.', fact)).toBe(false);
    expect(recovers('Share rose 28.6%.', fact)).toBe(true);
  });

  it('scores zero across two currencies', () => {
    const fact = number({ unit: 'USD' });
    expect(recovers('Revenue reached €1.2 billion.', fact)).toBe(false);
    expect(recovers('Revenue reached £1.2bn.', fact)).toBe(false);
    expect(recovers('Revenue reached $1.2 billion.', fact)).toBe(true);
  });

  it('treats dimensionless as a real unit rather than a wildcard', () => {
    const fact = number({ value: 42, unit: 'dimensionless' });
    expect(recovers('The answer is 42 percent.', fact)).toBe(false);
    expect(recovers('The answer is 42.', fact)).toBe(true);
  });

  it('gives no partial credit for a wrong unit', () => {
    const result = scored('Share rose 28.6 percentage points.', task([number({ value: 28.6, unit: 'percent' })]));
    expect(result.share).toBe(0);
    expect(result.recovered).toBe(0);
  });

  it('accepts a figure with no unit written beside it, and says so', () => {
    // The corpus really carries units like `CVSS v3.1 base score` that no report
    // will write out. Refusing those would be a false negative in the category
    // where false negatives are most expensive.
    const result = scored(
      'NVD assigned it 8.8.',
      task([number({ value: 8.8, unit: 'CVSS v3.1 base score' })]),
    );
    expect(result.facts[0]?.recovered).toBe(true);
    expect(result.facts[0]?.unitEvidence).toBe('unstated');
    expect(result.unitUnstated).toEqual(['f1']);
    expect(result.notes.join(' ')).toContain('weaker evidence');
  });

  it('prefers a stated unit over an unstated one when both appear', () => {
    const result = scored(
      'Somewhere 28.6 appears bare. Later, share rose 28.6%.',
      task([number({ value: 28.6, unit: 'percent' })]),
    );
    expect(result.facts[0]?.unitEvidence).toBe('stated');
  });
});

describe('a gold unit with its own scale word (ACCREL-04)', () => {
  it('folds the scale into the value', () => {
    const fact = number({ value: 1.2, unit: 'USD billions' });
    expect(recovers('Revenue reached $1.2bn.', fact)).toBe(true);
    expect(recovers('Revenue reached 1,200,000,000 dollars.', fact)).toBe(true);
  });
});

describe('citations are not prose (ACCREL-06)', () => {
  it.each([
    ['a link target', 'Revenue grew ([source](https://x.test/revenue-1200000000)).'],
    ['an autolink', 'Revenue grew <https://x.test/revenue-1200000000>.'],
    ['a bare URL', 'Revenue grew: https://x.test/revenue-1200000000'],
    ['a reference definition', 'Revenue grew [1].\n\n[1]: https://x.test/revenue-1200000000'],
    ['a cite tag', 'Revenue grew <cite url="https://x.test/revenue-1200000000">so</cite>.'],
  ])('does not recover a figure carried only by %s', (_name, report) => {
    expect(recovers(report, number({ unit: 'dimensionless' }))).toBe(false);
  });

  it('still recovers the same figure written in the prose', () => {
    expect(
      recovers(
        'Revenue reached 1,200,000,000 ([source](https://x.test/other)).',
        number({ unit: 'dimensionless' }),
      ),
    ).toBe(true);
  });
});

describe('negation (ACCREL-08)', () => {
  it('does not recover a value stated only inside a denial', () => {
    const result = scored('Revenue was not $1.2 billion.', task([number()]));
    expect(result.facts[0]?.recovered).toBe(false);
    expect(result.facts[0]?.negatedOnly).toBe(true);
    expect(result.negatedOnly).toEqual(['f1']);
    expect(result.notes.join(' ')).toContain('cue list');
  });

  it('recovers when the value is also stated plainly', () => {
    const result = scored(
      'Revenue was not $1.2 billion in 2024. In 2025 revenue reached $1.2 billion.',
      task([number()]),
    );
    expect(result.facts[0]?.recovered).toBe(true);
    expect(result.negatedOnly).toEqual([]);
  });

  it('can be turned off so its effect is measurable rather than argued about', () => {
    const result = scoreAccuracy('Revenue was not $1.2 billion.', task([number()]), {
      ignoreNegation: true,
    });
    expect(result.status).toBe('scored');
    if (result.status === 'scored') expect(result.recovered).toBe(1);
  });

  it('applies to names and dates too', () => {
    expect(
      recovers('The vendor was not Acme Corporation.', {
        id: 'f1',
        kind: 'name',
        value: 'Acme Corporation',
        aliases: [],
        source: { url: 'https://example.test/a' },
      }),
    ).toBe(false);
    expect(
      recovers('It was not published on 2026-07-08.', {
        id: 'f1',
        kind: 'date',
        value: '2026-07-08',
        source: { url: 'https://example.test/a' },
      }),
    ).toBe(false);
  });
});

describe('tolerance arms (ACCREL-09)', () => {
  it('accepts inside and rejects outside an absolute bound', () => {
    const fact = number({ value: 100, unit: 'dimensionless', tolerance: { kind: 'absolute', value: 0.5 } });
    expect(recovers('The figure was 100.5.', fact)).toBe(true);
    expect(recovers('The figure was 100.6.', fact)).toBe(false);
  });

  it('accepts inside and rejects outside a relative bound', () => {
    const fact = number({ value: 100, unit: 'dimensionless', tolerance: { kind: 'relative', fraction: 0.01 } });
    expect(recovers('The figure was 101.', fact)).toBe(true);
    expect(recovers('The figure was 102.', fact)).toBe(false);
  });

  it('rounds to significant figures', () => {
    const fact = number({
      value: 1_234_567,
      unit: 'dimensionless',
      tolerance: { kind: 'significantFigures', digits: 3 },
    });
    expect(recovers('About 1.23 million.', fact)).toBe(true);
    expect(recovers('About 1.24 million.', fact)).toBe(false);
  });

  it('notes a relative tolerance against a zero gold, which has no width', () => {
    const result = scored(
      'The figure was 0.',
      task([number({ value: 0, unit: 'dimensionless', tolerance: { kind: 'relative', fraction: 0.1 } })]),
    );
    expect(result.notes.join(' ')).toContain('no width');
  });
});

describe('names and identifiers (ACCREL-12)', () => {
  const name = (over: Partial<Extract<GoldFact, { kind: 'name' }>> = {}): GoldFact => ({
    id: 'f1',
    kind: 'name',
    value: 'Meta Platforms',
    aliases: [],
    source: { url: 'https://example.test/a' },
    ...over,
  });

  it('matches case-insensitively', () => {
    expect(recovers('meta platforms filed the report.', name())).toBe(true);
  });

  it('matches on word boundaries so a term does not hit inside a longer word', () => {
    expect(recovers('The metadata was incomplete.', name({ value: 'Meta' }))).toBe(false);
    expect(recovers('Meta filed the report.', name({ value: 'Meta' }))).toBe(true);
  });

  it('matches an alias and names which one', () => {
    const result = scored(
      'Meta filed the report.',
      task([name({ value: 'Meta Platforms, Inc.', aliases: ['Meta'] })]),
    );
    expect(result.facts[0]?.recovered).toBe(true);
    expect(result.facts[0]?.via).toBe('alias');
    expect(result.facts[0]?.alias).toBe('Meta');
  });

  it('matches an identifier and its aliases', () => {
    const fact: GoldFact = {
      id: 'f1',
      kind: 'identifier',
      value: 'CVE-2026-53488',
      aliases: ['cve-2026-53488'],
      source: { url: 'https://example.test/a' },
    };
    expect(recovers('The advisory is CVE-2026-53488.', fact)).toBe(true);
    expect(recovers('The advisory is CVE-2026-99999.', fact)).toBe(false);
  });

  it('normalises Unicode before comparing', () => {
    // Composed and decomposed spellings of one name are one name: a single
    // code point, and a plain letter followed by a combining diaeresis, are the
    // same word once NFKC has run.
    const composed = 'Zo\u00EB Systems';
    const decomposed = 'Zoe\u0308 Systems';
    expect(composed).not.toBe(decomposed);
    expect(recovers(`The vendor was ${decomposed}.`, name({ value: composed }))).toBe(true);
    expect(recovers(`The vendor was ${composed}.`, name({ value: decomposed }))).toBe(true);
  });

  it('does not fold a diacritic away, because that is a different name', () => {
    // This scorer does not pretend `Zoe` and `Zo\u00EB` are one string. An author
    // who wants both records the second as an alias, which is the field the task
    // format added for exactly this.
    expect(recovers('The vendor was Zoe Systems.', name({ value: 'Zo\u00EB Systems' }))).toBe(false);
    expect(
      recovers(
        'The vendor was Zoe Systems.',
        name({ value: 'Zo\u00EB Systems', aliases: ['Zoe Systems'] }),
      ),
    ).toBe(true);
  });});

describe('every answer kind is handled (ACCREL-13)', () => {
  it('covers the exported kind tuple exhaustively', () => {
    // A fifth kind added to the format fails here until it is handled, rather
    // than silently scoring zero for every task that uses it.
    const byKind: Record<string, GoldFact> = {
      number: number({ value: 5, unit: 'dimensionless' }),
      date: { id: 'f1', kind: 'date', value: '2026-07-08', source: { url: 'https://e.test/a' } },
      name: { id: 'f1', kind: 'name', value: 'Acme', aliases: [], source: { url: 'https://e.test/a' } },
      identifier: {
        id: 'f1',
        kind: 'identifier',
        value: 'ISO-9001',
        aliases: [],
        source: { url: 'https://e.test/a' },
      },
    };
    expect(Object.keys(byKind).sort()).toEqual([...GOLD_FACT_KINDS].sort());

    const report = 'The answer is 5, on 2026-07-08, from Acme, under ISO-9001.';
    for (const kind of GOLD_FACT_KINDS) {
      const fact = byKind[kind];
      expect(fact, `no case for kind "${kind}"`).toBeDefined();
      if (fact) expect(recovers(report, fact), `kind "${kind}"`).toBe(true);
    }
  });
});

describe('applicability (ACCREL-14)', () => {
  it('is not applicable when the task records no gold facts', () => {
    const result = scoreAccuracy('anything at all', task([], {
      category: 'obscure-entity',
      expectedRefusal: { kind: 'no-public-footprint', acknowledgementTerms: ['no record'] },
    }));
    expect(result.status).toBe('not-applicable');
    expect(result).not.toHaveProperty('share');
    expect(result.recovery).toEqual({});
  });
});

describe('the seam with calibration (ACCREL-17)', () => {
  it('returns a recovery record calibration accepts unchanged', () => {
    const t = task([
      number({ id: 'revenue', label: 'revenue' }),
      number({ id: 'headcount', label: 'headcount', value: 500, unit: 'dimensionless' }),
    ]);
    const report =
      'Revenue reached $1.2 billion. (High Confidence)\n\nHeadcount was 400. (Low Confidence)';

    const accuracy = scored(report, t);
    expect(accuracy.recovery).toEqual({ revenue: true, headcount: false });

    const calibration = scoreCalibration(report, t, factRecovery(accuracy));
    expect(calibration.status).toBe('scored');
    if (calibration.status === 'scored') {
      expect(calibration.scoredAnswers).toBe(2);
      expect(calibration.unresolved).toEqual([]);
      // The confidently wrong claim is the one calibration exists to charge for,
      // and it can only be charged because this scorer said the answer was wrong.
      expect(calibration.pairings.find((p) => p.factId === 'headcount')?.recovered).toBe(false);
    }
  });

  it('cannot rescue a numeric answer whose label the report never uses', () => {
    // Worth pinning as a cross-item fact rather than discovering it in a
    // scorecard. Calibration pairs on the label first and falls back to
    // `String(value)`, which for a large figure is the plain integer — and a
    // report writing "$1.2 billion" never contains "1200000000". So a numeric
    // answer whose label the report does not use goes unpaired however well this
    // scorer recovered it. That is calibration's own documented limit, and the
    // fix lives in the task file: give the answer a label the prose will use.
    const t = task([number({ id: 'revenue', label: 'FY25 revenue' })]);
    const report = 'Revenue reached $1.2 billion. (High Confidence)';

    const accuracy = scored(report, t);
    expect(accuracy.recovery).toEqual({ revenue: true });

    const calibration = scoreCalibration(report, t, factRecovery(accuracy));
    expect(calibration.status).toBe('unmeasurable');
  });

  it('hands calibration an empty record from a not-applicable result', () => {
    const t = task([], {
      category: 'false-premise',
      expectedRefusal: {
        kind: 'false-premise',
        fabricatedTerms: ['the 2026 merger'],
        acknowledgementTerms: ['no such'],
      },
    });
    const accuracy = scoreAccuracy('No such merger took place.', t);
    const calibration = scoreCalibration('No such merger took place.', t, factRecovery(accuracy));
    expect(calibration.status).toBe('not-applicable');
  });
});

describe('the real corpus (ACCREL-18)', () => {
  const corpus = loadCorpusFromDirectory(
    new URL('../../tasks', import.meta.url).pathname,
    { now: new Date('2026-07-27T00:00:00.000Z') },
  );

  it('has tasks to score', () => {
    expect(corpus.tasks.length).toBeGreaterThan(0);
  });

  it('scores every task without throwing', () => {
    for (const t of corpus.tasks) {
      const result = scoreAccuracy('An unrelated report about something else entirely.', t);
      if (t.goldFacts.length === 0) expect(result.status).toBe('not-applicable');
      else expect(result.status).toBe('scored');
    }
  });

  it('recovers every fact from a report built out of the task own gold', () => {
    // The strongest available check without a model: a report that states each
    // answer in its plainest form must score one. A miss here is a false
    // negative against real, human-verified gold rather than against a fixture.
    for (const t of corpus.tasks) {
      if (t.goldFacts.length === 0) continue;
      const lines = t.goldFacts.map((f) => {
        const label = f.label ?? f.id;
        if (f.kind === 'number') return `The ${label} is ${toPlainString(f.value)} ${f.unit}.`;
        return `The ${label} is ${String(f.value)}.`;
      });
      const result = scoreAccuracy(lines.join('\n\n'), t);
      expect(result.status).toBe('scored');
      if (result.status === 'scored') {
        const missed = result.facts.filter((f) => !f.recovered).map((f) => `${f.id}: ${f.why}`);
        expect(missed, `task ${t.id}`).toEqual([]);
        expect(result.share).toBe(1);
      }
    }
  });
});
