# BENCH-18: Syndication is the only text normaliser with no Unicode normalisation

**ID:** BENCH-18
**Status:** In Review
**Created:** 2026-07-28
**Last updated:** 2026-07-28
**Brief:** [BENCH-18](../features-to-triage/BENCH-18-syndication-unicode.md)

> **Harness, not product.** Nothing here reaches `dist/` or a user of the npm package. It changes a benchmark scorer, and the number that scorer produces is the one the design calls governing: agreement is not corroboration.

## Feature description

*(Verbatim from `docs/features-to-triage/BENCH-18-syndication-unicode.md`.)*

# BENCH-18: syndication detection is the only normaliser with no Unicode normalisation

## What is wrong

`normaliseForShingling` in `bench/src/score/syndication.ts` lowercases and strips non-alphanumerics. It does not normalise Unicode. Every other text normaliser in the tree does: `verify/match.ts`, `score/confidence.ts`, `score/due-weight/text.ts` and `score/units.ts` all apply NFKC or NFC first.

Measured on one wire story published by two outlets differing only in `U+FB01` (the ﬁ ligature) versus `fi`, which are NFKC-identical:

```
shingles: 958 / 958   (well above the 100 minimum)
as shipped -> same:false  resemblance:0.392  containment:0.564
with NFKC  -> same:true   resemblance:1      containment:1
```

## Why it matters more than a near-miss

**It fails open, in the direction that flatters the backend.** The wire story is not collapsed, so `collapsedIndependentDomains` stays equal to `rawIndependentDomains` and the report overstates source independence. That defeats the rule `CLAUDE.md` calls governing: agreement is not corroboration.

Ligatures, precomposed accents, curly quotes and non-breaking spaces are ordinary in syndicated newswire copy. This is the exact text the check exists to catch.

## What to do

Normalise before shingling, with the same form the sibling normalisers use, and say in a comment why the form was chosen. Then add a fixture of two texts differing only by normalisation and assert they collapse.

While there: the audit noted `score/confidence.ts` and `score/due-weight/text.ts` use **different** forms (NFKC and NFC) and different whitespace handling, and that `boundaryOk` in `confidence.ts` indexes with `h[at-1]`, which is the surrogate-pair bug `due-weight/text.ts` documents having fixed on its own side. That was reported unconfirmed. Confirm or refute it by execution and fold it in if real.

## Acceptance

- Two texts differing only by Unicode normalisation collapse to one source.
- The chosen normalisation form is stated with its reason.
- The surrogate-pair lead is either fixed or recorded as refuted, with the evidence.

## Grounding: the baseline, reproduced before anything was designed

Every figure below was produced by running the shipped code against `bench/src/score/wire-fixtures.ts`, on `main` at `b560922`, before any edit.

### The defect is real, and it is density-dependent

The brief's page carried 958 shingles and fell to `resemblance 0.392`. `WIRE_PRINTINGS[0]` carries 293, and with `fi` alone substituted it scores `0.814` and still collapses. That difference is not a contradiction, it is the shape of the defect: a shingle survives only if none of its ten words wears a costume, so the shared fraction is roughly `(1 - p)^10` where `p` is the share of words affected. At `p = 1.1%` the pair scores 0.814 and squeaks over the bar; at `p = 5.6%` it scores 0.392 and does not. **The defect is present in both cases and only the verdict differs**, which is the worst possible property for a scorer: it fails silently on the pages that happen to be dense and passes on the pages that happen not to be.

A real typesetter does not ligate `fi` alone. It ligates the whole Alphabetic Presentation Forms run: `ﬁ ﬂ ﬀ ﬃ ﬄ`. Applied to the same fixture:

| Costume, one printing against its own typeset twin | as shipped | with NFC | with NFKC |
|---|---|---|---|
| Ligature set `ﬁ ﬂ ﬀ ﬃ ﬄ` | `same:false` r 0.632 c 0.775 | `same:false` r 0.632 | **`same:true` r 1.000** |
| Fullwidth digits `０` to `９` | `same:false` r 0.684 c 0.812 | `same:false` r 0.684 | **`same:true` r 1.000** |
| Accents, precomposed against decomposed | `same:false` r 0.000 | **`same:true` r 1.000** | **`same:true` r 1.000** |
| Non-breaking space `U+00A0` | `same:true` r 1.000 | `same:true` r 1.000 | `same:true` r 1.000 |

Two of those four costumes cross the bar as shipped and are missed. That is the acceptance case.

### Which form, decided by the table rather than by convention

**NFKC.** It is the only one of the two that answers the case this scorer exists for.

NFC composes and nothing else. It fixes the accent row and leaves the ligature row and the fullwidth-digit row exactly where they were, because a ligature and a fullwidth digit are *compatibility* equivalences, not canonical ones. A scorer that applied NFC here would still miss the two costumes the brief names first.

The non-breaking-space row is not a defect and is recorded so nobody later claims normalisation fixed it: `normaliseForShingling` already replaces every run of non-alphanumerics with one space, so `U+00A0` was never a separator this check could see.

### What NFKC costs, stated because it is the reason the sibling declined it

