# BENCH-01: Task format, gold-set schema and loader

**ID:** BENCH-01
**Status:** In Review
**Created:** 2026-07-27
**Last updated:** 2026-07-27
**Brief:** [BENCH-01](../features-to-triage/BENCH-01-task-format.md) · **Design of record:** [benchmark.md](../plan/benchmark.md)

## Feature description

*(Verbatim from `docs/features-to-triage/BENCH-01-task-format.md`.)*

# BENCH-01: task format, gold-set schema and loader

## What

A YAML file per task under `bench/tasks/`, parsed by Zod into a typed corpus. The schema is the contract every scorer reads and every task author writes against.

## Why this first

Everything else depends on the shape. Getting it wrong is expensive later, because the seed corpus in BENCH-09 is a hundred hand-authored files and reshaping them is hand work again.

## Fields

- `id`, `category`, `question`
- `asOf`: the date the gold was true
- `reverifiedAt`: when a human last checked it, which is not the same date and must not be collapsed into it
- `goldFacts[]`: `{ value, kind: number|date|name|identifier, tolerance?, source }`
- `requiredTerms[]` and `driftTerms[]` for relevance
- `knownDissent[]`: `{ url, distinguishingTerm }` for due weight
- `conflictingFigures[]`: two or more authoritative values for the same quantity
- `expectedRefusal`: for false-premise and no-public-footprint tasks
- `fringeClaims[]`: the false-balance counterweight

## Acceptance

- A malformed task file fails loudly at load with the file named, never silently skipped. A corpus that quietly drops tasks reports a score over a sample nobody chose.
- A task whose `reverifiedAt` is older than six months loads but is marked `stale`, and every downstream report shows the stale count. Gold rots: a revenue figure is correct until the next filing.
- Every `goldFact` of kind `number` either carries a tolerance or is rejected. Comparing floats exactly is how a correct answer scores zero.
- The loader is pure and synchronous, so scorers can be tested without a filesystem.

## Non-goals

No scoring here. No network. This slice reads files and returns types.

### Fleet context carried with the brief

- The governing rule for the whole benchmark: **no model in the scoring loop.** Every score is computed by code from a gold set fixed before the run. The task format must be expressive enough that accuracy, relevance, due weight, calibration and refusal can all be checked mechanically from what a task author records.
- A category in `docs/plan/benchmark.md` that the format cannot express without a model at scoring time is a design problem to report, not to route around.

---

## Triage — 2026-07-27

**Ready for Implementation Plan**

**Sentinel review:** S1 — Approve with assumptions

*(No UI preview section: this repo has no user interface and no design system. Nothing customer-facing changes; the whole item is behind the scenes.)*

**Where it shows up**
- Nothing customer-facing changes. Nothing a person using the research product will see, at all.
- The people affected are the ones who will hand-write the benchmark's hundred task files, and the nine scoring items that read them.

**Behaviour changes**
- A new, checked format for a benchmark task: the question, the answers a correct report must contain, the date each answer was true, and the date a human last confirmed it.
- Reading a set of task files either succeeds completely or fails completely, naming every file it rejected. Nothing is ever quietly dropped.
- A task whose answers have not been re-confirmed in the last six months still loads, but is flagged **stale**, and the count of stale tasks travels with the set so every later report can show it. This item is accepted on the count being carried; showing it belongs to the reporting item. The word is `stale` throughout, matching the brief and the design document, so nothing downstream has to translate a second vocabulary.

**Assumptions**

