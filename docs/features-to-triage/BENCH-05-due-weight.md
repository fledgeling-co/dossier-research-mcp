# BENCH-05: due weight, the viewpoint-coverage scorers

## The failure being measured

A genuine minority or dissenting position is dropped because the published weight sits on the other side. Call it consensus collapse.

## Why it can be scored without a model

Because the gold set names the dissent in advance. The task author records the dissenting source's URL and its distinguishing term at authoring time; the scorer checks whether the report reached it. No judgement at scoring time.

## Three metrics

1. **Dissent recall.** Did the report cite the known dissenting source, or use its distinguishing term?
2. **Conflict acknowledgement.** For tasks where two authoritative sources give different figures, the gold carries both. Did the report contain both, or explicitly flag the disagreement? Reporting one number as settled when two exist is the failure, and the second number is a string search.
3. **False-balance guard.** A subset of tasks has a genuinely settled answer and a documented fringe claim. Surfacing the fringe claim as though it were contested is penalised.

## Why the third is not optional

Without it, the metric rewards indiscriminate hedging. A backend that presents every question as contested would score perfectly on the first two and be useless. The guard is what makes due weight mean due rather than equal.

## Acceptance

- A report citing the dissenting URL scores recall; one merely using a synonym of its term does not, and that limit is stated in the output rather than hidden.
- A backend that hedges everything scores well on dissent recall and badly overall, provable by a fixture.
