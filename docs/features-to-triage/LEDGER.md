# Spec ledger

One row per spec. The id is allocated here and nowhere else.

All ten ids below were claimed in a single write at fleet start, rather than
allocated one at a time during triage. The race this file normally guards
against is concurrent auto-allocation; these briefs already carry stable ids, so
claiming them up front removes the shared write instead of serialising it.

A runner that creates a *child* spec for deferred work still takes the ledger
serially, through the orchestrator.

| ID | Title | Brief | Status | Spec | Plan |
|---|---|---|---|---|---|
| BENCH-01 | Task format, gold-set schema and loader | [brief](BENCH-01-task-format.md) | Untriaged | | |
| BENCH-02 | The run harness | [brief](BENCH-02-run-harness.md) | Untriaged | | |
| BENCH-03 | Citation integrity scorers | [brief](BENCH-03-citation-integrity.md) | Untriaged | | |
| BENCH-04 | Accuracy and relevance scorers | [brief](BENCH-04-accuracy-relevance.md) | Untriaged | | |
| BENCH-05 | Due weight, viewpoint coverage | [brief](BENCH-05-due-weight.md) | Untriaged | | |
| BENCH-06 | Calibration and refusal correctness | [brief](BENCH-06-calibration-refusal.md) | Untriaged | | |
| BENCH-07 | Source quality and syndication | [brief](BENCH-07-source-quality.md) | Untriaged | | |
| BENCH-08 | Reporting and comparison | [brief](BENCH-08-reporting.md) | Untriaged | | |
| BENCH-09 | The seed task corpus | [brief](BENCH-09-seed-corpus.md) | Untriaged | | |
| BENCH-10 | Self-eval of Dossier's own checking | [brief](BENCH-10-self-eval.md) | Untriaged | | |
