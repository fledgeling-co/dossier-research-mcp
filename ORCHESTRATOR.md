# Orchestrator: the Dossier benchmark

**Started** 27 July 2026 · **Integration branch** `main` · **Fleet size** 10 items, up to 8 concurrent

This file is the memory, not the transcript. A fresh session resumes the whole fleet from here alone. If context is compacted, re-read this file, `CLAUDE.md` and `docs/plan/benchmark.md` before doing anything else.

---

## What is being built

A benchmark that measures three separate things:

1. **Each research backend on its own.** Every CLI, every API. What each is good and bad at, per category.
2. **Dossier with no backend at all**, running the free local loop over ordinary web search. The honest control: if the keyless loop scores close to a paid backend, that is the finding.
3. **Dossier's own checking.** Whether `research_verify_citations` and `research_verify_claims` actually catch a bad citation. A detector eval, scored as a confusion matrix.

The design is `docs/plan/benchmark.md`. The briefs are `docs/features-to-triage/BENCH-*.md`.

## The rule that governs every item

**No model in the scoring loop.** Every score is computed by code from a gold set fixed before the run.

A model judge is non-deterministic, costs money per task per backend per repetition, and is circular: it uses the class of system under test to grade the system under test, so a failure mode shared by judge and subject is invisible by construction.

The cost is paid once, in task authoring. **A task is admitted only if its correct answer can be checked by a string, a number, a set membership or an HTTP request.** Any runner that finds itself reaching for a model to score something has hit the boundary of the design and must report that rather than route around it.

## How this repo differs from the pipeline's assumptions

- **No UI, so no Playwright.** This is a stdio MCP server. `acceptance-e2e` is substituted with `npm run gate` plus a protocol-level stdio smoke test: spawn `dist/index.js`, `initialize`, call the new surface, assert on the result. Two wire-level defects this session (a status compared case-sensitively, citations arriving out of band) passed unit tests and only showed up over the real protocol.
- **No DESIGN md and no mocks.** Nothing to render, so the design-language and mock-refresh stages have nothing to act on. Not a gap.
- **`CLAUDE.md` is the binding convention doc** and outranks anything general: Zod at every trust boundary, a money-spending tool says so in its description, stdout is the protocol so diagnostics go to stderr, AC rows into `docs/test-plan.md` **before** the test, a CHANGELOG entry in the same change, and no em dash in any prose.
- **`npm run gate`** is typecheck, lint, lint:source, lint:docs, test:all and build. It must pass, and the suite is run twice.

## Waves

Computed from the internal-dependency DAG. An item starts only when everything it depends on has **merged**, not merely finished.

| Wave | Items | Why together |
|---|---|---|
| 1 | BENCH-01 | The task schema is the contract every scorer reads. Nothing else can start. |
| 2 | BENCH-02, 03, 04, 05, 06, 07, 09 | All depend only on 01, and touch disjoint files. Seven concurrent. |
| 3 | BENCH-08, BENCH-10 | 08 needs the harness and the scorers; 10 needs the citation checks from 03. |

BENCH-09 is hand-authoring work and is the long pole in wall-clock terms. It starts in wave 2 and may still be running when wave 3 begins; 08 and 10 do not depend on it.

## Ledger

| ID | Title | Deps | Status | Branch | Outcome |
|---|---|---|---|---|---|
| BENCH-01 | Task format, gold-set schema and loader | none | **Running** | _(worktree pending)_ | |
| BENCH-02 | The run harness | 01 | Blocked | | |
| BENCH-03 | Citation integrity scorers | 01 | Blocked | | |
| BENCH-04 | Accuracy and relevance scorers | 01 | Blocked | | |
| BENCH-05 | Due weight, viewpoint coverage | 01 | Blocked | | |
| BENCH-06 | Calibration and refusal correctness | 01 | Blocked | | |
| BENCH-07 | Source quality and syndication | 01 | Blocked | | |
| BENCH-08 | Reporting and comparison | 02, scorers | Blocked | | |
| BENCH-09 | The seed task corpus | 01 | Blocked | | |
| BENCH-10 | Self-eval of Dossier's own checking | 01, 03 | Blocked | | |

## Context contract

Every agent, every lane, is given by path and told to read:

1. Its brief, `docs/features-to-triage/BENCH-NN-*.md`, then `docs/specs/spec-<ID>.md` and `docs/plans/plan-<ID>.md` as they come to exist.
2. **`docs/plan/benchmark.md`** in full. It carries the reasoning the briefs assume, and a runner that skips it will reinvent a decision already made.
3. **`CLAUDE.md`**, which is binding.
4. `docs/CODING_PRACTICES.md` and `docs/NEW_PROJECT_BEST_PRACTICES.md`.

**After any compaction, re-read all of the above before continuing.** The on-disk artifacts are the memory; the conversation is not.

## Shared surfaces, and the rules for them

Seven concurrent runners in wave 2 all touch three shared files. These are the collision points:

- **`docs/test-plan.md`** — every item appends AC rows. Append only, never rewrite, and never reorder another item's rows.
- **`CHANGELOG.md`** — every item adds an entry under Unreleased. Append within the section.
- **`docs/features-to-triage/LEDGER.md`** — id allocation is a read-modify-write, taken serially during pre-triage and never concurrently.

Merges are serialized by the orchestrator, one branch at a time, so conflicts in these three files are resolved at merge rather than raced in the worktrees.

## Log

- **27 Jul, preflight** — Renamed `features-for-triages` to `features-to-triage`; created `docs/specs`, `docs/plans`, `docs/deep-research`, and the ledger. `CODING_PRACTICES.md` and `NEW_PROJECT_BEST_PRACTICES.md` already present. Git clean, no `ai/*` branches, no worktrees to reconcile.
- **27 Jul, decisions** — Verification substituted (gate plus stdio smoke, no Playwright). Full fleet of ten authorised. Directory renamed to the conventional name.
- **27 Jul, pre-triage** — All ten ids claimed in one ledger write rather than allocated serially, since the briefs already carry stable ids. Removes the shared write instead of queueing behind it.
- **27 Jul, wave 1 started** — BENCH-01 dispatched to an Opus runner. Nothing else can start until it merges.
