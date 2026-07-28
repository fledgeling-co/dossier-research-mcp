# BENCH-17: the frontier makes the strongest claim with the weakest evidence

**ID:** BENCH-17
**Status:** In Review
**Created:** 2026-07-28
**Last updated:** 2026-07-28
**Brief:** [BENCH-17](../features-to-triage/BENCH-17-combine-floors.md)

> **Harness, not product.** Nothing here reaches `dist/` or a user of the npm package. `bench/src/combine/` has no consumer at all, so nothing in this item fixes a wrong number anybody is reading today. What it fixes is a claim the code was built to be able to make, which would have been wrong the first time anyone made it.

## Feature description

*(Verbatim from `docs/features-to-triage/BENCH-17-combine-floors.md`.)*

# BENCH-17: the frontier makes the strongest claim with the weakest evidence

## What is wrong

`bench/src/combine/` publishes a Pareto frontier, and calling a combination **dominated** says nobody should ever buy it. That is a stronger claim than ordering two backends. It is made with less evidence than the ranking beside it, in two separate ways.

### It has no tie test on the production path

`evaluateCombinations` builds its candidates with `id, score, costUsd, robustness` and never sets `scoreSpread`; `EvaluateInput` has no field through which a caller could supply one. `spread-helpers.ts` exports a `scoreSpread()` helper that is not re-exported from `combine/index.ts` and is referenced only from a test.

So `spreadsOverlap` is dead outside tests and **every real frontier takes the unchecked branch**. Measured, two members, one run each, scores 0.800 against 0.801:

```
separability === UNCHECKED : true
DOMINATED: alpha <- beta
  "beta" has accuracy 0.8010 against 0.8000, costs the same, is equally
   robust, and is no worse on any axis.
```

A difference of 0.001 from a single run yields "nobody should ever buy alpha".

### It enforces none of the four floors its sibling enforces

The same evidence, one `technical` task, one repetition, two backends, through both surfaces:

```
report/aggregate.ts -> scorable=false, reason=under-sampled-corpus,
                       repetitionFloor {met:false, minRepetitions:1, floor:3}
combine/evaluate.ts -> frontier: [beta, alpha+beta], dominated: alpha <- beta
                       notes naming a task floor: 0
```

`CombinationReport` carries no `scorable`, no `withheld`, no `verdict` and no floor. `evaluateScopes` runs per task-category, which is precisely the scope `MIN_TASKS_PER_CATEGORY` governs, and applies none of `MIN_TASKS_PER_CATEGORY`, `MIN_REPETITIONS_FOR_SPREAD` or `MIN_COMPLETION_SHARE`. It computes `worstCompletion` and spends it on a prose note.

## What to do

Follow what `report/comparison.ts` already does: **take BENCH-08's verdicts wholesale rather than re-deriving them**, with the comment explaining why. A second answer to "can this sample support a claim" is worse than either answer alone.

Then give the frontier a way to receive a paired comparison, the same way `rank.ts` receives one by injection, and make the checked and unchecked sentences follow what actually happened.

One trap the audit found while reading: `paretoFrontier` sets the *checked* sentence when **some** candidate has a spread while `compareScore` requires **both**. A mixed candidate set would therefore advertise the stronger sentence over pairs compared as point estimates. That is unreachable today only because nothing populates `scoreSpread`, and it becomes live the moment this brief is implemented. Fix it in the same change.

## Honest framing

`bench/src/combine/` has **no consumer**. Nothing outside the directory imports it, there is no `bench:combine` script, and the report CLI never touches it. So none of this is producing a wrong number for anyone today.

It also means the design's fourth stated purpose, "which combination is worth its price", currently has no producer at all. Wiring it up and fixing the floors are the same piece of work, and doing the first without the second would publish exactly the failure the benchmark exists to refuse.

## Acceptance

- A frontier over an under-sampled scope reports withheld, with the same reason string the report uses.
- A dominance claim on single runs is refused rather than printed.
- The checked sentence appears only when every compared pair actually had a spread.
- Something consumes `combine/`, or the brief says plainly why not.

---

## Grounding: reproduced before anything was designed

Both defects were re-run against `main` at `b560922` rather than accepted on the brief's word, which is this fleet's standing habit after BENCH-02 tested promptfoo instead of adopting it.

**Defect 1 reproduces exactly as written.** Two members, one run each, scores 0.800 against 0.801, through `evaluateCombinations`:

