import { describe, expect, it } from 'vitest';
import { MIN_TASKS_PER_CATEGORY, aggregate, uncheckedShare } from './aggregate.js';
import { corpus, scoredCell, task } from './fixtures.js';

/** Six technical tasks, which clears the default floor of five. */
const SIX = ['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => task(id, 'technical'));

describe('REPORT-03 an under-sampled category is named and left unscored', () => {
  it('refuses to score a category the corpus holds two tasks of', () => {
    const tasks = [task('c1', 'contested'), task('c2', 'contested')];
    const cells = tasks.flatMap((t) =>
      [1, 2, 3].map((r) => scoredCell(t.id, 'gemini', r, 'contested', { accuracy: 0.9 })),
    );
    const agg = aggregate({ cells, corpus: corpus(tasks) });

    expect(agg.underSampledCategories).toEqual([{ category: 'contested', tasksInCorpus: 2 }]);
    const group = agg.categoryGroups.find((g) => g.category === 'contested');
    expect(group?.verdict.scorable).toBe(false);
    if (group?.verdict.scorable === false) {
      expect(group.verdict.reason).toBe('under-sampled-corpus');
      expect(group.verdict.why).toMatch(/below the floor of 5/);
      expect(group.verdict.why).toMatch(/authoring tasks, not re-running/);
    }
  });

  it('still carries the raw numbers, so the data survives the refusal to score it', () => {
    const tasks = [task('c1', 'contested'), task('c2', 'contested')];
    const cells = tasks.flatMap((t) =>
      [1, 2, 3].map((r) => scoredCell(t.id, 'gemini', r, 'contested', { accuracy: 0.9 })),
    );
    const agg = aggregate({ cells, corpus: corpus(tasks) });
    const group = agg.categoryGroups.find((g) => g.category === 'contested');
    expect(group?.metrics.accuracy?.median).toBeCloseTo(0.9);
  });

  it('excludes an unscorable category from the backend overall, and names it', () => {
    const tasks = [task('c1', 'contested'), ...SIX];
    const cells = [
      ...[1, 2, 3].map((r) => scoredCell('c1', 'gemini', r, 'contested', { accuracy: 0.1 })),
      ...SIX.flatMap((t) =>
        [1, 2, 3].map((r) => scoredCell(t.id, 'gemini', r, 'technical', { accuracy: 0.9 })),
      ),
    ];
    const agg = aggregate({ cells, corpus: corpus(tasks) });
    const backend = agg.backends[0];
    expect(backend?.scorableCategories).toEqual(['technical']);
    expect(backend?.excludedCategories.map((e) => e.category)).toEqual(['contested']);
    // The overall figure is the technical median alone, so the excluded
    // category cannot drag it. A blended 0.5 here would be the under-sample
    // rule enforced in one table and abandoned in the next.
    expect(backend?.metrics.accuracy?.median).toBeCloseTo(0.9);
  });
});

describe('REPORT-04 a backend that completed too few tasks is withheld separately', () => {
  it('names the completed under-sample rather than flattening it into the corpus one', () => {
    const cells = [
      ...['t1', 't2'].flatMap((id) =>
        [1, 2, 3].map((r) => scoredCell(id, 'openai', r, 'technical', { accuracy: 0.95 })),
      ),
      ...['t3', 't4', 't5', 't6'].flatMap((id) =>
        [1, 2, 3].map((r) =>
          scoredCell(id, 'openai', r, 'technical', {}, { outcome: 'failed', failureKind: '429' }),
        ),
      ),
    ];
    const agg = aggregate({ cells, corpus: corpus(SIX) });
    const group = agg.categoryGroups.find((g) => g.provider === 'openai');
    expect(group?.tasksCompleted).toBe(2);
    expect(group?.verdict.scorable).toBe(false);
    if (group?.verdict.scorable === false) {
      expect(group.verdict.reason).toBe('under-sampled-completed');
      expect(group.verdict.why).toMatch(/whichever tasks it happened to finish/);
      expect(group.verdict.why).toMatch(/re-running the failed cells/);
    }
  });

  it('reports nothing-completed distinctly from an under-sample', () => {
    const cells = SIX.flatMap((t) =>
      [1, 2, 3].map((r) =>
        scoredCell(t.id, 'local-codex', r, 'technical', {}, { outcome: 'failed', failureKind: 'argv' }),
      ),
    );
    const agg = aggregate({ cells, corpus: corpus(SIX) });
    const group = agg.categoryGroups[0];
    expect(group?.verdict.scorable).toBe(false);
    if (group?.verdict.scorable === false) expect(group.verdict.reason).toBe('nothing-completed');
  });
});

describe('REPORT-07 and REPORT-29 completion rate, and what failed', () => {
  it('counts failures in the rate and keeps them out of every metric sample', () => {
    const cells = [
      scoredCell('t1', 'gemini', 1, 'technical', { accuracy: 1 }),
      scoredCell('t1', 'gemini', 2, 'technical', {}, { outcome: 'failed', failureKind: '429' }),
      scoredCell('t1', 'gemini', 3, 'technical', { accuracy: 1 }),
    ];
    const agg = aggregate({ cells, corpus: corpus([task('t1', 'technical')]) });
    const group = agg.taskGroups[0];
    expect(group?.completion).toMatchObject({ attempted: 3, completed: 2, failed: 1 });
    expect(group?.completion.rate).toBeCloseTo(2 / 3);
    // Two values, not three, and certainly not a third value of zero.
    expect(group?.metrics.accuracy?.n).toBe(2);
    expect(group?.metrics.accuracy?.median).toBe(1);
  });

  it('names the failure kinds per backend, so a rate limit is not a broken adapter', () => {
    const cells = [
      scoredCell('t1', 'openai', 1, 'technical', {}, { outcome: 'failed', failureKind: '429' }),
      scoredCell('t1', 'openai', 2, 'technical', {}, { outcome: 'failed', failureKind: '429' }),
      scoredCell('t1', 'openai', 3, 'technical', {}, { outcome: 'failed', failureKind: 'timeout' }),
    ];
    const agg = aggregate({ cells, corpus: corpus([task('t1', 'technical')]) });
    expect(agg.backends[0]?.completion.failureKinds).toEqual({ '429': 2, timeout: 1 });
  });

  it('treats an unclassified failure as unclassified rather than dropping it', () => {
    const cells = [scoredCell('t1', 'x', 1, 'technical', {}, { outcome: 'failed' })];
    const agg = aggregate({ cells, corpus: corpus([task('t1', 'technical')]) });
    expect(agg.backends[0]?.completion.failureKinds).toEqual({ unclassified: 1 });
  });
});

describe('REPORT-17 two-stage aggregation', () => {
  it('collapses repetitions within a task before tasks within a category', () => {
    // One task is run five times and drifts wildly; five others are run three
    // times each and are steady. Averaged in one pass the noisy task would
    // pull the category; collapsed first, it contributes one median.
    const cells = [
      ...[1, 2, 3, 4, 5].map((r) =>
        scoredCell('t1', 'gemini', r, 'technical', { accuracy: r === 5 ? 1 : 0 }),
      ),
      ...['t2', 't3', 't4', 't5', 't6'].flatMap((id) =>
        [1, 2, 3].map((r) => scoredCell(id, 'gemini', r, 'technical', { accuracy: 1 })),
      ),
    ];
    const agg = aggregate({ cells, corpus: corpus(SIX) });
    const t1 = agg.taskGroups.find((g) => g.taskId === 't1');
    expect(t1?.metrics.accuracy?.median).toBe(0);
    expect(t1?.metrics.accuracy?.n).toBe(5);

    // Six task medians: 0, 1, 1, 1, 1, 1. Median of those is 1.
    const group = agg.categoryGroups.find((g) => g.category === 'technical');
    expect(group?.metrics.accuracy?.n).toBe(6);
    expect(group?.metrics.accuracy?.median).toBe(1);
  });

  it('labels a category spread as being across tasks, not repetitions', () => {
    const cells = SIX.flatMap((t, i) =>
      [1, 2].map((r) => scoredCell(t.id, 'gemini', r, 'technical', { accuracy: i / 10 })),
    );
    const agg = aggregate({ cells, corpus: corpus(SIX) });
    const group = agg.categoryGroups.find((g) => g.category === 'technical');
    // Two repetitions per task withholds the stage-1 spread ...
    expect(agg.taskGroups[0]?.metrics.accuracy?.spread).toBeNull();
    // ... while six tasks clears the stage-2 floor.
    expect(group?.metrics.accuracy?.spread).not.toBeNull();
  });
});

describe('REPORT-25 a category nobody ran still appears', () => {
  it('shows a corpus category with no cells rather than dropping it', () => {
    const tasks = [...SIX, task('l1', 'legal-regulatory')];
    const cells = SIX.flatMap((t) =>
      [1, 2, 3].map((r) => scoredCell(t.id, 'gemini', r, 'technical', { accuracy: 0.5 })),
    );
    const agg = aggregate({ cells, corpus: corpus(tasks) });
    const legal = agg.categoryGroups.find((g) => g.category === 'legal-regulatory');
    expect(legal).toBeDefined();
    expect(legal?.completion.attempted).toBe(0);
    expect(agg.corpus.tasksByCategory['legal-regulatory']).toBe(1);
  });

  it('does not invent a category the corpus has no task in', () => {
    const agg = aggregate({ cells: [], corpus: corpus(SIX) });
    expect(agg.categoryGroups).toHaveLength(0);
    expect(agg.corpus.tasksByCategory['social-sentiment']).toBe(0);
  });
});

describe('REPORT-05 and REPORT-12 the floors and the stale count', () => {
  it('takes a configured minimum and reports it back', () => {
    const tasks = [task('c1', 'contested'), task('c2', 'contested')];
    const cells = tasks.flatMap((t) =>
      [1, 2, 3].map((r) => scoredCell(t.id, 'gemini', r, 'contested', { accuracy: 1 })),
    );
    const agg = aggregate({ cells, corpus: corpus(tasks), minTasksPerCategory: 2 });
    expect(agg.minTasksPerCategory).toBe(2);
    expect(agg.underSampledCategories).toEqual([]);
    expect(agg.categoryGroups[0]?.verdict.scorable).toBe(true);
  });

  it('defaults to five and refuses a nonsense floor', () => {
    expect(aggregate({ cells: [], corpus: corpus([]) }).minTasksPerCategory).toBe(
      MIN_TASKS_PER_CATEGORY,
    );
    expect(() => aggregate({ cells: [], corpus: corpus([]), minTasksPerCategory: 0 })).toThrow(
      /positive integer/,
    );
  });

  it('carries the stale count and share through to the aggregate', () => {
    const tasks = [task('t1', 'technical', true), task('t2', 'technical'), task('t3', 'technical')];
    const agg = aggregate({ cells: [], corpus: corpus(tasks) });
    expect(agg.corpus.staleTasks).toBe(1);
    expect(agg.corpus.staleShare).toBeCloseTo(1 / 3);
    expect(agg.corpus.staleIds).toEqual(['t1']);
  });
});

describe('REPORT-11 the unchecked share', () => {
  it('is the unchecked count over everything looked at', () => {
    expect(uncheckedShare({ present: 1, absent: 1, unchecked: 2, invalid: 0 })).toBeCloseTo(0.5);
  });

  it('is null when nothing was looked at, rather than a flattering zero', () => {
    expect(uncheckedShare({ present: 0, absent: 0, unchecked: 0, invalid: 0 })).toBeNull();
  });

  it('sums the registry counts across every cell', () => {
    const cells = [
      scoredCell('t1', 'gemini', 1, 'technical', {}, {
        registry: { present: 1, absent: 0, unchecked: 3, invalid: 0 },
      }),
      scoredCell('t1', 'gemini', 2, 'technical', {}, {
        registry: { present: 0, absent: 1, unchecked: 5, invalid: 1 },
      }),
    ];
    const agg = aggregate({ cells, corpus: corpus([task('t1', 'technical')]) });
    expect(agg.registry).toEqual({ present: 1, absent: 1, unchecked: 8, invalid: 1 });
  });
});

describe('REPORT-13 cost and wall clock', () => {
  it('is taken over completed cells only, so a fast failure cannot flatter the median', () => {
    const cells = [
      scoredCell('t1', 'gemini', 1, 'technical', { accuracy: 1 }, { wallClockMs: 600_000, estimatedCostUsd: 3 }),
      scoredCell('t1', 'gemini', 2, 'technical', { accuracy: 1 }, { wallClockMs: 600_000, estimatedCostUsd: 3 }),
      scoredCell('t1', 'gemini', 3, 'technical', {}, { outcome: 'failed', wallClockMs: 900, estimatedCostUsd: 0 }),
    ];
    const agg = aggregate({ cells, corpus: corpus([task('t1', 'technical')]) });
    expect(agg.taskGroups[0]?.wallClockMs?.median).toBe(600_000);
    expect(agg.taskGroups[0]?.costUsd?.median).toBe(3);
  });

  it('reports a total spend even where the category is not scorable', () => {
    // A price is a fact about what was paid. Withholding it because a category
    // is under-sampled would hide the money actually spent.
    const cells = [1, 2, 3].map((r) =>
      scoredCell('c1', 'gemini', r, 'contested', {}, { estimatedCostUsd: 4 }),
    );
    const agg = aggregate({ cells, corpus: corpus([task('c1', 'contested')]) });
    expect(agg.backends[0]?.totalCostUsd).toBeCloseTo(12);
    expect(agg.backends[0]?.scorableCategories).toEqual([]);
  });
});

describe('an orphan cell is counted, never silently dropped', () => {
  it('names a cell whose task the corpus no longer holds', () => {
    const cells = [scoredCell('gone', 'gemini', 1, 'technical', { accuracy: 1 })];
    const agg = aggregate({ cells, corpus: corpus([task('t1', 'technical')]) });
    expect(agg.orphanCells).toEqual(['gone/gemini/1']);
    expect(agg.overall.attempted).toBe(0);
  });

  it('merges orphan keys the caller could not harvest at all', () => {
    const agg = aggregate({
      cells: [],
      corpus: corpus([task('t1', 'technical')]),
      orphanCells: ['ghost/openai/2'],
    });
    expect(agg.orphanCells).toEqual(['ghost/openai/2']);
  });
});

describe('ordering is deterministic', () => {
  it('sorts providers and task groups, so two runs render identically', () => {
    const cells = [
      scoredCell('t2', 'zeta', 1, 'technical', { accuracy: 1 }),
      scoredCell('t1', 'alpha', 1, 'technical', { accuracy: 1 }),
    ];
    const agg = aggregate({
      cells,
      corpus: corpus([task('t1', 'technical'), task('t2', 'technical')]),
    });
    expect(agg.providers).toEqual(['alpha', 'zeta']);
    expect(agg.taskGroups.map((g) => g.taskId)).toEqual(['t1', 't2']);
  });
});
