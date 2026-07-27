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
| BENCH-01 | Task format, gold-set schema and loader | [brief](BENCH-01-task-format.md) | In Review | [spec](../specs/spec-BENCH-01.md) | [plan](../plans/plan-BENCH-01.md) |
| BENCH-02 | The run harness | [brief](BENCH-02-run-harness.md) | In Review | [spec](../specs/spec-BENCH-02.md) | [plan](../plans/plan-BENCH-02.md) |
| BENCH-03 | Citation integrity scorers | [brief](BENCH-03-citation-integrity.md) | Untriaged | | |
| BENCH-04 | Accuracy and relevance scorers | [brief](BENCH-04-accuracy-relevance.md) | Ready for Plan | [spec](../specs/spec-BENCH-04.md) | |
| BENCH-05 | Due weight, viewpoint coverage | [brief](BENCH-05-due-weight.md) | Untriaged | | |
| BENCH-06 | Calibration and refusal correctness | [brief](BENCH-06-calibration-refusal.md) | In Review | [spec](../specs/spec-BENCH-06.md) | [plan](../plans/plan-BENCH-06.md) |
| BENCH-05 | Due weight, viewpoint coverage | [brief](BENCH-05-due-weight.md) | In Review | [spec](../specs/spec-BENCH-05.md) | [plan](../plans/plan-BENCH-05.md) |
| BENCH-06 | Calibration and refusal correctness | [brief](BENCH-06-calibration-refusal.md) | Untriaged | | |
| BENCH-07 | Source quality and syndication | [brief](BENCH-07-source-quality.md) | Untriaged | | |
| BENCH-08 | Reporting and comparison | [brief](BENCH-08-reporting.md) | Untriaged | | |
| BENCH-09 | The seed task corpus | [brief](BENCH-09-seed-corpus.md) | In Review | [spec](../specs/spec-BENCH-09.md) | [plan](../plans/plan-BENCH-09.md) |
| BENCH-10 | Self-eval of Dossier's own checking | [brief](BENCH-10-self-eval.md) | Untriaged | | |
| BENCH-11 | Which combination is best | [brief](BENCH-11-combinations.md) | Untriaged | | |
| BENCH-12 | A finished report is an input to the next one | [brief](BENCH-12-report-as-input.md) | Untriaged | | |
| BENCH-13 | The statistics | [brief](BENCH-13-statistics.md) | Untriaged | | |