```
separability === UNCHECKED : true
DOMINATED: alpha <- beta
  "beta" has accuracy 0.8010 against 0.8000, costs the same, is equally robust, and is no worse on any axis.
notes naming a task floor: 0
report has scorable field: false
```

**Defect 2, the trap, is worse than the brief states, and it is reachable today.** The brief says a mixed candidate set "would advertise the stronger sentence over pairs compared as point estimates", and calls it unreachable because nothing populates `scoreSpread`. Nothing populates it *through `evaluateCombinations`*. `paretoFrontier` is exported from `bench/src/combine/index.ts` and takes candidates directly, so a caller can reach it now. Three candidates, only `alpha` carrying a spread:

```
advertises the CHECKED sentence : true
DOMINATED: alpha <- beta
  "beta" has accuracy 0.8010 against 0.8000, costs the same, is equally robust, and is no worse on any axis.
DOMINATED: gamma <- alpha
frontier: beta
```

The candidate that **has** a spread is the one eliminated, by a bare point estimate, on 0.001, under a sentence claiming overlapping spreads were treated as ties. So this is not only a sentence that overstates: supplying evidence for one candidate and not another actively disadvantages the candidate with the evidence. That is the strongest single argument in this item for fixing the sentence and the comparison together.

## Design: one answer to "can this sample support a claim"

The instruction that governs every decision below is the brief's: **follow `report/comparison.ts`**. That file takes `BenchAggregate`'s verdicts wholesale and says why in a comment, because deriving them a second time let a backend the scorecard printed as invalid still receive a rank. The same failure is available here at one more remove, and a frontier is a stronger claim than a rank.

So this item adds **no new floor and no new rule**. It adds a way for BENCH-08's existing verdicts to arrive, gates on them, and refuses to compute what they do not support.

### Where each of the four floors arrives from

| Floor | Lives in | How it reaches the frontier |
|---|---|---|
| `MIN_TASKS_PER_CATEGORY` | `report/aggregate.ts` | the scope's `ScorableVerdict`, carried whole |
| `MIN_REPETITIONS_FOR_SPREAD` | `run/cell.ts`, via `RepetitionFloor` | each member's `RepetitionFloor`, carried whole |
| `MIN_COMPLETION_SHARE` | `report/aggregate.ts` | the `under-completed` arm **inside** each member's verdict |
| the spread floor itself | `run/cell.ts`, via `spread.ts` | `spreadsOverlap` on the candidates' `SpreadReport`s |

The third row is the one worth reading twice. The brief observes that `evaluate.ts` "computes `worstCompletion` and spends it on a prose note". The fix is **not** to threshold `worstCompletion`: `MIN_COMPLETION_SHARE` is already the fourth arm of `verdictFor`, so gating on the verdict applies it once, and thresholding the merged object's own completion rate as well would be the second answer this whole design refuses. `worstCompletion` stays a note, and gains a sentence saying where the floor actually lives.

### The shape of the seam

`EvaluateInput` gains a **required** `eligibility`. Required rather than optional, because an optional floor defaults to no floor, which is the state this item exists to end. The fields are BENCH-08's own types, imported rather than restated, so a fourth reason word cannot be invented here:

```ts
interface MemberEligibility {
  readonly verdict: ScorableVerdict;        // report/aggregate.ts
  readonly repetitionFloor: RepetitionFloor; // report/aggregate.ts
}
interface CombinationEligibility {
  readonly scope: ScorableVerdict;
  readonly members: Readonly<Record<string, MemberEligibility>>;
}
```

A combination is eligible when **every member in it** is. That direction is forced: a combination is scored as the union of its members, so a member whose own figure is withheld cannot be half of a union that is quoted.

`paretoFrontier` mirrors `rankBackends` gate for gate, in the same order and with the same reason vocabulary:

1. scope not scorable, `scope-not-scorable`, carrying the aggregate's own sentence
2. no eligibility supplied at all, `eligibility-not-supplied`
3. any candidate below the repetition floor, `sample-below-spread-floor`, the whole frontier withheld rather than a frontier over the survivors
4. fewer than two eligible candidates, `too-few-candidates`

Gate 3 withholds everything rather than computing a frontier over whichever candidates cleared it, for the same reason `rank.ts` does: a frontier over a subset of the lattice is not the frontier, and every subset containing the thin member is affected. Gate 4 folds a blocked candidate into `too-few-candidates` exactly as `comparison.ts` does, with the same comment, so the two withheld tables read side by side.

