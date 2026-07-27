# Implementation Plan: BENCH-05

**Title:** Due weight, viewpoint coverage
**Spec ID:** BENCH-05
**Spec:** docs/specs/spec-BENCH-05.md
**Plan size:** Standard

## Task

Add the benchmark's due-weight scorer: three pure metrics over one loaded task and one report, plus an aggregate over a set of those results. Dissent recall asks whether the report reached a dissenting source the task author named in advance, by its canonical URL or by its literal distinguishing term. Conflict acknowledgement asks whether both authoritative figures for one quantity are present, or the disagreement flagged near the quantity. The false-balance guard asks whether a documented fringe claim on a settled question was surfaced as though it were contested. No model is called at any point; every answer comes from string and number comparison against fields BENCH-01 already records.

## Approach

One new directory, `bench/src/score/due-weight/`, holding three source modules and their tests. A directory rather than a file so the text and number primitives are separately reviewable and separately testable, and a directory named after the item so the six concurrent wave-2 runners cannot collide on a file name.

Two decisions carry the whole item and are the reason it is not just three string searches.

**The overall is a suite-level harmonic mean of the three metric means.** The false-balance guard lives on `settled-with-fringe` tasks and the other two live on `contested` tasks, so no single task can carry all three and a per-task overall cannot express the trade at all. Weighting per metric rather than per task stops ninety contested tasks drowning ten fringe tasks. Taking the harmonic mean rather than the arithmetic one is what makes 1.0 / 1.0 / 0.0 read as 0 instead of 0.67, which is the difference between "hedging is penalised" and "hedging costs a third of a mark".

**The overall is withheld when no fringe task ran.** Without the counterweight the number rewards indiscriminate hedging, and a caveat printed beside a number is read as a number.

Every result carries a `limits` array in words. The acceptance criterion is explicit that the synonym limit is *stated in the output rather than hidden*, and the same discipline is applied to every other approximation this scorer makes.

## Reference implementation

- `bench/src/tasks/schema.ts` — the fields this scorer binds to (`KnownDissentSchema`, `ConflictingFigureSchema`, `FringeClaimSchema`, `ToleranceSchema`) and the comment density to match. The schema's own comments already name the failures this item scores.
- `bench/src/tasks/corpus.ts` — `ApplicableMetrics` is consumed, never re-derived. Its own comment gives the reason: four scorers each re-deriving one eligibility rule is how two implementations end up disagreeing about the rule.
- `src/research/corroborate.ts` (`canonicaliseUrl`) — imported directly. Tracking parameters, `www.`, trailing slashes and fragments all produce different strings for one page, and every one of them would otherwise read as a missed citation.
- `src/research/report.ts` (`extractCitedUrls`) — imported directly, to derive the cited-URL list from report markdown when the caller does not supply one. It already handles `<cite url="…">`, markdown links, CommonMark autolinks and bare URLs.
- `src/research/evidence.ts` — named only to fix where source classification lives (BENCH-07). Not called here.
- `bench/src/tasks/corpus.test.ts` — the closest existing test shape: pure functions, inline fixtures, one behaviour per assertion.

## Prerequisites

None. No new dependency. `bench/` is already wired into `tsconfig.json`, the vitest `unit` project and `scripts/check-source-hygiene.mjs` by BENCH-01, and `bench/src/score/**/*.test.ts` is matched by the existing `bench/**/*.test.ts` glob.

## Steps

### 1. Append the AC rows to the test plan

- **File:** `docs/test-plan.md`
- **Action:** Modify
- **Details:** Append the `DUEWT-*` rows to the end of the AC-traceability matrix, after the last existing row and before `### The paid project`. Append only; never reorder another fleet item's rows. Before the tests, per `CLAUDE.md`, so coverage follows the contract.
- **Verify:** `npm run lint:docs`.

### 2. The text primitives

