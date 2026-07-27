# The benchmark run harness

The benchmark executes a matrix of **task times backend times repetition** and keeps one raw record per cell. This document covers what a cell is, how a batch is planned and refused, how a resume works, and why the harness is written here rather than on top of promptfoo.

Nothing here scores anything and nothing here renders anything. The design of record is [`../plan/benchmark.md`](../plan/benchmark.md); the task format it runs over is [`task-format.md`](task-format.md).

## Why the run and the scoring are separate

Research is the expensive part and scoring is the part that will keep changing. Storing the raw report per cell means a metric invented in three months can be applied to research already paid for, instead of re-buying it to answer a new question about it.

That only works if the cell store is append-only and never rewritten, which is why it is JSONL and why nothing in the harness edits a line after writing it.

## What a cell is

One task, on one backend, at one repetition index. The key is `taskId/provider/repeat`, and it is what a resume subtracts, so a key two cells could collide on is a cell bought twice or a cell never bought at all. Task ids are slugs and provider ids are enum members, so neither can contain the separator.

Every cell records the run id, the wall clock, and the worst-case cost that was reserved for it. A backend scoring two points higher for six times the money or six times the time is a finding rather than a winner, and neither number is recoverable after the fact.

The report is **referenced, not inlined**. A Deep Research report is roughly 60,000 tokens, and four thousand of those in one file is a store nothing can open.

### A failed cell is recorded, never omitted

An omitted failure silently improves the backend's score. It is the same defect as a throttled search counting as an established absence: the sample quietly shrinks and the average quietly rises, with nothing on screen to say so. The 2026 prior art reaches the same conclusion from the other direction and promotes completion rate to a validity metric, which is only computable if the failures are in the store.

The repo's own ledger is the argument. `local-codex` was 0 for 3 and `openai` 0 for 2, and both would have vanished from a naive average rather than showing up as the infrastructure problems they were.

## Repetitions, and the defect that made them necessary

Deep research is non-deterministic, so a single run per pair is a rank ordering of noise. Every task runs `n` times per backend and is reported as a median with a spread.

That did not work before this item. `FingerprintInput` in `src/research/contract.ts` carried prompt, tier, tools, planning, attachments, provider, shape and window, and **no repetition index**, so `n = 5` of one task on one backend inside the dedupe window collapsed onto **one paid run**. Every spread, every `pass^k` and every non-determinism figure would have been one sample reported as five. The measurement most sensitive to the defect is the one it makes look cleanest, because five identical copies of one report have zero variance.

The fix makes a deliberate repeat **expressible**, and does not weaken dedupe:

- Omitted, or `0`, hashes to the byte-identical string it hashed to before the field existed. No stored fingerprint is invalidated and no live dedupe window is reopened by upgrading.
- A fractional, negative or `NaN` index throws rather than hashing. Every `NaN` stringifies alike, so a bad index would silently collapse the very cells the field exists to separate.
- **No nonce, anywhere.** An agent stuck in a retry loop passes the same arguments every time, including this one, and still collapses onto the run it already bought. Only a caller that deliberately counts buys a second report.

The bench counts from 1 and never sends 0, so a benchmark cell can never dedupe onto a human's earlier ad-hoc run of the same question. A contaminated sample that looks like a measurement is worse than an extra purchase.

### The spread floor

`n = 1` is allowed. What is not allowed is quoting a spread from it. `spreadEligibility()` is the single place that rule lives, the floor is **three completed repetitions**, and the count is of repetitions that actually produced a report rather than of the `n` that was asked for. A batch that requested five and landed two has two samples.

## Planning a batch, and refusing one

Everything free happens before anything paid, which is the same ordering `src/research/runner.ts` uses. The planner subtracts the cells that already have a recorded outcome, totals the **worst case of the remainder**, and refuses above the ceiling before a single cell starts, naming the total it needed.

Two details that matter more than they look:

