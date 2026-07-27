# BENCH-02: The run harness

**ID:** BENCH-02
**Status:** In Review
**Created:** 2026-07-27
**Last updated:** 2026-07-27
**Brief:** [BENCH-02](../features-to-triage/BENCH-02-run-harness.md) · **Design of record:** [benchmark.md](../plan/benchmark.md) · **Prior art:** [benchmark-prior-art.md](../deep-research/benchmark-prior-art.md)

## Feature description

*(Verbatim from `docs/features-to-triage/BENCH-02-run-harness.md`, including both amendments.)*

Adopt promptfoo as the shell. Write the Dossier-specific parts as its extension points: a provider adapter per backend, and each scorer as a custom JavaScript assertion. **Evaluate the claim before committing to it.** Confirm against the real package that it does multi-provider runs, resumes an interrupted matrix, stores raw output per cell, and lets a custom scorer see the whole report rather than a truncated field. If any of those is missing, say so and build only the missing piece rather than abandoning the adoption or pretending it fits.

The matrix executes task times backend times repetition and keeps one raw record per cell. Research is the expensive part and scoring is the part that will keep changing; storing raw reports means a metric added in three months can be applied retrospectively to runs already paid for, instead of re-buying the research.

Requirements: resumable, keyed by task, backend and repetition index; concurrency bounded and configurable, defaulting well below the panel's own limit; cost accounted per cell and refused against a ceiling before the batch starts, on the sum, not per cell, following and never bypassing the budget machinery in `src/research/runner.ts`; every cell records wall clock and cost alongside the report; a failed cell recorded as failed with its reason, never omitted.

Acceptance: killing the process mid-run and restarting completes exactly the remaining cells; a batch whose projected cost exceeds the ceiling refuses before spending anything and names the total it needed; `n=1` is allowed but the report must refuse to state a spread from it.

Non-goals: no scoring, no rendering.

**Blocking defect found by BENCH-01, verified.** `FingerprintInput` in `src/research/contract.ts` carries prompt, tier, tools, planning, attachments, provider, shape and window, and no repetition index. So `n = 5` of the same task on the same backend inside the dedupe window collapses onto one paid run, and every spread, every `pass^k` and every non-determinism figure would be computed over a single sample while reporting five. Fix it by making a repeat expressible rather than by weakening dedupe. Do not simply add a nonce to every request, or the protection disappears for the case it was built for.

**Contradiction between two documents, needs one answer.** `benchmark.md` says a stale task is "reported as stale rather than scored". BENCH-01's brief says it loads and is counted, and BENCH-01 implemented the latter. Decide, write it in one place, and make the other reference it.

---

## Triage — 2026-07-27

**Ready for Implementation Plan.**

*(No UI preview section: this repo has no user interface and no design system. Nothing customer-facing changes.)*

### The adoption evaluation, run against the real package

The brief made the adoption conditional on four claims. Every one was tested against `promptfoo@0.121.19` (published 2026-07-14, the version the prior art names), installed locally on 27 July 2026, driven by two custom `file://` providers, a custom `javascript` assertion, and a matrix of two tasks times two providers.

| Claim in the brief | Verdict | How it was established |
|---|---|---|
| Multi-provider runs | **Holds** | Two tasks times two providers times `--repeat 3` executed 12 distinct cells |
| A custom scorer sees the whole report | **Holds** | The assertion received the full 120,032-character output, and `context.providerResponse` carries the complete provider response beside it. Nothing truncates |
| Raw output stored per cell | **Holds, with one caveat below** | The `eval_results` table stores `response`, `latency_ms`, `cost`, `error` and `metadata` per row, and `-o out.json` writes the same |
| **Resumes an interrupted matrix** | **Does not hold** | See below |

**`--resume` re-buys the entire matrix.** A four-cell evaluation was run to completion, making four provider calls. `promptfoo eval --resume` was then run against it. It printed `Resuming: skipping 4 previously completed cases` and then **called the provider four more times**, reporting 16 passing assertions where four had passed, and leaving eight rows in `eval_results` for a four-cell matrix, duplicated on the same `(test_idx, prompt_idx)` coordinates. No process was killed in that control, so this is not an artefact of an interrupted write; the same result appears with two providers sharing an `id()` and with two providers holding distinct ones. It identifies the completed set correctly and then ignores it.

