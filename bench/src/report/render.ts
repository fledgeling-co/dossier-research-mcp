import { TASK_CATEGORIES, type TaskCategory } from '../tasks/schema.js';
import {
  metricDescriptor,
  metricsOfFamily,
  type MetricDescriptor,
  type MetricId,
} from './metrics.js';
import type { SpreadReport } from './spread.js';
import {
  uncheckedShare,
  undatedShare,
  type BackendSummary,
  type BenchAggregate,
  type CategoryGroup,
  type CompletionCounts,
} from './aggregate.js';
import { rankBackends, type RankCandidate, type Ranking } from './rank.js';
import {
  comparisonSummary,
  comparisons as buildComparisons,
  reliability as buildReliability,
  separatorFor,
  type Comparison,
  type ComparisonSummary,
} from './comparison.js';
import {
  DEFAULT_CONFIDENCE,
  DEFAULT_RESAMPLES,
  NO_MEASURED_DIFFERENCE,
  type ReliabilityReport,
} from '../stats/index.js';

/**
 * The aggregate, as something a person can act on.
 *
 * **This file must never import `node:fs`.** See `metrics.ts`. Rendering takes
 * an aggregate and returns a string; `cli.ts` decides where it goes.
 *
 * Section order is deliberate and the first one is the argument. The brief's
 * word for the stale count and the unchecked count is "prominently", and this
 * repo already learned at 0.10.0 what happens to a caveat placed in the middle
 * of a long output: an agent read one report of five in full and wrote a
 * confident synthesis over all five, because the disclosure was somewhere a
 * reader in a hurry skims. So the validity panel is first, before a single
 * score, and every score below it carries its own sample size and completion
 * rate rather than relying on the reader remembering the panel.
 */

