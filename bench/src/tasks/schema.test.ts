import { describe, expect, it } from 'vitest';
import {
  MAX_FLAT_GOLD_FACTS,
  taskFileSchema,
  utcDayOrdinal,
  utcDayOrdinalFromIsoDate,
} from './schema.js';

/**
 * The format's rules, asserted one at a time.
 *
 * These drive the schema directly rather than through YAML, so a failure names
 * the rule rather than the parser. `corpus.test.ts` covers the YAML layer and
 * the loader; `files.test.ts` covers the disk.
 */

const NOW = new Date('2026-07-27T00:00:00.000Z');
const schema = taskFileSchema(NOW);

const source = { url: 'https://example.gov/report' };

const numberFact = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'revenue',
  kind: 'number',
  value: 1_200_000_000,
  unit: 'USD',
  tolerance: { kind: 'significantFigures', digits: 3 },
  source,
  ...over,
});

const task = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'acme-fy25-revenue',
  category: 'technical',
  question: 'What was the reported revenue for the year?',
  asOf: '2026-01-10',
  reverifiedAt: '2026-07-01',
  goldFacts: [numberFact()],
  ...over,
});

/** The first issue path, dotted, for asserting the error names the right field. */
function firstPath(result: ReturnType<typeof schema.safeParse>): string {
  if (result.success) throw new Error('expected the parse to fail');
  return result.error.issues[0]?.path.join('.') ?? '';
}

function messages(result: ReturnType<typeof schema.safeParse>): string {
  if (result.success) throw new Error('expected the parse to fail');
  return result.error.issues.map((i) => i.message).join(' | ');
}

describe('TASKFMT-01 a well-formed task', () => {
  it('parses, with the list fields defaulted rather than absent', () => {
    const parsed = schema.safeParse(task());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.id).toBe('acme-fy25-revenue');
    expect(parsed.data.requiredTerms).toEqual([]);
    expect(parsed.data.knownDissent).toEqual([]);
    expect(parsed.data.goldFacts).toHaveLength(1);
  });

  it('keeps the two dates apart rather than collapsing them', () => {
    const parsed = schema.safeParse(task({ asOf: '2019-04-01', reverifiedAt: '2026-07-01' }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.asOf).toBe('2019-04-01');
    expect(parsed.data.reverifiedAt).toBe('2026-07-01');
  });
});

describe('TASKFMT-04 a number always states a tolerance and a unit', () => {
  it('rejects a number with no tolerance, naming the field', () => {
    const missing = numberFact();
    delete missing['tolerance'];
    const result = schema.safeParse(task({ goldFacts: [missing] }));
    expect(result.success).toBe(false);
    expect(firstPath(result)).toBe('goldFacts.0.tolerance');
  });

  it('rejects a number with no unit, naming the field', () => {
    const missing = numberFact();
    delete missing['unit'];
    const result = schema.safeParse(task({ goldFacts: [missing] }));
    expect(result.success).toBe(false);
    expect(firstPath(result)).toBe('goldFacts.0.unit');
  });

  it('accepts dimensionless as the explicit way to say a figure has no unit', () => {
    const result = schema.safeParse(
      task({ goldFacts: [numberFact({ unit: 'dimensionless', value: 0.42 })] }),
    );
    expect(result.success).toBe(true);
  });

  it('requires no tolerance on a name, and rejects one offered anyway', () => {
    const ok = schema.safeParse(
      task({ goldFacts: [{ id: 'ceo', kind: 'name', value: 'Jane Roe', source }] }),
    );
    expect(ok.success).toBe(true);

    const extra = schema.safeParse(
      task({
        goldFacts: [
          { id: 'ceo', kind: 'name', value: 'Jane Roe', source, tolerance: { kind: 'exact' } },
        ],
      }),
    );
    expect(extra.success).toBe(false);
  });
});