- `[Data & scope]` One bad task file fails the whole load, listing every bad file at once (rather than stopping at the first). *(a hundred hand-written files; one report beats a hundred rounds.)*
- `[Data & scope]` Staleness is measured as 183 days, written as a named constant. *(six months with no month-length edge cases; the same number the product already uses for six months.)*
- `[Data & scope]` An answer's kind decides what else it must carry, so a numeric answer is impossible to write without a tolerance. *(makes the acceptance rule structural, not a later check.)*
- `[Data & scope]` A tolerance is stated as exact, plus-or-minus, a fraction, or significant figures. *(covers the cases the design names; a fraction and a percentage are named differently so they cannot be confused.)*
- `[Data & scope]` Numeric answers must record their unit, or say `dimensionless`. *(a right figure in the wrong unit must score zero, which needs the right unit written down.)*
- `[Data & scope]` Every answer carries an identifier unique inside its task. *(the only thing a confidence marker can be paired against, and the only stable way to re-score a stored result later.)*
- `[Data & scope]` A source is a link, optionally with the sentence it came from and where in the document. *(the corpus item must confirm each answer is really present in its cited source.)*
- `[Data & scope]` Name and identifier answers may record other acceptable wordings. *(a right answer missed on wording makes every backend look worse.)*
- `[Data & scope]` A task may declare a grid of things by properties and tag its answers with the cell each belongs to; cells expected to be unknown are declared. *(the enumeration category is a grid, and a flat list cannot carry one.)*
- `[Data & scope]` A fringe claim may record the wording that shows a report is rejecting it. *(otherwise mentioning a fringe claim to dismiss it is indistinguishable from presenting it as contested.)*
- `[Operations]` Each loaded task reports which measures it can support, derived from what it records. *(four later items would otherwise each re-derive the same rule.)*
- `[Data & scope]` A misspelt or unknown field is rejected, not ignored. *(a silently ignored typo is a task scored on less than its author wrote.)*
- `[Data & scope]` Two tasks sharing an identifier fail the load. *(hand-written files; a duplicate would silently halve a category.)*
- `[Data & scope]` A task carries one to ten answers unless it expects a refusal, in which case it may carry none. *(matches the stated design, rather than leaving the count open.)*
- `[Data & scope]` The ten-answer ceiling applies to a task without a grid. A task that declares a grid may carry up to two hundred answers, one per cell. *(a three-by-four grid is already twelve cells, so a flat ten would make the completeness category unable to test completeness; stated openly because it widens a number the design document gives as one to ten.)*
- `[Data & scope]` A task's category must match what it records: a false-premise task carries the fabricated wording, a contested one carries its dissent or its clashing figures, a settled-with-fringe one carries its fringe claim. *(a task that cannot be scored in its own category would otherwise drag that category down silently.)*
- `[Data & scope]` A task may record the time window its question should be asked over. *(two of the ten categories are defined by that window; nothing else can carry it.)*
- `[Operations]` The reference date for ageing is supplied by the caller, never read from the clock inside. *(keeps loading repeatable, so the same set scores the same twice.)*
- `[Operations]` An empty set of task files loads as an empty set rather than failing. *(refusing to score too small a sample is already the reporting item's job.)*
- `[Experience]` No task files are authored here beyond test material. *(the corpus is its own item; authoring here would pre-empt it.)*
- `[Experience]` The date a human last checked an answer may not be in the future; the date the answer was true is left unconstrained. *(a check cannot have happened yet; a rule that applies from a future date legitimately can.)*

*If any of these are wrong, edit it inline (or correct an assumption) in this file and re-run `/triage BENCH-01` before the planner picks this up.*

**Findings carried to the planner**

- *Medium, Engineering Readiness.* Calibration is the thinnest of the five mechanical paths. Pairing a stated confidence with the specific answer it was about is a matching rule, and that rule belongs to the calibration item, not here. What this item can do is give every answer an optional human-readable label so the pairing has something to key on, and record the answer's own written form so a match can be attempted by proximity. Recorded so the calibration item does not discover the gap late.
- *Medium, Engineering Readiness.* The design document caps a task at ten answers, and a grid of things by properties breaks that cap on contact: three things across four properties is already twelve cells. The cap is therefore kept for a task without a grid and widened for one with a grid. This is a deliberate, stated widening of a number the design document gives flatly, recorded here so nobody discovers it as a surprise while hand-writing the corpus.
- *Low, Operational.* Recording a question's time window is request shaping sitting inside a set of scoring fields — a mild mixing of two concerns. Kept because two of the ten categories are defined by that window and there is nowhere else to put it; the field is documented as read by the run harness and by no scorer.

**Codex cross-family spec review — 2026-07-27**

Reviewer: `gpt-5.6-sol` at `max` effort, read-only, grounded in the repository. Verdict as returned: **MATERIAL DEFECTS**, 19 findings. Every one is dispositioned below. Nine were accepted and changed the format before the status flipped; three were verified against the code and accepted as findings that belong to other items; the rest were rejected as scope this item does not own, and are carried to the fleet log rather than dropped.

Accepted, and the format changed for it:

1. *Numbers need a unit or the wrong-unit rule cannot bite.* A numeric answer now must state its unit, with `dimensionless` as the explicit way to say it has none. A right figure in the wrong unit can only score zero if the right unit was written down.
2. *An answer needs a stable name.* Every answer now carries an identifier that is unique inside its task. Without one, an answer is only "the third one", which changes meaning the moment somebody inserts an answer above it, and a result stored today cannot be re-scored in six months. It is also the only thing a confidence marker can be paired against.
3. *Where an answer came from needs more than a link.* A source is now a link plus, optionally, the sentence it was taken from and where in the document it sits. The corpus item's own acceptance says a scripted pass must confirm each answer is really present in its cited source; a bare link cannot support that.
4. *Names have more than one surface form.* Name and identifier answers may record the other forms a correct report might legitimately use. A right answer missed on wording is a false negative that makes every backend look worse, which the accuracy item explicitly warns against.
5. *Refusing needs a positive signal, not only the absence of a wrong one.* Both refusal kinds now require the wording that shows the report pushed back. Checking only that a fabricated name is absent cannot tell a report that asserted it from one that corrected it, because both contain the name.
6. *A settled question with a fringe claim was not scoreable at all.* Mentioning a fringe claim in order to reject it looked identical to presenting it as contested. A task may now record the wording that marks a rejection, which turns the check into something a string search can decide.
7. *Enumeration could not be expressed.* A flat list of one to ten answers cannot carry a grid of things by properties, nor a cell a task deliberately expects to be unknown, which is the whole of what that category tests. A task may now declare its grid and tag each answer with the cell it belongs to, and cells expected to be unknown are declared explicitly.
8. *Which measures apply to a task was left to each reader.* Each loaded task now reports which measures it can support, worked out from what it actually records. Four later items would otherwise each re-derive that rule, and two implementations of a rule eventually disagree about what the rule is.
9. *The boundary was unbounded.* Every piece of text and every list now has a stated maximum, dates are a fixed format compared as whole days in UTC, and an oversized file is refused.

Accepted as real, and belonging to another item. Each was checked against the code before being written down:

- *Repetitions would silently collapse into one.* The identity a run is deduplicated by carries no repetition number, so asking the same question of the same backend five times is charged once and answered once. Every spread in the whole benchmark would then be measured over a single sample. Verified. Belongs to the run harness item.
- *The source-quality item names the wrong existing function.* The one it names only separates a person's own documents from public ones; the one that actually counts independent sources is a different function. Verified. Belongs to the source-quality item.
- *The recency rule the design says already exists does not.* Ageing is graded by broad source kind, and nothing distinguishes a nine-year-old standard, which is current, from a nine-year-old benchmark, which is not. Verified. No item in the fleet owns recency at all.

Rejected for this item, with reasons, and carried to the fleet log:

- *Make the run harness exclude ageing tasks before spending.* This contradicts the brief, which requires an ageing task to load and be counted. The disagreement is real and sits between the design document and two other items, so it is reported rather than settled here.
- *Define the confidence-to-probability table and the pairing rule now.* That is the calibration item's rule, not a recorded field. What this item owes it is the stable answer identifier, which is now delivered.
- *Define how a claim is tied to the citation next to it.* Belongs to the citation item; nothing a task author writes affects it.
- *Give the detector corpus a shape.* That corpus is a different format in a different item, and its own brief already says so.
- *Record what a run actually cost as opposed to what was reserved.* Belongs to the run harness and the reporting item.
- *Detect a negated answer.* A report saying a figure was not the answer still contains the figure. Real, and it is a matching rule inside the accuracy item; no field here changes it.
- *Fix the vague test wording in two other items.* Theirs to fix.

*If any of these dispositions are wrong, edit them inline here and re-run `/triage BENCH-01`.*

**Assumptions review gate — 2026-07-27**

A fresh reviewer, not the one that wrote the assumptions, checked every default against the brief, the design document and the fleet's own record. Twenty of twenty-two passed. Two were sent back and both were fixed here rather than raised as questions, because both were settleable from the governing documents: the ceiling on how many answers a task may carry had to say what happens to a grid, and the word for an out-of-date task had to be the one the brief and the design document already use rather than a second synonym. Gate re-checked against those two points and passed.

## Plan — 2026-07-27

Implementation plan: [`docs/plans/plan-BENCH-01.md`](../plans/plan-BENCH-01.md) (Plan size: Standard).

## Progress — 2026-07-27

**Implementation Complete (local branch, not merged, not pushed)**

**Summary:** `bench/` now exists as a second source tree holding the benchmark's task format: a Zod schema for one hand-authored YAML task, a pure synchronous loader over file contents, and a thin synchronous filesystem adapter. Nothing scores anything and nothing touches the network.

**Branch:** `ai/bench-01` (local, based on `main`, **not rebased and not merged by instruction**; worktree `.worktrees/BENCH-01`). Two commits: `0a5237a` the implementation, `66eef71` the defects the cross-family critic found.

**Built by slice:**
- Gate wiring: `tsconfig.json`, `vitest.config.ts`, `scripts/check-source-hygiene.mjs`, `package.json` (adds `yaml` as a **dev** dependency; `build` now clears `dist/` first).
- `bench/src/tasks/schema.ts`: the ten categories, the gold-fact and tolerance and refusal unions, the source shape, the grid, and nine cross-field rules.
- `bench/src/tasks/corpus.ts`: the pure loader, `TaskCorpusError`, staleness, derived metric applicability. Imports no filesystem.
- `bench/src/tasks/files.ts`: the only disk reader. Explicit sorted walk, symlinks never followed.
- `bench/src/tasks/index.ts`: the barrel wave 2 imports.
- Tests: 130 across three files, traced to `TASKFMT-01` through `TASKFMT-38` in `docs/test-plan.md`.
- Docs: `docs/bench/task-format.md`, plus the `bench/` entry in `CLAUDE.md` and a CHANGELOG entry.

**Rebase:** deliberately **not** performed. `main` advanced by four commits while this ran (`fb3e018`, `0d8544b`, `9e0312b`, `936f0db`), including an amendment to `docs/plan/benchmark.md` and to the BENCH-02, BENCH-03 and BENCH-09 briefs. The orchestrator serialises merges, so the reconciliation is its call, not this runner's. One amendment was acted on here rather than deferred: see the `topic` field below.

**Reachability:** BENCH-01 adds **no MCP surface and no user-facing capability**, so there is no UI hop to trace. Its in-product consumers are the nine items it blocks, none of which exists yet. The exported surface is declared **producer-less by design** rather than counted as delivered. What is wired today: `schema.ts` into `corpus.ts` into `files.ts`, each exercised by a test that runs the real code, plus a real-Node out-of-transform run through the barrel.

**Clause coverage:** every plan acceptance criterion is ticked in `docs/plans/plan-BENCH-01.md` and carries a named test. The three partials declared mid-review (rejection cues untested, the window field untested, only a sample of caps tested) were closed, not deferred.

**Acceptance review:** the Codex `gpt-5.6-sol` critic at `max` effort, read-only, returned 5 seeded items over the audit; every one was investigated and 4 became confirmed defects, all fixed in `66eef71`. Two were real holes in the format (a conflicting figure could carry a grid cell tag that no rule checked; an untagged answer on a grid task was silently accepted). Two more were found by exercising rather than reading (the directory walk followed symlinks out of the corpus, verified by building one; an Invalid Date reference silently disabled the future-date rule). The fifth, that the no-filesystem check was a regex weak enough to pass after a dynamic import was added, was also real and is fixed. No Critical, High or Medium finding remains open.

**Implementation assumptions:**
- The integration branch is **local `main`**, not `origin/main`, which is ten commits behind it. Branching from `origin/main` would have cut this work off from the fleet's own setup commits.
- The spec, plan and ledger are committed **on the branch** rather than left uncommitted in the main tree, because this repo tracks them and an external commit swept a mid-progress copy of them onto `main` while this ran. The branch therefore carries the authoritative versions.
- `bench/tasks/` ships holding only `.gitkeep`. Authoring the corpus is BENCH-09 and doing it here would pre-empt it.

**Dropped or changed vs spec/plan:** none dropped. One field added beyond the plan: `topic`, an optional clustering slug, added because `docs/plan/benchmark.md` was amended after this branch was cut to require clustered standard errors, and the cluster key has no other home. Recorded here rather than folded in silently.

**Gates (actually run, on the final tree):**
- `npm run gate` exit 0, **twice consecutively**: typecheck, lint, lint:source, lint:docs, test:all, build. 32 test files, 801 passed, 2 skipped, identical both runs.
- `npm pack --dry-run`: zero `bench/` and zero `dist/bench/` entries.
- Real-Node out-of-transform run via `tsx` through the barrel: loads a corpus, keeps `asOf` a string, computes staleness, reports the symlink as ignored without reading it, refuses an invalid reference date, and names the file on a malformed task.
- stdio smoke against `dist/index.js`: initialize ok, `tools/list` returns 36 tools, zero non-JSON lines on stdout. A regression check, since this item adds no MCP surface.

**Codex lane:** spec review (R1, `max`, read-only): MATERIAL DEFECTS, 19 findings, 9 accepted and folded into the format, 3 accepted as belonging to other items, 7 rejected with reasons. Plan review (R1, `max`): MATERIAL DEFECTS, 14 findings, all 14 accepted. Completeness critic (R2, `max`): 5 seed items, 4 confirmed as defects and fixed. No downgrade: the lane was available for all three.
