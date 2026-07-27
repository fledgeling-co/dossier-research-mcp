# BENCH-04: accuracy and relevance scorers

## Accuracy

Normalised exact match of the report against `goldFacts`. Numbers compared with the per-fact tolerance, dates parsed and compared as dates, names matched case-insensitively after Unicode normalisation. Score is the share recovered.

## Relevance, without a judge

The naive version needs a model. The programmatic version uses what the task author recorded: `requiredTerms` a competent answer cannot avoid, and `driftTerms` indicating the answer wandered into an adjacent topic.

Score is required-term coverage minus a drift penalty. This is crude on purpose. It only has to separate an answer about the right subject from one that is not; accuracy decides whether it is correct.

## Requirements

- Number matching handles the ways models write numbers: "1.2 billion", "1,200,000,000", "1.2B". A gold fact missed on formatting is a false negative that makes every backend look worse.
- Percentages, currencies and units normalised before comparison.
- Matching is over the report's prose, not its citation URLs, or a backend that pastes a URL containing the figure scores for reasoning it never did.

## Acceptance

- The number-format cases above are a table-driven test, since this is where silent false negatives live.
- A report stating the right figure with the wrong unit scores zero for that fact, not partial credit.