NFKC rewrites characters that change what a figure says. `²` becomes `2`, `½` becomes `1⁄2`, `㎡` becomes `m2`, `Ⅻ` becomes `XII`. `score/due-weight/text.ts` refuses NFKC for exactly this, and its refusal is correct **for its own input**: it extracts numeric mentions out of the normalised string and compares them against gold figures, so a folded superscript would silently change a number it then reports on.

Nothing of that kind happens here. `normaliseForShingling` feeds `shingleHashes`, which joins ten words and hashes them to a `number`. No caller reads a figure, a word or a character back out of the shingle stream; the only operation performed on the output is set intersection between two pages fingerprinted by the same function. So the folding costs nothing that is reachable, and the constraint that keeps it costing nothing is written beside the constant as a condition on future callers rather than as a fact about today.

That is also why `verify/match.ts` (NFKC) and `score/confidence.ts` (NFKC) differ from `due-weight/text.ts` (NFC) without either being wrong. The rule the tree actually follows is: **NFKC where the text is being matched or fingerprinted, NFC where a figure is read back out of it.** Syndication is the first kind.

### The surrogate-pair lead: confirmed, by execution

`boundaryOk` in `bench/src/score/confidence.ts` reads its neighbours as UTF-16 code units:

```ts
const before = at === 0 ? undefined : h[at - 1];
const after = h[at + length];
```

Beside a supplementary-plane letter each of those is a lone surrogate, and `\p{L}` does not match a lone surrogate, so the boundary rule reads "letter" as "not a letter". Run against the shipped code with `U+10400` DESERET CAPITAL LETTER LONG I on both sides:

```
mentions("a𐐀AI𐐀b", "AI") = true   at=3     <- matched INSIDE a word
mentions("𐐀AI",     "AI") = true   at=2     <- left side alone
mentions("AI𐐀",     "AI") = true   at=0     <- right side alone
mentions("saidAIsaid","AI") = false at=-1    <- the BMP control, correct
```

The sibling that documents fixing it returns the opposite on the equivalent input:

```
due-weight findTermPositions("a𐐀ai𐐀b", "ai") = []
due-weight findTermPositions("saidaisaid", "ai") = []
```

**Both sides of the boundary are affected, not only the `h[at - 1]` the audit named.** The audit reported one and there are two.

The trigger is narrower than it first looks and is real. `normaliseForSearch` applies NFKC before `boundaryOk` runs, and NFKC folds the mathematical alphanumerics (`𝐀` to `a`, `𝟏` to `1`) that would otherwise be the commonest supplementary-plane letters in a pasted report. What survives NFKC and still triggers it is script text: CJK Extension B and beyond (`U+20000`+), Deseret, Gothic, Osage, Adlam. A report citing Chinese or Japanese sources carries them as a matter of course.

What it costs when it fires: `mentions` and `findAllMentions` are consumed by `score/relevance.ts` (required-term coverage and the drift penalty), `score/calibration.ts` (pairing a confidence marker's span to a gold fact), `score/accuracy.ts` and `score/refusal.ts`. The refusal consumer is the sharpest: `refusal.ts` filters the fabricated entities a report was supposed to refuse by `mentions(report, t)`, so a false positive scores a correctly-refusing report as having asserted the fabrication.

### The other half of the same lead: refuted, with the reason

The audit also noted that `confidence.ts` and `due-weight/text.ts` use different forms and different whitespace handling, implying a drift. Both differences are deliberate, documented at the function, and load-bearing:

- **Form.** Covered above. `due-weight/text.ts` reads figures back out of its normalised string and NFKC would rewrite them; `confidence.ts` only locates a subject.
- **Whitespace.** `confidence.ts` deliberately does **not** collapse whitespace, because the indices it returns are positions in the haystack as passed and the paragraph arithmetic in `findConfidenceMarkers` depends on them; it handles a term wrapped across a line break by rewriting whitespace runs in the *needle* as `\s+`. `due-weight/text.ts` collapses whitespace and works entirely in normalised coordinates, which it can because nothing maps its offsets back.

Two normalisers answering two questions is not duplication. Making them identical would break one of them. **Recorded as refuted**; the surrogate half is the real finding and is fixed.

## Acceptance criteria, as tested

| AC | Criterion |
|---|---|
| SYND-U1 | Two printings of one wire story differing only by the Alphabetic Presentation Forms ligature set collapse to one story, at resemblance 1. |
| SYND-U2 | The same holds for fullwidth digits and for precomposed-against-decomposed accents. |
| SYND-U3 | Four independently written articles about one event still do not collapse, including when one of them is dressed in the same ligature costume. The fix is not a loosened threshold. |
| SYND-U4 | The documented figures for the existing fixtures (wire 0.83 to 0.86, independent 0.00) are unmoved, because NFKC is a no-op on ASCII. |
| SYND-U5 | `normaliseForShingling` is idempotent, so a caller that normalises before calling cannot land in a second coordinate system. |
| SYND-U6 | Normalisation happens after the `MAX_PAGE_CHARS` cap, so a compatibility expansion cannot carry a page past the resource bound. |
| CONF-U1 | `mentions` refuses a match wedged between two supplementary-plane letters, on either side, and still accepts the ordinary boundary cases. |

## Out of scope

- Retuning any threshold. Every constant keeps its value; the fix is upstream of them.
- Any change to `due-weight/text.ts`, whose divergence is refuted above rather than confirmed.
- The other normalisers. `verify/match.ts` and `units.ts` were read and already normalise.
