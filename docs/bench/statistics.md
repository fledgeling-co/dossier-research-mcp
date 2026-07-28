# The statistics

What makes a benchmark number a claim rather than a decoration, and the four places this suite refuses to make one.

The code is [`bench/src/stats/`](../../bench/src/stats) and [`bench/src/report/comparison.ts`](../../bench/src/report/comparison.ts). The design it serves is [`../plan/benchmark.md`](../plan/benchmark.md), amended after the prior art in [`../deep-research/benchmark-prior-art.md`](../deep-research/benchmark-prior-art.md). The report it feeds is [`reporting.md`](reporting.md).

---

## The one thing to take away

**Correct statistics over a corpus this size mostly report that differences are not measurable, and that is the right answer.** The prior art's judgement is that every published deep-research benchmark is underpowered for the comparisons it is used to make, that detecting a three-point difference at 80% power needs roughly 969 questions, and that the largest published sets have between 89 and 303. This one currently admits seven tasks.

So the honest output of this slice today is that almost nothing here is distinguishable, and the report says so above every score rather than in a footnote. The temptation this whole section exists to resist is loosening any of the floors below until the rankings look decisive.

## Where the statistics sit

They do not replace [`reporting.md`](reporting.md)'s refusals; they extend them. BENCH-08 already decided what a sample can support, and **two different answers to that in one codebase is worse than either**, so:

- the `k >= 3` floor for `pass^k` is `spreadEligibility` from [`bench/src/run/cell.ts`](../../bench/src/run/cell.ts), imported and never restated;
- the completion floor is a fourth arm on the verdict that already withholds an under-sampled category, checked last so neither existing floor changes behaviour;
- the paired difference supersedes the interquartile-overlap tie check in `rank.ts` wherever it has an answer, and the overlap check survives only as the fallback;
- a comparison runs only where the aggregate already says a figure may be quoted, using the same three gates and the same reason words.

Nothing in `bench/src/stats/` reaches a filesystem, a network, a model or a wallet, and a test asserts it by reading the modules' own source.

## 1. Paired differences, with a bootstrap interval

Backends are compared on the **same** tasks, so the comparison is paired. An unpaired test throws away exactly the structure that makes it powerful: Miller gives `Var(paired) = Var(unpaired) - 2 * Cov(A, B) / n`, and his worked example, two models each with variance 1/12 correlated at 0.5, cuts the variance by a third.

The comparison uses only the tasks both backends have a value on. The tasks it dropped are counted and named on the result, because a comparison that quietly dropped half of one backend's failures is the completion-rate lesson reappearing inside the statistics.

**5,000 resamples, 95%, two-sided, percentile.** Copied from FutureSearch, which is the only deep-research leaderboard the prior art could find that publishes an interval at all. Bias-corrected and accelerated intervals are better on a skewed sample and are more machinery than seven tasks can justify; the choice is recorded here so it can be revisited when the corpus is large enough for the difference to matter.

### The rule

**A difference whose interval contains zero is reported as `no measured difference`, in those words.** Not as a smaller number, because a number on a page is read as an ordering by everybody in a hurry, which is everybody. The point estimate stays on the JSON object for a downstream consumer and stays off the rendered line.

### Reproducibility

A bootstrap resamples, so it needs randomness, and randomness would make every interval in the report a different number on every render. That breaks a property `reporting.md` states and a test enforces, and it would make a published figure unreproducible by anybody who tried, which is the failure this benchmark exists to avoid rather than commit.

So the generator is a small seeded PRNG and the seed is a hash of what is being compared: the metric, the scope and both backend names. Two renders of one store resample identically; two different comparisons do not share a draw. The seed used is on the result, so a reader can reproduce the interval.

## 2. Standard errors clustered on category

Two tasks in one category are not two independent observations. They share a topic, often a source, sometimes an entity, and a backend good at one is more likely to be good at the other. Treating them as independent understates the standard error, which makes a difference look significant when it is not, **in the direction that flatters whichever backend happened to win**.

The size of the error is not marginal. Miller measures the inflation at up to 3.05x on DROP, 1.88x on MGSM, and judges the Llama 3 report's reading-comprehension intervals likely too narrow as a result. The ICLR 2026 error-bars blogpost gives the design effect as `1 + (m - 1) * rho` and puts realistic intracluster correlations at 0.2 to 0.4, which inflates a standard error by a factor of two or three. The benchmark design is ten categories of ten related tasks, so this is the ordinary case here rather than a corner of it.

### The formulas

With `n` observations, mean `s`, and clusters `c`:

```
naive^2     = (1/n^2) * sum_i (v_i - s)^2
clustered^2 = (1/n^2) * sum_c ( sum_{i in c} (v_i - s) )^2
```

The second is algebraically identical to Miller's published form, `SE_CLT^2 + (1/n^2) * sum_c sum_{i != j in c} (v_i - s)(v_j - s)`, because expanding the square of a sum gives the diagonal plus the off-diagonal terms. It is written as a sum of squares because **it cannot go negative**: the additive form can be handed a negative radicand by floating-point rounding on strongly negatively correlated clusters, and a `NaN` standard error printed beside a difference is worse than none. A test asserts the two forms agree, including on a fixture whose within-cluster covariance is negative.

Both are reported, always, with the ratio between them. Reporting only the corrected figure hides how much of the apparent precision was an artefact, and that ratio is the most legible number in the whole slice.

