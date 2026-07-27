# Plan: BENCH-04, accuracy and relevance scorers

**Spec:** [spec-BENCH-04.md](../specs/spec-BENCH-04.md) · **Brief:** [BENCH-04](../features-to-triage/BENCH-04-accuracy-relevance.md) · **Design of record:** [benchmark.md](../plan/benchmark.md)
**Tier:** Standard · **Written:** 2026-07-27

## What this builds

Two pure functions over a report's text and a loaded task: `scoreAccuracy`, which decides per gold fact whether the report actually stated it, and `scoreRelevance`, which decides whether the report is about the right subject. No network, no filesystem, no model.

Everything joins the scoring tree BENCH-06 shipped at `bench/src/score/`, reuses its search and normalisation helpers, and produces the recovery record its calibration scorer already declares as an input.

## What already exists, and is reused rather than rewritten

| Existing | Where | Used for |
|---|---|---|
| `normaliseForSearch` | `bench/src/score/confidence.ts` | one coordinate system for every match. Idempotent on purpose, so a pre-normalised haystack can be passed back in and the indices still mean something |
| `findAllMentions`, `mentions` | same | word-boundary term and name matching. A bare substring search is how a two-letter term scores a hit on every page |
| `FactRecovery` | `bench/src/score/calibration.ts` | the output type. Imported, never redeclared |
| `utcDayOrdinalFromIsoDate` | `bench/src/tasks/schema.ts` | whole-UTC-day date comparison |
| `GoldFact`, `Tolerance`, `BenchTaskFile` | same | the contract this scorer reads |

Deliberately **not** reused: `bench/src/verify/match.ts`. Its `numberForms` generates the spellings of a number to look for in a *fetched source page* and its own comment says a regex-based scanner would disagree with this scorer. The two jobs are different — one asks whether the author's own citation supports the gold, the other asks whether a backend recovered it — and collapsing them would make one rule serve two questions badly.

## Files

New, all under `bench/src/score/`:

| File | Holds |
|---|---|
| `prose.ts` | `extractProse` (strip every citation form), the negation rule, `NEGATION_CUES` |
| `units.ts` | the canonical unit map, `canonicaliseUnit`, `foldScaleWord`, `unitSurfaceForms` |
| `numbers.ts` | `toPlainString`, `shiftDecimal`, number-mention scanning, interpretations, `withinTolerance` |
| `dates.ts` | date-mention scanning across the accepted written forms |
| `accuracy.ts` | `scoreAccuracy` and its result types |
| `relevance.ts` | `scoreRelevance` and its result types |

Plus a co-located `*.test.ts` for each, `bench/src/score/index.ts` extended, `docs/bench/scoring.md` extended, `docs/test-plan.md` AC rows appended, `CHANGELOG.md` entry appended.

## The rules, stated so two implementations cannot disagree

### 1. Prose

`extractProse(markdown)` removes every citation form `extractCitedUrls` in `src/research/report.ts` recognises, because a figure surviving in any one of them would score for reasoning nobody did:

1. `<cite url="…">` opening tags and `</cite>` closing tags, keeping the inner text.
2. Images and inline links: the destination goes, the visible text stays, **unless** that text is itself a bare hostname or URL (`arxiv.org`), which is part of the citation rather than prose.
3. CommonMark autolinks, `<https://…>`.
4. Reference definitions at the head of a line, `[label]: https://…`.
5. Bare URLs anywhere else.

Order matters: destinations are removed before the bare-URL sweep, or the sweep eats the closing parenthesis and leaves a stray fragment.

### 2. Coordinates

Every match runs over `normaliseForSearch(extractProse(report))`, computed once. `normaliseForSearch` is idempotent, so the helpers may re-normalise it and their indices still refer to the same string. Matching therefore happens in lower case, which is why every lexicon below is lower case.

### 3. Negation

A value that appears **only** inside a negation is not recovered. One plain occurrence anywhere is enough.

The scope is the clause containing the match, bounded backwards by `.` `!` `?` `;` `:` a newline, an em or en dash, or one of the contrast words (`but`, `however`, `although`, `though`, `whereas`, `while`, `yet`). A `.` between two digits is not a boundary, or `1.2` would cut its own clause. Within that clause, and within ten words of the match, a cue from `NEGATION_CUES` on a word boundary marks the occurrence negated.

Crude, exact, repeatable, free, and reported as exactly that — the same trade this repo already makes for token containment. The cue list is an exported constant so a later item can widen it with evidence rather than by editing a literal.

### 4. Numbers

A mention is `[currency prefix]? digits [magnitude]? [unit]?`.

