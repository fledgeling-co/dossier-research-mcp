# Plan: BENCH-13, the statistics

**Spec:** [`../specs/spec-BENCH-13.md`](../specs/spec-BENCH-13.md) · **Tier:** Standard · **Branch:** `ai/bench-13`

Four new pure modules under `bench/src/stats/`, one new pure module under `bench/src/report/`, and three surgical edits to files BENCH-08 already owns. Nothing in `src/` changes. `bench/src/score/index.ts` is not touched.

The shape of the change is decided by one instruction: **extend BENCH-08, do not build beside it.** So the new statistics do not get their own CLI, their own floors or their own report. They get wired into the aggregate, the ranking and the renderer that already exist, and where they answer a question BENCH-08 already answers, they extend that answer in place.

## Order of work

Each numbered step ends with a commit.

### 1. `bench/src/stats/random.ts`

A seeded PRNG. `mulberry32`, thirty lines, self-contained, no dependency. Plus `seedFrom(parts: readonly string[])`, an FNV-1a hash over the comparison's identity, so the seed is a function of what is being compared rather than of when it was compared.

Reason it exists at all: the bootstrap must be reproducible or the report stops being byte-identical between two renders of one store, which is a property `docs/bench/reporting.md` states and a test already enforces.

Tests: the sequence is stable across calls; two different seeds diverge; the output is in `[0, 1)`; `seedFrom` is order-sensitive and never returns zero.

### 2. `bench/src/stats/clustered.ts`

```ts
clusteredError(observations: readonly Observation[]): ClusteredError | null
```

`Observation = { value: number; cluster: string }`.

- `naive = sqrt((1/n^2) * sum_i (v_i - mean)^2)`
- `clustered = sqrt((1/n^2) * sum_c (sum_{i in c} (v_i - mean))^2)`

The second form is algebraically identical to Miller's `SE_CLT^2 + (1/n^2) sum_c sum_{i != j} (...)`, and is written this way because it is a sum of squares and therefore provably non-negative, where the additive form can be handed a negative radicand by a floating-point rounding on strongly negatively-correlated clusters. The equivalence is stated in the module and asserted by a test.

Also returned: `inflation = clustered / naive` (null when naive is zero), `designEffect = inflation^2`, the cluster count and the per-cluster sizes.

Tests: singleton clusters give `inflation === 1` exactly (STAT-08); perfectly correlated clusters of size `m` give `inflation === sqrt(m)` (STAT-07); a hand-computed three-value fixture matches; both additive and sum-of-squares forms agree on a fixture with a negative within-cluster covariance; zero variance returns zero rather than NaN.

### 3. `bench/src/stats/bootstrap.ts`

```ts
clusterBootstrap(observations, options): BootstrapResult
```

Percentile bootstrap over **clusters**: each resample draws `C` clusters with replacement and takes the mean of every observation inside them, so a category is drawn or not drawn as a unit and within-category correlation survives the resampling. 5,000 resamples by default, 95% two-sided, both stated on the result rather than assumed by the caller.

`crossesZero` is computed here, once, so the renderer cannot re-derive it differently.

Tests: the same input gives the same interval twice (STAT-04); a sample centred on zero crosses zero; a sample far from zero does not; the interval widens when clusters are correlated versus when the same values are spread one per cluster (which is STAT-05 made observable); the resample count and level are echoed.

### 4. `bench/src/stats/paired.ts`

```ts
pairedDifference(input: PairedInput): PairedDifference
```

Input is two named backends and their per-task values. It intersects on task id, computes `d_i = a_i - b_i` per shared task, carries each task's category as the cluster, then calls `clusteredError` and `clusterBootstrap` over the differences.

The verdict is one of `measured`, `no-measured-difference`, or a withheld reason drawn from the same vocabulary `rank.ts` already uses. `NO_MEASURED_DIFFERENCE` is exported as a constant holding the literal words, so the phrase cannot drift (STAT-03).

`pointEstimate` is present on the result and is **omitted from the rendered line** when the verdict is `no-measured-difference`; the interval still prints, because bounds on a magnitude are information and a point estimate is an invitation to rank.

Tests: pairing drops a task only one side has and names the count (STAT-01); a difference straddling zero is `no-measured-difference` and its rendering contains the literal phrase; fewer than two shared tasks withholds; the direction of the metric is respected so "better" is not hardcoded to "larger".

### 5. `bench/src/stats/reliability.ts`

```ts
passRates(input: ReliabilityInput): ReliabilityReport
```

Per task: `k` = completed repetitions, `passes` = repetitions whose primary-metric value met the threshold. Then

- `passAt1` = total passes / total repetitions, over tasks that cleared the floor.
- `passHatK` = share of tasks where every one of the `k` repetitions passed.
- `k` is the **minimum** completed repetition count across the tasks counted, and it is printed, because a `pass^k` quoted from a mixture of 3 and 7 repetitions is two different numbers in one column.

The floor is `spreadEligibility(k).reportable`, imported, never restated (STAT-10).

