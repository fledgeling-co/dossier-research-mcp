# BENCH-13: the statistics, without which the scores are decoration

**Status:** In Review
**Brief:** [`../features-to-triage/BENCH-13-statistics.md`](../features-to-triage/BENCH-13-statistics.md)
**Design of record:** [`../plan/benchmark.md`](../plan/benchmark.md), [`../deep-research/benchmark-prior-art.md`](../deep-research/benchmark-prior-art.md)
**Depends on:** BENCH-02 (the cell store and the spread floor), BENCH-08 (the aggregate, the refusals and the ranking).

---

## The original brief, verbatim

> ## Why this exists
>
> The benchmark design had no statistics at all. It said "median with spread" and stopped. The prior art in `../deep-research/benchmark-prior-art.md` treats several things as non-negotiable in 2026, and without them this suite will produce confident rankings it cannot support, which is the exact failure the product argues against, appearing in its own output.
>
> ## What to build
>
> ### 1. Paired-difference tests with bootstrap confidence intervals
>
> Backends are compared on the **same** tasks, so the comparison is paired and an unpaired test throws away the pairing that makes it powerful. Report the difference with a bootstrap confidence interval, 5,000 resamples, rather than a p-value alone.
>
> A difference whose interval crosses zero is reported as *no measured difference*, in those words. Not as a smaller number that a reader will rank anyway.
>
> ### 2. Clustered standard errors, which this corpus walks straight into
>
> The literature reports that ignoring topic clustering inflates naive standard errors **up to threefold**. The seed corpus is ten categories of ten related tasks, which is precisely the clustered case: two time-bound tasks are not two independent observations.
>
> Cluster on category. Getting this wrong does not make the numbers slightly optimistic; it makes differences look significant that are not, and it would do so in the direction that flatters whichever backend happened to win.
>
> ### 3. `k >= 3` repeats, with `pass^k` beside `pass@1`
>
> `pass@1` is what a user gets on one attempt. `pass^k` is whether the backend gets it right **every** time out of k, which is the number that matters for anything you would rely on unattended.
>
> A backend with high `pass@1` and low `pass^k` is a backend that sometimes works, and reporting only the first number sells it as one that does.
>
> ### 4. Completion rate as a validity metric
>
> A run that failed produces no score. If failures are dropped, a backend that fails half its hard tasks scores on the easy half and looks good, and the benchmark rewards giving up.
>
> Report completion rate beside every score, and make a score computed over fewer than a stated share of attempted tasks render as invalid rather than as a number.
>
> This is not hypothetical. In this repo's own ledger, `local-codex` is currently 0-for-3 through an argument-parsing bug, and `openai` was 0-for-2 through rate limits. Both would have silently vanished from a naive average.
>
> ### 5. Citation accuracy separately from citation volume
>
> A backend citing a hundred sources at 80% accuracy and one citing ten at 80% are not the same product, and one number cannot tell them apart. Report both, always, and never a single "citation score" that collapses them.
>
> ## Acceptance
>
> - Every reported difference carries an interval, and one crossing zero is rendered as no measured difference in words rather than as a number.
> - Standard errors are clustered on category, and a test proves the clustered and naive figures differ on a fixture built to have within-category correlation. If they never differ, the clustering is not wired up.
> - `pass@1` and `pass^k` are both reported, and `k` is stated.
> - A score over an under-completed task set renders as invalid, not as a number with a footnote.
> - Citation accuracy and citation volume appear as separate columns everywhere they appear at all.
>
> ## Honest limit
>
> None of this rescues an underpowered corpus. The prior art's judgement is that every published set is underpowered and that effort belongs in extending toward a thousand tasks; this suite starts at a hundred. Correct statistics over a hundred tasks will mostly report that differences are not measurable, and **that is the right answer**, not a failure of the method. The temptation this brief exists to resist is loosening the statistics until the rankings look decisive.

Two further requirements were carried in with the dispatch and are treated here as part of the brief:

1. **Extend BENCH-08, do not build beside it.** Twelve items merged first. `bench/src/report/` already decided what a sample can support: it imports `spreadEligibility` from `bench/src/run/cell.ts`, enforces `MIN_TASKS_PER_CATEGORY`, and marks a value whose spread is not run-to-run variance. **Two different answers to "can this sample support a claim" in one codebase is worse than either.**
2. **Say plainly what the current corpus supports.** If the honest output is that almost nothing is distinguishable yet, that goes on the face of the report rather than in a footnote.

---

## What this is, in one paragraph

Four statistics, all pure, all computed from cells already bought, all wired into the report BENCH-08 already renders so that the existing refusals and the new ones are **one rule** rather than two. A pairwise paired-difference test with a cluster bootstrap interval replaces the interquartile-overlap tie check as the separation oracle wherever it can be computed. A clustered standard error is reported beside the naive one with the inflation ratio between them, so the reader can see how much of the apparent precision was an artefact of treating related tasks as independent observations. `pass@1` and `pass^k` sit beside each other with `k` stated. And a completion-share floor joins the two under-sample floors already in force, so a score computed over an under-completed set renders `invalid` rather than as a number.