- **Digits**: comma-grouped (`1,200,000`), plain (`1200000`), decimal (`8.8`), leading-dot (`.5`), optional exponent (`1.2e9`). A sign is taken only when the character before it is not a digit, so the `-07` inside `2026-07-01` is read as `7` rather than `-7`.
- **Currency prefix**: `$`, `us$`, `a$`, `c$`, `nz$`, `€`, `£`, `¥`, `₹`, or a three-letter code.
- **Magnitude**: `k` `m` `mm` `bn` `b` `tn` `t` and the words `thousand` `million` `billion` `trillion` with plurals.
- **Unit**: longest match against the lexicon **union the gold fact's own surface forms**, so an author unit like `questions` or `CVSS v3.1 base score` participates without being in a global table.

**Interpretations.** A mention yields more than one reading when its suffix is ambiguous: `450m` is both `450 000 000` and `450 metres`. A fact matches if **any** interpretation matches. `1.2B` is not ambiguous in the other direction and yields one reading. This is the lenient direction on purpose: the brief names the false negative as the expensive error.

**The unit rule**, which is the whole of the second acceptance criterion:

- No recognised unit token attached, **before or after the figure** (the preposed case was added at the gate; see below), ⇒ `unitEvidence: 'unstated'`, and the interpretation is compatible with any gold unit. A right figure whose unit the report left implicit is recovered, not wrong, and the real corpus has units no report will ever write out.
- A recognised unit token attached ⇒ it must canonicalise to the gold's canonical unit, or **that interpretation cannot match**. No partial credit, no fallback to "unstated". The veto is structural: the unit belongs to the interpretation, so an interpretation carrying the wrong unit is simply not a match.
- Lookup is longest-surface-form-first, so `percentage points` is never read as `percentage`.

Canonical classes that must stay distinct because they are the confusions being caught: `percent`, `percentage-point`, `basis-point`, and one class per currency.

**Gold-side folding.** A gold `unit` may carry its own scale word — `USD billions`, `millions of USD`. It is folded out into the value, so `1.2` with unit `USD billions` and `$1.2bn` in a report are one fact.

**Decimal safety.** Scaling shifts the decimal point in the digit *string*; it never multiplies by a power of ten. (The example first written here, `1.1 * 1e6`, is wrong: that one is exact. The real cases were found by sweep and are `1.005 * 1e6`, `0.267 * 1e9`, `2.01 * 1e3` and `0.067 * 1e12`.) `toPlainString` expands exponential notation on the way out for the same reason `numberForms` guards it: `String(1e21)` and `(1e21).toFixed(0)` are both `1e+21`, and a benchmark that prints that has lied about its own gold.

**Tolerance**, with `a` the report's value and `g` the gold's:

| Arm | Test |
|---|---|
| `exact` | ~~`abs(a - g) <= max(abs(g), 1) * 1e-12`~~ **superseded, see the gate note below:** strict equality. The guard was a tolerance in disguise |
| `absolute` | `abs(a - g) <= value` |
| `relative` | `abs(a - g) <= fraction * abs(g)`; at `g = 0` this has no width and degrades to equality, which is noted on the result rather than left to be discovered |
| `significantFigures` | `Number(a.toPrecision(d)) === Number(g.toPrecision(d))` |

### 5. Dates

Accepted written forms: `YYYY-MM-DD`, `YYYY/MM/DD`, `D Month YYYY`, `Month D, YYYY` (with or without the comma and with an optional ordinal suffix), and full or three-letter month names. `DD/MM/YYYY` and `MM/DD/YYYY` are genuinely ambiguous, so both readings are generated and either may match, with the ambiguity noted. A month and year with no day is not a match for a full date. Every candidate is validated as a real calendar date and compared as a whole UTC day.

### 6. Names and identifiers

`mentions` on the prose, on word boundaries, against the value and then each alias. Aliases exist on those two arms specifically for this scorer, so matching them is the requirement rather than a nicety.

### 7. Relevance

```
coverage   = requiredHit / requiredTerms.length
driftShare = driftTerms.length === 0 ? 0 : driftHit / driftTerms.length
score      = clamp(coverage - DRIFT_WEIGHT * driftShare, 0, 1)     // DRIFT_WEIGHT = 1
```

Each term counts once whether it appears once or forty times. `coverage` and `driftShare` are returned alongside `score`, because the prior art is explicit that a collapsed number hides what its components say.

**Negation is deliberately not applied here.** Relevance asks whether the report is about the subject; a report saying "this is not about Kubernetes" has still raised the subject. Accuracy asks whether an answer is right, which is where polarity changes the answer.

### 8. Applicability

Both scorers return a discriminated result whose first state is `not-applicable`, matching the convention the sibling scorers established. A task with no gold facts is not accuracy-applicable; a task with no required terms is not relevance-applicable. Neither ever returns a zero standing in for an absent measurement, and the condition checked is the one `ApplicableMetrics` derives, with a comment saying so rather than a second derivation.