- **File:** `bench/src/score/due-weight/text.ts`
- **Action:** Create
- **Details:** An offset-preserving normaliser and a literal, boundary-respecting term search over it.
  - `normaliseForMatch(text)` returns `{ text, offsets }`: the text lower-cased, runs of whitespace collapsed to one space, and the typographic characters that are the same character in a different costume folded (curly quotes to straight, en and em dashes to hyphen, non-breaking and narrow spaces to space). `offsets[i]` is the index in the **original** string that normalised character `i` came from, which is what lets proximity be measured against real positions after the length has changed.
  - `findTermOffsets(normalised, term)` returns every original-string offset where the term occurs. The term is normalised the same way. A match is rejected unless both ends sit on a word boundary: if the term's first normalised character is a letter or digit the preceding character must not be, and the same at the end. Without that a two-letter term matches inside longer words and the metric reports recall that is not there.
  - `containsTerm(normalised, term)` is `findTermOffsets(...).length > 0`.
  - `nearestDistance(a, b)` returns the smallest absolute difference between any offset in `a` and any offset in `b`, or `null` when either is empty. Both lists are produced in ascending order, so this is a linear merge rather than a product.
  - `PROXIMITY_CHARS = 500`, exported and named, roughly a paragraph. Used by both the disagreement check and the rejection-cue check, so "in the same passage" means one thing in this scorer.
- **Verify:** unit tests; `npm run typecheck`.

### 3. The number primitives

- **File:** `bench/src/score/due-weight/numbers.ts`
- **Action:** Create
- **Details:** Extract numeric mentions from report prose and compare them to a gold value under the task's declared tolerance.
  - `extractNumericMentions(text)` returns `{ value, index, length, text }` per mention. Handles a leading sign, comma-grouped thousands, a decimal part, an exponent, an optional `%`, and an optional magnitude word or suffix (`thousand`, `million`, `billion`, `trillion`, and `k`, `m`, `mn`, `bn`, `b`, `tn`, `t`) with or without a space before it.
  - **Magnitude is applied by shifting the decimal point in the digit string, never by multiplying.** Measured in Node rather than assumed: `1.2 * 1e9` does land on `1200000000` exactly, but `1.07 * 1e9` is `1070000000.0000001` and `2.01 * 1e3` is `2009.9999999999998`, so a report stating the gold value correctly would fail an `exact` tolerance roughly one time in ten thousand. Shifting the decimal point in the digit string is exact for every input.
  - Boundary rules, so a version string and an ISO date do not become numbers: a candidate is rejected when the character before it is a letter, digit, `.`, `,`, `-`, `_` or `/`; and when the character after the numeric core is `.`, `-` or `/` followed by a digit. A trailing letter is allowed only when it is exactly one of the magnitude suffixes and is itself followed by a non-alphanumeric.
  - `matchesTolerance(actual, expected, tolerance)` implements the four arms: `exact` is strict equality, `absolute` is within `±value`, `relative` is within `|expected| × fraction`, `significantFigures` rounds both with `toPrecision` and compares.
  - `findValueInText(text, expected, tolerance)` returns the first matching mention or `null`.
- **Verify:** unit tests; `npm run typecheck`.

### 4. The scorer

- **File:** `bench/src/score/due-weight/index.ts`
- **Action:** Create
- **Details:** The public surface.
  - `ScoredReport` is `{ text: string; citedUrls?: readonly string[] }`. Structural on purpose: BENCH-02 owns the canonical run record and does not exist yet, so the harness satisfies this without importing anything. When `citedUrls` is absent it is derived from `text` with `extractCitedUrls`, so a report and its citation list cannot disagree.
  - `Measured<T>` is `({ measured: true } & T) | { measured: false; reason: string }`. A metric a task cannot support is not zero and must never be summed as zero.
  - `scoreDueWeight(task: BenchTask, report: ScoredReport): DueWeightScore` computes the three metrics, gated by `task.applicableMetrics`.
    - **Dissent recall.** Per `knownDissent` entry, `reachedBy` is `url`, `term`, `url-and-term` or `missed`. URL match is `canonicaliseUrl` on both sides and string equality. Score is reached over total.
    - **Conflict acknowledgement.** Per `conflictingFigures` entry: every value looked up with `findValueInText` under its own tolerance; `unitNearby` recorded per value by searching for the declared unit within `PROXIMITY_CHARS` of the matched mention, reported and never gating; `disagreementFlagged` true when a `DISAGREEMENT_CUES` phrase sits within `PROXIMITY_CHARS` of a mention of the `quantity`. Outcome and score: `both-figures` 1, `flagged-only` `FLAGGED_ONLY_CREDIT`, `one-sided` 0, `unaddressed` 0. `one-sided` and `unaddressed` score the same and are named differently because they are different failures and a scorecard that conflates them is less useful than one that does not.
    - **False-balance guard.** Per `fringeClaims` entry: `not-surfaced` when the distinguishing term is absent (1); `surfaced-and-rejected` when a `rejectionCues` phrase sits within `PROXIMITY_CHARS` of a mention (1); `surfaced-as-contested` otherwise (0).
  - `DISAGREEMENT_CUES` and `FLAGGED_ONLY_CREDIT` are exported constants, so the vocabulary is inspectable rather than buried, and half credit is a named decision rather than a magic number.
  - `limits` is assembled per task from what actually applied, including the per-task case of a fringe claim recorded with no rejection cues.
  - `aggregateDueWeight(scores)` returns the three metric means, `overall`, `overallReason`, `guardApplied` and the deduplicated union of the task limits. `overall` is the harmonic mean of the measured metric means, `0` when any of them is `0`, and `null` when `guardApplied` is false or when nothing was measured.
