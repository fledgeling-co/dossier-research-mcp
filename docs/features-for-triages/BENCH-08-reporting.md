# BENCH-08: reporting and comparison

## What

Turn `bench/results/*.jsonl` into something a person can act on, without re-running research.

## Outputs

- A per-backend scorecard across every category.
- A category matrix: which backend leads where, which is unusable where.
- Cost and wall clock beside every score. A backend scoring two points higher for six times the money is a finding, not a winner, and a table that hides the price implies otherwise.
- Median with spread, never a bare number, wherever `n` is above 1.
- The stale-task count and the unchecked-registry count, prominently. A score computed over a corpus that is a third stale is a different claim from one that is not.

## The rule this slice must not break

Never report a ranking the sample cannot support. At `n=1`, print the numbers and refuse to rank. With fewer than the configured minimum tasks in a category, print the category and refuse to score it. A benchmark that produces confident rankings from too little evidence is the exact failure this product argues against, appearing in its own output.

## Acceptance

- A results set with one repetition renders numbers and no ranking.
- A category with two tasks renders as under-sampled rather than as a score.
- Rendering is pure over the JSONL, so a metric added later needs no re-run.
