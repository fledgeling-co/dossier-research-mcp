# BENCH-02: the run harness, adopted rather than built

> **Amended 27 July 2026.** This brief originally said to build a harness. The prior-art research in `../deep-research/benchmark-prior-art.md` says promptfoo already is one: TypeScript, shipping daily, with multi-provider evals, custom JavaScript scorers returning `{pass, score, reason}`, custom aggregation and agent-trajectory assertions. Building a runner, a provider abstraction and a result store is months of undifferentiated work, and none of it is what makes this benchmark worth having.

## What

Adopt promptfoo as the shell. Write the Dossier-specific parts as its extension points: a provider adapter per backend, and each scorer as a custom JavaScript assertion.

**Evaluate the claim before committing to it.** Confirm against the real package that it does multi-provider runs, resumes an interrupted matrix, stores raw output per cell, and lets a custom scorer see the whole report rather than a truncated field. If any of those is missing, say so and build only the missing piece rather than abandoning the adoption or pretending it fits.

The requirements below still hold; they are now acceptance criteria for the adapter layer rather than a specification for a harness.

## What the matrix must still do

Execute task times backend times repetition, and keep one raw record per cell.

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