- **The projection covers the remainder, not the matrix.** A plan that totalled the whole matrix would refuse a resume that costs almost nothing, and a gate that refuses the cheap case is a gate people turn off.
- **The worst case, not the midpoint.** Reserving the midpoint for a batch that runs at the top of its band is not a ceiling. The estimate comes from the same `estimate()` the runner reserves with, so the two cannot drift.

The per-cell figure is the backend's own band **plus the utility call** Dossier reserves separately to title and summarise every completed run. That call sits outside every provider's band, so leaving it out understated a 4,000-cell batch by up to $0.08 a cell and let real spend past the batch ceiling unaccounted.

There are two ceilings and both apply. The harness refuses on its own batch ceiling up front; every cell still goes through `Runner.start()` and therefore through dedupe, the concurrency cap, the per-provider budget, the rolling-window budget and the ledger, exactly as any other run does. The plan **reports** the rolling-window headroom and does not refuse on it, because that window rolls while a multi-day batch runs.

`--ceiling` is required. A batch with no ceiling is the one that quietly buys four figures of research.

## Concurrency

Bounded, configurable, and clamped to at least one below `DOSSIER_MAX_CONCURRENT` so a batch that runs for days can never take every slot from interactive use of the same server. The default is 3 against a server default of 10.

## Resuming

Re-run the same command. The store is read, the completed keys are subtracted, and exactly the cells with no recorded outcome are queued.

A cell is persisted **before** its slot is released, so a process killed mid-batch has every finished cell already on disk. A failure to *execute* is caught and recorded; a failure to *record* is deliberately not caught and ends the batch, because a store that cannot be written to means every further cell is money spent that no resume can find.

A cell that failed has a recorded outcome and is not retried by default. `--include-failed` re-queues them, for an operator who knows the failure was free.

A torn last line, which is what a process killed mid-append leaves, is reported and skipped rather than making the rest of the file unreadable. This is the one place in the benchmark where skip-and-continue is right: the corpus loader fails a whole load because a dropped *task* narrows the sample, whereas a damaged *result* line is a cell that will simply be re-run.

Two rows can legitimately carry the same cell key: a cell that failed and was later retried, or two batches over one store. The reader collapses them last-wins and reports how many rows were superseded, so a cell cannot be double-counted in a downstream average. Criticising promptfoo for duplicate rows at the same coordinates and then shipping them here would be indefensible.

### What resume does not promise

**This is at-least-once, not exactly-once, and it cannot be anything else.** Buying a report and recording it are two acts, so a process killed between them leaves a cell that was paid for and is not in the store, and the resume executes it again. The harness test asserts this directly: a 24-cell matrix interrupted after the ninth record takes **25 executions** to complete, not 24.

What bounds the damage is not the harness. It is Dossier's own fingerprint dedupe: the re-executed cell carries the same task, backend and repetition, so it computes the same fingerprint and returns the run already bought, for nothing. That holds inside the dedupe window, 24 hours by default. Outside it, or with `DOSSIER_DEDUPE_TTL_MINUTES=0`, the re-execution is a second purchase.

**Two batches pointed at one store are not prevented.** There is no cross-process batch lock. Both plan from the same store, both queue the same cells, and both execute them. The same dedupe closes the spend hole under the same condition, and the last-wins reader closes the double-counting hole unconditionally, but the wall clock is wasted either way. Run one batch per store.

## Stale tasks

**A stale task is loaded, scored, and counted as stale.** The rule is written in one place, [`task-format.md`](task-format.md), and the harness prints the stale count and the stale ids before it starts, because a score over a corpus that is a third stale is a different claim from one that is not.

## Why this is not built on promptfoo

The brief for this item said to adopt promptfoo as the shell, and made the adoption conditional on four claims that were to be checked against the real package first. They were. Every result below comes from `promptfoo@0.121.19`, published 2026-07-14, installed and driven on 27 July 2026 with two custom `file://` providers, a custom `javascript` assertion, and a matrix of two tasks times two providers.