Staleness is not consulted. That was settled by the run harness: a stale task loads, is scored, and is counted, and the count is printed before the run.

## Steps

1. `prose.ts` + test. Extraction over all five citation forms, then the negation rule.
2. `units.ts` + test. The lexicon, longest-match canonicalisation, scale-word folding.
3. `numbers.ts` + test. This is the table-driven one the brief demands; it is where the bugs live.
4. `dates.ts` + test.
5. `accuracy.ts` + test, including against the real corpus.
6. `relevance.ts` + test.
7. Barrel, `docs/bench/scoring.md`, `docs/test-plan.md` AC rows (before the tests they describe), `CHANGELOG.md`.
8. `npm run gate`, twice, plus the stdio smoke against `dist/index.js`.

## Acceptance checklist

Each row becomes an `ACCREL-*` row in `docs/test-plan.md` before its test is written.

1. `1.2 billion`, `1,200,000,000`, `1.2B`, `1.2 bn`, `$1.2B`, `USD 1.2 billion` and `1.2e9` all recover a gold of `1200000000 USD`. Table-driven.
2. A right figure with a recognised wrong unit recovers nothing: `28.6 percentage points` against a gold of `28.6 percent`, and `€1.2bn` against a gold in USD.
3. A figure present only inside a citation URL is not recovered, once per citation form.
4. A figure present only inside a negation is not recovered; the same figure stated plainly as well is.
5. Each tolerance arm accepts immediately inside its bound and rejects immediately outside, including a relative tolerance against a zero gold.
6. Scaling is decimal-exact: `1.1 million` is `1100000`, and no output anywhere contains `e+`.
7. Every accepted date form matches; a bare month and year does not; an ambiguous numeric date matches on either reading and says so.
8. Names and identifiers match case-insensitively after Unicode normalisation, on word boundaries, by value or by alias.
9. All four answer kinds are handled, proven against the exported kind tuple so a fifth kind cannot be added without failing here.
10. A task with no gold facts is not-applicable, never zero; the same for relevance with no required terms.
11. Relevance is coverage minus drift, clamped, counting each term once, with an empty drift list scoring no penalty.
12. The recovery record `scoreAccuracy` returns is accepted by `scoreCalibration` unchanged.
13. The seven admitted corpus tasks all score without throwing, and a report built from each task's own gold recovers every fact.

---

## Plan review gate, 2026-07-27

**Codex cross-family review** (`gpt-5.6-sol`, `max` effort, read-only, grounded in the repo, run against main after four items had merged).

`codex-review: MATERIAL DEFECTS · 9 findings · 7 accepted / 2 recorded-not-fixed`

Accepted and fixed, each verified against the code first:

1. *A preposed unit is invisible, and the CVSS v4.0 sentence recovers the v3.1 gold.* The sharpest finding of the nine, and it was against a real corpus task rather than a fixture. Units are now read before the figure as well as after, and a multi-word author unit contributes a family token so that naming the family without naming this member of it is a wrong unit rather than an absent one.
2. *A date shape states a number.* `2026-07-01` holds an `07`, and an unstated unit is compatible with any gold unit, so a gold of seven was recoverable from a publication date. Whole date shapes are masked, length-preserving.
3. *`exact` is not exact.* The `1e-12` relative guard accepted a reported `0` for a gold of `1e-13`. Strict equality now.
4. *A numeric citation label is left in the prose.* The server rewrites stored citations into a bracketed number, so a gold of 1 was recoverable from a citation marker.
5. *NFKC changes numeric meaning.* A superscript two becomes a plain `2`, so ten squared read as `102`. Those characters are blanked before normalisation.
6. *Only three of four answer kinds were specified.* Already implemented; now pinned by a test against the exported kind tuple.
7. *Applicability re-derives the loader's rule.* True, and the sibling scorer does the same. Closed with a parity test over every corpus task rather than by changing the argument type, which would have diverged from the sibling.

Recorded, not fixed, with reasons:

8. *Unify with the due-weight scorer's numeric primitives.* Correct and important, and it cannot be done from here: that code merged after this branch was cut, and this item was told not to rebase. Both implementations now carry the same note. See the deferred section of `docs/bench/scoring.md`.
9. *Negation should scan forward as well as backward.* Scanning forward fixes "8.8 is not the assigned score" and breaks "8.8, not 7.2", and the second is the commoner shape. Backward-only is the safer direction and is recorded as a known limit.

Rejected from the earlier spec review, unchanged: the stale-task policy was already settled by the run harness, and the `{ pass, score, reason }` result shape belongs to a harness that was evaluated and not adopted.