const PERCENT = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** Three significant figures, without the exponent notation `toPrecision` reaches for. */
function num(value: number): string {
  if (Number.isInteger(value)) return String(value);
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(0)}s`;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * One metric value, with its sample size attached.
 *
 * **Never returns a bare number.** Either it carries `n` and a spread, or it
 * carries `n` and the reason the spread was withheld, or it says the metric was
 * not measured. That is the brief's "median with spread, never a bare number"
 * read the only way it can survive contact with a real corpus, where a spread
 * needs three results and plenty of groups have fewer.
 */
export function formatValue(
  report: SpreadReport | null,
  format: (v: number) => string = num,
): string {
  if (report === null) return 'not measured';
  if (report.spread === null) return `${format(report.median)} (n=${String(report.n)}, no spread)`;
  return `${format(report.median)} [${format(report.spread.q1)}-${format(report.spread.q3)}] (n=${String(report.n)})`;
}

function formatCompletion(counts: CompletionCounts): string {
  if (counts.rate === null) return 'none attempted';
  return `${PERCENT(counts.rate)} (${String(counts.completed)}/${String(counts.attempted)})`;
}

function formatterFor(descriptor: MetricDescriptor): (v: number) => string {
  return descriptor.unit === 'share' ? PERCENT : num;
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n');
}

function failureSummary(counts: CompletionCounts): string {
  const kinds = Object.entries(counts.failureKinds).sort(([a], [b]) => a.localeCompare(b));
  if (kinds.length === 0) return 'none';
  return kinds.map(([kind, n]) => `${kind} ${String(n)}`).join(', ');
}

/** The header: what was measured, against what, under which floors. */
function renderHeader(agg: BenchAggregate): string {
  return [
    '# Benchmark report',
    '',
    `Rendered from stored results. Nothing here ran research, called a model or spent money: every number below is computed by code from cells already bought and a gold set fixed before the run.`,
    '',
    `- **Corpus** ${String(agg.corpus.tasks)} tasks, evaluated as of ${agg.corpus.evaluatedAt}`,
    `- **Cells** ${String(agg.overall.attempted)} recorded, ${String(agg.overall.completed)} completed`,
    `- **Backends** ${agg.providers.length === 0 ? 'none' : agg.providers.join(', ')}`,
    `- **Floors in force** a spread needs 3 results; a category needs ${String(agg.minTasksPerCategory)} tasks before it is scored at all; a backend must complete ${PERCENT(agg.minCompletionShare)} of its attempted cells in a scope before its figure there is a number rather than the word invalid`,
  ].join('\n');
}

/**
 * The validity panel, first and unmissable.
 *
 * Three numbers here exist because each of them was learned the hard way on
 * this project rather than derived from a design.
 */
function renderValidity(agg: BenchAggregate, analysis: Analysis): string {
  const rows = agg.backends.map((b) => [
    b.provider,
    String(b.completion.attempted),
    String(b.completion.completed),
    formatCompletion(b.completion),
    failureSummary(b.completion),
  ]);

  const unchecked = uncheckedShare(agg.registry);
  const registryTotal =
    agg.registry.present + agg.registry.absent + agg.registry.unchecked + agg.registry.invalid;
  const undated = undatedShare(agg.dating);
  const datingTotal = agg.dating.dated + agg.dating.absent + agg.dating.unchecked;

  const parts = [
    '## Validity, before any score',
    '',
    '### What this corpus can actually distinguish',
    '',
    // First, above the completion rate and above every score, because it is the
    // one thing a reader in a hurry has to leave with. Correct statistics over
    // a corpus this size will mostly report that differences are not
    // measurable, and that is the right answer rather than a fault in the
    // method. Burying it would be the failure this benchmark exists to catch,
    // appearing in its own output.
    analysis.summary.sentence,
    '',
    '### Completion rate',
    '',
    'A backend that failed every cell disappears from a naive average while the benchmark rewards giving up. On this project `local-codex` was 0-for-3 through an argument-parsing bug and `openai` 0-for-2 through rate limits, which is why this table is above the scores rather than below them. **A failed cell counts here and reaches no metric denominator.** It is never scored as a zero.',
    '',
    `Completion is also a **floor**, not only a column: a backend that completed under ${PERCENT(agg.minCompletionShare)} of its attempted cells in a scope has its figure there rendered \`invalid\` rather than as a number, because a score computed over whichever attempts survived describes the attempts that survived.`,
    '',
    rows.length === 0
      ? '_No cells recorded._'
      : table(
          ['Backend', 'Cells', 'Completed', 'Completion rate', 'Failures by kind'],
          rows,
        ),
    '',
    '### Stale tasks',
    '',
    agg.corpus.tasks === 0
      ? '_No tasks loaded._'
      : `**${String(agg.corpus.staleTasks)} of ${String(agg.corpus.tasks)} tasks are stale** (${agg.corpus.staleShare === null ? 'n/a' : PERCENT(agg.corpus.staleShare)}), meaning their gold has gone unverified for ${String(agg.corpus.staleAfterDays)} days or more. A stale task still loads and is still scored; it is counted here because a score computed over a corpus that is a third stale is a different claim from one that is not.` +
        (agg.corpus.staleIds.length === 0 ? '' : `\n\nStale: ${agg.corpus.staleIds.join(', ')}.`),
    '',
    '### Registry checks, and how many never ran',
    '',
    registryTotal === 0
      ? '_No identifier was checked against a registry, so no citation was tested for fabrication. Absence of an `absent` verdict here means nothing at all._'
      : `**${String(agg.registry.unchecked)} of ${String(registryTotal)} identifier checks came back \`unchecked\`** (${unchecked === null ? 'n/a' : PERCENT(unchecked)}). Present ${String(agg.registry.present)}, absent ${String(agg.registry.absent)}, invalid ${String(agg.registry.invalid)}.`,
    '',
    'What `unchecked` means, and why the share is here rather than in a footnote: BENCH-03 probed all five registries live and found arXiv rate-limiting nearly every request, so `unchecked` is that archive\'s ordinary answer rather than its exceptional one, and found that Crossref alone would report a genuine DOI as fabricated because it is one registration agency among several. A registry score computed over mostly-unchecked identifiers accuses backends of fabrication on the strength of checks that never ran. An `unchecked` answer leaves every denominator; the share is what tells you how much of the instrument was actually pointed at anything.',
    '',
    '### Publication dates, and how many could not be established',
    '',
    datingTotal === 0
      ? '_No cited source was checked for a publication date, so the recency figures below rest on nothing. An absent date here is not evidence that anything was published recently._'
      : `**${String(agg.dating.absent + agg.dating.unchecked)} of ${String(datingTotal)} cited sources could not be dated** (${undated === null ? 'n/a' : PERCENT(undated)}). Dated ${String(agg.dating.dated)}; read and carrying no date ${String(agg.dating.absent)}; never read, or read only as far as the byte cap, ${String(agg.dating.unchecked)}.`,
    '',
    'The recency score is computed over the dated sources **only**. An undated source is never counted as fresh and never enters the denominator, which is why this count sits above it: a fresh share of 1.0 over one dated source in forty is arithmetic rather than a finding. The two undated causes are kept apart on purpose. A page read in full that states no date is a fact about the publisher; a page nobody could read is a fact about this pipeline, and only the second one is fixable by re-running the collection pass. Measured over 212 real cited URLs on 28 July 2026, 41 could be dated, 151 were read in full and state no date, and 20 were never read, so a large undated share is the ordinary condition of a technical corpus rather than a fault in this pipeline.',
  ];

  if (agg.pipelineGaps.length > 0) {
    parts.push(
      '',
      '### Gaps in this pipeline, not in the backends',
      '',
      `${String(agg.pipelineGaps.length)} cell(s) could not be fully read or had no evidence collected. These are our failures, not theirs, and they are named so they cannot be read as backend results:`,
      '',
      ...agg.pipelineGaps.map((g) => `- ${g}`),
    );
  }
  if (agg.orphanCells.length > 0) {
    parts.push(
      '',
      `**${String(agg.orphanCells.length)} recorded cell(s) name a task the corpus no longer holds** and were excluded: ${agg.orphanCells.join(', ')}. The corpus moved under a stored result.`,
    );
  }

  return parts.join('\n');
}