For a prompt harness, re-running a completed cell wastes a cheap API call. Here a cell is a $1-7 durable research job that takes 4 to 60 minutes, and the brief's first requirement and first acceptance criterion are both exactly this. On the 4,000-cell matrix the brief sizes (100 tasks, 8 backends, n=5) a single resume would re-buy every completed cell.

**One further absence, checked separately.** promptfoo has no budget gate: no `--budget`, `--max-cost`, ceiling or spend option exists, and none could exist as a provider or an assertion, because both of those are called *per cell, after the batch has already started*. The brief's second acceptance criterion is a refusal computed on the sum before anything is spent, which is structurally outside promptfoo's extension points.

**Two costs worth recording rather than arguing from.** The install is **1.6 GB** of `node_modules` for a package whose whole competing virtue here is that it is already written; and it depends on `ai@^6.0.190` while this repo is on `ai@^7.0.37`.

### What is adopted, and what is built

The brief forbids two failure modes: abandoning the adoption because it is imperfect, and pretending it fits. Both are avoided by splitting it where the evidence splits it.

**Adopted — the scorer contract.** Every scorer in BENCH-03 through BENCH-07 is written as a pure function returning `{ pass, score, reason }`, which is promptfoo's `GradingResult` verbatim. A promptfoo `javascript` assertion is then a two-line wrapper around one, with no adapter layer, and the results stay comparable with the rest of the ecosystem. This is the half of the adoption that was verified to work, and it is kept exactly.

**Built — the execution shell, and only that.** The two missing pieces are resume-that-does-not-re-buy and a ceiling refused on the sum before the batch. Those two *are* the control loop of a matrix runner, so building "only the missing piece" means building the loop. What is left of promptfoo after removing them is iterating a cross product and bounding concurrency, which is a loop and a semaphore.

**The dependency is not added.** 1.6 GB in every contributor's install and in the gate, plus a second and conflicting definition of what a cell is, buys a web viewer. Exporting the cell store into promptfoo's output shape later would buy the same viewer with none of that, and belongs to BENCH-08, which owns rendering.

**One coupling worth naming.** The repetition fix below also makes promptfoo's broken resume survivable: a re-executed cell would hit Dossier's own fingerprint dedupe and return the existing run for free. That is true only inside the dedupe window (24 hours by default) and a 4,000-cell matrix runs far longer than that, so it is recorded as a fact, not relied on as a mitigation.

### The blocking defect: how the repeat is made expressible

`FingerprintInput` gains an optional `repeat`, and nothing else changes:

- **Omitted or `0` hashes to the byte-identical string it hashed to before.** No stored fingerprint is invalidated, and no in-flight dedupe window is reopened by upgrading.
- **A non-integer or negative `repeat` throws.** Every `NaN` stringifies to the same thing, so a bad index would silently collapse the very cells the field exists to separate — the original defect wearing a disguise. It fails closed, which is the rule `CLAUDE.md` sets for anything gating spend.
- **No nonce, anywhere.** An agent stuck in a retry loop passes the same arguments every time, including this one, and still collapses onto one run. Only a caller that deliberately counts buys a second report.
- **No new MCP tool argument.** The consumer that needs a deliberate repeat is the benchmark harness, which calls `Runner.start()` directly because it lives in this repo. Adding a public argument that defeats dedupe is a footgun for a surface whose documentation is one paragraph in a tool description, and `CLAUDE.md` asks for the minimum change that solves the problem. Recorded here so a later item that genuinely needs it knows the decision was made rather than missed.
- **The index is recorded on the run, not merely hashed into it**, so a stored cell is attributable to its repetition an hour later.

The bench sends `repeat` from 1 upward, never 0. A benchmark cell is therefore never able to dedupe onto a human's earlier ad-hoc run of the same question, which would have made a contaminated sample look like a measurement.

### The contradiction: which document wins

**A stale task loads, is scored, and is counted as stale. `docs/bench/task-format.md` is the one place that rule is written.** `docs/plan/benchmark.md` is corrected by a dated amendment that points at it, rather than silently edited, matching how the prior-art amendment was recorded on 27 July.

