# BENCH-13: the statistics, without which the scores are decoration

## Why this exists

The benchmark design had no statistics at all. It said "median with spread" and stopped. The prior art in `../deep-research/benchmark-prior-art.md` treats several things as non-negotiable in 2026, and without them this suite will produce confident rankings it cannot support, which is the exact failure the product argues against, appearing in its own output.

## What to build

### 1. Paired-difference tests with bootstrap confidence intervals

Backends are compared on the **same** tasks, so the comparison is paired and an unpaired test throws away the pairing that makes it powerful. Report the difference with a bootstrap confidence interval, 5,000 resamples, rather than a p-value alone.

A difference whose interval crosses zero is reported as *no measured difference*, in those words. Not as a smaller number that a reader will rank anyway.

### 2. Clustered standard errors, which this corpus walks straight into

The literature reports that ignoring topic clustering inflates naive standard errors **up to threefold**. The seed corpus is ten categories of ten related tasks, which is precisely the clustered case: two time-bound tasks are not two independent observations.

Cluster on category. Getting this wrong does not make the numbers slightly optimistic; it makes differences look significant that are not, and it would do so in the direction that flatters whichever backend happened to win.

### 3. `k >= 3` repeats, with `pass^k` beside `pass@1`

`pass@1` is what a user gets on one attempt. `pass^k` is whether the backend gets it right **every** time out of k, which is the number that matters for anything you would rely on unattended.

A backend with high `pass@1` and low `pass^k` is a backend that sometimes works, and reporting only the first number sells it as one that does.

### 4. Completion rate as a validity metric

A run that failed produces no score. If failures are dropped, a backend that fails half its hard tasks scores on the easy half and looks good, and the benchmark rewards giving up.

Report completion rate beside every score, and make a score computed over fewer than a stated share of attempted tasks render as invalid rather than as a number.

This is not hypothetical. In this repo's own ledger, `local-codex` is currently 0-for-3 through an argument-parsing bug, and `openai` was 0-for-2 through rate limits. Both would have silently vanished from a naive average.

### 5. Citation accuracy separately from citation volume

A backend citing a hundred sources at 80% accuracy and one citing ten at 80% are not the same product, and one number cannot tell them apart. Report both, always, and never a single "citation score" that collapses them.

## Acceptance

- Every reported difference carries an interval, and one crossing zero is rendered as no measured difference in words rather than as a number.
- Standard errors are clustered on category, and a test proves the clustered and naive figures differ on a fixture built to have within-category correlation. If they never differ, the clustering is not wired up.
- `pass@1` and `pass^k` are both reported, and `k` is stated.
- A score over an under-completed task set renders as invalid, not as a number with a footnote.
- Citation accuracy and citation volume appear as separate columns everywhere they appear at all.

## Honest limit

None of this rescues an underpowered corpus. The prior art's judgement is that every published set is underpowered and that effort belongs in extending toward a thousand tasks; this suite starts at a hundred. Correct statistics over a hundred tasks will mostly report that differences are not measurable, and **that is the right answer**, not a failure of the method. The temptation this brief exists to resist is loosening the statistics until the rankings look decisive.
