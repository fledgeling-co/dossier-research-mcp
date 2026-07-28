import { describe, expect, it } from 'vitest';
import { aggregate, MIN_TASKS_PER_CATEGORY } from '../report/aggregate.js';
import { corpus, scoredCell, task } from '../report/fixtures.js';
import type { ScoredCell } from '../report/harvest.js';
import { MIN_REPETITIONS_FOR_SPREAD } from '../run/cell.js';
import { evaluateCombinations, evaluateScopes } from './evaluate.js';
import { eligibilityFromAggregate, type MemberProviders } from './eligibility.js';
import { member, run } from './fixtures.js';
import type { CombinationMember } from './member.js';
import type { MeasureLabel } from './frontier.js';

/**
 * The join, end to end, from stored cells to a withheld frontier.
 *
 * Everything else in this directory tests the lattice against fixtures written
 * here. This file tests it against **BENCH-08's real output**: cells go through
 * `aggregate`, the verdicts come out, and the frontier prints the sentence the
 * report prints. A fixture written to agree with itself would prove the shape
 * of the seam and nothing about whether the two slices actually say the same
 * thing.
 */

const ACCURACY: MeasureLabel = { name: 'accuracy', direction: 'higher-is-better' };
const COUNT = (m: { citedUrls: readonly string[] }): number => m.citedUrls.length;

const PROVIDERS = ['gemini', 'perplexity'] as const;

/** One member per backend, which is the ordinary reading of a member. */
function backendMembers(repetitions: number): CombinationMember[] {
  return PROVIDERS.map((provider) => ({
    id: provider,
    independence: 'independent' as const,
    runs: Array.from({ length: repetitions }, (_, i) =>
      run(provider, [`https://${provider}.example.org/${String(i)}`]),
    ),
  }));
}

const memberProviders: MemberProviders[] = PROVIDERS.map((p) => ({ id: p, providers: [p] }));

/** `tasks` technical tasks, each run `repetitions` times by both backends. */
function aggregateOver(tasks: number, repetitions: number): ReturnType<typeof aggregate> {
  const taskList = Array.from({ length: tasks }, (_, i) => task(`t${String(i)}`, 'technical'));
  const cells: ScoredCell[] = [];
  for (const t of taskList) {
    for (const provider of PROVIDERS) {
      for (let repeat = 1; repeat <= repetitions; repeat += 1) {
        cells.push(scoredCell(t.id, provider, repeat, 'technical', { accuracy: 0.8 }));
      }
    }
  }
  return aggregate({ cells, corpus: corpus(taskList) });
}

describe('a frontier over an under-sampled scope withholds with the report own words (COMB-40, COMB-51)', () => {
  // The repo's own shape at the time this was written: a handful of tasks, one
  // repetition, and every category below the five-task floor. BENCH-13 found
  // that 180 pairwise comparisons enumerate and none can run; this is the same
  // corpus reaching the same answer through the other surface.
  const agg = aggregateOver(1, 1);

  it('agrees with the aggregate on the reason and on the sentence', () => {
    const categoryVerdict = agg.categoryGroups.find((g) => g.category === 'technical')!.verdict;
    expect(categoryVerdict.scorable).toBe(false);

    const eligibility = eligibilityFromAggregate(
      agg,
      { kind: 'category', category: 'technical' },
      memberProviders,
    );
    const report = evaluateCombinations({
      members: backendMembers(1),
      scoreCombination: COUNT,
      measure: ACCURACY,
      eligibility,
    });

    expect(report.scorable).toBe(false);
    expect(report.frontier.frontier).toBeNull();
    expect(report.frontier.withheld?.reason).toBe('scope-not-scorable');
    // Not a paraphrase. The identical string, so the two reports cannot drift.
    expect(report.frontier.withheld?.why).toBe(
      categoryVerdict.scorable ? '' : categoryVerdict.why,
    );
    expect(report.frontier.withheld?.why).toContain(String(MIN_TASKS_PER_CATEGORY));
    expect(report.frontier.withheld?.why).toContain('the fix is authoring tasks');
  });

  it('withholds the same way through evaluateScopes, which is where the floor belongs', () => {
    // `evaluateScopes` runs per task category, which is exactly the scope
    // `MIN_TASKS_PER_CATEGORY` governs, and applied none of it before this item.
    const members = backendMembers(1);
    const scoped = evaluateScopes(
      [
        {
          name: 'technical',
          members,
          eligibility: eligibilityFromAggregate(
            agg,
            { kind: 'category', category: 'technical' },
            memberProviders,
          ),
        },
      ],
      COUNT,
      ACCURACY,
      {
        overallEligibility: eligibilityFromAggregate(agg, { kind: 'overall' }, memberProviders),
      },
    );
    expect(scoped.byScope[0]!.report.scorable).toBe(false);
    expect(scoped.byScope[0]!.report.frontier.withheld?.reason).toBe('scope-not-scorable');
    // And the overall scope too, because no backend may be scored anywhere.
    expect(scoped.overall.scorable).toBe(false);
  });
});

