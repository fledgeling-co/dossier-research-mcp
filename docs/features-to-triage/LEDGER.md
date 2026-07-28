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
| BENCH-03 | Citation integrity scorers | [brief](BENCH-03-citation-integrity.md) | In Review | [spec](../specs/spec-BENCH-03.md) | [plan](../plans/plan-BENCH-03.md) |
| BENCH-04 | Accuracy and relevance scorers | [brief](BENCH-04-accuracy-relevance.md) | In Review | [spec](../specs/spec-BENCH-04.md) | [plan](../plans/plan-BENCH-04.md) |
| BENCH-05 | Due weight, viewpoint coverage | [brief](BENCH-05-due-weight.md) | In Review | [spec](../specs/spec-BENCH-05.md) | [plan](../plans/plan-BENCH-05.md) |
| BENCH-06 | Calibration and refusal correctness | [brief](BENCH-06-calibration-refusal.md) | In Review | [spec](../specs/spec-BENCH-06.md) | [plan](../plans/plan-BENCH-06.md) |
| BENCH-07 | Source quality and syndication | [brief](BENCH-07-source-quality.md) | In Review | [spec](../specs/spec-BENCH-07.md) | [plan](../plans/plan-BENCH-07.md) |
| BENCH-08 | Reporting and comparison | [brief](BENCH-08-reporting.md) | In Review | [spec](../specs/spec-BENCH-08.md) | [plan](../plans/plan-BENCH-08.md) |
| BENCH-09 | The seed task corpus | [brief](BENCH-09-seed-corpus.md) | In Review | [spec](../specs/spec-BENCH-09.md) | [plan](../plans/plan-BENCH-09.md) |
| BENCH-10 | Self-eval of Dossier's own checking | [brief](BENCH-10-self-eval.md) | In Review | [spec](../specs/spec-BENCH-10.md) | [plan](../plans/plan-BENCH-10.md) |
| BENCH-11 | Which combination is best | [brief](BENCH-11-combinations.md) | In Review | [spec](../specs/spec-BENCH-11.md) | [plan](../plans/plan-BENCH-11.md) |
| BENCH-12 | A finished report is an input to the next one | [brief](BENCH-12-report-as-input.md) | In Review | [spec](../specs/spec-BENCH-12.md) | [plan](../plans/plan-BENCH-12.md) |
| BENCH-13 | The statistics | [brief](BENCH-13-statistics.md) | In Review | [spec](../specs/spec-BENCH-13.md) | [plan](../plans/plan-BENCH-13.md) |
| BENCH-14 | A fresh worktree cannot run the suite | [brief](BENCH-14-worktree-tsx.md) | In Review | [spec](../specs/spec-BENCH-14.md) | [plan](../plans/plan-BENCH-14.md) |
| BENCH-15 | Three primitives now exist twice | [brief](BENCH-15-duplicate-primitives.md) | Untriaged | | |
| BENCH-16 | Nothing records when a source was published | [brief](BENCH-16-evidence-dates.md) | Untriaged | | |
| BENCH-17 | The frontier makes the strongest claim with the weakest evidence | [brief](BENCH-17-combine-floors.md) | In Review | [spec](../specs/spec-BENCH-17.md) | [plan](../plans/plan-BENCH-17.md) |
| BENCH-18 | Syndication has no Unicode normalisation | [brief](BENCH-18-syndication-unicode.md) | In Review | [spec](../specs/spec-BENCH-18.md) | [plan](../plans/plan-BENCH-18.md) |
| BENCH-19 | One entry point spends with no gate; two have no test | [brief](BENCH-19-spend-gates.md) | In Review | [spec](../specs/spec-BENCH-19.md) | [plan](../plans/plan-BENCH-19.md) |