describe('TASKFMT-05 the tolerance arms', () => {
  it('accepts every arm', () => {
    for (const tolerance of [
      { kind: 'exact' },
      { kind: 'absolute', value: 0.5 },
      { kind: 'relative', fraction: 0.01 },
      { kind: 'significantFigures', digits: 3 },
    ]) {
      expect(schema.safeParse(task({ goldFacts: [numberFact({ tolerance })] })).success).toBe(true);
    }
  });

  it('rejects a relative tolerance outside a fraction, which is the percentage confusion', () => {
    for (const fraction of [0, 1.5, -0.1]) {
      const result = schema.safeParse(
        task({ goldFacts: [numberFact({ tolerance: { kind: 'relative', fraction } })] }),
      );
      expect(result.success).toBe(false);
    }
    expect(
      schema.safeParse(task({ goldFacts: [numberFact({ tolerance: { kind: 'relative', fraction: 1 } })] }))
        .success,
    ).toBe(true);
  });

  it('rejects significant figures outside 1..15 and a non-integer count', () => {
    for (const digits of [0, 16, 2.5]) {
      expect(
        schema.safeParse(task({ goldFacts: [numberFact({ tolerance: { kind: 'significantFigures', digits } })] }))
          .success,
      ).toBe(false);
    }
  });

  it('rejects an unknown tolerance kind rather than ignoring it', () => {
    const result = schema.safeParse(
      task({ goldFacts: [numberFact({ tolerance: { kind: 'roughly', value: 1 } })] }),
    );
    expect(result.success).toBe(false);
  });
});

describe('TASKFMT-06 unknown fields are rejected, not ignored', () => {
  it('rejects a misspelt top-level field', () => {
    const result = schema.safeParse(task({ requiredTerm: ['revenue'] }));
    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/unrecognized|unexpected/i);
  });

  it('rejects an unknown field on a gold fact', () => {
    const result = schema.safeParse(task({ goldFacts: [numberFact({ toleranceKind: 'exact' })] }));
    expect(result.success).toBe(false);
  });

  it('rejects an unknown field on a source', () => {
    const result = schema.safeParse(
      task({ goldFacts: [numberFact({ source: { url: source.url, page: 42 } })] }),
    );
    expect(result.success).toBe(false);
  });
});

describe('TASKFMT-07 every string and array is capped', () => {
  it('accepts a question at its limit and rejects one past it', () => {
    expect(schema.safeParse(task({ question: 'q'.repeat(2000) })).success).toBe(true);
    expect(schema.safeParse(task({ question: 'q'.repeat(2001) })).success).toBe(false);
    expect(schema.safeParse(task({ question: 'short' })).success).toBe(false);
  });

  it('accepts required terms at the limit and rejects one past it', () => {
    expect(schema.safeParse(task({ requiredTerms: Array(50).fill('term') })).success).toBe(true);
    expect(schema.safeParse(task({ requiredTerms: Array(51).fill('term') })).success).toBe(false);
  });

  it('rejects a task id that is not a slug', () => {
    for (const id of ['Acme FY25', '-leading', 'UPPER', '']) {
      expect(schema.safeParse(task({ id })).success).toBe(false);
    }
  });

  it('rejects a source url that is not http or https', () => {
    for (const url of ['file:///etc/passwd', 'data:text/plain,hi', 'ftp://example.com/x']) {
      expect(schema.safeParse(task({ goldFacts: [numberFact({ source: { url } })] })).success).toBe(
        false,
      );
    }
  });

  it('rejects a date that is not a real calendar date', () => {
    for (const asOf of ['2026-02-30', '2026-13-01', '2026-1-5', '20260101']) {
      expect(schema.safeParse(task({ asOf })).success).toBe(false);
    }
  });
});

describe('TASKFMT-10 the reference date bounds re-verification only', () => {
  it('rejects a re-verification date in the future', () => {
    const result = schema.safeParse(task({ reverifiedAt: '2026-07-28' }));
    expect(result.success).toBe(false);
    expect(firstPath(result)).toBe('reverifiedAt');
    expect(messages(result)).toMatch(/future/);
  });

  it('accepts a re-verification date on the reference day itself', () => {
    expect(schema.safeParse(task({ reverifiedAt: '2026-07-27' })).success).toBe(true);
  });

  it('accepts an as-of date in the future, because a rule can take effect later', () => {
    expect(schema.safeParse(task({ asOf: '2027-01-01' })).success).toBe(true);
  });
});