## The governing constraints

- **No model anywhere.** Every number is computed by code from stored cells. Nothing in this slice reaches a network, a model or a wallet, and a test asserts that by reading the modules' own source, exactly as BENCH-08's does.
- **Deterministic.** A bootstrap resamples, so it needs randomness. The randomness is a seeded, self-contained PRNG and the seed is derived from the comparison's own identity, so two renders of one store are byte-identical. An interval whose value changes between two renders of the same data cannot be quoted.
- **One answer per question.** Where BENCH-08 already answers "may this be ranked", this slice extends that answer rather than adding a second one: it reuses `spreadEligibility` for the `k >= 3` floor, reuses `ScorableVerdict` for the completion floor, and feeds the paired verdict into `rank.ts`'s existing tie decision rather than printing a rival ordering.

## Acceptance criteria

| AC | Statement |
|---|---|
| **STAT-01** | A pairwise comparison is **paired**: it uses only the tasks on which both backends have a value, and the tasks it dropped are counted and named. |
| **STAT-02** | Every reported difference carries a 95% bootstrap confidence interval from 5,000 resamples. |
| **STAT-03** | A difference whose interval crosses zero renders the literal words **no measured difference**, and no point estimate that could be ranked. |
| **STAT-04** | The bootstrap is reproducible: the same input produces the same interval, every time. |
| **STAT-05** | The bootstrap resamples **clusters** (categories), not tasks, so the interval respects within-category correlation. |
| **STAT-06** | A naive standard error and a category-clustered standard error are both reported, with the ratio between them. |
| **STAT-07** | On a fixture built with perfect within-category correlation, the clustered figure is strictly larger than the naive one, by the factor the design effect predicts. |
| **STAT-08** | On a fixture with one task per category, the clustered and naive figures are identical: with no cluster to share, clustering may not change the answer. |
| **STAT-09** | `pass@1` and `pass^k` are reported side by side and `k` is stated beside them. |
| **STAT-10** | `pass^k` is withheld below `k = 3`, using the same floor constant the spread rule already uses, and says so. |
| **STAT-11** | A backend whose completion rate in a scope is below the stated share renders **invalid**, not a number, with the share on the report. |
| **STAT-12** | The completion floor composes with the two BENCH-08 floors rather than replacing them: an under-sampled corpus is still named as such. |
| **STAT-13** | Citation accuracy and citation volume never appear in one table, and a test locks that. |
| **STAT-14** | The count of comparisons that produced a measured difference is on the face of the report, above every score, and reads plainly when it is zero. |
| **STAT-15** | Nothing in the statistics modules touches the filesystem, the network, a model or a wallet, asserted by reading their source. |
| **STAT-16** | A paired comparison inherits BENCH-08's gates: an unrankable metric, an unscorable scope, or a candidate below the repetition floor withholds the comparison with the same reason vocabulary. |
| **STAT-17** | Where a paired verdict exists it decides `rank.ts`'s tie, and the interquartile-overlap check is used only where it does not. |

## Assumptions, stated rather than buried

- **A "pass" is full credit on the task's primary metric.** `pass@1` and `pass^k` need a binary, and the corpus scores continuous shares. The primary metric is the task's own: `refusal` where the task declares it applicable, otherwise `accuracy`; a task with neither has no binary pass and is excluded with a reason rather than defaulted. The threshold is 1.0 and is a parameter with that default, because these are reliability numbers and a partly-right answer is not something you would rely on unattended.
- **The completion share is measured over attempted cells**, which is the completion rate the validity panel already prints, rather than over tasks. It is the number the brief's own two examples are counted in (`local-codex` 0-for-3, `openai` 0-for-2).
- **The default completion share is 0.6**, derived rather than chosen: `docs/plan/benchmark.md` runs five repetitions and treats three as the floor at which a figure says anything, so a backend completing fewer than three in five has, at the median cell, fallen below the sample floor its own figure is printed against. It is configurable and printed on every report.
- **Percentile bootstrap, not BCa.** FutureSearch's published practice, which the prior art tells this project to copy, is a 5,000-resample percentile bootstrap. Bias-corrected and accelerated intervals are better on skewed samples and are more machinery than a seven-task corpus can justify; the choice is recorded so it can be revisited when the corpus is large enough for the difference to matter.
- **95%, two-sided.** Stated on the report rather than assumed.

## What this cannot mean

- **A bootstrap interval is not a licence to rank.** It says how much of the observed gap survives resampling the categories in hand. It cannot speak about categories the corpus does not have.
- **A clustered standard error corrects for the clustering it is told about.** Cluster is category. Two tasks in different categories that share a source, an entity or a week are still treated as independent, and this corpus is small enough that they might not be.
- **`pass^k` is a reliability measure over the repetitions bought**, not a probability. At `k = 3` it can take four values, and the difference between two backends at that resolution is very unlikely to be measurable.
- **Under-completion renders invalid rather than zero.** An invalid score is the absence of a claim, not a claim that the backend scored badly.
