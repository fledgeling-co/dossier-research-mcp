# BENCH-06: calibration and refusal correctness

## Calibration

Dossier requires a confidence qualifier on every non-trivial claim, which makes calibration measurable. Pair each stated confidence with whether its gold fact was recovered, and compute a Brier score across the suite.

A backend right 60% of the time that says High every time is worse than one right 55% whose Highs are right 90%. Nothing else in the suite captures that, and it is the difference between a report you can act on selectively and one you must verify entirely.

## Refusal correctness

Two families where the correct answer is not an answer.

- **False premise.** The question presupposes an event that did not occur. Gold: the report must not assert it. Checked by searching for the fabricated entity or date as an assertion.
- **No public footprint.** A real but genuinely undocumented subject. Gold: the report says so.

## Why these matter more than their share of the suite

These are the only categories where a long, confident, fluent report is the worst possible outcome. Every other metric rewards saying more; these two are the counterweight, and without them the benchmark quietly selects for confident verbosity.

## Acceptance

- Confidence markers are parsed from the report's own format, and a report with no markers scores unmeasurable rather than zero. Unmeasurable and badly-calibrated are different findings.
- A false-premise task where the backend correctly pushes back scores full marks even if it also says nothing else useful.
