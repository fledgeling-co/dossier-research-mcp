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
  type BackendSummary,
  type BenchAggregate,
  type CategoryGroup,
  type CompletionCounts,
} from './aggregate.js';
import { rankBackends, type RankCandidate, type Ranking } from './rank.js';

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
    `- **Floors in force** a spread needs 3 results; a category needs ${String(agg.minTasksPerCategory)} tasks before it is scored at all`,
  ].join('\n');
}

/**
 * The validity panel, first and unmissable.
 *
 * Three numbers here exist because each of them was learned the hard way on
 * this project rather than derived from a design.
 */
function renderValidity(agg: BenchAggregate): string {
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

  const parts = [
    '## Validity, before any score',
    '',
    '### Completion rate',
    '',
    'A backend that failed every cell disappears from a naive average while the benchmark rewards giving up. On this project `local-codex` was 0-for-3 through an argument-parsing bug and `openai` 0-for-2 through rate limits, which is why this table is above the scores rather than below them. **A failed cell counts here and reaches no metric denominator.** It is never scored as a zero.',
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
): string {
  if (metrics.length === 0 || agg.backends.length === 0) {
    return [`## ${title}`, '', preamble, '', '_No cells recorded._'].join('\n');
  }
  const header = ['Backend', 'Completion rate', ...metrics.map((m) => m.label)];
  const rows = agg.backends.map((b) => [
    b.provider,
    formatCompletion(b.completion),
    ...metrics.map((m) => formatValue(b.metrics[m.id], formatterFor(m))),
  ]);
  return [
    `## ${title}`,
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
    scorecardFor(agg, accuracyMetrics, 'Citation accuracy', 'Rates. Higher is better. Support comes from token containment, which is not entailment and is never claim verification.').replace(
      '## Citation accuracy',
      '### Citation accuracy',
    ),
    '',
    scorecardFor(agg, volumeMetrics, 'Citation volume', 'Counts. **These are never ranked and never combined with the rates above.** They say how much a backend did, not how well.').replace(
      '## Citation volume',
      '### Citation volume',
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
        if (!group.verdict.scorable) {
          return group.verdict.reason === 'nothing-completed'
            ? 'nothing completed'
            : `withheld (${String(group.tasksCompleted)}/${String(group.tasksInCorpus)} tasks)`;
        }
        return formatValue(group.metrics[metric.id], formatterFor(metric));
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
        scorable: b.scorableCategories.length > 0,
        why: `${b.provider} has no scorable category, so it has no overall figure`,
        completionRate: b.completion.rate,
      })),
      scopeScorable: agg.backends.some((b) => b.scorableCategories.length > 0),
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
    })),
    scopeScorable: agg.corpus.tasksByCategory[scope] >= agg.minTasksPerCategory,
  };
}

/** Every ranking this aggregate can support, and every one it cannot. */
export function rankings(agg: BenchAggregate): readonly Ranking[] {
  const out: Ranking[] = [];
  for (const metric of metricsOfFamily('quality')) {
    const overall = candidatesFor(agg, metric.id, 'overall');
    out.push(
      rankBackends(metric.id, { kind: 'overall' }, overall.candidates, overall.scopeScorable),
    );
    for (const category of TASK_CATEGORIES) {
      if (agg.corpus.tasksByCategory[category] === 0) continue;
      const scoped = candidatesFor(agg, metric.id, category);
      out.push(
        rankBackends(metric.id, { kind: 'category', category }, scoped.candidates, scoped.scopeScorable),
      );
    }
  }
  return out;
}

function renderRankings(agg: BenchAggregate): string {
  const all = rankings(agg);
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

function renderLimits(agg: BenchAggregate): string {
  return [
    '## What none of this can mean',
    '',
    `- **This is not a significance test.** Spreads are observed interquartile ranges over the results in hand. Bootstrap intervals, paired differences and standard errors clustered on category are BENCH-13, and until they land, an overlap between two spreads is the only separation check offered here.`,
    `- **A ranking withheld is not a tie.** It means the sample cannot order the backends, which is a different statement from their being equal.`,
    `- **Cost is a reservation at the worst case of an estimate band**, never an invoice.`,
    `- **A stale task is still scored.** ${String(agg.corpus.staleTasks)} of ${String(agg.corpus.tasks)} tasks here have gold that has gone unverified for ${String(agg.corpus.staleAfterDays)} days or more.`,
    `- **Token containment is not entailment.** A cited page can contain a figure while saying something else about it entirely.`,
    `- **Recency is unavailable**, not zero: no publication date is recorded for any source in the stored results, so the durability axis cannot be fed from them. Approximating one from the fetch time would grade every source fresh.`,
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
  return [
    renderHeader(agg),
    '',
    renderValidity(agg),
    '',
    renderPrice(agg),
    '',
    scorecardFor(
      agg,
      quality,
      'Per-backend scorecard',
      'One row per backend, across the categories it may be scored in. Every value carries its sample size, and its completion rate is the column beside it. A value reading `not measured` was never measured; it is not a zero.',
    ),
    '',
    renderCitations(agg),
    '',
    renderMatrices(agg),
    '',
    renderRankings(agg),
    '',
    renderLimits(agg),
    '',
  ].join('\n');
}

/**
 * The same numbers, as JSON.
 *
 * Everything the markdown shows and everything it summarises, including the
 * per-task groups, so BENCH-11 and BENCH-13 consume this rather than parsing
 * prose. Stable key order and two-space indentation, so two renders of one
 * store are byte-identical and a diff between two runs is readable.
 */
export function renderJson(agg: BenchAggregate): string {
  return `${JSON.stringify({ aggregate: agg, rankings: rankings(agg) }, null, 2)}\n`;
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