Tests: a backend passing every repetition has both figures at 1; a backend passing two of three on every task has `pass@1 = 2/3` and `pass^k = 0`, which is the brief's headline case; `k = 2` withholds `pass^k` and says which floor; the primary metric falls back from refusal to accuracy and a task with neither is excluded with a reason.

### 6. `bench/src/report/comparison.ts`

The join. Takes a `BenchAggregate` and produces every pairwise comparison the aggregate can support, applying **BENCH-08's gates first**: the metric must be rankable, the scope scorable, and both candidates must clear the repetition floor. Only then does it pair.

Per-task values come from `agg.taskGroups[].metrics[id].median`, which is stage 1's figure, so the statistics are computed over the same numbers the tables print.

Also produces the report-level summary the validity panel needs: how many comparisons were attempted, how many were withheld and why, and how many produced a measured difference (STAT-14).

Tests: a gate failing in `aggregate.ts` withholds here with the same reason word (STAT-16); comparisons are emitted in a stable order; two backends with no shared task are withheld rather than compared.

### 7. `bench/src/run/cell.ts`, one added constant

`TARGET_REPETITIONS = 5`, beside `MIN_REPETITIONS_FOR_SPREAD`, with the same provenance sentence pointing at `docs/plan/benchmark.md`. The completion share is derived from the two rather than chosen, which is what makes it defensible.

### 8. `bench/src/report/aggregate.ts`, the completion floor

`MIN_COMPLETION_SHARE = MIN_REPETITIONS_FOR_SPREAD / TARGET_REPETITIONS`. A fourth arm on `verdictFor`, reason `under-completed`, checked **after** the corpus floor and the nothing-completed arm so an under-sampled corpus is still named as such (STAT-12). `minCompletionShare` joins `AggregateInput` and `BenchAggregate`, validated like `minTasksPerCategory`.

Tests: 0.5 completion withholds as `under-completed`; 0.6 exactly is admitted (the floor is inclusive and the test says so); the corpus floor still wins when both apply.

### 9. `bench/src/report/rank.ts`, the separation oracle

`rankBackends` takes an optional `separation` callback. Where it returns a verdict for an adjacent pair, that verdict decides the tie; where it returns null, the interquartile overlap decides, as now (STAT-17). `OVERLAP_NOTE` is rewritten: it currently says bootstrap intervals are BENCH-13 and have not landed, which stops being true with this change.

Tests: with a `no-measured-difference` separator, two non-overlapping spreads tie; with a `measured` separator, two overlapping spreads separate; with no separator the existing behaviour is unchanged, which the existing tests already assert.

### 10. `bench/src/report/render.ts`, three additions

- The validity panel gains a **separation line**, above every score: how many comparisons were attempted and how many produced a measured difference, with a plain sentence when that count is zero.
- A `## Differences between backends` section: one table per rankable metric and scope with a comparison, columns for the pair, the shared task count, the difference or the literal `no measured difference`, the interval, the naive and clustered standard errors, and the inflation ratio.
- A `## Reliability` section with `pass@1`, `pass^k`, `k`, and the threshold and metric each was computed against.

`renderJson` carries all of it, since BENCH-11 and anything after it consume the JSON rather than the prose.

Tests: the literal phrase appears (STAT-03); the zero-comparisons sentence appears on the current corpus; the citation rates and the citation volumes are still two tables (STAT-13); the JSON round-trips the comparisons.

### 11. `bench/src/report/cli.ts`, one flag

`--min-completion <share>`, validated as a number in `(0, 1]`, refused on anything else. Wired into `aggregate`.

### 12. `bench/src/stats/index.ts` and the report barrel

Exports only. No new names collide with `bench/src/score/index.ts`; checked before writing, because a name collision through an append-only merge already nearly shipped on this fleet.

### 13. Docs

- `docs/bench/statistics.md`, new: the four statistics, the formulas, every threshold's provenance, and what none of the numbers can mean.
- `docs/bench/reporting.md`: the two sentences that say BENCH-13 has not landed are replaced by what actually landed, in place, with the date.
- `CLAUDE.md`: one line in the repo-layout block for `bench/src/stats/`.
- `docs/test-plan.md`: the AC rows, appended, **before** the tests are written.
- `CHANGELOG.md`: one entry under Unreleased.

### 14. Verification

`npm run gate` twice, plus the stdio smoke against `dist/index.js` (initialize, `tools/list`, `research_plan`), since this repo has no UI and that is the substitute for an end-to-end run.

## Risks

- **The paired test could be wired in and never bite.** The corpus has seven tasks in four categories, all below the task floor, so every scope is unscorable and every comparison is withheld. That is the correct answer for this corpus and it is also indistinguishable from a broken wiring, so the tests carry their own fixtures with enough tasks to make the machinery run, and the report says which of the two it is.
- **`rank.ts` is load-bearing.** Its tie rule is the thing BENCH-08 found its own defect in twice. The separation callback is optional and defaulted to absent, so every existing test exercises the unchanged path and the new path is tested on top.
- **`aggregate.ts` is shared.** The completion floor is an added arm, ordered after the existing ones, with the existing tests left untouched to prove they still pass.
