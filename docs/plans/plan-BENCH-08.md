# Plan: BENCH-08, reporting and comparison

**Spec:** [`../specs/spec-BENCH-08.md`](../specs/spec-BENCH-08.md) · **Tier:** Standard · **Branch:** `ai/bench-08`

Seven new files under `bench/src/report/`, six of them pure, one CLI. Nothing in `src/` changes. `bench/src/score/index.ts` is appended to only if a symbol is genuinely missing; nothing there is restructured.

## Order of work

Each step ends with a commit, because a capacity error took four uncommitted worktrees on this fleet already.

### 1. `metrics.ts` — the registry

`METRIC_IDS` tuple, `MetricId` union, `MetricDescriptor { id, label, family, direction, unit, caveat }`, `METRICS` keyed record, `metricDescriptor(id)`, `isRankable(id)`. `direction: 'none'` is what makes a volume metric unrankable, so `isRankable` is the single gate `rank.ts` calls.

Test: every id has a descriptor; volume and validity metrics are not rankable; `calibration-brier` is the only `lower`; the tuple and the record cannot drift (a key-set parity assertion).

### 2. `spread.ts` — median and quartiles

`summarise(values: readonly number[], completed: number): SpreadReport`.
- Median: mean of the two middle values on an even count.
- Quartiles: linear interpolation at 0.25 and 0.75 over the sorted sample (R type 7 / `PERCENTILE.INC`), the most widely implemented definition, named in a comment so a later reader does not "fix" it to a different one.
- The spread is populated only when `spreadEligibility(completed).reportable`; otherwise `spread` is `null` and `spreadWithheld` carries that function's own reason string, verbatim, so this file states no floor of its own.
- Rejects a non-finite value rather than propagating `NaN` through a median.

Test: odd and even medians; a known quartile fixture checked by hand; `n = 1` and `n = 2` withhold with the floor's own wording; `n = 3` reports; a `NaN` input throws.

### 3. `harvest.ts` — one cell to one `ScoredCell`

```ts
harvestCell(input: HarvestInput): ScoredCell
```
`HarvestInput` = `{ cell: CellRecord; task: BenchTask; report?: string; evidence?: CitationEvidenceView & { pages: readonly PageEvidence[] } }`.

- `cell.outcome === 'failed'` ⇒ every metric `null`, every `unmeasured` reason `the cell failed and produced no report`, and return before any scorer runs.
- No report text for an `ok` cell ⇒ same shape with `the report could not be read`. That is a pipeline gap, not a backend result, and it is worded so.
- Otherwise call, in this order: `scoreAccuracy` → `factRecovery` → `scoreCalibration` (which needs the recovery record), `scoreRelevance`, `scoreRefusal`, `scoreDueWeight`.
- With evidence: `scoreCitationIntegrity(report, evidence)` and `scoreSourceQuality(sourceUniverse(report), pages)`.
- Without evidence: the citation and source-quality metrics are `null` with `no citation evidence snapshot was collected for this cell`.
- Recency: always `null`, reason `no publication date is recorded for any source, so the durability axis cannot be fed from stored results`.
- Registry counts come from `CitationIntegrityScored.registryTotal`; with no evidence they are all zero and `evidence: 'absent'` says why.

Every scorer's `not-applicable` arm maps to `null` plus its own `why`, never to `0`. That is the single most important line in the file.

Test: a failed cell scores nothing and explains itself; a not-applicable arm is `null` not `0`; a refusal task's accuracy is `null`; evidence present and absent both produce a well-formed cell; the same input harvests identically twice.

### 4. `aggregate.ts` — the three stages and both refusals

`aggregate(input: AggregateInput): BenchAggregate`, where the input is `{ cells: readonly ScoredCell[]; corpus: TaskCorpus; minTasksPerCategory?: number }`.

Stage 1 groups by `taskId|provider`; stage 2 by `provider|category`; stage 3 per provider. Under-sample verdicts are computed in stage 2 and carried, never recomputed by the renderer. Failures are counted by `failureKind` (falling back to `unclassified`).

`MIN_TASKS_PER_CATEGORY = 5` is exported from here with its derivation in the doc comment.

Test: S1, S2, S9 and S10 land here. A category with two tasks is `under-sampled-corpus`; a backend completing two of six is `under-sampled-completed`; nulls never enter a sample; completion rate counts failures; a category present in the corpus but with no cells at all still appears.

### 5. `rank.ts` — the ordering and its four conditions

`rankBackends(metric, candidates): Ranking`. Withholds on: unrankable metric, unscorable scope, any candidate below the spread floor, fewer than two candidates. Sorts by direction. Marks adjacent overlapping IQRs as tied, and every ranking carries the sentence saying the overlap check is descriptive and not a significance test.

Test: `n = 1` withholds and names the floor; a volume metric withholds; `calibration-brier` sorts ascending; overlapping spreads tie; one candidate withholds.

### 6. `render.ts` — markdown and JSON

`renderMarkdown(aggregate): string` and `renderJson(aggregate): string`. Section order is the spec's. The validity panel is first. Citation accuracy columns and citation volume columns are rendered by two separate calls over two separate metric lists, so they cannot be merged by editing one array.

Test: the stale count and the unchecked count appear before any score; every value carries `n`; accuracy and volume are separate columns; a withheld ranking prints its reason; rendering twice is byte-identical; a metric with no value renders as unavailable with a reason.

### 7. `cli.ts` and `index.ts`

`bench-report --cells <file> [--tasks <dir>] [--store <dir>] [--evidence <dir>] [--min-tasks <n>] [--format markdown|json] [--as-of <YYYY-MM-DD>]`.

Reads, hands in, prints. Unknown flags refused, as the run CLI does. `--as-of` defaults to today and is echoed on the report, because staleness is measured against it. Reports to stdout, diagnostics to stderr. Never imports `Runner` and never spends.

Test: arg parsing including an unknown flag and a bad date; an end-to-end render from a temporary JSONL, corpus and report file.

### 8. Docs and the shared files

- `docs/bench/reporting.md` — the new reference: what each number is, both refusal rules, the recency gap, and what none of it can mean.
- `docs/test-plan.md` — AC rows appended in a new `### BENCH-08` section, **before** the tests are written.
- `CHANGELOG.md` — one entry appended under `## [Unreleased]`.
- `CLAUDE.md` — the repo-layout block gains the `bench/src/report/` lines and the docs list gains `docs/bench/reporting.md`.
- `package.json` — a `bench:report` script beside `bench:verify`.
- `docs/features-to-triage/LEDGER.md` — the BENCH-08 row only.

## Verification

`npm run gate` twice, plus a protocol-level stdio smoke against `dist/index.js` (initialize, `tools/list`, call `research_plan`) to prove the build still serves the MCP surface, since the gate builds `dist/` and this item must not have disturbed it. No Playwright; there is no UI.

## Risks

- **Scope creep into BENCH-13.** Mitigation: no bootstrap, no CI, no significance test. The overlap tie note explicitly hands that over.
- **A wide markdown table.** Mitigation: one table per metric family rather than one table with sixteen columns.
- **`bench/src/score/index.ts` collisions.** Several items have edited it. Mitigation: append only if something is genuinely missing; prefer importing from the owning module directly.