| Claim | Verdict |
|---|---|
| Multi-provider runs | Holds. Two tasks times two providers times `--repeat 3` executed 12 distinct cells |
| A custom scorer sees the whole report | Holds. The assertion received the full 120,032-character output, and `context.providerResponse` carries the complete provider response beside it |
| Raw output stored per cell | Holds. `eval_results` stores `response`, `latency_ms`, `cost`, `error` and `metadata` per row |
| **Resumes an interrupted matrix** | **Does not hold** |

### The resume measurement

A four-cell evaluation was run to completion, making four provider calls. `promptfoo eval --resume` was then run against it. It printed:

```
Resuming: skipping 4 previously completed cases
Running 4 test cases (up to 1 at a time)...
```

and called the provider **four more times**, reporting 16 passing assertions where four had passed, and leaving eight rows in `eval_results` for a four-cell matrix, duplicated on the same `(test_idx, prompt_idx)` coordinates. No process was killed in that control, so it is not an artefact of an interrupted write, and the same result appears whether the two providers share an `id()` or hold distinct ones. It identifies the completed set correctly and then ignores it.

For a prompt harness, re-running a completed cell wastes a cheap API call. Here a cell is a $1 to $7 durable research job that takes 4 to 60 minutes, and resume is this item's first requirement and first acceptance criterion. On the 4,000-cell matrix the design sizes, one resume would re-buy every completed cell.

### The other absence

promptfoo has no budget gate. There is no `--budget`, no `--max-cost`, no ceiling or spend option, and none could exist as a provider or an assertion, because both of those are called **per cell, after the batch has already started**. A refusal computed on the sum before anything is spent is structurally outside its extension points.

### What was adopted anyway

The half that was verified to work is kept exactly. Every scorer in the benchmark returns `{ pass, score, reason }`, which is promptfoo's `GradingResult` verbatim, so a promptfoo `javascript` assertion is a two-line wrapper around one and the results stay comparable with the rest of the ecosystem.

What is built here is the execution shell, because the two missing pieces are resume-that-does-not-re-buy and a ceiling refused on the sum, and those two *are* the control loop of a matrix runner. What remains of promptfoo after removing them is iterating a cross product and bounding concurrency, which is a loop and a semaphore.

The dependency is not added. It installs **1.6 GB** of `node_modules` and depends on `ai@^6.0.190` while this repo is on `ai@^7.0.37`. That buys a web viewer, and exporting the cell store into promptfoo's output shape later would buy the same viewer with none of the weight.

One coupling is worth naming rather than relying on: because a repetition index is now part of the fingerprint, a cell re-executed inside the dedupe window returns the existing run for free, so Dossier's own dedupe would blunt promptfoo's resume defect. That window is 24 hours by default and a 4,000-cell matrix runs far longer, so it is a fact about the system and not a mitigation.

## Running it

```bash
npx tsx bench/src/run/cli.ts --providers gemini,perplexity --repeat 5 --ceiling 200 --dry-run
```

Plan first. `--dry-run` prints the matrix, the remaining cells, the projected worst case and the spread verdict, and starts nothing. Drop the flag to run.

| Flag | Meaning |
|---|---|
| `--providers <ids>` | Comma-separated backend ids. Required |
| `--ceiling <usd>` | Refuse the batch if the remainder projects above this. Required |
| `--repeat <n>` | Repetitions per task per backend. Default 5; the spread floor is 3 |
| `--tasks <dir>` | Corpus directory. Default `bench/tasks` |
| `--out <file>` | Cell store. Default `bench/results/cells.jsonl` |
| `--concurrency <n>` | Cells in flight. Default 3, clamped below `DOSSIER_MAX_CONCURRENT` |
| `--include-failed` | Re-queue cells whose recorded outcome was a failure |
| `--dry-run` | Plan and print, start nothing |

Exit codes: `0` ran or had nothing to do, `1` no tasks found, `2` refused by the ceiling.
