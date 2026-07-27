# Benchmark briefs, awaiting triage

Ten slices of one thing: a benchmark that measures what every research backend is good and bad at, what Dossier's own free loop achieves with no backend at all, and whether Dossier's citation checking actually catches a bad citation.

The design they implement is [`../plan/benchmark.md`](../plan/benchmark.md). Read it first; it carries the reasoning these briefs assume.

**The rule that governs all ten: no model in the scoring loop.** Every score is computed by code from a gold set fixed before the run. This is not fastidiousness. A model judge is non-deterministic, costs money per task per backend per repetition, and is circular, since it uses the class of system under test to grade the system under test. A benchmark that cannot be re-run cheaply gets run once and rots.

The cost is paid once, in task authoring. A task is only admitted if its correct answer can be checked by a string, a number, a set membership or an HTTP request.

## Order

`BENCH-01` blocks everything. `BENCH-02` blocks every scorer. `BENCH-09` can be written in parallel with the scorers and is the long pole in wall-clock terms, because it is hand work.

| Brief | Depends on |
|---|---|
| BENCH-01 task format and loader | nothing |
| BENCH-02 run harness | 01 |
| BENCH-03 citation integrity | 01 |
| BENCH-04 accuracy and relevance | 01 |
| BENCH-05 due weight | 01 |
| BENCH-06 calibration and refusal | 01 |
| BENCH-07 source quality and syndication | 01 |
| BENCH-08 reporting | 02, and whichever scorers exist |
| BENCH-09 seed corpus | 01 |
| BENCH-10 self-eval of Dossier's checking | 01, 03 |
