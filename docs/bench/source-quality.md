# Source quality, independence and syndication

What the source-quality scorer measures, and what each number cannot mean. It sits beside [`scoring.md`](scoring.md), which covers calibration, refusal correctness and recency.

Three things are graded, and only the third is new.

## The source mix is the product's own rule

`classifySource` decides what a cited URL is: official, academic, journalism, secondary industry, community, or the honest `other`. `profileEvidence` turns a set of them into the mix, the official or academic share, the largest single domain's share, and the product's advisory floors.

Both are imported, not reimplemented. Two definitions of "official source" eventually disagree about what the rule is, and then the benchmark is measuring something the product does not do.

The floors travel with the result and are **reported, never scored**. They are gameable, and they wrongly penalise investigative work where one leaked primary document outweighs twenty write-ups. That is what `profileEvidence` says about them and nothing here overrides it.

## Independence is counted in domains

`assessSupport` is the counter. It encodes the rule the whole product turns on: corroboration is counted in independent registrable domains after canonicalisation, never in providers and never in raw URLs.

`countsAsCorroboration` is **not** the counter, though `docs/plan/benchmark.md` said so until 27 July 2026. It takes one classified source and answers whether that source is public enough to count at all, which is the rule that keeps a user's own documents out of independent corroboration. It counts nothing. The design document is corrected.

Citations that are not resolvable web addresses are discarded **once, before either count**. Model output really does arrive with "unknown" and "not available" among the links, and the product already learned what happens when three of those are counted as three domains. Discarding late would leave the raw count and the collapsed count describing different populations, and then the difference between them stops meaning syndication.

## Syndication is the new part

Four domains carrying one wire story are four domains and one source. No amount of care about domain identity can see it, because the four domains genuinely are four domains.

