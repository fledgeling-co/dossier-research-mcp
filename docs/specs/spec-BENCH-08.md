# BENCH-08: reporting and comparison

**Status:** In Review
**Brief:** [`../features-to-triage/BENCH-08-reporting.md`](../features-to-triage/BENCH-08-reporting.md)
**Design of record:** [`../plan/benchmark.md`](../plan/benchmark.md), [`../deep-research/benchmark-prior-art.md`](../deep-research/benchmark-prior-art.md)
**Depends on:** BENCH-02 (the cell store), BENCH-01 (the corpus loader), and the scorers from BENCH-03, 04, 05, 06 and 07.

---

## The original brief, verbatim

> ## What
>
> Turn `bench/results/*.jsonl` into something a person can act on, without re-running research.
>
> ## Outputs
>
> - A per-backend scorecard across every category.
> - A category matrix: which backend leads where, which is unusable where.
> - Cost and wall clock beside every score. A backend scoring two points higher for six times the money is a finding, not a winner, and a table that hides the price implies otherwise.
> - Median with spread, never a bare number, wherever `n` is above 1.
> - The stale-task count and the unchecked-registry count, prominently. A score computed over a corpus that is a third stale is a different claim from one that is not.
>
> ## The rule this slice must not break
>
> Never report a ranking the sample cannot support. At `n=1`, print the numbers and refuse to rank. With fewer than the configured minimum tasks in a category, print the category and refuse to score it. A benchmark that produces confident rankings from too little evidence is the exact failure this product argues against, appearing in its own output.
>
> ## Acceptance
>
> - A results set with one repetition renders numbers and no ranking.
> - A category with two tasks renders as under-sampled rather than as a score.
> - Rendering is pure over the JSONL, so a metric added later needs no re-run.

Three further requirements were carried in with the dispatch, all learned during the fleet run rather than derived from the design, and all are treated here as part of the brief:

1. **Completion rate beside every score.** `local-codex` was 0-for-3 through an argument-parsing bug and `openai` 0-for-2 through rate limits. Both would have vanished silently from a naive average while the benchmark rewarded giving up.
2. **Citation accuracy and citation volume as separate columns**, never one collapsed score.
3. **The `unchecked` count.** BENCH-03 established that arXiv rate-limits nearly every probe and that Crossref alone would call a genuine DOI fabricated. A registry score computed over mostly-unchecked identifiers must say so.

Plus the stale-task count, which the brief already names.

---

## What this slice is, and what it deliberately is not

It is the read side of the benchmark: **cells in, a report out, nothing bought.**

It is **not** the statistics. Bootstrap confidence intervals, paired-difference tests, clustered standard errors and `pass^k` are BENCH-13, and the prior art is emphatic that a point-estimate ordering with unquantified uncertainty is what every published deep-research leaderboard already gets wrong. What this slice does is narrower and has to hold on its own: it reports observed medians with observed spreads, and it **withholds an ordering the sample cannot support** rather than printing one and hoping BENCH-13 arrives to qualify it.

It is **not** a blended score. There is no overall quality number, by design. The prior art's own inference is that citation count and citation correctness are close to orthogonal in current systems and that "any harness you build must report accuracy and volume as separate axes, never a blended score." That generalises: every metric here is reported on its own axis, and the type system is what enforces it (see `direction: 'none'` below).

---

## Success criteria

These are the acceptance oracle. Every one is checked by a test.

| # | Criterion |
|---|---|
| S1 | With one repetition per cell, the report prints every number and **no ranking**, and says why. |
| S2 | A category holding fewer than the configured minimum tasks is **named and left unscored**, never scored. |
| S3 | Rendering is pure over the stored JSONL plus the corpus: no network, no model, and every module outside the CLI imports no filesystem. |
| S4 | Every metric value carries its sample size and its group's completion rate. |
| S5 | Citation accuracy and citation volume are separate columns on every surface that shows either. |
| S6 | The registry `unchecked` count and share appear in the report's opening panel, with the BENCH-03 caveat beside them. |
| S7 | The corpus stale count and share appear in the report's opening panel. |
| S8 | Cost and wall clock appear beside every backend's scores. |
| S9 | A failed cell is counted in the completion rate and reaches **no** metric denominator; it is never scored as zero. |
| S10 | A metric that could not be measured renders as unavailable with a stated reason, never as zero and never omitted. |
| S11 | The same cells and corpus render byte-identically twice. |

---

## Design

### Module layout

Mirrors the split every other bench item uses: pure core, one impure edge.

