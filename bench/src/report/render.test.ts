import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { aggregate } from './aggregate.js';
import { formatValue, rankings, render, renderJson, renderMarkdown } from './render.js';
import { summarise } from './spread.js';
import { corpus, scoredCell, task } from './fixtures.js';
import type { DatingCounts } from '../score/recency.js';

const SIX = ['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => task(id, 'technical'));

/** A corpus with a scorable category, an under-sampled one and a stale task. */
function realistic(over: { readonly dating?: DatingCounts } = {}) {
  const tasks = [
    ...['t1', 't2', 't3', 't4', 't5'].map((id) => task(id, 'technical')),
    task('t6', 'technical', true),
    task('c1', 'contested'),
    task('c2', 'contested'),
  ];
  const cells = [
    ...['t1', 't2', 't3', 't4', 't5', 't6'].flatMap((id, i) =>
      [1, 2, 3].map((r) =>
        scoredCell(
          id,
          'gemini',
          r,
          'technical',
          {
            accuracy: 0.6 + i * 0.05,
            'citation-accuracy': 0.8,
            'citation-sources': 40 + i,
          },
          {
            stale: id === 't6',
            registry: { present: 2, absent: 0, unchecked: 7, invalid: 0 },
          },
        ),
      ),
    ),
    ...['t1', 't2', 't3', 't4', 't5', 't6'].flatMap((id, i) =>
      [1, 2, 3].map((r) =>
        scoredCell(
          id,
          'perplexity',
          r,
          'technical',
          { accuracy: 0.4 + i * 0.04, 'citation-accuracy': 0.9, 'citation-sources': 9 },
          { stale: id === 't6', estimatedCostUsd: 0.5, wallClockMs: 120_000 },
        ),
      ),
    ),
    ...['t1', 't2'].flatMap((id) =>
      [1, 2, 3].map((r) =>
        scoredCell(id, 'openai', r, 'technical', {}, { outcome: 'failed', failureKind: '429' }),
      ),
    ),
    ...['c1', 'c2'].flatMap((id) =>
      [1, 2, 3].map((r) => scoredCell(id, 'gemini', r, 'contested', { accuracy: 0.4 })),
    ),
  ];
  // Put the dating counts on exactly one cell rather than on every one, so the
  // rendered totals are the numbers the test names rather than a multiple of
  // them that nobody reading the assertion could check.
  const dating = over.dating;
  const withDating =
    dating === undefined ? cells : cells.map((c, i) => (i === 0 ? { ...c, dating } : c));
  return aggregate({ cells: withDating, corpus: corpus(tasks) });
}

describe('REPORT-06 no value is ever bare', () => {
  it('carries the sample size and the spread when there is one', () => {
    expect(formatValue(summarise([0.1, 0.2, 0.3], 3))).toBe('0.2 [0.15-0.25] (n=3)');
  });

  it('carries the sample size and says the spread is absent when there is not', () => {
    expect(formatValue(summarise([0.4], 1))).toBe('0.4 (n=1, no spread)');
  });

  it('says a metric was not measured rather than printing a zero', () => {
    expect(formatValue(null)).toBe('not measured');
    expect(formatValue(null)).not.toContain('0');
  });

  it('renders every metric cell with an n or with "not measured"', () => {
    const whole = renderMarkdown(realistic());
    // The score tables only. The validity panel above them is counts and
    // failure kinds by design, and it is what gives those scores their context.
    const markdown = whole.slice(whole.indexOf('## Per-backend scorecard'), whole.indexOf('## By category'));
    for (const line of markdown.split('\n')) {
      if (!line.startsWith('| gemini |') && !line.startsWith('| perplexity |')) continue;
      for (const cellText of line.split('|').slice(3)) {
        const text = cellText.trim();
        if (text === '') continue;
        // Every score column is a value with a sample size, a "not measured",
        // a completion rate, a price, a wall clock, a registry count or an
        // explicit "nothing checked". Nothing is a number standing on its own.
        expect(text).toMatch(/n=\d|not measured|nothing checked|%|\$|s$|^\d+$/);
      }
    }
  });
});

describe('REPORT-11 and REPORT-12 the validity panel comes first', () => {
  const markdown = renderMarkdown(realistic());
  const indexOf = (needle: string): number => markdown.indexOf(needle);

  it('puts the completion-rate table above the first score', () => {
    expect(indexOf('### Completion rate')).toBeGreaterThan(-1);
    expect(indexOf('### Completion rate')).toBeLessThan(indexOf('## Per-backend scorecard'));
  });

  it('puts the stale count above the first score, with its share', () => {
    expect(indexOf('### Stale tasks')).toBeLessThan(indexOf('## Per-backend scorecard'));
    expect(markdown).toMatch(/\*\*1 of 8 tasks are stale\*\* \(12\.5%\)/);
    expect(markdown).toContain('Stale: t6.');
  });

  it('puts the unchecked registry count above the first score, with the BENCH-03 caveat', () => {
    expect(indexOf('### Registry checks, and how many never ran')).toBeLessThan(
      indexOf('## Per-backend scorecard'),
    );
    expect(markdown).toMatch(/came back `unchecked`/);
    expect(markdown).toMatch(/arXiv rate-limiting/);
    expect(markdown).toMatch(/Crossref alone would report a genuine DOI as fabricated/);
    expect(markdown).toMatch(/checks that never ran/);
  });

  it('says a failed cell is counted here and nowhere else', () => {
    expect(markdown).toMatch(/reaches no metric denominator/);
    expect(markdown).toMatch(/never scored as a zero/);
  });

  it('names the failure kinds so a rate limit is legible', () => {
    expect(markdown).toMatch(/\| openai \| 6 \| 0 \| 0\.0% \(0\/6\) \| 429 6 \|/);
  });

  it('says when nothing was checked at all, rather than showing a flattering zero', () => {
    const agg = aggregate({
      cells: SIX.flatMap((t) => [1, 2, 3].map((r) => scoredCell(t.id, 'a', r, 'technical', { accuracy: 1 }))),
      corpus: corpus(SIX),
    });
    expect(renderMarkdown(agg)).toMatch(/No identifier was checked against a registry/);
  });
});

describe('REPORT-13 cost and wall clock sit beside the scores', () => {
  it('renders a cost table with a total and a median per cell', () => {
    const markdown = renderMarkdown(realistic());
    expect(markdown).toContain('## What it cost');
    expect(markdown).toContain('Median cost per cell');
    expect(markdown).toContain('Median wall clock');
    expect(markdown).toMatch(/\$\d+\.\d\d/);
    expect(markdown).toMatch(/estimate band, never a quote/);
  });
});

describe('REPORT-09 accuracy and volume are separate columns', () => {
  const markdown = renderMarkdown(realistic());

  it('renders two citation tables, not one', () => {
    expect(markdown).toContain('### Citation accuracy');
    expect(markdown).toContain('### Citation volume');
    expect(markdown).toMatch(/Accuracy and volume are two tables and never one number/);
  });

  it('keeps a volume column out of the accuracy table', () => {
    const accuracySection = markdown.slice(
      markdown.indexOf('### Citation accuracy'),
      markdown.indexOf('### Citation volume'),
    );
    expect(accuracySection).toContain('Citation accuracy');
    expect(accuracySection).not.toContain('Sources cited');
    expect(accuracySection).not.toContain('Independent domains');
  });

  it('keeps an accuracy column out of the volume table', () => {
    const volumeSection = markdown.slice(
      markdown.indexOf('### Citation volume'),
      markdown.indexOf('### Registry checks per backend'),
    );
    expect(volumeSection).toContain('Sources cited');
    expect(volumeSection).not.toContain('| Citation accuracy |');
    expect(volumeSection).toMatch(/never ranked and never combined/);
  });

  it('keeps the citation metrics out of the report-quality scorecard entirely', () => {
    const scorecard = markdown.slice(
      markdown.indexOf('## Per-backend scorecard'),
      markdown.indexOf('## Citations'),
    );
    expect(scorecard).toContain('Accuracy');
    expect(scorecard).not.toContain('Sources cited');
    expect(scorecard).not.toContain('Citation accuracy');
  });
});

describe('REPORT-03 and REPORT-05 the under-sampled category on the page', () => {
  const markdown = renderMarkdown(realistic());

  it('names the under-sampled category and its task count', () => {
    expect(markdown).toMatch(/Under-sampled and therefore unscored:\*\* contested \(2 tasks\)/);
    expect(markdown).toMatch(/authoring tasks, not re-running research/);
  });

  it('renders under-sampled rather than a score in every category matrix', () => {
    const matrix = markdown.slice(markdown.indexOf('### Accuracy\n'), markdown.indexOf('### Relevance'));
    expect(matrix).toMatch(/\| contested \| 2 \| under-sampled \|/);
  });

  it('prints the floors in force at the top', () => {
    expect(markdown).toMatch(/a spread needs 3 results; a category needs 5 tasks/);
  });

  it('prints a lowered floor rather than the default', () => {
    const tasks = [task('c1', 'contested'), task('c2', 'contested')];
    const cells = tasks.flatMap((t) =>
      [1, 2, 3].map((r) => scoredCell(t.id, 'gemini', r, 'contested', { accuracy: 1 })),
    );
    const agg = aggregate({ cells, corpus: corpus(tasks), minTasksPerCategory: 2 });
    expect(renderMarkdown(agg)).toMatch(/a category needs 2 tasks/);
  });

  it('shows a backend withheld for completing too few tasks, with the count', () => {
    const cells = [
      ...['t1', 't2'].flatMap((id) =>
        [1, 2, 3].map((r) => scoredCell(id, 'openai', r, 'technical', { accuracy: 1 })),
      ),
      ...['t3', 't4', 't5', 't6'].flatMap((id) =>
        [1, 2, 3].map((r) =>
          scoredCell(id, 'openai', r, 'technical', {}, { outcome: 'failed', failureKind: '429' }),
        ),
      ),
    ];
    const agg = aggregate({ cells, corpus: corpus(SIX) });
    expect(renderMarkdown(agg)).toMatch(/withheld \(2\/6 tasks\)/);
  });
});

describe('REPORT-01 and REPORT-18 the ranking on the page', () => {
  it('states no ranking at all when every cell was run once', () => {
    const cells = SIX.map((t) => scoredCell(t.id, 'gemini', 1, 'technical', { accuracy: 0.8 })).concat(
      SIX.map((t) => scoredCell(t.id, 'openai', 1, 'technical', { accuracy: 0.4 })),
    );
    const markdown = renderMarkdown(aggregate({ cells, corpus: corpus(SIX) }));
    expect(markdown).toMatch(/\*\*No ranking is stated\.\*\*/);
    expect(markdown).toMatch(/the sample is what cannot order them/);
    // The numbers are still there. Refusing to rank is not refusing to report.
    expect(markdown).toMatch(/80\.0%/);
    expect(markdown).toMatch(/40\.0%/);
  });

  it('states a ranking when the sample supports it, with the overlap note', () => {
    const markdown = renderMarkdown(realistic());
    expect(markdown).toContain('### Accuracy, technical');
    expect(markdown).toMatch(/not a significance test/);
    expect(markdown).toMatch(/BENCH-13/);
  });

  it('lists everything withheld with the condition that failed', () => {
    const markdown = renderMarkdown(realistic());
    const withheld = markdown.slice(markdown.indexOf('### Withheld'));
    expect(withheld).toContain('scope-not-scorable');
    expect(withheld).toContain('metric-not-measured');
  });

  it('names the excluded categories on the backend overall', () => {
    const agg = realistic();
    const gemini = agg.backends.find((b) => b.provider === 'gemini');
    expect(gemini?.excludedCategories.map((e) => e.category)).toEqual(['contested']);
    expect(gemini?.scorableCategories).toEqual(['technical']);
  });
});

describe('DATE-23 and DATE-24 the report prints what recency is computed over', () => {
  // REPORT-21 asserted that recency renders unavailable and is corrected in
  // place in `docs/test-plan.md`. The reason it named no longer exists.

  it('DATE-24 no longer claims recency is unavailable', () => {
    const markdown = renderMarkdown(
      realistic({ dating: { dated: 12, absent: 25, unchecked: 3, afterHorizon: 0 } }),
    );
    expect(markdown).not.toMatch(/Recency is unavailable/);
    expect(markdown).not.toMatch(/no publication date is recorded/);
    expect(markdown).toMatch(/\*\*Recency is measured over the sources that could be dated\*\*/);
  });

  it('DATE-24 a report where nothing was dated says so in the limits too, rather than "0 of 0"', () => {
    // Two sections ten apart said different things about the same emptiness:
    // the panel said no source was checked, the limits said 0 of 0 could not be
    // dated, which reads as a clean bill of health. Found by an out-of-family
    // review.
    const markdown = renderMarkdown(realistic());
    expect(markdown).toMatch(/\*\*Recency was measured over nothing here\*\*/);
    expect(markdown).not.toMatch(/0 of 0 cited sources could not be/);
  });

  it('DATE-24 the metric caveat says what the figure is over, not that it cannot be computed', () => {
    const markdown = renderMarkdown(realistic());
    expect(markdown).toMatch(/share of \*\*datable\*\* sources/);
  });

  it('DATE-23 counts the sources it could and could not date, with the two causes apart', () => {
    const markdown = renderMarkdown(
      realistic({ dating: { dated: 12, absent: 25, unchecked: 3, afterHorizon: 0 } }),
    );
    expect(markdown).toMatch(/### Publication dates, and how many could not be established/);
    expect(markdown).toMatch(/\*\*28 of 40 cited sources could not be dated\*\* \(70\.0%\)/);
    expect(markdown).toMatch(
      /Dated 12; read and carrying no date 25; never read, or read only as far as the byte cap, 3; dated later than the task's as-of date, 0\./,
    );
  });

  it('DATE-23 counts a source dated after the as-of date apart from the ones that could be graded', () => {
    // `Dated` has to be the denominator of the share printed above it. A source
    // stated as published after the task's own as-of date carries a date and
    // cannot be graded against a horizon it precedes.
    const markdown = renderMarkdown(
      realistic({ dating: { dated: 3, absent: 1, unchecked: 0, afterHorizon: 2 } }),
    );
    expect(markdown).toMatch(/\*\*3 of 6 cited sources could not be dated\*\* \(50\.0%\)/);
    expect(markdown).toMatch(/dated later than the task's as-of date, 2\./);
  });

  it('DATE-23 says plainly that nothing was checked rather than printing a zero share', () => {
    const markdown = renderMarkdown(realistic());
    expect(markdown).toMatch(/No cited source was checked for a publication date/);
  });
});

describe('REPORT-24 rendering is deterministic', () => {
  it('renders byte-identical markdown twice', () => {
    const agg = realistic();
    expect(renderMarkdown(agg)).toBe(renderMarkdown(agg));
    expect(renderMarkdown(realistic())).toBe(renderMarkdown(realistic()));
  });

  it('renders byte-identical json twice', () => {
    expect(renderJson(realistic())).toBe(renderJson(realistic()));
  });
});

describe('REPORT-30 the json carries everything the markdown summarises', () => {
  it('includes the per-task groups, the verdicts and the rankings', () => {
    const parsed: unknown = JSON.parse(renderJson(realistic()));
    expect(parsed).toMatchObject({
      aggregate: {
        minTasksPerCategory: 5,
        corpus: { staleTasks: 1 },
      },
    });
    const typed = parsed as {
      aggregate: { taskGroups: unknown[]; categoryGroups: unknown[]; backends: unknown[] };
      rankings: unknown[];
    };
    expect(typed.aggregate.taskGroups.length).toBeGreaterThan(0);
    expect(typed.aggregate.categoryGroups.length).toBeGreaterThan(0);
    expect(typed.aggregate.backends.length).toBe(3);
    expect(typed.rankings.length).toBeGreaterThan(0);
  });

  it('routes both formats through one entry point', () => {
    const agg = realistic();
    expect(render(agg, 'markdown')).toBe(renderMarkdown(agg));
    expect(render(agg, 'json')).toBe(renderJson(agg));
  });
});

describe('an empty store renders a report rather than crashing', () => {
  it('says there are no cells instead of printing a table of nothing', () => {
    const markdown = renderMarkdown(aggregate({ cells: [], corpus: corpus([]) }));
    expect(markdown).toContain('_No cells recorded._');
    expect(markdown).toContain('_No tasks loaded._');
    expect(markdown).toMatch(/\*\*No ranking is stated\.\*\*/);
  });
});

describe('a pipeline gap is named as ours, not as a backend result', () => {
  it('lists it in the validity panel', () => {
    const cells = [
      scoredCell('t1', 'gemini', 1, 'technical', {}, { gaps: ['t1/gemini/1: no snapshot'] }),
    ];
    const markdown = renderMarkdown(aggregate({ cells, corpus: corpus([task('t1', 'technical')]) }));
    expect(markdown).toContain('### Gaps in this pipeline, not in the backends');
    expect(markdown).toContain('t1/gemini/1: no snapshot');
  });

  it('names an orphan cell and says the corpus moved', () => {
    const cells = [scoredCell('gone', 'gemini', 1, 'technical', { accuracy: 1 })];
    const markdown = renderMarkdown(aggregate({ cells, corpus: corpus([task('t1', 'technical')]) }));
    expect(markdown).toMatch(/name a task the corpus no longer holds/);
    expect(markdown).toContain('gone/gemini/1');
  });
});

describe('REPORT-23 rendering is pure over stored bytes', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it('imports no filesystem and no network anywhere except the CLI', () => {
    // Read from their own source rather than asserted in prose. The property
    // this protects is the one `docs/plan/benchmark.md` bought by separating
    // the run from the scoring: a metric added later applies to research
    // already paid for, and it stops being true the moment rendering needs a
    // disk. `cli.ts` is the single documented exception; `fixtures.ts` and the
    // tests are not shipped logic, and `render.test.ts` reads source on purpose.
    const exempt = new Set(['cli.ts', 'fixtures.ts']);
    const files = readdirSync(here).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !exempt.has(f),
    );
    expect(files.length).toBeGreaterThan(4);
    for (const file of files) {
      const source = readFileSync(join(here, file), 'utf8');
      const imports = [...source.matchAll(/^import[^;]*from\s+'([^']+)'/gm)].map((m) => m[1] ?? '');
      for (const specifier of imports) {
        expect(specifier, `${file} imports ${specifier}`).not.toMatch(
          /^node:(fs|http|https|net|dns|child_process|worker_threads)/,
        );
      }
      expect(source, `${file} reaches a network`).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it('keeps the exception to exactly one file, so the exemption cannot quietly grow', () => {
    const cli = readFileSync(join(here, 'cli.ts'), 'utf8');
    expect(cli).toMatch(/from 'node:fs'/);
    expect(cli).not.toMatch(/\bfetch\s*\(/);
    // Nothing here can start a run, and that is structural rather than a
    // promise. Asserted on the imports rather than on the text, because the
    // doc comment above them says the same thing and a prose match would pass
    // on the comment while the import sat underneath it.
    const imports = [...cli.matchAll(/^import[^;]*from\s+'([^']+)'/gm)].map((m) => m[1] ?? '');
    for (const specifier of imports) {
      expect(specifier, `cli.ts imports ${specifier}`).not.toMatch(/runner|providers|gemini/);
    }
  });
});

describe('a value that could not be measured never becomes a zero on the page', () => {
  it('prints the reason family rather than a number', () => {
    const cells = SIX.flatMap((t) =>
      [1, 2, 3].map((r) => scoredCell(t.id, 'gemini', r, 'technical', { accuracy: 0.5 })),
    );
    const markdown = renderMarkdown(aggregate({ cells, corpus: corpus(SIX) }));
    const scorecard = markdown.slice(
      markdown.indexOf('## Per-backend scorecard'),
      markdown.indexOf('## Citations'),
    );
    expect(scorecard).toContain('not measured');
    expect(scorecard).not.toMatch(/\|\s*0\.0%\s*\|/);
  });

  it('reports every ranking for an unmeasured metric as not measured', () => {
    const cells = SIX.flatMap((t) =>
      [1, 2, 3].map((r) => scoredCell(t.id, 'gemini', r, 'technical', { accuracy: 0.5 })),
    );
    const all = rankings(aggregate({ cells, corpus: corpus(SIX) }));
    const refusal = all.filter((r) => r.metric === 'refusal');
    expect(refusal.length).toBeGreaterThan(0);
    for (const r of refusal) expect(r.withheld).toBe('metric-not-measured');
  });
});

describe('REPORT-01 a spread the runs cannot support is marked, not printed plain', () => {
  /**
   * The defect this guards was found in this slice's own output, which is the
   * strongest available evidence the rule is worth enforcing. Six tasks run
   * ONCE each produce a genuine six-task spread. Ranking is withheld, but the
   * matrix cell still read `74.5% [68.3%-80.8%] (n=6)`, which to anybody
   * skimming is a confident figure with run-to-run variance attached. It has
   * neither.
   */
  const singleRun = () => {
    const cells = SIX.map((t, i) =>
      scoredCell(t.id, 'gemini', 1, 'technical', { accuracy: 0.5 + i * 0.05 }),
    ).concat(SIX.map((t, i) => scoredCell(t.id, 'openai', 1, 'technical', { accuracy: 0.2 + i * 0.05 })));
    return aggregate({ cells, corpus: corpus(SIX) });
  };

  it('marks the matrix value when the tasks behind it were run once', () => {
    const markdown = renderMarkdown(singleRun());
    const matrix = markdown.slice(markdown.indexOf('### Accuracy\n'), markdown.indexOf('### Relevance'));
    expect(matrix).toMatch(/\(n=6\) †/);
  });

  it('explains the mark, in the same section as the tables that carry it', () => {
    const markdown = renderMarkdown(singleRun());
    const section = markdown.slice(markdown.indexOf('## By category'), markdown.indexOf('## Rankings'));
    expect(section).toMatch(/† comes from tasks that were not repeated enough/);
    expect(section).toMatch(/The number is real; it is never ranked/);
  });

  it('states no ranking for the same figures, so the mark and the refusal agree', () => {
    expect(renderMarkdown(singleRun())).toMatch(/\*\*No ranking is stated\.\*\*/);
  });

  it('leaves the mark off once the repetitions clear the floor', () => {
    const cells = SIX.flatMap((t, i) =>
      [1, 2, 3].map((r) => scoredCell(t.id, 'gemini', r, 'technical', { accuracy: 0.5 + i * 0.05 })),
    );
    const markdown = renderMarkdown(aggregate({ cells, corpus: corpus(SIX) }));
    const matrix = markdown.slice(markdown.indexOf('### Accuracy\n'), markdown.indexOf('### Relevance'));
    expect(matrix).toContain('(n=6)');
    expect(matrix).not.toContain('†');
  });

  it('does not mark a cell that has no value to mark', () => {
    const markdown = renderMarkdown(singleRun());
    expect(markdown).not.toMatch(/not measured †/);
  });
});

describe('the citation headings nest under their section', () => {
  it('renders both citation tables at heading level three, under Citations', () => {
    const markdown = renderMarkdown(realistic());
    // Built from a passed heading level rather than rewritten afterwards: a
    // `.replace('## x', '### x')` works until somebody edits the title, then
    // stops silently and the section nests wrongly with nothing failing.
    expect(markdown).toContain('## Citations');
    expect(markdown).toContain('### Citation accuracy');
    expect(markdown).toContain('### Citation volume');
    // Matched at the start of a line: `### X` contains `## X` as a substring,
    // so a bare `toContain` would pass against the very nesting bug this
    // guards.
    const headings = markdown.split('\n').filter((l) => l.startsWith('#'));
    expect(headings).toContain('### Citation accuracy');
    expect(headings).toContain('### Citation volume');
    expect(headings).not.toContain('## Citation accuracy');
    expect(headings).not.toContain('## Citation volume');
  });

  it('keeps the top-level scorecard at heading level two', () => {
    expect(renderMarkdown(realistic())).toContain('## Per-backend scorecard');
  });
});

/** Two categories of five tasks, three repetitions, which is the smallest set anything can be compared on. */
function comparable(values: (category: string) => { alpha: number; beta: number }) {
  const categories = ['technical', 'contested'] as const;
  const tasks = categories.flatMap((category) =>
    [1, 2, 3, 4, 5].map((n) => task(`${category}-${String(n)}`, category)),
  );
  const cells = categories.flatMap((category) =>
    [1, 2, 3, 4, 5].flatMap((n) =>
      [1, 2, 3].flatMap((r) => [
        scoredCell(`${category}-${String(n)}`, 'alpha', r, category, {
          accuracy: values(category).alpha,
        }),
        scoredCell(`${category}-${String(n)}`, 'beta', r, category, {
          accuracy: values(category).beta,
        }),
      ]),
    ),
  );
  return aggregate({ cells, corpus: corpus(tasks) });
}

describe('STAT-03 and STAT-14 what the differences section says', () => {
  it('puts the separability sentence above every score, not under them', () => {
    const markdown = renderMarkdown(realistic());
    const headline = markdown.indexOf('What this corpus can actually distinguish');
    expect(headline).toBeGreaterThan(-1);
    expect(headline).toBeLessThan(markdown.indexOf('## Per-backend scorecard'));
    expect(headline).toBeLessThan(markdown.indexOf('## Citations'));
    expect(headline).toBeLessThan(markdown.indexOf('## Rankings'));
  });

  it('says plainly that nothing is distinguishable, when nothing is', () => {
    const markdown = renderMarkdown(realistic());
    expect(markdown).toMatch(/\*\*Almost nothing here is distinguishable yet\.\*\*/);
    expect(markdown).toMatch(/authoring tasks, not loosening the statistics/);
  });

  it('renders a crossing interval as the literal words and no point estimate', () => {
    // The gap flips sign between the two categories, so resampling categories
    // straddles zero however large either gap is on its own.
    const markdown = renderMarkdown(
      comparable((c) => (c === 'technical' ? { alpha: 0.9, beta: 0.2 } : { alpha: 0.2, beta: 0.9 })),
    );
    const section = markdown.slice(
      markdown.indexOf('## Differences between backends'),
      markdown.indexOf('## Reliability'),
    );
    expect(section).toContain('no measured difference');
    expect(section).toMatch(/\| alpha vs beta \| 10 \| no measured difference \|/);
  });

  it('renders a measured difference with its interval and both standard errors', () => {
    const markdown = renderMarkdown(
      comparable((c) => (c === 'technical' ? { alpha: 0.9, beta: 0.2 } : { alpha: 0.85, beta: 0.15 })),
    );
    const section = markdown.slice(
      markdown.indexOf('## Differences between backends'),
      markdown.indexOf('## Reliability'),
    );
    expect(section).toContain('| SE naive | SE clustered | Inflation |');
    expect(section).toMatch(/\| alpha vs beta \| 10 \| 0\.7/);
    expect(section).toMatch(/\*\*The inflation column is the one to read\.\*\*/);
    expect(markdown).toMatch(/1 produced a measured difference/);
  });

  it('counts the refusals by reason instead of printing a thousand rows', () => {
    const markdown = renderMarkdown(realistic());
    const section = markdown.slice(markdown.indexOf('## Differences between backends'));
    expect(section).toContain('| Condition | Comparisons |');
    expect(section).toContain('_No pairwise comparison could be run._');
  });
});

describe('STAT-09 pass@1 beside pass^k', () => {
  it('prints both, with k and the threshold', () => {
    const markdown = renderMarkdown(realistic());
    const section = markdown.slice(
      markdown.indexOf('## Reliability: pass@1 beside pass^k'),
      markdown.indexOf('## Rankings'),
    );
    expect(section).toContain('| Backend | pass@1 | pass^k | k | Tasks counted | Threshold | Pass metric |');
    expect(section).toMatch(/collapsing to 25% pass@8/);
    expect(section).toMatch(/never counted as a failed attempt/);
  });

  it('withholds pass^k below the floor and names it', () => {
    const cells = SIX.flatMap((t) =>
      [1, 2].map((r) => scoredCell(t.id, 'gemini', r, 'technical', { accuracy: 1 })),
    );
    const markdown = renderMarkdown(aggregate({ cells, corpus: corpus(SIX) }));
    const section = markdown.slice(markdown.indexOf('## Reliability'), markdown.indexOf('## Rankings'));
    expect(section).toContain('| gemini | 100.0% | withheld | 2 |');
    expect(section).toMatch(/below the floor of 3/);
  });
});

describe('STAT-11 an under-completed backend renders invalid, not a number', () => {
  it('says invalid in the scorecard rather than printing its accuracy', () => {
    const cells = SIX.flatMap((t) =>
      [1, 2, 3].map((r) =>
        r === 1
          ? scoredCell(t.id, 'gemini', r, 'technical', { accuracy: 0.9 })
          : scoredCell(t.id, 'gemini', r, 'technical', {}, { outcome: 'failed', failureKind: '429' }),
      ),
    );
    const markdown = renderMarkdown(aggregate({ cells, corpus: corpus(SIX) }));
    expect(markdown).toMatch(/invalid \(completed 33\.3%, floor 60\.0%\)/);
    expect(markdown).toMatch(/invalid \(completed 33\.3%\)/);
    expect(markdown).toMatch(/a backend must complete 60\.0% of its attempted cells/);
  });
});

describe('STAT-13 the new sections did not merge the two citation tables', () => {
  it('still keeps accuracy and volume apart, with the differences section between neither', () => {
    const markdown = renderMarkdown(realistic());
    const volumeSection = markdown.slice(
      markdown.indexOf('### Citation volume'),
      markdown.indexOf('### Registry checks per backend'),
    );
    expect(volumeSection).not.toContain('| Citation accuracy |');
    expect(markdown.indexOf('### Citation accuracy')).toBeLessThan(
      markdown.indexOf('### Citation volume'),
    );
  });
});

describe('the JSON carries the statistics, so nothing downstream parses prose', () => {
  it('round-trips the comparisons, the summary and the reliability', () => {
    const parsed: unknown = JSON.parse(renderJson(realistic()));
    expect(parsed).toHaveProperty('comparisons');
    expect(parsed).toHaveProperty('comparisonSummary');
    expect(parsed).toHaveProperty('reliability');
  });

  it('is byte-identical on two renders, which is what the seeded bootstrap buys', () => {
    const agg = comparable((c) =>
      c === 'technical' ? { alpha: 0.9, beta: 0.2 } : { alpha: 0.85, beta: 0.15 },
    );
    expect(renderJson(agg)).toBe(renderJson(agg));
    expect(renderMarkdown(agg)).toBe(renderMarkdown(agg));
  });
});

describe('STAT-18 a refused comparison never falls back to the weaker check', () => {
  it('ties every backend inside a category, because within one nothing can be clustered', () => {
    // Two backends seventy points apart in every task of both categories, with
    // spreads that do not overlap. The interquartile check would have ordered
    // them, on a difference it says on its face it cannot establish. The paired
    // test refuses within a category, and that refusal now decides: the numbers
    // print, and every backend comes out tied at this sample size.
    const markdown = renderMarkdown(comparable(() => ({ alpha: 0.9, beta: 0.2 })));
    const section = markdown.slice(
      markdown.indexOf('### Accuracy, technical'),
      markdown.indexOf('### Accuracy, contested'),
    );
    expect(section).toContain('| 1 | alpha |');
    expect(section).toContain('| 1 (tied) | beta |');
    expect(section).toMatch(/excludes zero/);
  });

  it('states an overall ordering where the paired test does support one', () => {
    // Three categories, so the overall figure clears the spread floor as well.
    const categories = ['technical', 'contested', 'false-premise'] as const;
    const tasks = categories.flatMap((c) =>
      [1, 2, 3, 4, 5].map((n) => task(`${c}-${String(n)}`, c)),
    );
    const cells = categories.flatMap((c) =>
      [1, 2, 3, 4, 5].flatMap((n) =>
        [1, 2, 3].flatMap((r) => [
          scoredCell(`${c}-${String(n)}`, 'alpha', r, c, { accuracy: 0.9 - n * 0.01 }),
          scoredCell(`${c}-${String(n)}`, 'beta', r, c, { accuracy: 0.2 - n * 0.01 }),
        ]),
      ),
    );
    const markdown = renderMarkdown(aggregate({ cells, corpus: corpus(tasks) }));
    const section = markdown.slice(markdown.indexOf('### Accuracy, overall'));
    expect(section).toContain('| 1 | alpha |');
    expect(section).toContain('| 2 | beta |');
    expect(section).toMatch(/excludes zero/);
  });
});

describe('STAT-20 the scorecard and the ranking cannot disagree', () => {
  it('does not print invalid for a backend that failed only an unscored category', () => {
    const aTasks = [1, 2, 3, 4, 5].map((n) => task(`a-${String(n)}`, 'technical'));
    const bTasks = [1, 2, 3, 4, 5].map((n) => task(`b-${String(n)}`, 'contested'));
    const cells = [
      ...aTasks.flatMap((t) =>
        [1, 2, 3].map((r) => scoredCell(t.id, 'alpha', r, 'technical', { accuracy: 0.9 })),
      ),
      ...bTasks.flatMap((t) =>
        [1, 2, 3].map((r) =>
          scoredCell(t.id, 'alpha', r, 'contested', {}, { outcome: 'failed', failureKind: '429' }),
        ),
      ),
    ];
    const markdown = renderMarkdown(aggregate({ cells, corpus: corpus([...aTasks, ...bTasks]) }));
    const scorecard = markdown.slice(
      markdown.indexOf('## Per-backend scorecard'),
      markdown.indexOf('## Citations'),
    );
    expect(scorecard).not.toContain('invalid (');
    expect(scorecard).toContain('90.0%');
  });
});

describe('STAT-21 the reliability table is invalidated too', () => {
  it('prints invalid rather than a perfect score built from the survivors', () => {
    const cells = SIX.flatMap((t) =>
      [1, 2, 3].map((r) =>
        r === 1
          ? scoredCell(t.id, 'gemini', r, 'technical', { accuracy: 1 })
          : scoredCell(t.id, 'gemini', r, 'technical', {}, { outcome: 'failed', failureKind: '429' }),
      ),
    );
    const markdown = renderMarkdown(aggregate({ cells, corpus: corpus(SIX) }));
    const section = markdown.slice(markdown.indexOf('## Reliability'), markdown.indexOf('## Rankings'));
    expect(section).toContain('| gemini | invalid (completed 33.3%) | invalid (completed 33.3%) |');
    expect(section).toMatch(/below the floor of 60\.0%/);
  });
});
