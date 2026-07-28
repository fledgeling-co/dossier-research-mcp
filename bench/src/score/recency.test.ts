import { describe, expect, it } from 'vitest';
import { assessStaleness, type SourceType } from '../../../src/research/evidence.js';
import {
  assessSourceRecency,
  BENCH_SOURCE_HORIZONS,
  classifyDurability,
  recencyHorizon,
  recencyInputs,
  scoreRecency,
  type RecencyResult,
  type RecencyScored,
} from './recency.js';

/**
 * Recency, including the standard-versus-benchmark rule the design assumed
 * existed and BENCH-01 verified did not.
 *
 * The parity block at the end is the one that stops this drifting: it drives
 * the product's own `assessStaleness` and this file side by side, so a source
 * of unknown durability must grade identically. If the product ever changes its
 * horizons, this fails rather than quietly measuring against an old rule.
 */

const AS_OF = '2026-07-27';
const DAY_MS = 86_400_000;

/** A date `days` before the as-of date, as `YYYY-MM-DD`. */
function daysBefore(days: number): string {
  return new Date(Date.parse(`${AS_OF}T00:00:00.000Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

function scored(result: RecencyResult): RecencyScored {
  if (result.status !== 'scored') throw new Error(`expected a scored result, got ${result.status}`);
  return result;
}

describe('RECENCY-01 the design sentence, as a test', () => {
  it('grades a 2019 standard current and a 2019 benchmark not', () => {
    const standard = assessSourceRecency(
      { url: 'https://www.w3.org/TR/webauthn-2/', publishedAt: '2019-03-04' },
      AS_OF,
    );
    const benchmark = assessSourceRecency(
      { url: 'https://example.com/benchmarks/2019-results', publishedAt: '2019-03-04' },
      AS_OF,
    );
    expect(standard.durability).toBe('durable');
    expect(standard.freshness).toBe('fresh');
    expect(benchmark.durability).toBe('perishable');
    expect(benchmark.freshness).toBe('stale');
    // The two are the same age and the same source type. Only durability differs.
    expect(standard.ageDays).toBe(benchmark.ageDays);
    expect(standard.type).toBe(benchmark.type);
  });

  it('would have graded both identically on source type alone', () => {
    // The state of the world before this file existed, asserted so the gap the
    // orphan describes is visible rather than argued about.
    const before = assessStaleness('2019-03-04', AS_OF, 'other');
    expect(before.freshness).toBe('stale');
  });
});

describe('RECENCY-02 and RECENCY-03 the durability classifier', () => {
  it('leaves an unrecognised URL unknown and falls back to the source-type horizon', () => {
    const verdict = classifyDurability('https://example.com/notes/quarterly-thoughts');
    expect(verdict.durability).toBe('unknown');
    const graded = assessSourceRecency(
      { url: 'https://example.com/notes/quarterly-thoughts', publishedAt: daysBefore(300) },
      AS_OF,
    );
    expect(graded.horizon).toEqual(BENCH_SOURCE_HORIZONS.other);
    expect(graded.freshness).toBe('ageing');
  });

  it('recognises standards bodies, legislatures and courts by host', () => {
    for (const url of [
      'https://www.iso.org/standard/82875.html',
      'https://www.rfc-editor.org/rfc/rfc9110',
      'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679',
      'https://www.legislation.gov.uk/ukpga/2018/12/contents',
    ]) {
      expect(classifyDurability(url).durability).toBe('durable');
    }
  });

  it('recognises a durable document by path wherever it is hosted', () => {
    expect(classifyDurability('https://example.org/specs/wire-format-v3').durability).toBe('durable');
    expect(classifyDurability('https://example.org/legislation/act-2019').durability).toBe('durable');
  });

  it('treats a benchmark published by a standards body as perishable, because the path says what it is', () => {
    const verdict = classifyDurability('https://www.iso.org/benchmarks/2024-throughput');
    expect(verdict.durability).toBe('perishable');
    expect(verdict.basis).toContain('moment');
  });

  it('recognises the moving-number pages', () => {
    for (const url of [
      'https://example.com/pricing',
      'https://example.com/changelog/2026-07',
      'https://example.com/leaderboard',
      'https://example.com/releases/v3',
      'https://paperswithcode.com/sota/thing',
    ]) {
      expect(classifyDurability(url).durability).toBe('perishable');
    }
  });

  it('always states a basis, including for a URL it cannot parse', () => {
    const broken = classifyDurability('not a url at all');
    expect(broken.durability).toBe('unknown');
    expect(broken.basis.length).toBeGreaterThan(0);
  });

  it('may only widen a horizon for durable and narrow it for perishable', () => {
    for (const type of Object.keys(BENCH_SOURCE_HORIZONS) as SourceType[]) {
      const base = BENCH_SOURCE_HORIZONS[type];
      const durable = recencyHorizon(type, 'durable');
      const perishable = recencyHorizon(type, 'perishable');
      expect(durable.stale).toBeGreaterThanOrEqual(base.stale);
      expect(durable.ageing).toBeGreaterThanOrEqual(base.ageing);
      expect(perishable.stale).toBeLessThanOrEqual(base.stale);
      expect(perishable.ageing).toBeLessThanOrEqual(base.ageing);
      expect(recencyHorizon(type, 'unknown')).toEqual(base);
    }
  });
});

describe('RECENCY-04 to RECENCY-07 the report-level figure', () => {
  it('excludes undated sources from the share rather than counting them current', () => {
    const result = scored(
      scoreRecency(
        [
          { url: 'https://example.com/a', publishedAt: daysBefore(10) },
          { url: 'https://example.com/b' },
          { url: 'https://example.com/c' },
        ],
        AS_OF,
      ),
    );
    expect(result.counts.undated).toBe(2);
    expect(result.dated).toBe(1);
    expect(result.freshShare).toBe(1);
    expect(result.notes.join(' ')).toContain('excluded from the share');
  });

  it('reports a source dated after the as-of date as after-horizon and excludes it', () => {
    const result = scored(
      scoreRecency(
        [
          { url: 'https://example.com/a', publishedAt: daysBefore(10) },
          { url: 'https://example.com/b', publishedAt: '2026-12-01' },
        ],
        AS_OF,
      ),
    );
    expect(result.counts['after-horizon']).toBe(1);
    expect(result.dated).toBe(1);
    expect(result.notes.join(' ')).toContain('after the task');
  });

  it('treats an unreadable date as undated rather than as an age of zero', () => {
    const graded = assessSourceRecency(
      { url: 'https://example.com/a', publishedAt: 'last spring' },
      AS_OF,
    );
    expect(graded.freshness).toBe('undated');
    expect(graded.ageDays).toBeNull();
    expect(graded.why).toContain('could not be read');
  });

  it('reports no figure for an empty source list rather than a perfect one', () => {
    const result = scoreRecency([], AS_OF);
    expect(result.status).toBe('not-applicable');
    expect('freshShare' in result).toBe(false);
  });

  it('reports unmeasurable when nothing could be dated', () => {
    const result = scoreRecency(
      [{ url: 'https://example.com/a' }, { url: 'https://example.com/b' }],
      AS_OF,
    );
    expect(result.status).toBe('unmeasurable');
    expect('freshShare' in result).toBe(false);
  });
});

describe('RECENCY-10 to RECENCY-13 the holes an adversarial pass found', () => {
  it('does not read a locale path segment as a standards document', () => {
    // `tr` was in the durable path list for `w3.org/TR/`. It is also the
    // Turkish locale segment, which graded a 2019 news article `fresh` in 2026.
    const graded = assessSourceRecency(
      { url: 'https://www.hurriyetdailynews.com/tr/2019/ekonomi/haber-12345', publishedAt: '2019-03-04' },
      AS_OF,
    );
    expect(graded.durability).toBe('unknown');
    expect(graded.freshness).toBe('stale');
    // The page it was there for is reached by host anyway.
    expect(classifyDurability('https://www.w3.org/TR/webauthn-2/').durability).toBe('durable');
  });

  it('falls back to the source-type horizon on a standards body news or blog path', () => {
    for (const url of [
      'https://www.w3.org/blog/2019/some-news-post/',
      'https://www.congress.gov/news/2019/daily-digest',
    ]) {
      const verdict = classifyDurability(url);
      expect(verdict.durability).toBe('unknown');
      expect(verdict.basis).toContain('rather than a standards document');
    }
    expect(
      assessSourceRecency(
        { url: 'https://www.w3.org/blog/2019/some-news-post/', publishedAt: '2019-03-04' },
        AS_OF,
      ).freshness,
    ).toBe('stale');
  });

  it('reports a source stamped hours after the as-of date as after-horizon', () => {
    // `Math.round(-0.4)` is `-0`, and `-0 < 0` is false, so branching on the
    // rounded age let a future timestamp into the fresh count.
    const graded = assessSourceRecency(
      { url: 'https://example.com/notes/x', publishedAt: '2026-07-27T11:00:00Z' },
      AS_OF,
    );
    expect(graded.freshness).toBe('after-horizon');
    const result = scoreRecency(
      [{ url: 'https://example.com/notes/x', publishedAt: '2026-07-27T11:00:00Z' }],
      AS_OF,
    );
    expect(result.status).toBe('unmeasurable');
  });

  it('fails loudly on an unreadable as-of date instead of blaming the sources', () => {
    expect(() =>
      assessSourceRecency({ url: 'https://example.com/a', publishedAt: '2020-01-01' }, 'not-a-date'),
    ).toThrow(TypeError);
    expect(() =>
      scoreRecency([{ url: 'https://example.com/a', publishedAt: '2020-01-01' }], 'not-a-date'),
    ).toThrow(TypeError);
  });
});

describe('RECENCY-08 source type', () => {
  it('is derived from the product classifier when the caller does not supply one', () => {
    expect(assessSourceRecency({ url: 'https://arxiv.org/abs/2509.04499' }, AS_OF).type).toBe(
      'academic',
    );
    expect(assessSourceRecency({ url: 'https://www.reuters.com/business/x' }, AS_OF).type).toBe(
      'journalism',
    );
    expect(assessSourceRecency({ url: 'https://www.sec.gov/files/x' }, AS_OF).type).toBe('official');
  });

  it('honours a type the caller supplies over the URL heuristic', () => {
    const graded = assessSourceRecency(
      { url: 'https://example.com/a', publishedAt: daysBefore(200), type: 'academic' },
      AS_OF,
    );
    expect(graded.type).toBe('academic');
    expect(graded.freshness).toBe('fresh');
  });
});

describe('RECENCY-09 parity with the product', () => {
  const TYPES: SourceType[] = [
    'academic',
    'journalism',
    'community',
    'official',
    'secondary-industry',
    'other',
  ];
  // Every horizon boundary in the product's table, plus one either side.
  const AGES = [0, 89, 90, 91, 182, 183, 184, 547, 548, 549, 729, 730, 731, 1094, 1095, 1096];

  it('grades an unknown-durability source exactly as assessStaleness does', () => {
    for (const type of TYPES) {
      for (const age of AGES) {
        const published = daysBefore(age);
        const mine = assessSourceRecency(
          { url: 'https://example.com/notes/thing', publishedAt: published, type },
          AS_OF,
        );
        const theirs = assessStaleness(published, AS_OF, type);
        expect(`${type}:${String(age)}:${mine.freshness}`).toBe(
          `${type}:${String(age)}:${theirs.freshness}`,
        );
        expect(mine.ageDays).toBe(theirs.ageDays);
      }
    }
  });

  it('agrees on the undated and after-horizon answers too', () => {
    const undated = assessSourceRecency({ url: 'https://example.com/notes/x' }, AS_OF);
    expect(undated.freshness).toBe(assessStaleness(undefined, AS_OF, 'other').freshness);
    const ahead = assessSourceRecency(
      { url: 'https://example.com/notes/x', publishedAt: '2026-12-01' },
      AS_OF,
    );
    expect(ahead.freshness).toBe(assessStaleness('2026-12-01', AS_OF, 'other').freshness);
  });
});

describe('DATE-19 the join produces the graded list and the printed counts in one pass', () => {
  it('carries a found date onto the source and counts it dated', () => {
    const { sources, dating } = recencyInputs(
      ['https://a.test/x'],
      [{ url: 'https://a.test/x', published: { status: 'found', date: '2026-07-01' } }],
    );
    expect(sources).toEqual([{ url: 'https://a.test/x', publishedAt: '2026-07-01' }]);
    expect(dating).toEqual({ dated: 1, absent: 0, unchecked: 0, afterHorizon: 0 });
  });

  it('keeps the two undated causes apart, because they have different fixes', () => {
    const { dating } = recencyInputs(
      ['https://a.test/x', 'https://b.test/y'],
      [
        { url: 'https://a.test/x', published: { status: 'absent' } },
        { url: 'https://b.test/y', published: { status: 'unchecked' } },
      ],
    );
    expect(dating).toEqual({ dated: 0, absent: 1, unchecked: 1, afterHorizon: 0 });
  });

  it('counts a cited URL with no page record as unchecked, never as absent', () => {
    // It was never fetched, whether the page budget bound or no snapshot exists
    // at all. Reporting that as a publisher who omitted a date is the accusation
    // this whole distinction exists to prevent.
    const { sources, dating } = recencyInputs(['https://a.test/x'], []);
    expect(dating).toEqual({ dated: 0, absent: 0, unchecked: 1, afterHorizon: 0 });
    expect(sources).toEqual([{ url: 'https://a.test/x' }]);
  });

  it('grades every cited source, so the two numbers describe one population', () => {
    const cited = ['https://a.test/x', 'https://b.test/y', 'https://c.test/z'];
    const { sources, dating } = recencyInputs(cited, [
      { url: 'https://a.test/x', published: { status: 'found', date: '2026-07-01' } },
      { url: 'https://b.test/y', published: { status: 'absent' } },
    ]);
    expect(sources).toHaveLength(cited.length);
    expect(dating.dated + dating.absent + dating.unchecked).toBe(cited.length);
  });

  it('an undated source reaches the scorer as undated and never as fresh', () => {
    const { sources } = recencyInputs(
      ['https://a.test/x'],
      [{ url: 'https://a.test/x', published: { status: 'absent' } }],
    );
    const scored = scoreRecency(sources, '2026-07-28');
    expect(scored.status).toBe('unmeasurable');
    if (scored.status !== 'unmeasurable') throw new Error('expected unmeasurable');
    expect(scored.counts.fresh).toBe(0);
    expect(scored.counts.undated).toBe(1);
  });
});
