# BENCH-15: three primitives now exist twice

## What happened

Runners built in parallel on a shared base and independently needed the same primitives. Each recorded the duplication from its own side rather than reaching into a merged item's files mid-fleet, which was the right call at the time and is now debt with an owner.

| Primitive | Copy A | Copy B | Do they agree? |
|---|---|---|---|
| Numeric comparison | `bench/src/score/numbers.ts` (BENCH-04) | `bench/src/score/due-weight/numbers.ts` (BENCH-05) | On tolerance arms and date masking, yes. **On accepted magnitude words, no.** |
| URL scheme fold | `bench/src/combine/identity.ts` (BENCH-11) | private `sourceIdentity` in `bench/src/score/due-weight/index.ts` | Unknown; unify and find out |
| Containment | `tokenContainment` (BENCH-03) | `shingleContainment` (BENCH-07) | **These are genuinely different measures** and must stay separate. Listed so nobody "unifies" them |

## Why this is worth doing now rather than later

Two implementations of one rule eventually mean two different answers to one question, and the disagreement surfaces as an unexplained scoring difference between two categories that share a corpus. The magnitude-word divergence is already live: a report writing "1.2 bn" scores differently depending on which scorer reads it.

Both arrived at the decimal-shift conclusion independently, which is decent evidence the shared behaviour is right. The divergence is at the edges, and the edges are where a false negative hides.

## What to do

Unify the numeric comparison and the scheme fold into one implementation each, under `bench/src/score/` where both callers can reach them. Take the **union** of accepted magnitude words only where both authors can be shown to have wanted it; where they genuinely disagree, decide, and record the decision with its reason rather than splitting the difference.

Leave the two containments alone and put a comment on each saying why they are not duplicates, or somebody will merge them next quarter.

## Acceptance

- One numeric comparator, one scheme fold, both with every existing caller migrated and every existing test still passing.
- A test asserts the magnitude-word set explicitly, so the resolved disagreement is visible rather than implied.
- The two containments carry a comment naming the other and saying why they differ.
