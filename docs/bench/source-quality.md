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

The detector is Broder's shingling. Each page's text is lowercased, stripped of punctuation, cut into overlapping runs of ten words, and each run hashed. Two pages are the same story when their **resemblance** (the shared runs over the combined runs) reaches 0.7, or when their **containment** (the shared runs over the smaller page's runs) reaches 0.9.

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

### The objection that does not apply here

Near-duplicate merging was declined once for `src/research/corroborate.ts`, and the reason was right: thresholds in this range are tuned against article titles and bodies, while that file holds one-sentence worker-written claims, and two workers summarising genuinely independent sources will write near-identical sentences. Merging those would destroy real corroboration.

That objection is about the **input**, not the number. This scorer is never given claim text. It is given full fetched page text, which is the case those thresholds were tuned against. The product's own crude claim-text detector is untouched and stays where it is.

## What these numbers cannot mean

- **The collapsed count is an upper bound on how many independent sources there are.** A domain with no fetched page, a page too short to characterise, and a page past the page ceiling are all counted as their own source and named in `uncheckedDomains`. Syndication among them is untested, not ruled out, and untested syndication can only ever merge more. So the gap between the two figures is a **lower** bound on how much collapsing there is.
- **A merged domain may have contributed real evidence too.** An outlet that ran both the wire copy and its own original piece merges on the strength of the wire copy alone. That understates independence, the scorer says so in its notes, and the alternative (counting stories instead of domains) would answer a different question from the raw figure it sits beside.
- **A publisher can bridge two unrelated stories into one component.** Because the merge is transitive over publishers rather than over stories, a domain carrying two different syndicated pieces joins the carriers of both, so two publishers sharing no story at all can be counted as one. Same direction as the case above: it understates independence, and it is the price of keeping the collapsed figure comparable with the raw one.
- **Two domains serving the same third-party interstitial will merge.** A shared bot-check or consent page is long enough to pass the length floor and identical across hosts, and nothing here can tell it from real syndication. Every cluster is therefore reported with its URLs and its scores rather than folded silently into a count.
- **There is deliberately no blended score.** Citation volume and citation quality are close to orthogonal in current systems and human preference tracks the former, so a blended number systematically fails to penalise the failure being measured. See [`../deep-research/benchmark-prior-art.md`](../deep-research/benchmark-prior-art.md).

## What supplies the page text

Nothing here fetches. Page text arrives already collected, exactly as recency takes publication dates already collected, which is what keeps the scorer reproducible from a stored run and keeps every test off the network.

**No component currently stores it.** The run harness records the report, the cost and the timing; the product's claim-verification tool fetches page text and keeps only whether the fetch succeeded. So this scorer is a **producer-less library today**: it is complete, tested and callable, and the durable citation snapshot it wants (canonical URL, bounded extracted text, explicit fetch status) is not yet written by anything. That contract belongs to the run harness or the citation-integrity item, and is recorded here rather than discovered later.
