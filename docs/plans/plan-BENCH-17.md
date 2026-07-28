# Plan: BENCH-17, the frontier's floors

**Spec:** [spec-BENCH-17](../specs/spec-BENCH-17.md)
**Size:** Small. One directory, five files touched, one added, no product code.
**Branch:** `ai/bench-17` in `.worktrees/BENCH-17`

Every decision is in the spec. This is the order of operations and the test list.

## What is touched

| File | Change |
|---|---|
| `bench/src/combine/eligibility.ts` | **new.** BENCH-08's verdicts, mapped onto members. The only file that knows about `BenchAggregate` |
| `bench/src/combine/frontier.ts` | the four gates, the `separated` oracle, three separability sentences plus the withheld one, the pair sweep |
| `bench/src/combine/evaluate.ts` | required `eligibility` on the input and the scope, candidate eligibility per combination, the verdict on the report |
| `bench/src/combine/index.ts` | export the new surface, and `scoreSpread`, which the brief notes is unreachable today |
| `bench/src/combine/frontier.test.ts` | rewritten for the gates; every existing case keeps its meaning |
| `bench/src/combine/evaluate.test.ts` | eligibility threaded through; new cases for the join |
| `bench/src/combine/eligibility.test.ts` | **new.** The end-to-end join from real cells |
| `docs/bench/combinations.md` | the frontier section, the floors, and the recorded absence of a producer |
| `docs/test-plan.md` | AC rows `COMB-40` to `COMB-53`, appended, before the tests |
| `CHANGELOG.md` | one entry under Unreleased, saying plainly that nothing was live |

Nothing under `src/` changes. Nothing reaches `dist/`.

## Order

1. **AC rows first** (`docs/test-plan.md`). CLAUDE.md's rule, and it is what stops the tests being written against whatever was convenient to assert.
2. **`frontier.ts`.** The gates and the sentences are self-contained and everything else depends on their types.
3. **`evaluate.ts`.** Thread eligibility through `evaluateCombinations`, then `evaluateScopes`.
4. **`eligibility.ts`.** The adapter, last, because it is written against the shapes the first two settled.
5. **Tests, in that same order**, then the join test.
6. **Docs.**

Commit at each numbered step. Six runners in this fleet were killed by capacity errors mid-flight and the ones holding commits lost minutes.

## The one piece of real algorithm work

`paretoFrontier`'s sweep currently uses `find` per candidate, which short-circuits and therefore visits a different set of pairs depending on input order. That is fine while nothing depends on which pairs were visited, and it stops being fine the moment the separability sentence has to describe them.

Replace it with one `i < j` double loop evaluating each unordered pair once and testing domination both ways. Three consequences, all wanted:

- **Half the worst case, and a slower best case.** With nothing dominated the old `find` did `n(n-1)` comparisons and this does `n(n-1)/2`. But `find` short-circuited, so where almost everything is dominated by the first candidate it did `O(n)` and this does `n(n-1)/2` regardless. That trade is the price of the accounting: which pairs a short circuit visits depends on input order, and a separability sentence describing the pairs actually compared cannot rest on that. The complexity comment on the function states both ends rather than only the flattering one.
- **First-in-input-order is preserved.** With `i` ascending outermost, the potential dominators of the candidate at index `k` are visited as `0, 1, ..., k-1, k+1, ...`, which is input order. `COMB-24`'s existing assertion holds unchanged.
- **The separability accounting becomes order-independent**, and is then decided at candidate level anyway, which is equivalent and O(n).

## Test list, against the AC rows

Existing rows that must keep passing unchanged: `COMB-24` through `COMB-33`, `COMB-36` through `COMB-39`. `COMB-34` and `COMB-35` are amended rather than replaced, and the amendment is noted in the test plan beside them.

New:

- `COMB-40` scope withheld, the aggregate's own `under-sampled-corpus` sentence
- `COMB-41` single runs, `sample-below-spread-floor`, nothing dominated
- `COMB-42` the numbers survive a withheld frontier
- `COMB-43` no eligibility at all is refused, not defaulted
- `COMB-44` a member missing from the map is not scorable
- `COMB-45` a combination is only as eligible as its worst member
- `COMB-46` the mixed sentence, and the trap fixture from the spec
- `COMB-47` the checked sentence needs every candidate
- `COMB-48` the injected oracle beats the overlap check
- `COMB-49` an oracle separating in the other direction ties
- `COMB-50` the completion floor arrives through the verdict, and nothing thresholds `worstCompletion`
- `COMB-51` the join: real cells, `aggregate`, `eligibilityFromAggregate`, withheld
- `COMB-52` purity holds. `eligibility.ts` imports no filesystem
- `COMB-53` a caller can actually supply a spread, so the tie test is on the production path

## Risk, and what it would look like

The realistic failure is **inventing a fifth floor by accident**. Any line in `combine/` that compares a number against a threshold, rather than reading a verdict BENCH-08 already computed, is that failure. The review question for every hunk is: does this decide whether a sample supports a claim? If yes, it must be a field read, never a comparison.

The second is churn in `evaluate.test.ts` hiding a real behaviour change behind a signature change. Mitigation: thread eligibility through the existing cases as a permissive fixture that reproduces today's answers exactly, so a diff in any existing assertion is a real regression rather than a fixture artefact.
