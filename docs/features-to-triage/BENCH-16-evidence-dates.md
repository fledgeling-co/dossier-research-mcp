# BENCH-16: nothing records when a source was published

## The gap

`benchmark.md` lists recency as a scored dimension. BENCH-06 built the durability axis it needs, where a standard from 2019 is fresh and a benchmark from 2019 is stale. BENCH-08 then found it **cannot be computed at all**, and says so on every report it renders.

Neither the cell store nor BENCH-03's `PageEvidence` records a publication date. `PageEvidence` carries when a page was **checked**, which is a different fact, and approximating one from the other grades every source fresh, which is the failure the axis exists to catch.

The syndication-collapsed domain count is withheld for the same reason when no page text was compared.

## Why it is not a reporting fix

The data does not exist at the point reporting runs. Closing it means recording a publication date **at evidence-collection time**, which is BENCH-02 (the harness that stores cells) or BENCH-03 (the fetcher that already has the page in hand) rather than BENCH-08.

## What to do

Extract a publication date when a page is fetched, and persist it with the evidence. Then unwithhold recency in the report.

The extraction is the hard part and it is worth being honest about: a publication date can come from a `<meta>` tag, JSON-LD, an Open Graph property, a `<time>` element, a URL path segment, or nowhere at all. **Where it cannot be found, record that it could not be found.** A missing date must not become a guessed one, and a source with no date is a different finding from a source that is old.

## Acceptance

- A fetched page's publication date, or an explicit absence, is persisted with its evidence.
- The report stops withholding recency, and instead reports the share of sources whose date could not be established.
- A source with no discoverable date never scores as fresh.
