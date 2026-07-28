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
