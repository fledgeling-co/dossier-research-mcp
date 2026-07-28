# BENCH-15: three primitives now exist twice

**ID:** BENCH-15
**Status:** In Review
**Created:** 2026-07-28
**Last updated:** 2026-07-28
**Brief:** [BENCH-15](../features-to-triage/BENCH-15-duplicate-primitives.md)

> **Harness, not product.** Nothing here reaches `dist/` or a user of the npm package. Every file changed is under `bench/`, and the product's own `canonicaliseUrl` is read rather than edited, for the reason both copies of the scheme fold already give: a benchmark that edits the behaviour it is measuring to make its own numbers nicer has stopped being a benchmark.

## Feature description

*(Verbatim from `docs/features-to-triage/BENCH-15-duplicate-primitives.md`.)*

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

## Grounding, measured rather than assumed

Every row below was executed against `main` before anything was designed, because the brief's own table was written from an audit and one of its rows is stale.

### The brief's magnitude row is wrong, and the correction changes the work

`SCALE_WORDS` in `bench/src/score/units.ts` already holds `mn`, `thousand`, `tn` and `trillion`. BENCH-04's vocabulary is a strict **superset** of BENCH-05's: it adds the plurals and `mm`. So the union is BENCH-04's table, and the live divergence runs the other way from the brief's description.

```
"a 1.2 millions figure" | accuracy: [1200000] | due-weight: [1.2]
```

Due-weight reads `1.2` and drops the magnitude, because `MAGNITUDE_PLACES` has no plurals. That is the live false negative on this row.

### The date-masking table reproduces exactly

Every row of the brief's table was re-executed through the real scoring path (`normaliseForSearch(extractProse(report))` for accuracy, `normaliseForMatch` for due-weight) and every one reproduced, with one correction and one addition.

**Correction: `extractProse` already removes a bare URL**, so a URL query parameter does not reach accuracy on the sanctioned path. `maskDateShapes` alone does not remove one, which is what the audit measured. The exposure is real but narrower than the brief states, and the timestamp exposure is exactly as stated:

```
"as of 2026-07-27T10:30:00Z the count was 12" | accuracy: [10, 30, 0, 12]
"filed 03/04/26 with 12 items"                | accuracy: [3, 4, 26, 12]
```

**Addition, found while measuring: the space fill is itself a defect.** BENCH-04 blanks a date with spaces, and the scale-word probe in `readNumbers` skips spaces before reading a magnitude word. So a masked date between a figure and a magnitude word is skipped straight over:

```
"revenue was 1.2 2026-07-27 billion" | accuracy: [1200000000]
```

A figure the report wrote as `1.2` is scored as one point two billion. BENCH-05's `#` fill cannot do this, because `#` is not whitespace and the probe stops on it. The fill character is therefore part of the unification rather than an implementation detail.

**Addition: BENCH-05's month pattern over-masks.** `MONTH` is `(?:jan|feb|...|dec)[a-z]*`, and BENCH-05 alone carries a bare `MONTH \d{4}` shape. Together those blank real figures:

```
maskDateShapes("novel 2026")  -> "##########"
maskDateShapes("decade 2026") -> "###########"
```

`nov` + `el` and `dec` + `ade`. Taking the `MONTH \d{4}` shape into the shared masker without tightening `MONTH` would carry that into accuracy, where it would silently drop a real gold figure. Tightening it also fixes a live due-weight false negative.

### `completionRate` diverges only on the empty denominator

`combine/member.ts` returns `0` for `runs.length === 0`; a member whose every run failed also returns `0`, and that one is correct on both readings. So the change is confined to the empty case, which is what the brief says.

### The two scheme folds are byte-identical

`bench/src/combine/identity.ts` and the private `sourceIdentity` in `bench/src/score/due-weight/index.ts` are the same one-line body. `identity.ts`'s own comment already records that nothing pins them together and names BENCH-15 as the owner.

## What is in scope