```
bench/src/report/
  metrics.ts    the metric registry. Id, family, direction, and what each number cannot mean
  harvest.ts    pure: one cell + its task + its report text (+ optional evidence) -> ScoredCell
  spread.ts     pure: median, quartiles, and the spread floor
  aggregate.ts  pure: cells -> task groups -> category groups -> backends; both refusal rules
  rank.ts       pure: the ordering, and the four conditions under which it is withheld
  render.ts     pure: markdown and JSON, over an aggregate
  index.ts      the barrel
  cli.ts        the only file here that reads a disk
```

`metrics.ts`, `harvest.ts`, `spread.ts`, `aggregate.ts`, `rank.ts` and `render.ts` import no `node:fs` and no network, asserted by a test that reads their own source, the same guard BENCH-03 used on `bench/src/score/`.

### The metric registry

Every metric declares a `family` and a `direction`:

| Family | Direction | Meaning |
|---|---|---|
| `quality` | `higher` or `lower` | A rate or a score. Rankable. |
| `volume` | `none` | A count. Reported, **never ranked, never blended.** |
| `validity` | `none` | Completion rate, unchecked share. Context for every other number. |

`direction: 'none'` is the mechanism, not a label: `rank.ts` refuses a metric that is not `higher` or `lower`, so "citations per statement" cannot become a leaderboard by anybody's later convenience.

Metrics, and where each comes from:

| Id | Family | Dir | Source |
|---|---|---|---|
| `accuracy` | quality | higher | `scoreAccuracy(...).share` |
| `relevance` | quality | higher | `scoreRelevance(...).score` |
| `calibration-brier` | quality | **lower** | `scoreCalibration(...).brier` |
| `refusal` | quality | higher | `scoreRefusal(...).score` |
| `dissent-recall` | quality | higher | `scoreDueWeight(...).dissentRecall.score` |
| `conflict-acknowledgement` | quality | higher | `scoreDueWeight(...).conflictAcknowledgement.score` |
| `false-balance` | quality | higher | `scoreDueWeight(...).falseBalance.score` |
| `citation-accuracy` | quality | higher | `scoreCitationIntegrity(...).citationAccuracy` |
| `citation-thoroughness` | quality | higher | `.citationThoroughness` |
| `source-necessity` | quality | higher | `.sourceNecessity` |
| `resolvability` | quality | higher | `.resolvability.liveRate` |
| `citation-sources` | volume | none | `.volume.sources` |
| `citations-per-statement` | volume | none | `.volume.citationsPerStatement` |
| `independent-domains` | volume | none | `scoreSourceQuality(...).rawIndependentDomains` |
| `independent-domains-collapsed` | volume | none | `.collapsedIndependentDomains` |
| `report-chars` | volume | none | the cell record |

**Recency is declared and permanently unavailable, with a reason printed on every report.** BENCH-06 built the durability axis and it needs a publication date per source. Neither the cell store nor BENCH-03's evidence snapshot records one: `PageEvidence` carries url, verdict, text, truncation, anchors and a check timestamp, and nothing about when the page was published. Rather than approximate a date from the fetch time, which would grade every source fresh and score the whole dimension as a lie, the metric reports `unavailable` and names the missing input. This is a real pipeline gap discovered here, recorded in [`../bench/reporting.md`](../bench/reporting.md), and it is the shape BENCH-03 established for a dimension it could not compute.

### Two-stage aggregation

Taken from FutureSearch's published practice, which averages first within a task category and then across, so a large category cannot dominate.

**Stage 1, the cell group**, one task on one backend, over its repetitions. Produces a median per metric, a spread when the repetition count clears the floor, plus `attempted` / `completed` / completion rate, median cost and median wall clock.

**Stage 2, the category group**, one backend in one category, over the stage-1 medians of the tasks in it. The spread here is across tasks, which is a different uncertainty from stage 1's across repetitions, and both are labelled as what they are.

**Stage 3, the backend overall**, the median of the stage-2 medians over the *scorable* categories only, always printed with the list of categories excluded and why.

### The spread floor is BENCH-02's, not a second one

`MIN_REPETITIONS_FOR_SPREAD = 3` and `spreadEligibility()` already live in `bench/src/run/cell.ts`, with a comment saying in terms that the rule lives there once so the reporting item and the statistics item cannot disagree about the floor. This slice imports it and never restates it.

That makes one divergence from this brief's own wording explicit rather than silent. The brief says "median with spread ... wherever `n` is above 1"; `docs/plan/benchmark.md` says "`n = 5` is the target; `n = 3` is the floor at which a spread is reported at all", and BENCH-02 encoded the second. **The design document governs**, so at `n = 2` the value prints with its sample size and an explicit note that a spread was withheld and why. It is never bare: every value carries `n`, which is the property the brief's sentence is actually protecting.

### Refusal rule 1: the ranking

An ordering is emitted only when **all four** hold, and the report prints which one failed when it does not:

