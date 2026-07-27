import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../tasks/index.js';
import type { BenchTask } from '../tasks/corpus.js';
import { targetsFor, verifyCorpus, type FetchedSource } from './verify.js';

const NOW = new Date('2026-07-27T00:00:00Z');

function taskFrom(yaml: string): BenchTask {
  const corpus = loadCorpus([{ file: 'x.yaml', text: yaml }], { now: NOW });
  const task = corpus.tasks[0];
  if (task === undefined) throw new Error('fixture did not load');
  return task;
}

const SIMPLE = `
id: simple
category: technical
question: What score does the record carry for this identifier?
asOf: 2026-07-01
reverifiedAt: 2026-07-20
goldFacts:
  - id: score
    kind: number
    value: 8.8
    unit: CVSS v3.1 base score
    tolerance: { kind: exact }
    source:
      url: https://example.org/record
      quote: '"baseSeverity":"HIGH"'
`;

function fetcherReturning(body: string, over: Partial<FetchedSource> = {}) {
  return async (url: string): Promise<FetchedSource> => ({
    url,
    status: 200,
    ok: true,
    body,
    contentType: 'application/json',
    truncated: false,
    ...over,
  });
}

describe('targetsFor', () => {
  it('flattens gold facts, conflicting values, fringe claims and dissent', () => {
    const task = taskFrom(`
id: everything
category: contested
question: Which figure is right, and what does the minority say about it?
asOf: 2026-01-01
reverifiedAt: 2026-07-20
goldFacts:
  - id: anchor
    kind: name
    value: Acme
    source: { url: https://example.org/a }
knownDissent:
  - url: https://example.org/dissent
    distinguishingTerm: overstated by half
conflictingFigures:
  - quantity: reported revenue
    values:
      - id: filing
        kind: number
        value: 100
        unit: USD
        tolerance: { kind: exact }
        source: { url: https://example.org/filing }
      - id: press
        kind: number
        value: 90
        unit: USD
        tolerance: { kind: exact }
        source: { url: https://example.org/press }
`);
    const roles = targetsFor(task).map((t) => t.role);
    expect(roles).toEqual(['goldFact', 'conflictingValue', 'conflictingValue', 'knownDissent']);
  });

  it('gives a dissenting source no value probe, because only reachability is knowable', () => {
    const task = taskFrom(`
id: dissent-only
category: contested
question: What does the minority position argue about this figure?
asOf: 2026-01-01
reverifiedAt: 2026-07-20
goldFacts:
  - id: anchor
    kind: name
    value: Acme
    source: { url: https://example.org/a }
knownDissent:
  - url: https://example.org/dissent
    distinguishingTerm: overstated by half
`);
    const dissent = targetsFor(task).find((t) => t.role === 'knownDissent');
    expect(dissent?.probe).toBeUndefined();
    expect(dissent?.quote).toBeUndefined();
  });
});

describe('verifyCorpus', () => {
  it('proves a fact whose quote and value are both in the source', async () => {
    const report = await verifyCorpus([taskFrom(SIMPLE)], {
      fetcher: fetcherReturning('{"baseScore":8.8,"baseSeverity":"HIGH"}'),
      checkedAt: '2026-07-27',
    });
    expect(report.proven).toBe(1);
    expect(report.unproven).toBe(0);
    expect(report.checks[0]?.verdict).toBe('proven');
  });

  it('separates a missing quote from a missing value', async () => {
    const report = await verifyCorpus([taskFrom(SIMPLE)], {
      fetcher: fetcherReturning('{"baseScore":8.8,"baseSeverity":"LOW"}'),
      checkedAt: '2026-07-27',
    });
    expect(report.checks[0]?.verdict).toBe('quote-absent');
    expect(report.checks[0]?.value).toBe('present');
  });

  it('reports both absent when neither is in the source', async () => {
    const report = await verifyCorpus([taskFrom(SIMPLE)], {
      fetcher: fetcherReturning('{"baseScore":1.0,"baseSeverity":"NONE"}'),
      checkedAt: '2026-07-27',
    });
    expect(report.checks[0]?.verdict).toBe('both-absent');
  });

  it('calls an unreachable source unreachable, never absent', async () => {
    // A publisher's 403 says nothing about whether the fact is real, and
    // reporting it as a fabrication is the defect this verifier exists to catch.
    const report = await verifyCorpus([taskFrom(SIMPLE)], {
      fetcher: fetcherReturning('', { ok: false, status: 403 }),
      checkedAt: '2026-07-27',
    });
    expect(report.checks[0]?.verdict).toBe('unreachable');
    expect(report.unreachable).toBe(1);
  });

  it('will not call a fact absent against a body it stopped reading early', async () => {
    const report = await verifyCorpus([taskFrom(SIMPLE)], {
      fetcher: fetcherReturning('{"baseScore":1.0}', { truncated: true }),
      checkedAt: '2026-07-27',
    });
    expect(report.checks[0]?.verdict).toBe('source-truncated');
  });

  it('still proves a fact found inside a truncated body', async () => {
    const report = await verifyCorpus([taskFrom(SIMPLE)], {
      fetcher: fetcherReturning('{"baseScore":8.8,"baseSeverity":"HIGH"}', { truncated: true }),
      checkedAt: '2026-07-27',
    });
    expect(report.checks[0]?.verdict).toBe('proven');
  });

  it('fetches one URL once however many facts cite it', async () => {
    const task = taskFrom(`
id: shared-source
category: technical
question: What are the two identifiers this one record carries?
asOf: 2026-07-01
reverifiedAt: 2026-07-20
goldFacts:
  - id: one
    kind: identifier
    value: aaa
    source: { url: https://example.org/rec }
  - id: two
    kind: identifier
    value: bbb
    source: { url: https://example.org/rec }
`);
    let calls = 0;
    await verifyCorpus([task], {
      fetcher: async (url) => {
        calls += 1;
        return {
          url,
          status: 200,
          ok: true,
          body: 'aaa bbb',
          contentType: 'text/plain',
          truncated: false,
        };
      },
      checkedAt: '2026-07-27',
    });
    expect(calls).toBe(1);
  });
});