1. **The date mask, first and alone**, so it is bisectable. One `maskDateShapes` under `bench/src/score/`, taking the union of shapes both authors wanted, with `MONTH` tightened and `#` as the fill. Both callers migrated.
2. **The magnitude vocabulary.** One `SCALE_WORDS` table, in `units.ts` where it already lives. Due-weight derives its patterns from it instead of holding a second table.
3. **The tolerance comparator.** `matchesTolerance` becomes `withinTolerance`; there is one function.
4. **The scheme fold.** One exported `sourceIdentity` under `bench/src/score/`, with both existing callers migrated.
5. **`completionRate` returns `number | null`**, null for an empty denominator, following `report/aggregate.ts`.
6. **A comment on each containment** naming the other and saying why they are not duplicates.

## What is deliberately not in scope

**The two extraction functions stay two.** `readNumbers` answers "what figures did the report state, and in what unit"; `extractNumericMentions` answers "does this text state this figure". They return different types, have opposite error preferences that their own module docs state, and only one has a unit model. Merging them would mean picking one error preference for both, which is a scoring decision neither brief authorises. What they share is the vocabulary, the mask, the decimal shift and the comparator, and after this item they share exactly one implementation of each.

**The scheme fold is not pushed into `score/matrix.ts`, `score/source-quality.ts` or `score/citations.ts`.** See the decision record below.

**The two containments are not merged.** They measure different objects. The brief lists them so nobody merges them, and the acceptance is a comment on each.

**A hyphenated token still yields a number in accuracy.** Measured while grounding: `covid-19 killed 26` gives accuracy `[19, 26]` and due-weight `[26]`. That is a real false positive on the accuracy path and it is a *different* rule from date masking, living in the extraction functions this item keeps apart. Recorded here for an owner rather than fixed by side effect.

## The decisions, with their reasons

### D1. The mask fill is `#`, not a space

Both fills preserve length, which is the property every offset downstream depends on. They are not otherwise equivalent: a space is whitespace, and two of accuracy's readers skip whitespace to find what follows a figure. Measured above, a space fill lets the scale-word probe read a magnitude word from the far side of a masked date and turn `1.2` into `1200000000`.

The cost is one narrow case in the other direction. Due-weight decides a leading `-` is a minus only when the character before it opens a number, and whitespace opens one while `#` does not, so `2026-07-27-5` reads as a positive five rather than a negative. That shape is a date-range spelling rather than a signed figure, and the case where it matters, `2026-07-27 -5`, still keeps the real space between the mask and the sign and still reads `-5`.

### D2. `MONTH` names months, rather than starting like one

`(?:jan|feb|...)[a-z]*` matches `novel`, `decade`, `mayonnaise` and `marginal`. It survived in both files because neither carried a shape where a month is followed only by a year. The shared masker does carry one, so the pattern is tightened to the twelve names and their standard abbreviations, on a word boundary.

### D3. The magnitude vocabulary is shared; the attachment policy is not, and that is the decision

One `SCALE_WORDS` table. Due-weight stops holding `MAGNITUDE_PLACES` and derives its patterns from the shared table, so a word added once reaches both.

Where they genuinely disagree is not *which words* but *where a word may sit*, and the reason is structural rather than accidental. Accuracy has a unit model: an ambiguous suffix produces two readings and the gold fact's own unit decides between them, so `450m` can be read as both 450 million and 450 metres at no cost. Due-weight has no unit model and only one reading per mention, and its module doc states the opposite error preference: a spurious match credits a report for acknowledging a disagreement it never mentioned.

So:

| | accuracy | due-weight |
|---|---|---|
| spelled-out word, attached or spaced | yes | yes |
| abbreviation attached | yes | yes |
| abbreviation after a space | yes, both readings | only `mn`, `bn`, `tn`, which name no unit |
| `mm` | yes, both readings | **no** |

`mm` is the one word that stays out of due-weight. It is in the shared table because accuracy needs it and reads it both ways; `5mm` is millimetres far more often than five million, and due-weight cannot say so. Its present behaviour on `5mm` is to yield nothing at all, and admitting the word would make it yield five million, which is the spurious match its own doc calls the worse error.

