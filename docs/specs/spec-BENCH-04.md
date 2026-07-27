# BENCH-04: Accuracy and relevance scorers

**ID:** BENCH-04
**Status:** In Review
**Created:** 2026-07-27
**Last updated:** 2026-07-27
**Brief:** [BENCH-04](../features-to-triage/BENCH-04-accuracy-relevance.md) · **Design of record:** [benchmark.md](../plan/benchmark.md)

## Feature description

*(Verbatim from `docs/features-to-triage/BENCH-04-accuracy-relevance.md`.)*

# BENCH-04: accuracy and relevance scorers

## Accuracy

Normalised exact match of the report against `goldFacts`. Numbers compared with the per-fact tolerance, dates parsed and compared as dates, names matched case-insensitively after Unicode normalisation. Score is the share recovered.

## Relevance, without a judge

The naive version needs a model. The programmatic version uses what the task author recorded: `requiredTerms` a competent answer cannot avoid, and `driftTerms` indicating the answer wandered into an adjacent topic.

Score is required-term coverage minus a drift penalty. This is crude on purpose. It only has to separate an answer about the right subject from one that is not; accuracy decides whether it is correct.

## Requirements

- Number matching handles the ways models write numbers: "1.2 billion", "1,200,000,000", "1.2B". A gold fact missed on formatting is a false negative that makes every backend look worse.
- Percentages, currencies and units normalised before comparison.
- Matching is over the report's prose, not its citation URLs, or a backend that pastes a URL containing the figure scores for reasoning it never did.

## Acceptance

- The number-format cases above are a table-driven test, since this is where silent false negatives live.
- A report stating the right figure with the wrong unit scores zero for that fact, not partial credit.

### Fleet context carried with the brief

- The governing rule for the whole benchmark: **no model in the scoring loop.** Every score is computed by code from a gold set fixed before the run.
- BENCH-01 is merged. `bench/src/tasks/schema.ts` already carries stable per-answer ids, aliases, a required unit on numbers, and a structured source, all added specifically so scorers like this one have something to bind to. This scorer reads that schema; it does not invent a parallel one.
- On relevance: the naive version needs a judge and this design forbids one. Use what the task author recorded, `requiredTerms` and `driftTerms`, and score coverage minus drift. It is crude on purpose. Do not quietly upgrade it into something that needs a model.
- Verification for this repo is `npm run gate` plus a protocol-level stdio smoke test; there is no UI and no Playwright. The suite runs twice.

---

## Triage — 2026-07-27

**Ready for Implementation Plan**

**Sentinel review:** S1 — Approve with assumptions

*(No UI preview section: this repo has no user interface and no design system. Nothing customer-facing changes; the whole item is behind the scenes, inside a benchmark that is not shipped in the published package.)*

**Where it shows up:** nothing customer-facing changes, and nothing the running server exposes changes. The benchmark is developer-facing only and is deliberately excluded from the published package.

**Behaviour changes:** two new measurement functions become available to whoever assembles the benchmark's results. Neither reads the network, neither spends money, and neither asks a model anything.

**Assumptions**