/** Cost and wall clock, beside the scores rather than under them. */
function renderPrice(agg: BenchAggregate): string {
  const rows = agg.backends.map((b) => [
    b.provider,
    formatCompletion(b.completion),
    formatValue(b.costUsd, usd),
    usd(b.totalCostUsd),
    formatValue(b.wallClockMs, seconds),
  ]);
  return [
    '## What it cost',
    '',
    'A backend scoring two points higher for six times the money is a finding, not a winner. Every figure is a reservation at the worst case of its estimate band, never a quote.',
    '',
    rows.length === 0
      ? '_No cells recorded._'
      : table(
          ['Backend', 'Completion rate', 'Median cost per cell', 'Total reserved', 'Median wall clock'],
          rows,
        ),
  ].join('\n');
}

function scorecardFor(
  agg: BenchAggregate,
  metrics: readonly MetricDescriptor[],
  title: string,
  preamble: string,
  // Passed rather than rewritten afterwards. A `.replace('## x', '### x')` on
  // the rendered string works until somebody edits the title, and then it
  // silently stops working and the section nests wrongly with nothing failing.
  level: '##' | '###' = '##',
): string {
  if (metrics.length === 0 || agg.backends.length === 0) {
    return [`${level} ${title}`, '', preamble, '', '_No cells recorded._'].join('\n');
  }
  const header = ['Backend', 'Completion rate', ...metrics.map((m) => m.label)];
  const rows = agg.backends.map((b) => {
    // The completion floor, rendered where a reader looks first. A backend
    // under it does not get a number with a footnote; it gets the word
    // `invalid`, because a figure computed over whichever attempts survived is
    // the absence of a claim rather than a low one.
    //
    // Read off the aggregate's own overall verdict rather than re-derived from
    // a completion rate here. Deriving it here disagreed with the comparison
    // and the ranking, which asked a different question of the same backend.
    const invalid =
      !b.verdict.scorable && b.verdict.reason === 'under-completed'
        ? `invalid (completed ${b.completion.rate === null ? 'nothing' : PERCENT(b.completion.rate)}, floor ${PERCENT(agg.minCompletionShare)})`
        : null;
    return [
      b.provider,
      formatCompletion(b.completion),
      ...metrics.map((m) => invalid ?? formatValue(b.metrics[m.id], formatterFor(m))),
    ];
  });
  return [
    `${level} ${title}`,
    '',
    preamble,
    '',
    table(header, rows),
    '',
    'What each column cannot mean:',
    '',
    ...metrics.map((m) => `- **${m.label}** ${m.caveat}`),
  ].join('\n');
}

