# BENCH-03: citation integrity scorers

## What

Four deterministic checks over a report's citations, in increasing strength.

1. **Resolvability.** The URL returns 2xx. `src/research/citations.ts` already does this with SSRF checks and redirect validation; reuse it rather than writing a second fetcher.
2. **Registry existence.** A DOI resolved against Crossref, an arXiv id against the arXiv API, a PMID against NCBI E-utilities, an ISBN against OpenLibrary, a CVE against the NVD.
3. **Claim-token containment.** Extract the checkable tokens from the claim (numerals, percentages, proper nouns, years) and require them in the fetched page text.
4. **Anchor honesty.** A cited URL carrying a fragment must contain that anchor.

## Why this is the most valuable slice

Registry existence is exact, free hallucination detection for the canonical failure of this entire product category. A fabricated academic citation either resolves in Crossref or it does not, and no judgement is involved at any point.

## Requirements

- Every registry call is cached on disk by identifier. The same DOI appearing in 40 reports must be looked up once.
- A registry being unreachable is recorded as `unchecked`, never as `absent`. This is the single most important rule in the slice: reporting a network failure as a fabricated citation would accuse a backend of the exact thing the benchmark exists to detect.
- Rate limits respected per registry, with the polite pool conventions Crossref asks for.

## Acceptance

- A known-good DOI scores present; a well-formed but non-existent DOI scores absent; an unreachable registry scores unchecked and is excluded from the denominator.
- Token containment reports what it is, never as claim verification. A page can contain "28.6%" while saying something else entirely about it. This check is weaker than a model's judgement and it is exact, repeatable and free, which for a regression suite is the better bargain.

## Adopt DeepTRACE's dimensions rather than inventing metrics

Amended 27 July 2026 after the prior-art research. DeepTRACE (arXiv 2509.04499, ICLR 2026) specifies its dimensions at formula level and separates **accuracy from thoroughness from necessity**. That third one is the distinction this brief was missing: it catches over-citing, where a report attaches sources to everything and scores well on any metric that only asks whether cited things are real.

Report citation accuracy and citation **volume** as separate numbers, always. A backend citing a hundred sources at 80% accuracy and one citing ten at 80% are not the same product, and a single collapsed score cannot tell them apart.

Adopting published metrics also makes results comparable with everyone else's, which inventing a private set destroys.

## Where this design and the published one genuinely disagree

DeepTRACE's support check uses a model judge. This design forbids a model in the scoring loop and uses token containment instead.

Keep both, and be plain about which is which. **Containment is the default**, because it is free, exact and repeatable, and because a regression suite that costs money per run gets run once. The judged variant is available for anyone who wants the stronger check. BENCH-10 scores the two against the same labelled corpus, so the gap between them is a measurement rather than an assumption, and if containment turns out to be much weaker that is a finding worth having rather than a decision to defend.

## Non-goals

No entailment in the default path. No model in the default path.