- `[Data & scope]` An answer with no unit stated near it still counts; only a *different* stated unit fails. *(a right figure whose unit the report left implicit is recovered, not wrong; the acceptance rule is about stated-and-wrong.)*
- `[Data & scope]` Units are canonicalised, never converted. *(kilometres do not satisfy a gold in metres; conversion would smuggle arithmetic into a match test.)*
- `[Data & scope]` Percent and percentage points are different units, and so are two currencies. *(this is the confusion the acceptance rule exists to catch.)*
- `[Data & scope]` An ambiguous suffix is read every plausible way and matches if any reading fits. *(rather than "450m", 450 million; the lenient direction avoids the false negative the brief names as the expensive error.)*
- `[Data & scope]` Numbers are read in English convention: comma grouping, dot decimal. *(the reports under test are English; `1.200.000` is documented as unparsed rather than silently read as 1.2.)*
- `[Data & scope]` A gold unit may itself carry a scale word, and it is folded into the value. *(so `1.2` with unit `USD billions` and `$1.2bn` in a report are the same fact.)*
- `[Experience]` Link text that is a bare hostname is dropped with its URL; other link text is kept. *(this repo's own reports cite as `[arxiv.org]` followed by a parenthesised url, so the visible text is part of the citation, not prose.)*
- `[Experience]` A term matches on a word boundary, so `Meta` does not match `Metadata`. *(a substring hit inside a longer word is not the term the author recorded.)*
- `[Operations]` A task with no gold facts scores `not applicable`, never zero, and the same for a task with no required terms. *(a zero in the denominator would report every backend as worse than it is; the loader already derives this flag and it is read rather than recomputed.)*
- `[Operations]` The drift penalty is weighted 1.0 and coverage and drift are also reported separately. *(literal to the brief, and the prior art is explicit that a collapsed score hides what the components say.)*
- `[Layout]` No shared barrel file under the new scoring directory. *(six wave-2 items would each create the same file; each module is imported by path instead.)*

*If any of these are wrong, edit it inline (or correct an assumption) in this file and re-run `/triage BENCH-04` before the planner picks this up.*

---

## Triage — 2026-07-27 (re-triage, after four items merged)

**Resolved by what shipped while this item was blocked:**

- The scoring directory **already exists**. BENCH-06 shipped `bench/src/score/` with a barrel, so the assumption above about not creating one is now moot in the other direction: this item joins that tree and adds to the existing barrel rather than starting a parallel one.
- The word-boundary matcher, Unicode normalisation and mention search **already exist** and were written with this item in mind. Reuse them; do not write a second one.
- The output shape is **already fixed by a consumer**. The calibration scorer takes "was this answer recovered", keyed by the stable answer id, as an input it does not compute. That record is precisely what this item produces, so the two must agree on the type by sharing it rather than by matching by eye.
- The **stale-task question is settled** and is no longer open: a stale task loads, is scored, and is counted as stale, and the count is printed before a run starts. This scorer therefore does not gate on staleness at all.
- **Negation is confirmed as this item's job**, carried here explicitly when the task format shipped: a report saying a figure was *not* the answer still contains the figure.
- Seven real gold sets now exist, so the tests run against the corpus that will actually be scored as well as against fixtures.

**Sentinel review:** S1 — Approve with assumptions

*(No UI preview section: this repo has no user interface and no design system. Nothing customer-facing changes; the whole item is behind the scenes, inside a benchmark that is not shipped in the published package.)*

**Revised assumptions** *(these supersede the ones above where they conflict)*

- `[Layout]` Joins the existing scoring tree and its barrel; reuses the existing search and normalisation helpers. *(a second matcher is the disagreement the first one's comments warn about.)*
- `[Data & scope]` Produces the recovery record the calibration scorer already declares, importing that type rather than redeclaring it. *(one type, one meaning; the answer id is required by the format for exactly this seam.)*
- `[Data & scope]` Results follow the shape the sibling scorers established: a status of not-applicable, unmeasurable or scored, never a zero standing in for an absent measurement. *(a zero in a denominator reports every backend as worse than it is.)*
- `[Data & scope]` Staleness is not consulted. *(settled elsewhere: a stale task is scored and counted, not skipped.)*
- `[Operations]` A value that appears only inside a negation is not recovered; one plain occurrence anywhere is enough. *(a report denying the figure contains the figure.)*
- `[Operations]` Negation is a named cue list scoped to a clause, reported as the crude thing it is. *(the same trade the repo already makes for token containment: weaker than a reader, and exact, repeatable and free.)*
- `[Data & scope]` An answer with no unit stated near it still counts; only a *different* recognised unit fails. *(a right figure whose unit the report left implicit is recovered, not wrong; the real corpus has units like `CVSS v3.1 base score` that no report will ever write out.)*
- `[Data & scope]` Units are canonicalised, never converted, and percent, percentage points, basis points and each currency are distinct. *(this is the confusion the acceptance rule exists to catch; conversion would smuggle arithmetic into a match test.)*
- `[Data & scope]` An ambiguous suffix is read every plausible way and matches if any reading fits. *(`450m` is both 450 million and 450 metres; the lenient direction avoids the false negative the brief names as the expensive error.)*
- `[Data & scope]` Numbers are read in English convention: comma grouping, dot decimal. *(the reports under test are English; `1.200.000` is documented as unparsed rather than silently read as 1.2.)*
- `[Data & scope]` A gold unit may carry its own scale word, and it is folded into the value. *(so `1.2` with unit `USD billions` and `$1.2bn` in a report are one fact.)*
- `[Experience]` Prose excludes every citation form the existing extractor recognises, and link text that is a bare hostname goes with its URL. *(this repo cites the hostname as the visible link text, so that text is part of the citation; a figure surviving only inside a bare URL would score for reasoning nobody did.)*
- `[Operations]` The relevance score is `clamp(coverage − weight × driftShare, 0, 1)` with weight 1, each term counted once, an empty drift list scoring no penalty, and coverage and drift also reported separately. *(literal to the brief, and the prior art is explicit that a collapsed score hides what its components say.)*
- `[Operations]` Every tolerance arm has a stated equation, including a zero gold value under a relative tolerance. *(otherwise two implementations disagree while both passing the requirement.)*
- `[Data & scope]` All four answer kinds are handled exhaustively, and aliases are matched for the two arms that carry them. *(the format added aliases for this scorer; noting they exist is not matching them.)*

**Codex cross-family spec review** *(`gpt-5.6-sol`, `max` effort, read-only, grounded in the repo)*

VERDICT: MATERIAL DEFECTS · 9 findings · 7 accepted / 2 rejected. Every finding was checked against the code before disposition.

Accepted, and now covered by the revised assumptions above:

- *The wrong-unit rule is not mechanically determined.* Correct, and it was the weakest part of the spec. The association between a number and its unit, the canonical map, the treatment of an unrecognised unit and the veto rule are now stated.
- *The relevance score is not an equation.* Correct. It is now written as one, with the empty-drift case, the count-once rule and the clamp.
- *The citation-stripping rule covered only one citation form.* Correct, and the sharpest finding of the nine: bare URLs appear in evidence tables in this repo's own reports, and the existing extractor recognises four forms. Prose extraction now has to cover all four, with a test per form.
- *Negation is unaddressed.* Correct, and it was carried here on purpose by an earlier item. Now an assumption and an acceptance row.
- *Only three of the four answer kinds were specified.* Correct. All four, exhaustively, with aliases matched.
- *Date parsing has no oracle.* Correct. The accepted written forms are enumerated, compared as whole UTC days, and an ambiguous numeric form is read both ways rather than guessed.
- *Tolerance arms have shapes but not semantics.* Correct. Each arm has an equation and a boundary case on each side.

Rejected, with reasons:

- *Settle the stale-task policy before planning.* Already settled, in the run harness that merged since: a stale task loads, is scored, and is counted, and the count is printed before the run. The design document line the reviewer cites is the one that lost. No change here.
- *Define a `{ pass, score, reason }` result and a rule for deriving pass from a fraction.* That shape belongs to the harness the design once planned to adopt and did not; the harness that shipped stores raw cells and the sibling scorers already established a different, richer result convention. Matching the siblings is what keeps one reporting item able to read all of them, so this scorer follows them rather than a shape nothing in the tree uses.

**Status:** Ready for Plan.

---

## Progress — 2026-07-27

**Branch** `ai/bench-04` · **Worktree** `.worktrees/BENCH-04` · **Status** In Review, not merged.

Delivered in `bench/src/score/`: `prose.ts`, `units.ts`, `numbers.ts`, `dates.ts`, `accuracy.ts`, `relevance.ts`, each with a co-located test, plus the barrel, `docs/bench/scoring.md`, twenty-three `ACCREL-*` rows in `docs/test-plan.md` and a changelog entry.

**Verification.** `npm run gate` green twice on the final state (1319 tests), plus a protocol-level stdio smoke against `dist/index.js`: initialize, `tools/list` (36 tools), `research_plan`, and stdout carrying only JSON-RPC. No Playwright; there is no UI.

**Gates.** `codex-review (spec): MATERIAL DEFECTS · 9 findings · 7 accepted / 2 rejected.` `codex-review (plan): MATERIAL DEFECTS · 9 findings · 7 accepted / 2 recorded-not-fixed.` Both dispositioned in the artifacts.

**Defects the reviews and the tests found in this item's own work**, all fixed:

- A preposed unit was invisible, so `CVSS v4.0 base score was 8.8` recovered a gold of `8.8 CVSS v3.1 base score`. The second acceptance criterion failing against a real corpus task.
- A date shape stated a number, so a gold of 7 was recoverable from `2026-07-01`.
- `exact` carried a hidden `1e-12` width and accepted `0` for a gold of `1e-13`.
- A numeric citation label and an NFKC-shifted superscript could each stand in for a figure.
- The unit matchers had an undocumented lower-case precondition; raw text found no unit and was indistinguishable from a report that stated none.
- The number-format table's own first draft asserted `1.1 * 1e6` is inexact. It is not. The real cases were found by sweep.

**Deferred, and owned by nobody yet:**

- Two numeric implementations now exist, this one and the due-weight scorer's, both recording the same debt from their own side. They agree on the four tolerance arms and on masking date shapes; they differ on accepted magnitude words. Unify now that both have merged.
- Negation is backward-only by choice: scanning forward would catch "8.8 is not the assigned score" and would break "8.8, not 7.2".
- Calibration's value-pairing fallback uses `String(value)`, which for a large figure is the plain integer and never appears in a report writing `$1.2 billion`. Numeric answers therefore pair by label or not at all. That is calibration's own documented limit, pinned here as a test; the fix is a label in the task file.
