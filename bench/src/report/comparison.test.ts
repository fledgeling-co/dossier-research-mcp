import { describe, expect, it } from 'vitest';
import type { TaskCategory } from '../tasks/schema.js';
import { aggregate } from './aggregate.js';
import { comparisonSummary, comparisons, reliability, separatorFor } from './comparison.js';
import { corpus, scoredCell, task } from './fixtures.js';
import type { MetricId } from './metrics.js';

/**
 * The join between BENCH-08's aggregate and BENCH-13's statistics.
 *
 * What is being tested here is mostly the **gates**, because the whole design
 * rests on the comparison running only where the aggregate already says a
 * figure may be quoted. A comparison that ran where a table refused to print
 * would be the second answer to "can this sample support a claim" that this
 * slice was written to avoid.
 */

const CATEGORIES: readonly TaskCategory[] = ['technical', 'contested'];

/** Five tasks in each of two categories: the smallest corpus anything can run on. */
function twoCategoryCorpus(): ReturnType<typeof corpus> {
  const tasks = CATEGORIES.flatMap((category) =>
    [1, 2, 3, 4, 5].map((n) => task(`${category}-${String(n)}`, category)),
  );
  return corpus(tasks);
}

interface CellOptions {
  readonly repeats?: number;
  readonly failEvery?: number;
}

function cellsFor(
  provider: string,
  value: (taskId: string, category: TaskCategory) => number,
  options: CellOptions = {},
): ReturnType<typeof scoredCell>[] {
  const repeats = options.repeats ?? 3;
  return CATEGORIES.flatMap((category) =>
    [1, 2, 3, 4, 5].flatMap((n) =>
      Array.from({ length: repeats }, (_unused, i) => {
        const taskId = `${category}-${String(n)}`;
        const failed = options.failEvery !== undefined && (i + 1) % options.failEvery !== 0;
        return scoredCell(
          taskId,
          provider,
          i + 1,
          category,
          failed ? {} : { accuracy: value(taskId, category) },
          failed ? { outcome: 'failed', failureKind: '429' } : {},
        );
      }),
    ),
  );
}

describe('STAT-16 a comparison inherits BENCH-08\'s gates', () => {
  it('withholds every pair when the corpus is below the task floor', () => {
    const tasks = [task('t1', 'technical'), task('t2', 'technical')];
    const cells = ['alpha', 'beta'].flatMap((p) =>
      tasks.flatMap((t) => [1, 2, 3].map((r) => scoredCell(t.id, p, r, 'technical', { accuracy: 0.5 }))),
    );
    const agg = aggregate({ cells, corpus: corpus(tasks) });
    const list = comparisons(agg);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((c) => c.withheld !== null)).toBe(true);
    expect(list.some((c) => c.withheld === 'scope-not-scorable')).toBe(true);
    expect(comparisonSummary(list).ran).toBe(0);
  });

  it('withholds a pair whose tasks were run once, with the repetition reason', () => {
    const cells = [
      ...cellsFor('alpha', () => 0.9, { repeats: 1 }),
      ...cellsFor('beta', () => 0.2, { repeats: 1 }),
    ];
    const agg = aggregate({ cells, corpus: twoCategoryCorpus() });
    const list = comparisons(agg);
    expect(list.some((c) => c.withheld === 'sample-below-spread-floor')).toBe(true);
    expect(list.filter((c) => c.withheld === null)).toHaveLength(0);
  });

  it('withholds a backend that fell under the completion floor', () => {
    const cells = [
      ...cellsFor('alpha', () => 0.9),
      // Two failures in every three attempts: 33% completion, well under 60%.
      ...cellsFor('beta', () => 0.2, { failEvery: 3 }),
    ];
    const agg = aggregate({ cells, corpus: twoCategoryCorpus() });
    const list = comparisons(agg);
    expect(list.filter((c) => c.withheld === null)).toHaveLength(0);
    // The scope is fine; a candidate could not enter it, which leaves one
    // eligible backend and is `rank.ts`'s own word for that.
    expect(list.some((c) => c.withheld === 'too-few-candidates')).toBe(true);
  });

  it('never emits a comparison for a volume metric', () => {
    const cells = [...cellsFor('alpha', () => 0.9), ...cellsFor('beta', () => 0.2)];
    const list = comparisons(aggregate({ cells, corpus: twoCategoryCorpus() }));
    const volume: readonly MetricId[] = ['citation-sources', 'independent-domains', 'report-chars'];
    expect(list.filter((c) => volume.includes(c.metric))).toHaveLength(0);
  });

  it('is emitted in a stable order, so two renders diff cleanly', () => {
    const cells = [...cellsFor('alpha', () => 0.9), ...cellsFor('beta', () => 0.2)];
    const agg = aggregate({ cells, corpus: twoCategoryCorpus() });
    expect(comparisons(agg).map((c) => `${c.metric}/${c.a}/${c.b}`)).toEqual(
      comparisons(agg).map((c) => `${c.metric}/${c.a}/${c.b}`),
    );
  });
});