Both resolved sets are asserted by name in a test, which is the brief's acceptance criterion.

### D4. The scheme fold stays at the "same document" boundary

There is one implementation. There are two questions, and only one of them wants the fold.

`canonicaliseUrl` deliberately preserves the scheme, because the product counts independent sources for corroboration and there two schemes are two strings. `combine/` and due-weight both ask a different question, "did this member read that page" and "did the report reach that document", where two schemes are one page. Both already layer the fold on top rather than editing the product, and both give that reason in their own comments.

`score/source-quality.ts`, `score/citations.ts` and `score/matrix.ts` ask the product's question, and two of them call the product's own counter to answer it. Folding there would make the benchmark's independent-source count diverge from the number the product computes, which is measuring something the product does not do. The brief's own row records that domain counts are unaffected either way, so what would change is only the URL-level population, in the direction of making the benchmark and the product disagree.

The boundary is a decision rather than an oversight, so it is pinned by a test that names which modules apply the fold and which do not.

### D5. Null is right for an empty completion denominator

Not re-derived: `report/aggregate.ts` already keeps four distinct reasons precisely to separate "never ran" from "failed everything", and `stats/reliability.ts` follows it. `combine/` returning `0` prints "completed 0% of its attempted runs" for a member that never attempted anything and had nothing fail, which reads as the worst possible result for the one state that is not a result at all.

`completionRate` returns `number | null`. The one consumer that compares it, `evaluate.ts`'s `worstCompletion`, excludes a null rather than treating it as zero, and the existing enumeration test that bans a fifth completion floor keeps passing unchanged.

## Acceptance criteria

| id | criterion |
|---|---|
| DUP-01 | One `maskDateShapes` exists under `bench/src/score/`; `readNumbers` and `extractNumericMentions` both call it, and neither file declares a date pattern of its own. |
| DUP-02 | The shared mask blanks every shape either author masked: ISO, slashed with a two- or four-digit year, `YYYY/MM/DD`, bare `YYYY-MM` with a real month, written-out dates in both orders with arbitrary whitespace and any case, bare `MONTH YYYY`, clock times, and URLs. |
| DUP-03 | The mask is length-preserving and fills with `#`; `readNumbers` no longer reads a magnitude word from the far side of a masked date. |
| DUP-04 | `MONTH` matches the twelve month names and their standard abbreviations only; `novel 2026` and `decade 2026` keep their figure. |
| DUP-05 | One `SCALE_WORDS` table; `bench/src/score/due-weight/numbers.ts` declares no magnitude table of its own and derives both its patterns from the shared one. |
| DUP-06 | A test asserts the resolved magnitude vocabulary and both attachment sets explicitly, by name. |
| DUP-07 | One tolerance comparator. `matchesTolerance` is gone and every caller uses `withinTolerance`. |
| DUP-08 | One exported `sourceIdentity` under `bench/src/score/`; `combine/identity.ts` and `score/due-weight/index.ts` both use it and neither declares the fold. |
| DUP-09 | A test names which modules apply the scheme fold and which deliberately do not, so D4 fails loudly if anyone moves the boundary. |
| DUP-10 | `completionRate` returns `null` for an empty denominator and a number otherwise; `MergedCombination` and `OverlapProfile` carry `number | null`; `worstCompletion` excludes a null instead of counting it as zero. |
| DUP-11 | `tokenContainment` and `shingleContainment` each carry a comment naming the other and saying why they are not duplicates. |
| DUP-12 | Every pre-existing test still passes, and the whole gate runs green twice. |

## Verification

`npm run gate` (typecheck, lint, `lint:source`, `lint:docs`, `test:all`, build), run twice, plus a stdio smoke against `dist/index.js`. There is no UI and no Playwright; the substitution is `ORCHESTRATOR.md`'s.

The two behaviour claims that matter are proved by **execution against the pre-change code**, not by assertion: the spurious `1200000000`, and the blanked figure in `novel 2026`. Both have a test that fails against `main` and passes after.