### The two tests that decide whether this is wired up

The brief is blunt about it: if the clustered and naive figures never differ, the clustering is a decoration. Both poles have a closed-form answer, so both are asserted exactly rather than approximately.

| Fixture | Expected ratio | Why |
|---|---|---|
| `m` identical tasks in each category | exactly `sqrt(m)` | perfect intracluster correlation makes the design effect exactly `m` |
| one task in each category | exactly 1 | with no cluster to share, clustering may not change the answer |

At `m = 9` the first gives exactly 3, which is where the literature's "up to threefold" comes from, and the test asserts the arithmetic rather than the anecdote.

### The limit this creates, stated plainly

Clustering on category means a **category-scoped comparison cannot be clustered at all**. Every shared task is in one cluster, so there is no replication across clusters and within-category correlation cannot be corrected for. The comparison is refused rather than computed at the task level, because a task-level interval there would assume exactly the independence this module exists to deny, and it would understate the width in the flattering direction.

The consequence is real and worth knowing before reading a report: **only overall comparisons can ever produce a measured difference**, and an overall comparison needs at least two categories that both backends may be scored in. Per-category separation would need a sub-cluster the corpus does not have.

## 3. `pass@1` beside `pass^k`

`pass@1` is what a user gets on one attempt. `pass^k` is whether the backend gets it right on **every** one of k, which is the number that matters for anything run unattended. A backend with high `pass@1` and low `pass^k` sometimes works, and reporting only the first sells it as one that does: the prior art's case is tau-bench, where agents at 61% pass@1 collapse to 25% pass@8.

- **A pass is full credit on the task's primary metric.** Refusal correctness where the task measured it, since on a false-premise or obscure-entity task the correct answer is not an answer and accuracy does not apply; accuracy otherwise. A task with neither measurable is excluded and named.
- **The threshold is 1.0**, and it is a parameter with that default. These are reliability numbers and a partly-right answer is not something you rely on unattended.
- **A completed repetition that measured nothing is an absence, not a fail.** It leaves the denominator. Counting it as a failed attempt would score an absence as a zero, which every other layer of this read side refuses.
- **`k` is the weakest task's repetition count**, not the average, exactly as `aggregate.ts` takes its repetition floor. One task run twice makes a suite-wide `pass^k` partly a `pass^2`, and a rule that averaged that away would only bite when it did not matter.
- **Below `k = 3`, `pass^k` is withheld** with the spread rule's own sentence. The brief asks for `k >= 3` and the design already sets three as the floor at which a figure over repetitions says anything; they are the same number and they are now the same constant.

At `k = 3`, `pass^k` takes four values. A difference between two backends at that resolution is very unlikely to be measurable, and that is not a defect of the number.

## 4. Completion rate as a validity metric

A run that failed produces no score. Drop the failures and a backend that fails half its hard tasks scores on the easy half and looks good, and the benchmark rewards giving up. That is not hypothetical here: `local-codex` was 0-for-3 on this project through an argument-parsing bug and `openai` 0-for-2 through rate limits.

Those two are caught by [`reporting.md`](reporting.md)'s `nothing-completed` verdict. What this adds is the case neither existing floor can see: a backend that attempted every task, completed enough distinct ones to clear the count floor, and failed most of its attempts on the way.

**Below the completion share, the figure renders `invalid`.** Not a number with a footnote. An invalid score is the absence of a claim, not a claim that the backend scored badly.

### Where 0.6 comes from

Derived rather than picked, because a floor nobody can defend is a floor somebody will lower. `benchmark.md` runs five repetitions per cell and treats three as the floor at which a figure over them says anything. A backend completing fewer than three in five has, at the median cell, fallen below the sample floor its own figure is printed against. Three fifths.

It is `MIN_REPETITIONS_FOR_SPREAD / TARGET_REPETITIONS`, both of which live in [`bench/src/run/cell.ts`](../../bench/src/run/cell.ts), so moving either moves this. It is configurable with `--min-completion` and printed on every report.

The four floors compose in this order, and the report names which one fired:

1. the corpus holds too few tasks in the category (`under-sampled-corpus`)
2. this backend completed nothing in it (`nothing-completed`)
3. this backend completed too few distinct tasks (`under-sampled-completed`)
4. this backend completed too small a share of its attempts (`under-completed`)

## 5. Citation accuracy separately from citation volume

Already true before this slice, and locked by [`reporting.md`](reporting.md)'s metric registry: a `direction` of `none` makes a volume figure unrankable, and the citation panel renders two tables through two separate calls over two separate metric lists, so merging them takes editing a function rather than editing an array. Recorded here because the brief asks for it and because the reason is a statistical one: the prior art finds citation count and citation correctness close to orthogonal in current systems, and finds human preference tracking the count.

## What none of these numbers can mean

- **A bootstrap interval is not a licence to rank.** It says how much of the observed gap survives resampling the categories in hand. It cannot speak about categories the corpus does not have.
- **A clustered standard error corrects for the clustering it is told about.** Cluster is category. Two tasks in different categories that share a source, an entity or a week are still treated as independent, and a corpus this size is small enough that they might not be.
- **A withheld comparison is not a tie**, and `no measured difference` is not equality. Both mean the sample cannot separate the two, which is a different statement.
- **`pass^k` is a reliability measure over the repetitions bought**, not a probability.
- **Nothing here rescues an underpowered corpus.** The fix is authoring tasks.
