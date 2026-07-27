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

**Codex cross-family spec review — 2026-07-27**

Reviewer: `gpt-5.6-sol` (codex-cli 0.145.0) at `max` effort, read-only, grounded in the repository. Verdict and dispositions are recorded in the Progress section below, because the review ran against the spec and the plan together once both existed.

## Plan — 2026-07-27

Implementation plan: [`docs/plans/plan-BENCH-05.md`](../plans/plan-BENCH-05.md) (Plan size: Standard).

## Progress — 2026-07-27

*(Filled in at the end of the run.)*
