# Plan: BENCH-02, the run harness

**Spec:** [spec-BENCH-02](../specs/spec-BENCH-02.md) · **Tier:** Standard · **Branch:** `ai/bench-02`

## Shape

Two changes to `src/`, one new slice under `bench/`.

### `src/` — the blocking defect only

| File | Change |
|---|---|
| `src/research/contract.ts` | `FingerprintInput.repeat?: number`. Appended to the canonical string **only** when greater than zero, so the default case hashes identically to before. Throws on a non-integer or negative value |
| `src/research/runner.ts` | `StartRunArgs.repeat?: number`, threaded into `fingerprintFor()` and onto the stored `RunRecord` |
| `src/store/types.ts` | `RunRecordSchema.repeat`, optional, 1 to 1000 |

Nothing else in `src/` moves. No tool argument, no change to any existing caller's behaviour.

### `bench/src/run/` — the harness

The same pure/impure split BENCH-01 used, for the same reason: everything that decides anything is testable without a filesystem, a network or a wallet.

| File | Purity | Responsibility |
|---|---|---|
| `cell.ts` | pure | The cell key, the cell record Zod schema, the spread rule |
| `plan.ts` | pure | Build the matrix, subtract what is done, sum the projected cost, refuse or proceed |
| `store.ts` | reads/writes a disk | Append-only JSONL cell store; read back the completed keys |
| `harness.ts` | pure given an injected executor | Bounded-concurrency execution, wall clock, failure capture |
| `dossier.ts` | impure | The real executor: `Runner.start()`, wait for terminal, read the report path |
| `cli.ts` | impure | Load corpus, plan, print, refuse or run |
| `index.ts` | — | Barrel |

## Decisions worth stating

**The cell key is `taskId · provider · repeat`, joined by a separator no id can contain.** `BenchTaskFile.id` is a slug and `ProviderId` is an enum, so a `/` separator is unambiguous. The key is what resume subtracts, so an ambiguous key is a cell silently bought twice or silently skipped.

**Repeat is 1-based in the bench.** `repeat: 0` in the fingerprint means "not a deliberate repeat" and is reserved for ordinary runs, so the bench never emits it. A consequence worth having: a benchmark cell can never dedupe onto a human's earlier ad-hoc run of the same question.

**Resume subtracts recorded outcomes, not successes.** A failed cell has an outcome and is not re-run by default, because the brief requires the failure to be recorded rather than retried into invisibility, and because a retry may buy a second report when the first one was charged. `planBatch({ includeFailed: true })` re-queues them for an operator who knows the failure was free.

**The projected cost is the sum of worst cases, not of midpoints.** Same rule as `Runner.start()`: reserving the midpoint for a batch that runs at the top of the band is not a ceiling. The estimate comes from the same `estimate()` the Runner uses, so the two cannot drift.

**The harness refuses on its own ceiling; the Runner still refuses on the rolling window.** Two gates, not one dressed as two. The plan reports the rolling-window headroom so an obviously doomed batch is visible up front, and does not refuse on it, because that window rolls during a multi-day batch.

**The executor is injected.** `harness.ts` takes `execute(cell) => Promise<CellOutcome>`. Every acceptance criterion is then testable hermetically, and `dossier.ts` is the only file that can spend anything.

## Test plan

Unit, in `bench/src/run/*.test.ts` and `tests/contract.test.ts`, hermetic throughout.

- Fingerprint: repeat changes the hash; absent and `0` reproduce the pre-change hash exactly (pinned against a literal, so a future edit to the canonical string is caught); `1.5`, `-1` and `NaN` throw.
- Runner: two starts differing only in `repeat` do not dedupe; two identical starts still do; the index lands on the record.
- Plan: matrix size; subtraction of completed keys; refusal above the ceiling naming the total; `n = 1` plans one repeat per pair; `includeFailed`.
- Harness: concurrency never exceeds the bound; a throwing executor is recorded failed with its reason and does not stop the batch; wall clock and cost recorded.
- Store: round-trip; a truncated last line is reported rather than crashing the read; append-only.
- Spread: fewer than three completed repetitions refuses, with a reason.

Verification is `npm run gate` run twice, plus the stdio smoke test against `dist/index.js` (`initialize`, `tools/list`, `research_plan`), because the fingerprint change touches the spend handshake that `research_plan` returns.