The reasoning, in the order it decided the question:

1. **Dropping stale tasks silently narrows the corpus**, which is the exact failure BENCH-01's loader already refuses when it fails a whole load rather than skipping one bad file. A score over a sample nobody chose is the thing this benchmark exists not to produce.
2. **Staleness is a property of the gold, not of the backend.** Excluding the task punishes every backend identically and hides that the suite is decaying, which is information the reader needs more than a marginally cleaner number.
3. **It would make results non-comparable over time.** The same suite would score a different set of tasks every month as items cross the 183-day line, so a movement between two runs could be the backend or could be the calendar, with no way to tell.
4. **Counting with a flag preserves the option; dropping destroys it.** From one run a report can compute both an all-tasks figure and a fresh-tasks-only figure. From a corpus that dropped stale tasks at load, the first can never be recovered without re-buying the research.

BENCH-01 already shipped this behaviour, so the correction is to the design document rather than to code.

### Behaviour changes

- A new benchmark harness under `bench/src/run/`, not compiled into `dist/` and not shipped, that executes a task times backend times repetition matrix and appends one raw record per cell to a JSONL store.
- A batch is planned before it runs. The plan names the total cells, the cells already done, the cells remaining, and the projected worst-case cost of the remainder. If that projection exceeds the batch ceiling it refuses, names the total it needed, and nothing is started.
- Re-running an interrupted batch executes exactly the cells with no recorded outcome. A cell that failed has an outcome and is not retried unless a retry is asked for explicitly.
- `research_start` gains no argument and behaves identically for every existing caller.

### Assumptions

- **The batch ceiling is separate from the rolling-window budget, and both apply.** The harness refuses on its own ceiling before starting; every cell still passes through `Runner.start()` and therefore through the rolling-window gate, the per-provider gate, the concurrency gate and the ledger, exactly as any other run does. The harness reports the rolling-window headroom in the plan but does not refuse on it, because that window rolls during a batch that runs for days and refusing on it would be wrong more often than right.
- **Default concurrency is 3** against a `DOSSIER_MAX_CONCURRENT` default of 10, and is clamped to at most one below the configured maximum so a batch can never take every slot from interactive use.
- **A spread needs three completed repetitions**, taken from `benchmark.md` ("`n = 5` is the target; `n = 3` is the floor at which a spread is reported at all") rather than from a fresh judgement. BENCH-02 owns the rule as a function; BENCH-08 owns showing it. The count is of *completed* repetitions, not of requested ones, so a batch that asked for five and landed two refuses a spread.
- **The harness drives `Runner` directly rather than the MCP protocol.** `bench/` is TypeScript in this repo and `buildDeps()` is already exported; going over stdio would add a transport to test through and would hide the per-cell cost and wall clock behind text.

### Acceptance criteria

| # | Criterion |
|---|---|
| BR-01 | A repetition index is part of the dedupe fingerprint, so `n` repeats of one task on one backend are `n` paid runs |
| BR-02 | A run with no repeat index hashes exactly as it did before the field existed |
| BR-03 | A non-integer, negative or `NaN` repeat index is refused, not hashed |
| BR-04 | The matrix is task times backend times repetition, with one raw record per cell |
| BR-05 | Re-planning after an interruption yields exactly the cells with no recorded outcome |
| BR-06 | A batch whose projected cost exceeds the ceiling refuses before anything starts, and names the total it needed |
| BR-07 | Every cell records wall clock, estimated cost, and the run id that produced it |
| BR-08 | A failed cell is recorded with its reason and is never omitted from the store |
| BR-09 | Concurrency is bounded, configurable, and defaults below the server's own limit |
| BR-10 | `n = 1` plans and runs, and the spread rule refuses a spread from fewer than three completed repetitions |
| BR-11 | The cell store is append-only and survives a process death mid-batch |
| BR-12 | A stale task is loaded and scored, and the rule is written in exactly one place |

## Progress

Implemented on `ai/bench-02` in `.worktrees/BENCH-02`. See the plan for the file-by-file shape and the CHANGELOG entry for what a reader would notice.
