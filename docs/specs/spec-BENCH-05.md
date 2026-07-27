# BENCH-05: Due weight, viewpoint coverage

**ID:** BENCH-05
**Status:** In Review
**Created:** 2026-07-27
**Last updated:** 2026-07-27
**Brief:** [BENCH-05](../features-to-triage/BENCH-05-due-weight.md) · **Design of record:** [benchmark.md](../plan/benchmark.md) · **Depends on:** [BENCH-01](spec-BENCH-01.md) (merged)

## Feature description

*(Verbatim from `docs/features-to-triage/BENCH-05-due-weight.md`.)*

# BENCH-05: due weight, the viewpoint-coverage scorers

## The failure being measured

A genuine minority or dissenting position is dropped because the published weight sits on the other side. Call it consensus collapse.

## Why it can be scored without a model

Because the gold set names the dissent in advance. The task author records the dissenting source's URL and its distinguishing term at authoring time; the scorer checks whether the report reached it. No judgement at scoring time.

## Three metrics

1. **Dissent recall.** Did the report cite the known dissenting source, or use its distinguishing term?
2. **Conflict acknowledgement.** For tasks where two authoritative sources give different figures, the gold carries both. Did the report contain both, or explicitly flag the disagreement? Reporting one number as settled when two exist is the failure, and the second number is a string search.
3. **False-balance guard.** A subset of tasks has a genuinely settled answer and a documented fringe claim. Surfacing the fringe claim as though it were contested is penalised.

## Why the third is not optional

Without it, the metric rewards indiscriminate hedging. A backend that presents every question as contested would score perfectly on the first two and be useless. The guard is what makes due weight mean due rather than equal.

## Acceptance

- A report citing the dissenting URL scores recall; one merely using a synonym of its term does not, and that limit is stated in the output rather than hidden.
- A backend that hedges everything scores well on dissent recall and badly overall, provable by a fixture.

### Fleet context carried with the brief

- The governing rule for the whole benchmark: **no model in the scoring loop.** Every score is computed by code from a gold set fixed before the run.
- BENCH-01 is merged. `bench/src/tasks/schema.ts` already carries `knownDissent`, `conflictingFigures` and `fringeClaims` with `rejectionCues`, all present so this scorer binds to recorded fields rather than inferring intent from prose.
- Verification in this repo is `npm run gate` plus a protocol-level stdio smoke test against `dist/index.js`. There is no UI and no Playwright. The suite runs twice.

---

## Triage — 2026-07-27

**Ready for Implementation Plan**

*(No UI preview section: this repo has no user interface and no design system. Nothing customer-facing changes; the whole item is behind the scenes.)*

**Where it shows up**

- Nothing a person using the research product will see. `bench/` is typechecked, linted and unit-tested by the gate and is deliberately not compiled into `dist/` or shipped in the package.
- The people affected are whoever reads a benchmark scorecard, and the two later items that consume this one: BENCH-08 (reporting) and BENCH-11 (combinations).

**Behaviour changes**

- A new scorer that takes one loaded task and one report and answers three questions about viewpoint coverage, plus an aggregate over a set of those answers.
- Every answer carries, in words, what was actually measured and what was not. The limits are part of the output, not a footnote in a document nobody opens.
- The aggregate refuses to produce an overall number when the false-balance guard did not run, because without the counterweight the number rewards hedging and would be read as due weight.

**The three metrics, as decided**

1. **Dissent recall.** Per recorded dissent: reached if the report cites that exact source after URL canonicalisation, **or** literally contains its distinguishing term. Score per task is reached over recorded.
2. **Conflict acknowledgement.** Per recorded conflicting figure, graded four ways: every value present under its own tolerance (full credit), the disagreement flagged near the quantity but not every value present (half credit), exactly one value present and no flag (zero, and this is the named failure), no value present and no flag (zero, recorded as a different failure because the report never addressed the quantity).
3. **False-balance guard.** Per recorded fringe claim: not surfaced at all (full credit), surfaced with a recorded rejection cue nearby (full credit), surfaced with no rejection cue nearby (zero, and this is the failure the guard exists for).

**Assumptions**