describe('TASKFMT-12 gold fact ids are unique task-wide', () => {
  it('rejects two answers sharing an id', () => {
    const result = schema.safeParse(
      task({ goldFacts: [numberFact(), numberFact({ value: 5, unit: 'USD' })] }),
    );
    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/used more than once/);
  });

  it('counts values nested under conflicting figures in the same namespace', () => {
    const result = schema.safeParse(
      task({
        category: 'contested',
        goldFacts: [numberFact({ id: 'headline' })],
        conflictingFigures: [
          {
            quantity: 'reported revenue',
            values: [numberFact({ id: 'headline', value: 1 }), numberFact({ id: 'other', value: 2 })],
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/used more than once/);
  });
});

describe('TASKFMT-13 how many answers a task may carry', () => {
  const facts = (n: number): Record<string, unknown>[] =>
    Array.from({ length: n }, (_, i) => numberFact({ id: `fact-${String(i)}` }));

  it('accepts ten answers without a grid and rejects eleven', () => {
    expect(schema.safeParse(task({ goldFacts: facts(MAX_FLAT_GOLD_FACTS) })).success).toBe(true);
    const result = schema.safeParse(task({ goldFacts: facts(MAX_FLAT_GOLD_FACTS + 1) }));
    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/at most 10/);
  });

  it('rejects a task with no answers and no expected refusal', () => {
    const result = schema.safeParse(task({ goldFacts: [] }));
    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/at least one gold fact/);
  });

  it('accepts a refusal task with no answers at all', () => {
    const result = schema.safeParse(
      task({
        category: 'obscure-entity',
        goldFacts: [],
        expectedRefusal: { kind: 'no-public-footprint', acknowledgementTerms: ['no public record'] },
      }),
    );
    expect(result.success).toBe(true);
  });
});

describe('TASKFMT-14 and TASKFMT-15 refusal belongs to its category and needs a positive signal', () => {
  it('rejects a refusal on a category that does not expect one', () => {
    const result = schema.safeParse(
      task({
        category: 'technical',
        expectedRefusal: { kind: 'no-public-footprint', acknowledgementTerms: ['nothing found'] },
      }),
    );
    expect(result.success).toBe(false);
    expect(firstPath(result)).toBe('expectedRefusal');
  });

  it('requires a refusal on the two categories that expect one', () => {
    const result = schema.safeParse(task({ category: 'false-premise' }));
    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/must declare an expectedRefusal/);
  });

  it('rejects a refusal whose kind does not match its category', () => {
    const result = schema.safeParse(
      task({
        category: 'obscure-entity',
        goldFacts: [],
        expectedRefusal: {
          kind: 'false-premise',
          fabricatedTerms: ['the 2025 merger'],
          acknowledgementTerms: ['no such merger'],
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it('requires acknowledgement wording on a false premise, not only the fabricated term', () => {
    const missing = schema.safeParse(
      task({
        category: 'false-premise',
        goldFacts: [],
        expectedRefusal: { kind: 'false-premise', fabricatedTerms: ['the 2025 merger'] },
      }),
    );
    expect(missing.success).toBe(false);

    const complete = schema.safeParse(
      task({
        category: 'false-premise',
        goldFacts: [],
        expectedRefusal: {
          kind: 'false-premise',
          fabricatedTerms: ['the 2025 merger'],
          acknowledgementTerms: ['no such merger took place'],
        },
      }),
    );
    expect(complete.success).toBe(true);
  });

  it('requires acknowledgement wording on a no-public-footprint task', () => {
    const result = schema.safeParse(
      task({
        category: 'obscure-entity',
        goldFacts: [],
        expectedRefusal: { kind: 'no-public-footprint', acknowledgementTerms: [] },
      }),
    );
    expect(result.success).toBe(false);
  });
});

describe('TASKFMT-16 and TASKFMT-17 a category must record what it promises', () => {
  it('rejects a contested task carrying neither dissent nor clashing figures', () => {
    const result = schema.safeParse(task({ category: 'contested' }));
    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/knownDissent or conflictingFigures/);
  });

  it('accepts a contested task carrying dissent alone', () => {
    const result = schema.safeParse(
      task({
        category: 'contested',
        knownDissent: [{ url: 'https://example.org/dissent', distinguishingTerm: 'overstated' }],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a settled-with-fringe task carrying no fringe claim', () => {
    const result = schema.safeParse(task({ category: 'settled-with-fringe' }));
    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/fringeClaim/);
  });

  it('requires two conflicting values, and requires them to be numeric', () => {
    const one = schema.safeParse(
      task({
        category: 'contested',
        conflictingFigures: [{ quantity: 'revenue', values: [numberFact({ id: 'a' })] }],
      }),
    );
    expect(one.success).toBe(false);

    const nonNumeric = schema.safeParse(
      task({
        category: 'contested',
        conflictingFigures: [
          {
            quantity: 'revenue',
            values: [
              numberFact({ id: 'a' }),
              { id: 'b', kind: 'name', value: 'about a billion', source },
            ],
          },
        ],
      }),
    );
    expect(nonNumeric.success).toBe(false);
  });
});

describe('TASKFMT-18 and TASKFMT-19 the enumeration grid', () => {
  const grid = {
    entities: ['acme', 'globex'],
    fields: ['founded'],
  };
  const cellFact = (entity: string, id: string): Record<string, unknown> => ({
    id,
    kind: 'date',
    value: '1998-04-01',
    source,
    cell: { entity, field: 'founded' },
  });

  it('accepts a grid whose every cell is answered or declared unknown', () => {
    const result = schema.safeParse(
      task({
        category: 'enumeration',
        enumeration: { ...grid, unknownCells: [{ entity: 'globex', field: 'founded' }] },
        goldFacts: [cellFact('acme', 'acme-founded')],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a grid with an uncovered cell', () => {
    const result = schema.safeParse(
      task({
        category: 'enumeration',
        enumeration: grid,
        goldFacts: [cellFact('acme', 'acme-founded')],
      }),
    );
    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/neither answered nor declared unknown/);
    expect(messages(result)).toMatch(/globex/);
  });

  it('rejects a cell covered twice', () => {
    const result = schema.safeParse(
      task({
        category: 'enumeration',
        enumeration: { ...grid, unknownCells: [{ entity: 'acme', field: 'founded' }] },
        goldFacts: [cellFact('acme', 'acme-founded'), cellFact('globex', 'globex-founded')],
      }),
    );
    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/covered more than once/);
  });

  it('rejects a cell naming an axis the grid never declared', () => {
    const result = schema.safeParse(
      task({
        category: 'enumeration',
        enumeration: { ...grid, unknownCells: [{ entity: 'globex', field: 'founded' }] },
        goldFacts: [cellFact('initech', 'initech-founded')],
      }),
    );
    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/does not declare/);
  });

  it('rejects duplicate axis labels, which would collapse two cells into one', () => {
    const dupEntity = schema.safeParse(
      task({
        category: 'enumeration',
        enumeration: { entities: ['acme', 'acme'], fields: ['founded'], unknownCells: [] },
        goldFacts: [cellFact('acme', 'acme-founded')],
      }),
    );
    expect(dupEntity.success).toBe(false);
    expect(messages(dupEntity)).toMatch(/declared more than once/);

    const dupField = schema.safeParse(
      task({
        category: 'enumeration',
        enumeration: { entities: ['acme', 'globex'], fields: ['founded', 'founded'], unknownCells: [] },
        goldFacts: [],
      }),
    );
    expect(dupField.success).toBe(false);
  });

  it('rejects a cell tag when the task declares no grid', () => {
    const result = schema.safeParse(task({ goldFacts: [cellFact('acme', 'acme-founded')] }));
    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/requires the task to declare an enumeration grid/);
  });

  it('requires an enumeration task to declare its grid', () => {
    const result = schema.safeParse(task({ category: 'enumeration' }));
    expect(result.success).toBe(false);
    expect(firstPath(result)).toBe('enumeration');
  });

  it('lets a grid task carry more than the flat ceiling of answers', () => {
    const entities = Array.from({ length: 12 }, (_, i) => `entity-${String(i)}`);
    const result = schema.safeParse(
      task({
        category: 'enumeration',
        enumeration: { entities, fields: ['founded'], unknownCells: [] },
        goldFacts: entities.map((entity, i) => cellFact(entity, `fact-${String(i)}`)),
      }),
    );
    expect(result.success).toBe(true);
  });
});

describe('the day arithmetic helpers', () => {
  it('ignores the time of day', () => {
    const midnight = utcDayOrdinal(new Date('2026-07-27T00:00:00.000Z'));
    const noon = utcDayOrdinal(new Date('2026-07-27T12:00:00.000Z'));
    const lastSecond = utcDayOrdinal(new Date('2026-07-27T23:59:59.999Z'));
    expect(noon).toBe(midnight);
    expect(lastSecond).toBe(midnight);
  });

  it('agrees with the iso-date form', () => {
    expect(utcDayOrdinalFromIsoDate('2026-07-27')).toBe(
      utcDayOrdinal(new Date('2026-07-27T18:30:00.000Z')),
    );
  });
});