When withheld, `frontier` is `null` and `dominated` is empty. The numbers are still printed: `CombinationReport.combinations` keeps every score, cost and overlap profile. That is `rank.ts`'s own posture, "print the numbers, refuse to rank", one claim stronger.

### The separability sentences

Three states rather than two, which is the trap fix:

- every eligible candidate carries a spread, so every pair had both: `SEPARABILITY_CHECKED`
- none does: `SEPARABILITY_UNCHECKED`
- some do and some do not: `SEPARABILITY_MIXED`, which names the count and says plainly that the pairs without one were compared as point estimates

Deciding this on the candidates rather than on the pairs is what makes it O(n) and order-independent, and it is exactly equivalent: every pair has both spreads if and only if every candidate has one. A fourth constant covers the withheld case, where nothing was compared and neither sentence would be true.

`SEPARABILITY_CHECKED`'s current text asserts that "evaluateCombinations sets no score spread and offers no parameter through which one could arrive". That sentence is the defect describing itself and stops being true in this change, so it is rewritten rather than left to become a lie.

### The paired comparison, by injection

`paretoFrontier` takes an optional `separated` oracle of exactly `rank.ts`'s `SeparationOracle` type, imported rather than redeclared. Precedence matches `rank.ts`: the paired verdict where it has one, the interquartile overlap where it does not, point estimates where neither is available. A verdict that separates but names the other candidate as better ties, because a frontier ordering its own test contradicts is the defect BENCH-13's review found in the ranking and it is available here identically.

## Decision: no runtime consumer is wired in this item

The brief's fourth acceptance criterion allows either. This item wires the **seam** and not a CLI, and the reason is that the missing piece is not plumbing.

`evaluateCombinations` takes `scoreCombination` by injection, and `docs/bench/combinations.md` says why: three of the five scorers cannot be reached from stored cells at all, since accuracy and relevance need the task's gold set, source quality needs fetched page text, and citation integrity needs the evidence snapshot. A `bench:combine` CLI has to answer "what number is a combination's score, computed how", and that answer is a scoring decision the design deliberately left to the caller. Making it here would be a second answer to a question the module documents as open, which is the same error this item is fixing one level down.

There is a second reason, and it is measurable. On the corpus as it stands, seven tasks across four categories, **every category is below the five-task floor**, which is why BENCH-13 enumerated 180 comparisons and could run none. A `bench:combine` wired today would print `withheld` for every scope, so it would produce no information while committing the design decision above. That is the worst of both.

What is wired instead is the join, end to end, under test: real cells go through `harvest` and `aggregate`, the verdicts come out, `eligibilityFromAggregate` maps them onto members, and the frontier withholds with the aggregate's own sentence. That proves the floors reach the frontier from BENCH-08's real output rather than from a fixture written to agree with itself, and it leaves the scoring decision to whoever owns it.

**Recorded for the orchestrator:** purpose 4 of `docs/plan/benchmark.md` still has no producer. What it now lacks is a named measure and a way to compute it over a merged union, not a floor and not a wire.

## Assumptions

1. **A member's eligibility is the worst of its providers'.** A member is a named set of runs and may draw on more than one provider. Taking the first non-scorable verdict is the fail-closed direction and matches how `comparison.ts` blocks a pair on either candidate.
2. **A member the caller does not describe is not scorable.** `eligibility.members` missing an id is refused with a named reason rather than defaulted to eligible, on the same principle as (1).
3. **The scope verdict for a category is read off the corpus count, as `comparison.ts` reads it.** The `why` string is lifted from a `CategoryGroup`'s own `under-sampled-corpus` verdict, which is provider-independent by construction, so the frontier prints the report's sentence and not a paraphrase.
4. **Breaking the exported signatures is free.** `bench/src/combine/` has no consumer, so `paretoFrontier`, `evaluateCombinations` and `evaluateScopes` can take required new arguments without a deprecation path. This is the one moment where that is cheap.

## Out of scope, and named rather than dropped

- **A `bench:combine` CLI**, and the named measure it would need. See the decision above.
- **Rendering a combination section into the report.** Same blocker, one layer up.
- **Any change to `overlap.ts`, `marginal.ts`, `merge.ts` or `member.ts`.** The frontier is the thing making the claim.
- **BENCH-13's statistics computed over combinations.** The oracle is injected, so a future caller supplies them; nothing here computes a bootstrap.

## Acceptance criteria, as tested

Rows `COMB-40` through `COMB-52` in [`../test-plan.md`](../test-plan.md), written before the tests.