The detector is Broder's shingling. Each page's text is Unicode-normalised to NFKC, lowercased, stripped of punctuation, cut into overlapping runs of ten words, and each run hashed. Two pages are the same story when their **resemblance** (the shared runs over the combined runs) reaches 0.7, or when their **containment** (the shared runs over the smaller page's runs) reaches 0.9.

Domains are then merged transitively: two domains join when any page on one is the same story as any page on the other, and a chain of outlets joins as one source rather than as a series of pairs.

### Both numbers, always

The raw count and the collapsed count are always reported together. The collapsed one is never reported alone.

That is not politeness. The threshold is a judgement, and a reader who disagrees with the judgement needs the raw figure to reason from. A single collapsed number would ask them to accept the judgement or discard the whole measure.

### Where the thresholds came from

Recorded in full in the comment beside the constants, because a number nobody can trace is a number nobody can argue with.

- **Ten words per shingle** is Broder, Glassman, Manasse and Zweig, *Syntactic Clustering of the Web* (WWW6, 1997), which states it flatly: "The shingle size w is 10."
- **0.7** is the figure this repo already recorded. `last30days-skill`, written up in [`../plan/external-skill-gap-analysis.md`](../plan/external-skill-gap-analysis.md), de-duplicates on `max(char_3gram_jaccard, token_jaccard) >= 0.7` over titles and bodies. Their measure is not this one, so the number transfers as a considered value rather than as a calibration, and that distinction is stated in the code.
- **The published anchors either side** are Broder's own clustering at 0.50 and Manning, Raghavan and Schütze's illustrative 0.9 for dropping a page from an index. Landing between them is this project's judgement: above 0.50 because a false collapse understates a backend's independence, below 0.9 because a republished wire story carries a house headline and local furniture that a near-verbatim bar would reject.
- **0.9 containment** exists because resemblance alone cannot see the ordinary case. An outlet running half a wire story verbatim can never exceed about 0.5 resemblance, however word-perfect it is.

Measured on the module's own fixtures, four printings of one wire story score 0.83 to 0.86 and four independently written articles about the same event score 0.00. The bar is not finely balanced between them; it sits in a wide empty gap.

### Why NFKC, and what it would cost somewhere else

Added 28 July 2026. Until then this was the only text normaliser in the tree that did not normalise Unicode, and it **failed open**: two printings of one wire story differing only in typographic dress stayed two independent domains, so the report overstated source independence. That is the direction that flatters the backend, and it defeats the rule the whole product turns on.

Measured on the same fixture, one printing against the same page as a typesetter would set it:

| Costume | as shipped | with NFC | with NFKC |
|---|---|---|---|
| The ligature run `ﬁ ﬂ ﬀ ﬃ ﬄ` | not the same story, 0.632 | not the same story, 0.632 | **the same story, 1.000** |
| Fullwidth digits | not the same story, 0.684 | not the same story, 0.684 | **the same story, 1.000** |
| Precomposed against decomposed accents | not the same story, 0.000 | **the same story, 1.000** | **the same story, 1.000** |

**The K is the point.** A ligature and a fullwidth digit are *compatibility* equivalences, not canonical ones, so NFC leaves the two commonest newswire costumes exactly where they were. A non-breaking space needs neither form: the punctuation strip already turns every run of non-alphanumerics into one separator, so it was never visible here.

NFKC has a real cost and it is paid elsewhere rather than here. It rewrites characters that change what a figure says: `²` becomes `2`, `㎡` becomes `m2`. [`due-weight.md`](due-weight.md)'s matcher refuses NFKC for exactly that reason, and it is right to, because it reads numeric mentions back out of its normalised string. Nothing does that here: the output is joined into ten-word windows and hashed, and the only operation ever performed on the result is set intersection against another page fingerprinted the same way. **That is a condition on future callers, not a happy accident.** Anything that needs to read a value out of a page must take the raw text.

So the rule the tree follows, which looks like a drift between two files and is not: NFKC where text is matched or fingerprinted, NFC where a figure is read back out of it.

Nothing about the thresholds changed. The fix is upstream of them, and the four independently written articles still score 0.00 against each other, including when one of them is dressed in the same ligature costume.

An out-of-family review of the change found two things worth carrying, and one of them was opened by the fix rather than found beside it.

**The boundary fix made an infinite loop reachable.** `confidence.ts` searches a multi-word term with a regular expression, and a rejected match used to advance by one UTF-16 code unit. A `u`-flagged pattern will not begin a match inside a surrogate pair, so beside a supplementary-plane character it snapped back to the same index and returned the identical match forever. It could not fire while the boundary check wrongly *accepted* such a match, so correcting the boundary is what opened it. Now it advances by a whole code point.

**Folding once is not enough.** NFKC then lower-case is not a fixed point: an uppercase `J` with a combining caron has no precomposed form, so one pass leaves it two characters and lower-casing it creates a sequence that composes. Stopping there let the punctuation strip delete the orphaned mark, and `J̌word` tokenised as two words while `ǰword` tokenised as one. That is the same word in two spellings scoring zero against itself, which is the failure the whole change is against. Idempotence alone did not catch it, because the one-pass version is idempotent too: the first pass has already destroyed the information.

### The objection that does not apply here

Near-duplicate merging was declined once for `src/research/corroborate.ts`, and the reason was right: thresholds in this range are tuned against article titles and bodies, while that file holds one-sentence worker-written claims, and two workers summarising genuinely independent sources will write near-identical sentences. Merging those would destroy real corroboration.

That objection is about the **input**, not the number. This scorer is never given claim text. It is given full fetched page text, which is the case those thresholds were tuned against. The product's own crude claim-text detector is untouched and stays where it is.

## What these numbers cannot mean

- **The collapsed count is an upper bound on how many independent sources there are.** A domain with no fetched page, a page too short to characterise, and a page past the page ceiling are all counted as their own source and named in `uncheckedDomains`. Syndication among them is untested, not ruled out, and untested syndication can only ever merge more. So the gap between the two figures is a **lower** bound on how much collapsing there is.
- **A merged domain may have contributed real evidence too.** An outlet that ran both the wire copy and its own original piece merges on the strength of the wire copy alone. That understates independence, the scorer says so in its notes, and the alternative (counting stories instead of domains) would answer a different question from the raw figure it sits beside.
- **A publisher can bridge two unrelated stories into one component.** Because the merge is transitive over publishers rather than over stories, a domain carrying two different syndicated pieces joins the carriers of both, so two publishers sharing no story at all can be counted as one. Same direction as the case above: it understates independence, and it is the price of keeping the collapsed figure comparable with the raw one.
- **Two domains serving the same third-party interstitial will merge.** A shared bot-check or consent page is long enough to pass the length floor and identical across hosts, and nothing here can tell it from real syndication. Every cluster is therefore reported with its URLs and its scores rather than folded silently into a count.
- **Normalisation folds costume, not disguise.** NFKC collapses a ligature, a fullwidth digit and a decomposed accent onto their plain forms. It does not collapse a homoglyph: a Cyrillic `а` standing in for a Latin `a` is a different character to Unicode and to every normalisation form, and it breaks every ten-word window it sits in. Two printings of one story that differ that way are still counted as two sources. Same direction as the cases above, which is the safe one: it understates collapsing, so the gap between the raw and collapsed figures stays a lower bound.
- **Folding shrinks the shingle set, and the length floor is measured after it.** The same review constructed a page of 1,033 words whose windows differ *only* by halfwidth against fullwidth digits: 1,024 distinct shingles before normalisation, one after, which drops it below the hundred-shingle floor and leaves its domains reported unchecked and independent. That is the intended behaviour taken to its adversarial extreme, since windows differing only by a compatibility distinction are exactly what this fold exists to merge, and a page whose every window folds onto one really does carry one distinguishable window. It is left rather than patched, because gating the floor on the un-normalised count would put the length test and the comparison in two different coordinate systems. Direction is the safe one again: unchecked, and named in `uncheckedDomains`.
- **There is deliberately no blended score.** Citation volume and citation quality are close to orthogonal in current systems and human preference tracks the former, so a blended number systematically fails to penalise the failure being measured. See [`../deep-research/benchmark-prior-art.md`](../deep-research/benchmark-prior-art.md).

## What supplies the page text

Nothing here fetches. Page text arrives already collected, exactly as recency takes publication dates already collected, which is what keeps the scorer reproducible from a stored run and keeps every test off the network. Both come from the same place: [`citation-integrity.md`](citation-integrity.md)'s evidence snapshot, written once at collection time.

**Corrected 28 July 2026.** This said no component stored it and that the scorer was a producer-less library. Both were true when written and neither is now. BENCH-03's evidence snapshot writes exactly the contract this asked for, canonical URL, bounded extracted text and an explicit fetch status, and `bench/src/report/harvest.ts` feeds it here, so the collapsed count renders whenever a snapshot exists. BENCH-16 added the other half of the sentence above: a publication date per page, or an explicit statement that one could not be established. The original paragraph is replaced rather than quietly deleted, because "recorded here rather than discovered later" is the habit that made both closable.