- **Verify:** unit tests; `npm run typecheck`.

### 5. Tests, including the hedging fixture

- **Files:** `bench/src/score/due-weight/text.test.ts`, `numbers.test.ts`, `index.test.ts`, `hedging.test.ts`
- **Action:** Create
- **Details:** One test per AC row from step 1. `hedging.test.ts` is the acceptance criterion made mechanical: a corpus of contested and settled-with-fringe tasks, two report generators, and assertions that the hedger's dissent recall equals the grounded backend's while its overall is strictly worse and is zero.
- **Verify:** `npm test`.

### 6. The reference doc

- **File:** `docs/bench/due-weight.md`
- **Action:** Create
- **Details:** What each metric measures, what the aggregate does, and every limit in one place, so the limits live somewhere a reader can find them as well as in the scorer's output. Linked from `docs/bench/task-format.md`'s due-weight section and from `CLAUDE.md`'s repo-layout tree.
- **Verify:** `npm run lint:docs`; the voice lint.

### 7. The changelog and the ledger

- **Files:** `CHANGELOG.md`, `docs/features-to-triage/LEDGER.md`, `CLAUDE.md`
- **Action:** Modify
- **Details:** One entry under `## [Unreleased]` → `### Added`, appended within the section. The BENCH-05 ledger row only. The `bench/` tree in `CLAUDE.md` gains the two new paths.
- **Verify:** `npm run lint:docs`.

## Edge cases

- A task in the `contested` category always records dissent or conflicting figures (BENCH-01 rule 5), but not necessarily both, so each metric is gated independently and a task with only one of them reports the other as not measured with a reason.
- An empty report scores 0 on recall and `unaddressed` on every conflict. It is a real result, not an error.
- A fringe claim whose `rejectionCues` list is empty makes any mention score 0. The task's `limits` says so, because a score over a check that could not distinguish anything must not read as a score over one that could.
- A conflicting figure whose values are all found, but where the report also flags a disagreement, is `both-figures`; the flag is recorded and adds nothing, because containing both numbers is strictly more informative.
- A number appearing inside an ISO date or a version string is not a numeric mention. `2026-07-27` yields nothing and `v1.2.3` yields nothing.
- A percentage is its face value: `28.6%` is `28.6`, so a gold value of `28.6` with unit `percent` matches and one of `0.286` does not. That is the author's decision to record correctly, and the unit field is what carries it.
- Aggregating an empty list returns three unmeasured means, `overall: null`, and a reason naming the emptiness.

## Acceptance criteria

