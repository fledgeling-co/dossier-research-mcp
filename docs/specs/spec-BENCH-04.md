# BENCH-04: Accuracy and relevance scorers

**ID:** BENCH-04
**Status:** Triage
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

**Codex cross-family spec review:** recorded below once run.