- `[Data & scope]` The overall due-weight number is computed at the **suite** level, not per task. *(the guard lives on `settled-with-fringe` tasks and the other two live on `contested` tasks, so no single task can carry all three; a per-task overall could never express the trade the brief describes.)*
- `[Data & scope]` The overall is the **harmonic mean of the measured metric means**, and each metric contributes once regardless of how many tasks fed it. *(the arithmetic mean of three metrics reads 1.0 / 1.0 / 0.0 as 0.67, which is not "badly overall"; and a mean over tasks lets ninety contested tasks drown ten fringe tasks, which is the dilution the guard exists to prevent.)*
- `[Data & scope]` When no task supplied a fringe claim, the overall is **withheld** rather than reported. *(without the counterweight the number rewards indiscriminate hedging, and a caveat printed beside a number is read as a number.)*
- `[Data & scope]` A distinguishing term is matched **literally**, after case folding, whitespace collapsing and typographic-character folding, and only on word boundaries. *(the schema says literally; folding case and a curly apostrophe is still the same term, whereas a synonym is a different claim. Word boundaries stop a short term matching inside a longer word.)*
- `[Data & scope]` A dissenting source is matched on its **canonical URL**, with `http` and `https` folded together. Another rendering of the same document at a different path does not count. *(canonicalisation already collapses tracking parameters, `www.` and trailing slashes. It deliberately keeps the scheme, because it exists to count independent sources and there the two schemes are two strings; for reaching one document they are the same page, so the fold is layered on in this scorer rather than pushed into the product's function. Equating two different paths would need a model or a mirror list.)*
- `[Data & scope]` A conflicting figure is matched on its **value under the task's declared tolerance**, and the declared unit is reported where it is found nearby but does **not** gate the match. *(the two values of one quantity are discriminated by their numbers; requiring the unit token would miss `$1.2bn` against a unit of `USD`, and a false negative makes every backend look worse.)*
- `[Data & scope]` A disagreement counts as flagged only when one of a **fixed, exported cue vocabulary** appears within a stated character distance of the quantity. *(the schema records no disagreement wording, and a whole-document search for "differ" fires on any long report.)*
- `[Data & scope]` A rejection cue counts when it appears within the same stated distance of **any** mention of the fringe term, not all of them. *(requiring every mention to be covered penalises a report that dismissed the claim properly and then listed the source again, which would make the guard fire on the honest backend.)*
- `[Data & scope]` The false-balance guard is keyed on the **term only**, never on the fringe source's URL. *(a URL-only mention gives no anchor to measure a rejection cue against, so it could not be scored either way without guessing; and the question the guard asks is how the claim was framed, which lives in prose.)*
- `[Data & scope]` A fringe claim recorded with **no** rejection cues makes any mention score zero, and the task's output says so. *(the alternative is silently crediting a mention nothing could have distinguished, which is a score over a check that did not happen.)*
- `[Operations]` Eligibility comes from BENCH-01's `applicableMetrics`, never re-derived here. *(four scorers each re-deriving one rule is how two implementations of a rule end up disagreeing about what the rule is; BENCH-01 derives it once for exactly this reason.)*
- `[Operations]` The scorer takes a **structural** report shape (`text`, optionally `citedUrls`) and derives the citations from the text with the product's own `extractCitedUrls` when they are not supplied. *(BENCH-02 owns the canonical run record and does not exist yet; a structural subset lets the harness satisfy this without an import, and deriving citations from the same text stops a report and its citation list disagreeing.)*
- `[Operations]` URL canonicalisation reuses `canonicaliseUrl` from `src/research/corroborate.ts` rather than a second implementation. *(the design of record picks TypeScript in this repo precisely so the existing primitives are reused.)*
- `[Experience]` No task files are authored here beyond test fixtures. *(the corpus is BENCH-09.)*
- `[Experience]` No reporting or rendering here beyond the returned structures and their stated limits. *(BENCH-08 owns presentation.)*

*If any of these are wrong, edit it inline (or correct an assumption) in this file and re-run triage before the planner picks this up.*

**Findings carried to the planner**

- *High, Engineering Readiness.* The brief's second metric says "did the report contain both, **or explicitly flag the disagreement**", and the task schema records no wording for a flag. A fixed cue vocabulary plus a proximity window is the only mechanical answer; it is a real weakening and is carried as a stated limit rather than hidden behind a boolean.
- *High, Engineering Readiness.* Comparing a reported number to a gold number under a tolerance is a primitive BENCH-04 also needs for gold facts. The two items are running concurrently on disjoint files, so this one implements the primitive inside its own directory and the duplication is recorded as known debt to be unified once both have merged, rather than raced into a shared file.
- *Medium, Engineering Readiness.* Scaling a magnitude word (`1.2 billion`) by multiplying floats can land one unit-in-the-last-place away from the gold value and fail an `exact` tolerance. The scaling is done by shifting the decimal point in the digit string, not by multiplication.
- *Medium, Operational.* The harmonic mean returns exactly zero when any metric mean is zero, which loses resolution between a perfect hedger and a backend that found nothing at all. Accepted: every component is reported beside the overall, so nothing is hidden, and the overall's job is to refuse to rank a hedger above an honest backend rather than to rank two failures against each other.

**Codex cross-family review — 2026-07-27**

Reviewer: `gpt-5.6-sol` (codex-cli 0.145.0) at `max` effort, read-only, grounded in the repository. Verdict and dispositions are recorded in the Progress section below, because the review ran against the spec and the plan together once both existed.

## Plan — 2026-07-27

Implementation plan: [`docs/plans/plan-BENCH-05.md`](../plans/plan-BENCH-05.md) (Plan size: Standard).

## Progress — 2026-07-27

**Implementation Complete (local branch, not rebased, not merged, not pushed, by instruction)**

**Summary:** `bench/src/score/due-weight/` scores three viewpoint-coverage metrics over one task and one report, and aggregates them across a suite. No model is called at any point; every answer comes from a string or number comparison against fields BENCH-01 already records. Nothing touches the network.

**Branch:** `ai/bench-05` (local, based on `main` at `a2b625e`; worktree `.worktrees/BENCH-05`). Seven commits.

**Built:**
- `bench/src/score/due-weight/text.ts` — normalisation and literal, boundary-respecting term matching, plus the proximity primitives.
- `bench/src/score/due-weight/numbers.ts` — numeric-mention extraction and tolerance comparison.
- `bench/src/score/due-weight/index.ts` — the three metrics, the per-task result, and the suite aggregate.
- Four test files, 97 tests, traced to `DUEWT-01` through `DUEWT-32` in `docs/test-plan.md`.
- `docs/bench/due-weight.md`, plus the CHANGELOG entry, the ledger row, and the two new paths in `CLAUDE.md`.

**The acceptance criteria, and how each is discharged:**

1. *A report citing the dissenting URL scores recall; one merely using a synonym does not, and that limit is stated in the output rather than hidden.* Both directions are tested. The limits are exported constants, attached to every result whose metric applied, and asserted on by the tests rather than described in prose.
2. *A backend that hedges everything scores well on dissent recall and badly overall, provable by a fixture.* `hedging.test.ts` writes two backends as functions of the task and runs them over a mixed corpus. Measured: the hedger scores 1.00 dissent recall and 1.00 conflict acknowledgement, **equal to the honest backend on both**, 0.00 on the guard, and **0 overall**. A partial hedger lands at 0.75, so the guard grades rather than gates.

**The design decision that makes the second criterion true**, recorded because it is the whole item: the overall is a suite-level **harmonic** mean of the three metric means, each metric counting once regardless of how many tasks fed it. Both halves are load-bearing and both are pinned by a test. Averaging over tasks lets ninety contested tasks outvote ten fringe ones. And the *arithmetic* mean of the hedger's own three numbers is 0.667, which is a passing grade for a backend that calls every settled question open; a test computes exactly that and contrasts it with the harmonic 0, so the choice is defended by measurement rather than by a comment. When no task recorded a fringe claim the overall is **withheld** rather than caveated, and a further test shows why: on such a corpus the hedger and the honest backend are identical on both remaining metrics.

**Codex cross-family review — MATERIAL DEFECTS, five findings, every one reproduced before being accepted.** Four fixed, one accepted with a measurement:

1. *High, and it defeated this item's own acceptance criterion.* The guard averaged over every fringe claim a task records, so claims nobody mentioned paid for one framed as live. Twenty recorded claims with one presented as contested scored 19/20, giving a suite overall near 0.98 for a backend doing exactly what the guard exists to catch. The denominator is now the claims the report actually raised. **The original fixture could not see this because it used one claim per task**, which is the more useful half of the finding and is why the new tests use multi-claim tasks.
2. *High.* Numeric extraction invented evidence: `July 27, 2026` yielded 27 and 2026, `COVID-19` yielded 19, `1/3` yielded 1, `F-16` yielded 16. Any of them could satisfy a conflicting-figure gold value and credit a report for disclosing a disagreement it never mentioned. Written-out dates are now masked whole; a hyphen after a letter marks a hyphenated token while a hyphen after a digit still marks a range; a fraction tail is rejected.
3. *Medium.* A leading-dot decimal was skipped. Fixed. The other half of the finding, an accounting negative in parentheses, is documented rather than guessed: nothing local separates a loss in a filing from an aside in prose.
4. *Medium.* Word boundaries indexed UTF-16 code units, so a lone surrogate read as a non-letter and a term matched inside a word joined by a supplementary-plane character. Boundaries are now whole code points.
5. *Low, accepted with a measurement rather than churn.* Repeated full-report scans. Measured: a 256k-character report, which is about the size this product returns, normalises in 15ms, yields 2,000 numeric mentions in 3ms, and takes under 1ms for the cue sweep.

**A second adversarial review, in family, found two more Criticals that the first did not.** It was launched as a redundancy while the Codex lane looked dead, and it earned its place. Both findings defeated the acceptance criterion, and neither was visible to the fixture as written:

1. *Critical.* The guard recognised a fringe claim **only by the exact wording the gold set records**, which is private to the task author. A real backend never emits it, so one that cited the fringe source and paraphrased the claim scored a perfect 1.0. Dissent recall has always had two doors, URL or term, and the guard had one; the asymmetry was the hole. A claim is now raised by its term **or** by a citation of its source. The reviewer's sharper point is recorded rather than softened: the original fixture proved the criterion partly by handing the hedging backend the gold set's own string.
2. *Critical.* **One debunking sentence laundered every fringe claim inside the proximity window** — six documented claims presented as live controversies scored 1.0. This had been seen earlier in the branch as a red test and worked around by moving the fixture's claims apart, which is the defect restated as a test precondition, and the reviewer said so. A cue is now attributed to the claim it **follows**, because a report states a claim and then dismisses it. That also resolves what had made the first attempt fail: a report dismissing four claims in sequence keeps credit for all four, where nearest-in-either-direction gave it one.

Four more from the same review, each reproduced: one number stated twice satisfied two gold values with overlapping tolerances, because matching was over mentions rather than distinct values and reports repeat a figure constantly; an empty report scored 1.0 overall on a fringe-only corpus; `50%-60%` read as fifty and minus sixty; and the `COVID-19` rule added earlier silently deleted the right-hand figure of every magnitude-suffixed range, contradicting this item's own documentation. Plus NFC composition folding, bidi controls, URL and clock-time masking, spaced two-letter magnitudes, a dead export and a NaN guard.

**Two constants were untested in the strict sense.** Widening `UNIT_PROXIMITY_CHARS` from 24 to 5000, and pinning `NumericMention.index` to 0, both left the suite green. Each now fails a named test.

**Two defects found before the reviewer, by asking what a degenerate input scores.** A single stated number could satisfy two gold values whose tolerances overlap, scoring a one-sided report as having disclosed a disagreement it never mentioned; assignment is now a maximum bipartite matching, and the guard test was checked in both directions, failing against the greedy implementation and passing against the matching one. And a guard score of 1.0 turned out to be ambiguous, because a report that says nothing at all earns it; the summary now reports `guardExercised` and says so in words when the guard passed without anything putting it to the question.

**One change was tried and reverted on evidence.** Attributing each rejection cue to the single nearest claim closes a narrow hole where one cue credits two claims. It also breaks the common case: a report dismissing four claims in sequence has each cue sitting nearer the *next* claim's mention than its own, so three of four score as false balance. Trading a narrow false negative for a broad false positive against honest reports is the wrong way round. The leniency stays, is stated in the output, and is pinned by a test so it cannot change unnoticed.

**Three claims corrected against measurement rather than left standing.** `canonicaliseUrl` preserves the URL scheme, which the spec had assumed it folded, so the `http`/`https` fold is this scorer's own layer and is documented as such rather than changing product behaviour to make the benchmark's numbers nicer. The plan's floating-point example was wrong: `1.2 * 1e9` is exact and `1.07 * 1e9` is not. And the plan's local date-rejection rule could not work, because a date and a numeric range are the same shape at the hyphen.

**Gates (actually run, on the final tree):**
- `npm run gate` exit 0, **twice consecutively**: typecheck, lint, lint:source, lint:docs, test:all, build. 36 test files, 950 passed, 2 skipped, identical both runs.
- stdio smoke against `dist/index.js`: initialize ok, `tools/list` returns 36 tools, zero non-JSON lines on stdout. A regression check, since this item adds no MCP surface.
- Real-Node out-of-transform run via `tsx` across the `bench/` to `src/` import edge: the hedger scores 1/0/0, the honest backend 1/1/1, the guard-less corpus withholds its overall, and the synonym limit is present in the output.
- `npm pack --dry-run`: zero `bench/` and zero `dist/bench/` entries.
- Performance measured on a 256k-character report, reported above.

**A pre-existing flake, proven not to be this item's.** `tests/concurrency.test.ts > FileLock > holds exclusivity under heavy contention` failed several times mid-run. It reproduces with this item's test files removed, it passes 6 of 6 in isolation either way, and its own comment plus `CLAUDE.md` already document it as contention-sensitive. The machine was running roughly two dozen concurrent Codex processes from other fleet runners at the time. Both final gate runs were clean.

**Not done, and flagged for the orchestrator.** `main` advanced while this ran: BENCH-06 has landed `docs/bench/scoring.md` plus four modules under `bench/src/score/`, and added them to the `CLAUDE.md` layout tree. This branch adds `docs/bench/due-weight.md` and its own `CLAUDE.md` lines, so **`CLAUDE.md` will conflict at merge** and the two scoring docs overlap in purpose enough to be worth a deliberate decision rather than a mechanical resolution. No rebase or merge was attempted, by instruction.