- [ ] A report citing the dissenting URL scores recall even when the distinguishing term is absent, and `reachedBy` is `url`.
- [ ] A report using a synonym of the distinguishing term, and not citing the URL, scores 0 recall, and the returned `limits` states that only the literal term and the exact URL count.
- [ ] The dissenting URL is matched after canonicalisation, so `http://`, a `www.` prefix, a trailing slash, a `?utm_source=…` parameter and a fragment all still score recall; a different path on the same host does not.
- [ ] A distinguishing term is matched case-insensitively, across a line break, and through a curly apostrophe; it is **not** matched when it appears inside a longer word.
- [ ] A task recording two dissents of which the report reaches one scores 0.5, and the findings name which one was missed.
- [ ] A report containing both conflicting figures under their declared tolerances scores full credit and is reported `both-figures`; the magnitude forms `1.2 billion`, `1,200,000,000` and `$1.2bn` all match a gold value of `1200000000` under an `exact` tolerance.
- [ ] A report containing exactly one of the two figures and no disagreement cue is reported `one-sided` and scores 0.
- [ ] A report containing neither figure and no cue is reported `unaddressed` and scores 0, distinguished in the output from `one-sided`.
- [ ] A report containing one figure plus a disagreement cue within `PROXIMITY_CHARS` of the quantity is reported `flagged-only` and scores `FLAGGED_ONLY_CREDIT`; the same cue beyond the window does not.
- [ ] A fringe term absent from the report scores 1 and is reported `not-surfaced`; present with a recorded rejection cue nearby scores 1 and is reported `surfaced-and-rejected`; present with no cue nearby scores 0 and is reported `surfaced-as-contested`.
- [ ] A fringe claim recorded with an empty `rejectionCues` list scores 0 on any mention **and** adds a limit naming that task.
- [ ] A metric a task cannot support is returned `measured: false` with a reason, never as a zero, and `aggregateDueWeight` excludes it from that metric's denominator.
- [ ] **The hedging fixture.** Over a mixed corpus, a backend that hedges every question scores 1.0 dissent recall, 1.0 conflict acknowledgement, 0.0 false balance and `overall: 0`; a grounded backend scores 1.0 on all three and `overall: 1`. The hedger's recall is **equal** to the grounded backend's and its overall is strictly lower.
- [ ] `overall` is `null` with a stated reason when the corpus contains no fringe task, and `guardApplied` is false.
- [ ] `aggregateDueWeight([])` returns three unmeasured means, `overall: null` and a reason.
- [ ] Numeric mentions do not fire inside an ISO date or a dotted version string, and `1.07 billion` compared to `1070000000` under an `exact` tolerance matches, which float multiplication would fail (`1.07 * 1e9` is `1070000000.0000001`).
- [ ] Each tolerance arm behaves: `exact` rejects a neighbouring value, `absolute` accepts at the boundary and rejects beyond it, `relative` treats its payload as a fraction and not a percentage, `significantFigures` accepts a correctly-rounded value.
- [ ] `citedUrls` is derived from the report text when the caller omits it, and an explicitly supplied list is used unchanged.
- [ ] `npm run gate` passes, and `npm run test:all` is green on two consecutive runs.
- [ ] A protocol-level stdio smoke against `dist/index.js` still initializes and lists tools with no stdout noise.
- [ ] `npm pack --dry-run` lists no `bench/` and no `dist/bench/` entry.

## Verify

- `npm run gate` (typecheck, lint, lint:source, lint:docs, test:all, build), then the whole suite a second time. Isolation breaks only show on the second run.
- A real-Node, out-of-transform check through `tsx`: score a task and aggregate it in a separate process, so NodeNext resolution across the `bench/` → `src/` import edge is proven on the wire rather than under vitest's swc transform.
- A protocol-level stdio smoke test against `dist/index.js` — `initialize`, then `tools/list` — as a regression guard. This item adds no MCP surface, so it is a regression check and is reported as one.
- `npm pack --dry-run`, and the voice lint on the new doc.

## Out of scope

- Accuracy and relevance scoring over `goldFacts`, `requiredTerms` and `driftTerms` (BENCH-04).
- Citation resolvability, registry existence and claim-token containment (BENCH-03).
- Calibration and refusal (BENCH-06); source quality and syndication (BENCH-07).
- The run harness, the result store, and anything that decides which backend to ask (BENCH-02).
- Rendering, comparison tables and the decision about what a scorecard shows (BENCH-08).
- Authoring corpus tasks (BENCH-09). Fixtures here are inline in tests.
- Unifying the numeric-tolerance primitive with BENCH-04's. Recorded as known debt; both items are in flight on disjoint files and racing a shared file is the worse trade.

## Plan review gate — 2026-07-27

*(Filled in below once the cross-family review has run.)*