describe('a corpus over the task floor still refuses on single runs (COMB-51)', () => {
  it('withholds as sample-below-spread-floor once the scope itself is fine', () => {
    const agg = aggregateOver(MIN_TASKS_PER_CATEGORY, 1);
    const technical = agg.categoryGroups.find((g) => g.category === 'technical')!;
    // The scope cleared: enough tasks, and this backend completed all of them.
    expect(technical.verdict.scorable).toBe(true);
    // What has not cleared is the repetitions behind the figure.
    expect(technical.repetitionFloor.met).toBe(false);
    expect(technical.repetitionFloor.floor).toBe(MIN_REPETITIONS_FOR_SPREAD);

    const report = evaluateCombinations({
      members: backendMembers(MIN_TASKS_PER_CATEGORY),
      scoreCombination: COUNT,
      measure: ACCURACY,
      eligibility: eligibilityFromAggregate(
        agg,
        { kind: 'category', category: 'technical' },
        memberProviders,
      ),
    });
    expect(report.frontier.withheld?.reason).toBe('sample-below-spread-floor');
    expect(report.frontier.withheld?.why).toContain('below the floor of 3');
  });

  it('states a frontier once the corpus and the repetitions both clear', () => {
    const agg = aggregateOver(MIN_TASKS_PER_CATEGORY, MIN_REPETITIONS_FOR_SPREAD);
    const report = evaluateCombinations({
      members: backendMembers(MIN_REPETITIONS_FOR_SPREAD),
      scoreCombination: COUNT,
      measure: ACCURACY,
      eligibility: eligibilityFromAggregate(
        agg,
        { kind: 'category', category: 'technical' },
        memberProviders,
      ),
    });
    expect(report.scorable).toBe(true);
    expect(report.frontier.withheld).toBeNull();
    expect(report.frontier.frontier).not.toBeNull();
    // Still a point-estimate frontier, and it says so: nothing supplies a score
    // spread over combinations, which is the honest state rather than a silent one.
    expect(report.frontier.separation).toBe('point');
  });
});

describe('the adapter refuses what it cannot vouch for', () => {
  const agg = aggregateOver(MIN_TASKS_PER_CATEGORY, MIN_REPETITIONS_FOR_SPREAD);

  it('treats a member naming a provider the aggregate never saw as not scorable', () => {
    const eligibility = eligibilityFromAggregate(agg, { kind: 'category', category: 'technical' }, [
      { id: 'gemini', providers: ['gemini'] },
      { id: 'ghost', providers: ['never-ran'] },
    ]);
    expect(eligibility.members['ghost']!.verdict.scorable).toBe(false);
    expect(eligibility.members['ghost']!.verdict.scorable ? '' : eligibility.members['ghost']!.verdict.why)
      .toMatch(/no figure for in this scope/);
  });

  it('treats a member drawing on no run at all as nothing-completed', () => {
    const eligibility = eligibilityFromAggregate(agg, { kind: 'category', category: 'technical' }, [
      { id: 'empty', providers: [] },
    ]);
    const verdict = eligibility.members['empty']!.verdict;
    expect(verdict.scorable).toBe(false);
    expect(verdict.scorable ? '' : verdict.reason).toBe('nothing-completed');
  });

  it('takes the worst provider when a member spans several', () => {
    // A method or a crawl lane can span backends. One withheld backend inside a
    // member withholds the member, for the same reason one withheld member
    // withholds a combination: the member is the union of its runs.
    const thin = aggregate({
      cells: [
        ...Array.from({ length: MIN_TASKS_PER_CATEGORY }, (_, i) =>
          Array.from({ length: MIN_REPETITIONS_FOR_SPREAD }, (_, r) =>
            scoredCell(`t${String(i)}`, 'gemini', r + 1, 'technical', { accuracy: 0.8 }),
          ),
        ).flat(),
        // perplexity ran one task once, so it cannot be scored in this category.
        scoredCell('t0', 'perplexity', 1, 'technical', { accuracy: 0.8 }),
      ],
      corpus: corpus(
        Array.from({ length: MIN_TASKS_PER_CATEGORY }, (_, i) => task(`t${String(i)}`, 'technical')),
      ),
    });
    const eligibility = eligibilityFromAggregate(
      thin,
      { kind: 'category', category: 'technical' },
      [{ id: 'lane', providers: ['gemini', 'perplexity'] }],
    );
    expect(eligibility.members['lane']!.verdict.scorable).toBe(false);
  });

  it('reports a category the corpus holds no task of at all, which the aggregate has no verdict for', () => {
    const eligibility = eligibilityFromAggregate(
      agg,
      { kind: 'category', category: 'contested' },
      memberProviders,
    );
    expect(eligibility.scope.scorable).toBe(false);
    expect(eligibility.scope.scorable ? '' : eligibility.scope.why).toMatch(/no contested task at all/);
  });
});

describe('the seam is the only place combine sees a report', () => {
  it('keeps a lattice buildable without an aggregate, so the merge stays testable alone', () => {
    // `eligibility.ts` is the one file here that has ever seen a BenchAggregate.
    // Everything else takes verdicts, which is what lets `member`, `merge` and
    // `overlap` be exercised without building a corpus.
    const members = [member('a', ['https://x.example.org/1']), member('b', ['https://y.example.org/1'])];
    const report = evaluateCombinations({
      members,
      scoreCombination: COUNT,
      measure: ACCURACY,
      eligibility: {
        scope: { scorable: true },
        members: {
          a: { verdict: { scorable: true }, repetitionFloor: { met: true, minRepetitions: 3, floor: 3, why: '' } },
          b: { verdict: { scorable: true }, repetitionFloor: { met: true, minRepetitions: 3, floor: 3, why: '' } },
        },
      },
    });
    expect(report.scorable).toBe(true);
    expect(report.combinations).toHaveLength(3);
  });
});