describe('a category-scoped comparison cannot be clustered, and says so', () => {
  it('refuses within one category rather than assuming its tasks are independent', () => {
    const cells = [...cellsFor('alpha', () => 0.9), ...cellsFor('beta', () => 0.2)];
    const agg = aggregate({ cells, corpus: twoCategoryCorpus() });
    const scoped = comparisons(agg).filter(
      (c) => c.scope.kind === 'category' && c.metric === 'accuracy',
    );
    expect(scoped.length).toBeGreaterThan(0);
    for (const c of scoped) {
      expect(c.withheld).toBe('too-few-clusters');
      expect(c.note).toMatch(/no replication across clusters/);
    }
  });
});

describe('the comparison that can run, does', () => {
  it('measures a large consistent gap over two categories', () => {
    const cells = [
      ...cellsFor('alpha', (id) => (id.startsWith('technical') ? 0.9 : 0.85)),
      ...cellsFor('beta', (id) => (id.startsWith('technical') ? 0.2 : 0.15)),
    ];
    const agg = aggregate({ cells, corpus: twoCategoryCorpus() });
    const overall = comparisons(agg).find(
      (c) => c.scope.kind === 'overall' && c.metric === 'accuracy',
    );
    expect(overall?.withheld).toBeNull();
    expect(overall?.result?.verdict).toBe('measured');
    expect(overall?.result?.betterBackend).toBe('alpha');
    expect(overall?.result?.shared).toHaveLength(10);
    expect(comparisonSummary(comparisons(agg)).measured).toBeGreaterThan(0);
  });

  it('reports no measured difference when the gap changes sign by category', () => {
    const cells = [
      ...cellsFor('alpha', (id) => (id.startsWith('technical') ? 0.9 : 0.2)),
      ...cellsFor('beta', (id) => (id.startsWith('technical') ? 0.2 : 0.9)),
    ];
    const agg = aggregate({ cells, corpus: twoCategoryCorpus() });
    const overall = comparisons(agg).find(
      (c) => c.scope.kind === 'overall' && c.metric === 'accuracy',
    );
    expect(overall?.result?.verdict).toBe('no-measured-difference');
    expect(overall?.result?.betterBackend).toBeNull();
  });
});

describe('STAT-14 the summary is the headline', () => {
  it('says plainly that nothing is distinguishable when nothing is', () => {
    const tasks = [task('t1', 'technical'), task('t2', 'technical')];
    const cells = ['alpha', 'beta'].flatMap((p) =>
      tasks.flatMap((t) => [1, 2, 3].map((r) => scoredCell(t.id, p, r, 'technical', { accuracy: 0.5 }))),
    );
    const summary = comparisonSummary(comparisons(aggregate({ cells, corpus: corpus(tasks) })));
    expect(summary.measured).toBe(0);
    expect(summary.sentence).toMatch(/Almost nothing here is distinguishable yet/);
    expect(summary.sentence).toMatch(/authoring tasks, not loosening the statistics/);
  });

  it('counts the refusals by reason', () => {
    const cells = [...cellsFor('alpha', () => 0.9), ...cellsFor('beta', () => 0.2)];
    const summary = comparisonSummary(comparisons(aggregate({ cells, corpus: twoCategoryCorpus() })));
    expect(Object.keys(summary.withheldBy)).toContain('too-few-clusters');
    expect(summary.pairs).toBe(summary.ran + summary.withheld);
  });
});

describe('STAT-17 the separation oracle', () => {
  it('answers separated for a measured pair and null where nothing ran', () => {
    const cells = [
      ...cellsFor('alpha', (id) => (id.startsWith('technical') ? 0.9 : 0.85)),
      ...cellsFor('beta', (id) => (id.startsWith('technical') ? 0.2 : 0.15)),
    ];
    const agg = aggregate({ cells, corpus: twoCategoryCorpus() });
    const list = comparisons(agg);
    const oracle = separatorFor(list, 'accuracy', { kind: 'overall' });
    expect(oracle('alpha', 'beta')).toBe('separated');
    // Order-insensitive: rank.ts asks about adjacent entries in score order,
    // which is not the order the comparison was built in.
    expect(oracle('beta', 'alpha')).toBe('separated');
    expect(oracle('alpha', 'nobody')).toBeNull();
    expect(separatorFor(list, 'relevance', { kind: 'overall' })('alpha', 'beta')).toBeNull();
  });
});

describe('STAT-09 reliability comes off the same task groups', () => {
  it('reports pass@1 and pass^k per backend over the corpus', () => {
    const cells = [...cellsFor('alpha', () => 1), ...cellsFor('beta', () => 0.5)];
    const reports = reliability(aggregate({ cells, corpus: twoCategoryCorpus() }));
    const alpha = reports.find((r) => r.provider === 'alpha');
    const beta = reports.find((r) => r.provider === 'beta');
    expect(alpha?.passAt1).toBe(1);
    expect(alpha?.passHatK).toBe(1);
    expect(alpha?.k).toBe(3);
    // Half credit is not a pass, which is what the default threshold means.
    expect(beta?.passAt1).toBe(0);
    expect(beta?.passHatK).toBe(0);
  });
});
