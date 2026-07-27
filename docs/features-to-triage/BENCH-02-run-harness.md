# BENCH-02: the run harness

## What

Execute the matrix of task times backend times repetition, and write one raw JSONL line per cell to `bench/results/`.

## Why the run and the scoring are separate

Research is the expensive part and scoring is the part that will keep changing. Storing raw reports means a metric added in three months can be applied retrospectively to runs already paid for, instead of re-buying the research to answer a new question about it.

## Requirements

- Resumable. A run of 100 tasks across 8 backends at n=5 is 4,000 cells and will be interrupted. Re-running must skip completed cells, keyed by task, backend and repetition index.
- Concurrency bounded and configurable, defaulting well below the panel's own limit, since this is a batch job that must not starve interactive use.
- Cost accounted per cell and refused against a ceiling before the batch starts, on the sum, not per cell. The existing budget machinery in `src/research/runner.ts` is the model to follow, and this must not bypass it.
- Every cell records wall clock and cost alongside the report.
- A failed cell is recorded as failed with its reason, never omitted. An omitted failure silently improves the backend's score, which is the same defect as a throttled search counting as an established absence.

## Acceptance

- Killing the process mid-run and restarting completes exactly the remaining cells.
- A batch whose projected cost exceeds the ceiling refuses before spending anything and names the total it needed.
- `n=1` is allowed but the report must refuse to state a spread from it.

## Non-goals

No scoring, no rendering.