/**
 * The citation panel: two tables, deliberately, never one.
 *
 * They are rendered by two separate calls over two separate metric lists, so
 * merging them would take editing this function rather than editing an array.
 * A backend citing a hundred sources at eighty percent and one citing ten at
 * eighty percent are not the same product, and one blended column would make
 * them identical.
 */
function renderCitations(agg: BenchAggregate): string {
  const accuracyMetrics = (
    ['citation-accuracy', 'citation-thoroughness', 'source-necessity', 'resolvability'] as const
  ).map(metricDescriptor);
  const volumeMetrics = (
    [
      'citation-sources',
      'citations-per-statement',
      'independent-domains',
      'independent-domains-collapsed',
      'report-chars',
    ] as const
  ).map(metricDescriptor);

  const registryRows = agg.backends.map((b) => {
    const share = uncheckedShare(b.registry);
    return [
      b.provider,
      String(b.registry.present),
      String(b.registry.absent),
      String(b.registry.unchecked),
      share === null ? 'nothing checked' : PERCENT(share),
      String(b.registry.invalid),
    ];
  });

  return [
    '## Citations',
    '',
    '**Accuracy and volume are two tables and never one number.** Published measurement finds citation count and citation correctness close to orthogonal in current systems, and finds human preference tracking the count. A blended score would hide exactly the failure this benchmark exists to catch.',
    '',
    scorecardFor(
      agg,
      accuracyMetrics,
      'Citation accuracy',
      'Rates. Higher is better. Support comes from token containment, which is not entailment and is never claim verification.',
      '###',
    ),
    '',
    scorecardFor(
      agg,
      volumeMetrics,
      'Citation volume',
      'Counts. **These are never ranked and never combined with the rates above.** They say how much a backend did, not how well.',
      '###',
    ),
    '',
    '### Registry checks per backend',
    '',
    registryRows.length === 0
      ? '_No cells recorded._'
      : table(
          ['Backend', 'Present', 'Absent', 'Unchecked', 'Unchecked share', 'Invalid'],
          registryRows,
        ),
    '',
    'An `absent` verdict is strong evidence a reference was fabricated. Everything else is not evidence of the opposite: `unchecked` means the check never ran, and a high unchecked share means the column beside it is describing very little.',
  ].join('\n');
}

/**
 * What one matrix cell says when the backend may not be scored there.
 *
 * A switch with an exhaustiveness default rather than an if-chain, because a
 * fifth withheld reason added later would otherwise print as the fourth one's
 * wording and be wrong in a way nothing catches. BENCH-13 added the fourth and
 * met exactly that shape.
 */
