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
