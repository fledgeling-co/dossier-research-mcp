# BENCH-15: three primitives now exist twice

## What happened

Runners built in parallel on a shared base and independently needed the same primitives. Each recorded the duplication from its own side rather than reaching into a merged item's files mid-fleet, which was the right call at the time and is now debt with an owner.

| Primitive | Copy A | Copy B | Do they agree? |
|---|---|---|---|
| Numeric comparison | `bench/src/score/numbers.ts` (BENCH-04) | `bench/src/score/due-weight/numbers.ts` (BENCH-05) | On tolerance arms, yes. **On magnitude words, no**: BENCH-05 accepts `mn`, `thousand`, `tn`, `trillion` and BENCH-04 does not. **On date masking, also no**, see below |
| Date masking | inside `readNumbers` (BENCH-04) | `extractNumericMentions` (BENCH-05) | **No, and each misses what the other catches.** This brief previously said they agreed; a cross-slice audit executed both and they do not |
| `completionRate` | `combine/member.ts` and `combine/merge.ts` return **0** for an empty denominator | `report/aggregate.ts` and `stats/reliability.ts` return **null**, and null is *valid* | **No.** `combine/` prints "completed 0% of its attempted runs" for a member that never attempted anything and had nothing fail |
| `http` to `https` fold | applied by `combine/merge.ts` and `score/due-weight/index.ts` | **not** applied by `score/matrix.ts`, `score/source-quality.ts`, `score/citations.ts` | **No.** One page cited under both schemes counts as one source or two depending which scorer reads it. Domain counts are unaffected, since both fold to the same registrable domain |
| URL scheme fold | `bench/src/combine/identity.ts` (BENCH-11) | private `sourceIdentity` in `bench/src/score/due-weight/index.ts` | Unknown; unify and find out |
| Containment | `tokenContainment` (BENCH-03) | `shingleContainment` (BENCH-07) | **These are genuinely different measures** and must stay separate. Listed so nobody "unifies" them |

### The date-masking divergence, measured

Executed by the audit. Each column is what that implementation extracts as a number:

| input | BENCH-04 | BENCH-05 |
|---|---|---|
| `03/04/26` | `[3, 4, 26]` | `[]` |
| `2026-07` | `[2026, 7]` | `[]` |
| `10:30:00` | `[10, 30, 0]` | `[]` |
| `https://x.test/?rev=1150000000` | `[1150000000]` | `[]` |
| `JULY 8, 2026` | `[]` | `[8, 2026]` |
| `July  8,  2026` (two spaces) | `[]` | `[8, 2026]` |

BENCH-04 requires a four-digit year, uses `\s+` and the `i` flag, and masks nothing else. BENCH-05 masks two-digit years, bare `YYYY-MM`, clock times and URLs, but uses `g` only and a literal single space.

**This one produces wrong scores today.** `score/accuracy.ts` runs on `readNumbers`, so a report containing a date, a timestamp or a URL query parameter offers spurious figures to gold-fact matching, and a gold value within tolerance of `26` or `30` can be scored recovered from a date. Due-weight silently drops real figures that sit beside a doubly-spaced date.

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