function withheldCell(group: CategoryGroup): string {
  if (group.verdict.scorable) throw new TypeError('a scorable group has no withheld cell');
  const { reason } = group.verdict;
  switch (reason) {
    case 'nothing-completed':
      return 'nothing completed';
    case 'under-completed':
      return `invalid (completed ${group.completion.rate === null ? 'nothing' : PERCENT(group.completion.rate)})`;
    case 'under-sampled-corpus':
    case 'under-sampled-completed':
      return `withheld (${String(group.tasksCompleted)}/${String(group.tasksInCorpus)} tasks)`;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/** One category matrix per rankable metric. Categories down, backends across. */
function renderMatrix(agg: BenchAggregate, metric: MetricDescriptor): string {
  const byKey = new Map<string, CategoryGroup>();
  for (const group of agg.categoryGroups) byKey.set(`${group.provider} ${group.category}`, group);

  const present = TASK_CATEGORIES.filter((c) => agg.corpus.tasksByCategory[c] > 0);
  if (present.length === 0 || agg.providers.length === 0) return '';

  const rows = present.map((category) => {
    const tasks = agg.corpus.tasksByCategory[category];
    if (tasks < agg.minTasksPerCategory) {
      return [
        `${category}`,
        `${String(tasks)}`,
        ...agg.providers.map(() => 'under-sampled'),
      ];
    }
    return [
      `${category}`,
      `${String(tasks)}`,
      ...agg.providers.map((provider) => {
        const group = byKey.get(`${provider} ${category}`);
        if (group === undefined) return 'not run';
        if (!group.verdict.scorable) return withheldCell(group);
        const value = formatValue(group.metrics[metric.id], formatterFor(metric));
        // A figure whose tasks were each run too few times still has a real
        // spread across tasks, and that spread says nothing about how much
        // this backend varies between two runs of one task. Printed, marked,
        // and never ranked; an unmarked spread here would read as run-to-run
        // variance to anybody skimming.
        return group.repetitionFloor.met || value === 'not measured' ? value : `${value} \u2020`;
      }),
    ];
  });

  return [
    `### ${metric.label}`,
    '',
    table(['Category', 'Tasks', ...agg.providers], rows),
  ].join('\n');
}

function renderMatrices(agg: BenchAggregate): string {
  const rankable = [...metricsOfFamily('quality')];
  const bodies = rankable.map((m) => renderMatrix(agg, m)).filter((s) => s !== '');
  const underSampled = agg.underSampledCategories;

  return [
    '## By category',
    '',
    `Two-stage aggregation: repetitions are collapsed within a task first, then tasks within a category, so a large category cannot dominate. A category holding fewer than ${String(agg.minTasksPerCategory)} tasks is named and left unscored; so is a backend that completed fewer than that many tasks inside one, because scoring it would grade it on whichever tasks it happened to finish.`,
    '',
    underSampled.length === 0
      ? '_Every category in the corpus clears the task floor._'
      : `**Under-sampled and therefore unscored:** ${underSampled.map((u) => `${u.category} (${String(u.tasksInCorpus)} task${u.tasksInCorpus === 1 ? '' : 's'})`).join(', ')}. The fix is authoring tasks, not re-running research.`,
    '',
    'A value marked \u2020 comes from tasks that were not repeated enough for its spread to say anything about run-to-run variation. The number is real; it is never ranked.',
    '',
    bodies.length === 0 ? '_No categories to show._' : bodies.join('\n\n'),
  ].join('\n');
}

/** Build the candidate list for one metric in one scope. */
function candidatesFor(
  agg: BenchAggregate,
  metric: MetricId,
  scope: TaskCategory | 'overall',
): { candidates: RankCandidate[]; scopeScorable: boolean } {
  if (scope === 'overall') {
    return {
      candidates: agg.backends.map((b: BackendSummary) => ({
        provider: b.provider,
        value: b.metrics[metric],
        // One verdict, three consumers: the scorecard above, this ranking, and
        // the paired comparison. They disagreed while each derived its own.
        scorable: b.verdict.scorable,
        why: b.verdict.scorable ? '' : b.verdict.why,
        completionRate: b.completion.rate,
        repetitionsMet: b.repetitionFloor.met,
        repetitionsWhy: b.repetitionFloor.why,
      })),
      scopeScorable: agg.backends.some((b) => b.verdict.scorable),
    };
  }
  const groups = agg.categoryGroups.filter((g) => g.category === scope);
  return {
    candidates: groups.map((g) => ({
      provider: g.provider,
      value: g.metrics[metric],
      scorable: g.verdict.scorable,
      why: g.verdict.scorable ? '' : g.verdict.why,
      completionRate: g.completion.rate,
      repetitionsMet: g.repetitionFloor.met,
      repetitionsWhy: g.repetitionFloor.why,
    })),
    scopeScorable: agg.corpus.tasksByCategory[scope] >= agg.minTasksPerCategory,
  };
}

/** Every ranking this aggregate can support, and every one it cannot. */
export function rankings(
  agg: BenchAggregate,
  comparisons: readonly Comparison[] = buildComparisons(agg),
): readonly Ranking[] {
  const out: Ranking[] = [];
  for (const metric of metricsOfFamily('quality')) {
    const overallScope = { kind: 'overall' } as const;
    const overall = candidatesFor(agg, metric.id, 'overall');
    out.push(
      rankBackends(
        metric.id,
        overallScope,
        overall.candidates,
        overall.scopeScorable,
        separatorFor(comparisons, metric.id, overallScope),
      ),
    );
    for (const category of TASK_CATEGORIES) {
      if (agg.corpus.tasksByCategory[category] === 0) continue;
      const scope = { kind: 'category', category } as const;
      const scoped = candidatesFor(agg, metric.id, category);
      out.push(
        rankBackends(
          metric.id,
          scope,
          scoped.candidates,
          scoped.scopeScorable,
          separatorFor(comparisons, metric.id, scope),
        ),
      );
    }
  }
  return out;
}

/**
 * Everything the two renderers need, computed once.
 *
 * The bootstrap runs 5,000 resamples per comparison that clears the gates, so
 * computing it twice because markdown and JSON both asked would double the cost
 * of the only expensive thing on this path.
 */
export interface Analysis {
  readonly comparisons: readonly Comparison[];
  readonly summary: ComparisonSummary;
  readonly reliability: readonly ReliabilityReport[];
  readonly rankings: readonly Ranking[];
}

export function analyse(agg: BenchAggregate): Analysis {
  const comparisons = buildComparisons(agg);
  return {
    comparisons,
    summary: comparisonSummary(comparisons),
    reliability: buildReliability(agg),
    rankings: rankings(agg, comparisons),
  };
}

function renderRankings(analysis: Analysis): string {
  const all = analysis.rankings;
  const stated = all.filter((r) => r.entries !== null);

  const lines = [
    '## Rankings',
    '',
    'An ordering is stated only when the metric has a direction, the scope clears the task floor, every backend in it clears the spread floor, and at least two remain. **At one repetition per cell nothing is ranked**, because a rank ordering without a spread is a rank ordering of noise. Everything withheld is listed below with the condition that failed.',
    '',
  ];

  if (stated.length === 0) {
    lines.push(
      '**No ranking is stated.** The numbers above are the numbers; the sample is what cannot order them.',
      '',
    );
  } else {
    for (const ranking of stated) {
      const entries = ranking.entries ?? [];
      const descriptor = metricDescriptor(ranking.metric);
      const format = formatterFor(descriptor);
      lines.push(
        `### ${descriptor.label}, ${ranking.scope.kind === 'overall' ? 'overall' : ranking.scope.category}`,
        '',
        table(
          ['Rank', 'Backend', 'Median', 'Spread', 'n', 'Completion rate'],
          entries.map((e) => [
            e.tiedWithPrevious ? `${String(e.rank)} (tied)` : String(e.rank),
            e.provider,
            format(e.median),
            e.spread === null ? 'withheld' : `${format(e.spread.q1)}-${format(e.spread.q3)}`,
            String(e.n),
            e.completionRate === null ? 'n/a' : PERCENT(e.completionRate),
          ]),
        ),
        '',
        ranking.note,
        '',
      );
    }
  }

  const withheld = all.filter((r) => r.entries === null);
  if (withheld.length > 0) {
    lines.push('### Withheld', '');
    const rows = withheld.map((r) => [
      metricDescriptor(r.metric).label,
      r.scope.kind === 'overall' ? 'overall' : r.scope.category,
      r.withheld ?? '',
      r.note,
    ]);
    lines.push(table(['Metric', 'Scope', 'Condition', 'Why'], rows));
  }

  return lines.join('\n');
}

/**
 * The paired differences, which are the point of this whole section.
 *
 * Only the comparisons that reached a bootstrap get a row. The refused ones are
 * counted by reason rather than listed, because a corpus below the task floor
 * refuses every pair on every metric in every scope and a thousand identical
 * rows would bury the one sentence that matters.
 */
function renderComparisons(analysis: Analysis): string {
  const ran = analysis.comparisons.filter((c) => c.result !== null && c.withheld === null);
  const rows = ran.map((c) => {
    const result = c.result;
    const interval = result?.interval;
    const error = result?.error;
    const measured = result?.verdict === 'measured';
    return [
      metricDescriptor(c.metric).label,
      c.scope.kind === 'overall' ? 'overall' : c.scope.category,
      `${c.a} vs ${c.b}`,
      String(result?.shared.length ?? 0),
      // The rule, rendered. A crossing interval prints the words and no point
      // estimate: a number on a page is an ordering, whatever the interval
      // beside it says.
      measured ? num(result?.pointEstimate ?? 0) : NO_MEASURED_DIFFERENCE,
      interval === null || interval === undefined
        ? 'none'
        : `${num(interval.lower)} to ${num(interval.upper)}`,
      error === null || error === undefined ? 'n/a' : num(error.naive),
      error === null || error === undefined ? 'n/a' : num(error.clustered),
      error?.inflation === null || error?.inflation === undefined
        ? 'n/a'
        : `${error.inflation.toFixed(2)}x`,
    ];
  });

  const withheldRows = Object.entries(analysis.summary.withheldBy)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => [reason, String(count)]);

  return [
    '## Differences between backends',
    '',
    `Every comparison here is **paired**: it uses only the tasks both backends answered, because an unpaired test throws away the pairing that makes the comparison powerful. The interval is a percentile bootstrap over ${String(DEFAULT_RESAMPLES)} resamples that draws **categories** as units, so two tasks in one category are not counted as two independent observations. A difference is in the metric's own units, so a difference of 0.1 on a share is ten percentage points.`,
    '',
    `**A difference whose interval contains zero is reported as ${NO_MEASURED_DIFFERENCE}, in those words, and never as a smaller number.** The point estimate is in the JSON for a downstream consumer; it is off this page because a number here would be read as an ordering.`,
    '',
    analysis.summary.sentence,
    '',
    rows.length === 0
      ? '_No pairwise comparison could be run._'
      : table(
          [
            'Metric',
            'Scope',
            'Pair',
            'Shared tasks',
            'Difference',
            '95% interval',
            'SE naive',
            'SE clustered',
            'Inflation',
          ],
          rows,
        ),
    '',
    '**The inflation column is the one to read.** It is the clustered standard error divided by the naive one, which is how much the naive figure understates the uncertainty by treating related tasks as independent observations. Published measurement puts it up to 3.05x, and at that ratio a difference that looks significant is not.',
    '',
    withheldRows.length === 0
      ? ''
      : [
          'Comparisons refused before an interval could be computed, by reason:',
          '',
          table(['Condition', 'Comparisons'], withheldRows),
        ].join('\n'),
  ]
    .filter((s) => s !== '')
    .join('\n');
}

/** `pass@1` beside `pass^k`, which are two different products. */
function renderReliability(analysis: Analysis): string {
  const rows = analysis.reliability.map((r) => {
    // Both figures are computed only over the repetitions that produced a
    // report, so a backend that failed most of its attempts would otherwise
    // read as perfectly reliable on the few that survived.
    const invalid = r.valid ? null : `invalid (completed ${r.completionRate === null ? 'nothing' : PERCENT(r.completionRate)})`;
    return [
      r.provider,
      invalid ?? (r.passAt1 === null ? 'not measured' : PERCENT(r.passAt1)),
      invalid ?? (r.passHatK === null ? 'withheld' : PERCENT(r.passHatK)),
      String(r.k),
      String(r.tasksCounted),
      num(r.threshold),
      r.metrics.length === 0 ? 'none' : r.metrics.join(', '),
    ];
  });

  const withheld = analysis.reliability.filter((r) => r.passHatK === null && r.kWithheld !== '');
  const invalidated = analysis.reliability.filter((r) => !r.valid);

  return [
    '## Reliability: pass@1 beside pass^k',
    '',
    '`pass@1` is what a user gets on one attempt. `pass^k` is whether the backend gets it right on **every** one of k, which is the number that matters for anything run unattended. A backend with high `pass@1` and low `pass^k` sometimes works, and reporting only the first sells it as one that does: published measurement has agents at 61% pass@1 collapsing to 25% pass@8.',
    '',
    'A pass is full credit on the task\'s own primary metric, refusal correctness where the task measured it and accuracy otherwise. A repetition that measured nothing is an absence and leaves the denominator; it is never counted as a failed attempt.',
    '',
    rows.length === 0
      ? '_No cells recorded._'
      : table(
          ['Backend', 'pass@1', 'pass^k', 'k', 'Tasks counted', 'Threshold', 'Pass metric'],
          rows,
        ),
    ...(invalidated.length === 0
      ? []
      : ['', ...invalidated.map((r) => `- **${r.provider}** ${r.invalidWhy}`)]),
    ...(withheld.length === 0
      ? []
      : ['', ...withheld.map((r) => `- **${r.provider}** ${r.kWithheld}`)]),
  ].join('\n');
}

function renderLimits(agg: BenchAggregate, analysis: Analysis): string {
  return [
    '## What none of this can mean',
    '',
    `- **A spread is not an interval.** Spreads in the tables are observed interquartile ranges over the results in hand. The paired differences carry a real ${String(Math.round(DEFAULT_CONFIDENCE * 100))}% bootstrap interval, and the two are different things: only the second says anything about how much of a gap survives resampling.`,
    `- **An interval that contains zero is ${NO_MEASURED_DIFFERENCE}**, not a small one. ${String(analysis.summary.measured)} of ${String(analysis.summary.ran)} comparisons that could be run produced one.`,
    `- **Clustering is on category and on nothing else.** Two tasks in different categories that share a source, an entity or a week are still treated as independent observations, and a corpus this size is small enough that they might not be.`,
    `- **A ranking withheld is not a tie.** It means the sample cannot order the backends, which is a different statement from their being equal.`,
    `- **Cost is a reservation at the worst case of an estimate band**, never an invoice.`,
    `- **A stale task is still scored.** ${String(agg.corpus.staleTasks)} of ${String(agg.corpus.tasks)} tasks here have gold that has gone unverified for ${String(agg.corpus.staleAfterDays)} days or more.`,
    `- **Token containment is not entailment.** A cited page can contain a figure while saying something else about it entirely.`,
    `- **Recency is measured over the sources that could be dated**, and ${String(agg.dating.absent + agg.dating.unchecked)} of ${String(agg.dating.dated + agg.dating.absent + agg.dating.unchecked)} cited sources could not be. An undated source never counts as fresh and never enters the denominator, exactly as an unchecked registry answer does not, so the share above is the number that says how much of the corpus the figure is about. A publication date is read from the page at fetch time and never approximated from the fetch time itself, which would grade every source fresh.`,
    `- **Nothing here re-ran research.** Every number is computed from cells already bought, which is what makes a metric added next month applicable to the runs in this file.`,
  ].join('\n');
}

/**
 * The report-quality columns, named rather than filtered.
 *
 * The citation metrics are deliberately absent: they have their own panel,
 * where the rates and the volumes sit in two separate tables. A filter
 * expression here would quietly pull a newly added citation metric into this
 * table and put it next to a volume count, which is the one arrangement this
 * slice is supposed to make impossible.
 */
const SCORECARD_METRICS = [
  'accuracy',
  'relevance',
  'calibration-brier',
  'refusal',
  'dissent-recall',
  'conflict-acknowledgement',
  'false-balance',
  'recency-fresh-share',
] as const satisfies readonly MetricId[];

/** The whole report, in markdown. */
export function renderMarkdown(agg: BenchAggregate): string {
  const quality = SCORECARD_METRICS.map(metricDescriptor);
  const analysis = analyse(agg);
  return [
    renderHeader(agg),
    '',
    renderValidity(agg, analysis),
    '',
    renderPrice(agg),
    '',
    scorecardFor(
      agg,
      quality,
      'Per-backend scorecard',
      'One row per backend, across the categories it may be scored in. Every value carries its sample size, and its completion rate is the column beside it. A value reading `not measured` was never measured; it is not a zero, and a row reading `invalid` is a backend that completed too few of its attempts for any of its figures to be a claim.',
    ),
    '',
    renderCitations(agg),
    '',
    renderMatrices(agg),
    '',
    renderComparisons(analysis),
    '',
    renderReliability(analysis),
    '',
    renderRankings(analysis),
    '',
    renderLimits(agg, analysis),
    '',
  ].join('\n');
}

/**
 * The same numbers, as JSON.
 *
 * Everything the markdown shows and everything it summarises, including the
 * per-task groups and every paired comparison, so BENCH-11 and anything after
 * it consume this rather than parsing prose. Stable key order and two-space
 * indentation, so two renders of one store are byte-identical and a diff
 * between two runs is readable. That property is why the bootstrap is seeded.
 */
export function renderJson(agg: BenchAggregate): string {
  const analysis = analyse(agg);
  return `${JSON.stringify(
    {
      aggregate: agg,
      rankings: analysis.rankings,
      comparisons: analysis.comparisons,
      comparisonSummary: analysis.summary,
      reliability: analysis.reliability,
    },
    null,
    2,
  )}\n`;
}

/** Everything the report can be rendered as. */
export type ReportFormat = 'markdown' | 'json';

export function render(agg: BenchAggregate, format: ReportFormat): string {
  switch (format) {
    case 'markdown':
      return renderMarkdown(agg);
    case 'json':
      return renderJson(agg);
    default: {
      const exhaustive: never = format;
      return exhaustive;
    }
  }
}