1. **The metric is rankable.** `direction` is `higher` or `lower`. A volume or validity metric is never ordered.
2. **The scope is scorable.** For a category ranking, the category clears the task floor.
3. **Every candidate clears the spread floor**, on every group contributing to its figure. At `n = 1` this fails for everyone, which is the brief's headline case: numbers, no ranking.
4. **At least two candidates remain** after the first three.

Even then the ordering is emitted with ties: two adjacent backends whose observed interquartile ranges overlap are reported as **tied at this sample size**, not ordered. This is a descriptive overlap check over observed values and it says so on every ranking; it is not a significance test, and BENCH-13 owns the real one. The prior art's judgement is that the published orderings in this field are point estimates with unquantified uncertainty, and an overlap check is the cheapest honest thing available before the statistics land.

### Refusal rule 2: the under-sampled category

Two distinct under-samples, named separately because they have different causes and different fixes:

- **`under-sampled-corpus`**, the category holds fewer than `minTasksPerCategory` tasks. Nobody can be scored in it. The fix is authoring tasks.
- **`under-sampled-completed`**, the category is big enough, but *this backend* completed fewer than the floor. Its figure is withheld and its completion rate is printed. The fix is re-running the failed cells. Without this, a backend that completed two of ten tasks would be scored on whichever two it found easiest, which is the completion-rate lesson applied to the denominator.

`MIN_TASKS_PER_CATEGORY` defaults to **5** and is a CLI flag. The derivation, stated because a floor nobody can defend is a floor somebody will lower: the design's own per-category target is ten, five is half of it, and five is the smallest count at which a median has at least two values on each side of it, so one task cannot move it across the whole range. It is printed on every report, so a report generated with a lower floor says so.

### Purity, and why it is load-bearing

`docs/plan/benchmark.md` separates the run from the scoring so that "a metric can be added later and applied retrospectively to runs already paid for." That property is only real if rendering needs nothing but stored bytes. So:

- The pure modules take values, never paths.
- `cli.ts` reads the cell JSONL, the corpus directory, each report from the Dossier store, and each evidence snapshot from BENCH-03's evidence directory, and hands them in.
- Nothing here can start a run. There is no code path from this slice to `Runner.start`.

### Failed cells

A failed cell is a recorded result. It contributes to `attempted`, to the failure list and to the completion rate, and to **no** metric denominator. `harvest.ts` returns a `ScoredCell` with every metric `null` and a reason of `cell failed`, and the aggregator drops nulls from samples rather than treating them as zeros. This is the same rule BENCH-03 applied to `unchecked` and BENCH-02 applied to recorded failures, restated at the aggregation layer because that is where a naive average would otherwise reward giving up.

### Output

Markdown to stdout by default; `--format json` emits the aggregate for BENCH-11 and BENCH-13 to consume. Diagnostics to stderr. Report sections, in order:

1. **Header**, corpus size, evaluated-at, cell counts, both floors in force.
2. **Validity panel**, per backend: attempted, completed, completion rate, failures by kind; the corpus stale count and share; the registry `unchecked` count and share with BENCH-03's caveat. This is first, deliberately: the brief's word is "prominently", and a caveat in the middle of a long output is something a reader in a hurry skims, which is the finding the 0.10.0 read-coverage change already rests on.
3. **Cost and wall clock** per backend.
4. **Quality scorecards** by family, backends as rows.
5. **Citation panel**, accuracy-family columns and volume-family columns, visually separated, with the rule printed above them.
6. **Category matrices**, one per rankable metric, categories as rows, backends as columns; under-sampled categories named and unscored.
7. **Rankings**, only where permitted, each with its tie note; every withheld ranking names the condition that failed.
8. **Limits**, what these numbers cannot mean.

---

## Assumptions

Recorded rather than asked, because each has a defensible default and none changes the shape of the slice:

1. **`minTasksPerCategory` defaults to 5.** Derived above. A flag, and printed on the report.
2. **Ranking requires the spread floor**, which is stricter than the brief's "at `n = 1` refuse to rank". A rank without a spread is exactly what `benchmark.md` calls a rank ordering of noise.
3. **No blended score**, per the prior art's explicit warning.
4. **Recency is unavailable**, per the missing publication dates above.
5. **The report reads from the Dossier store by run-relative path**, exactly as `CellOk.reportPath` documents it, rather than re-deriving a path from the run id.

## Cross-family review

Recorded here as a **logged downgrade**, per the pipeline's own rule that an unavailable out-of-family reviewer is carried into the evidence rather than passed silently: no Codex lane was available to this runner. The substitute was an adversarial self-review pass with fresh eyes over the diff against the success criteria, plus the twice-run gate. Named as a known weakness of this item's evidence.

## Progress

See the changelog entry and `docs/bench/reporting.md`.
