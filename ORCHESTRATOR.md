# Orchestrator: the Dossier benchmark

**Started** 27 July 2026 · **Integration branch** `main` · **Fleet size** 19 items, up to 8 concurrent

This file is the memory, not the transcript. A fresh session resumes the whole fleet from here alone. If context is compacted, re-read this file, `CLAUDE.md` and `docs/plan/benchmark.md` before doing anything else.

---

## What is being built

A benchmark that measures three separate things:

1. **Each research backend on its own.** Every CLI, every API. What each is good and bad at, per category.
2. **Dossier with no backend at all**, running the free local loop over ordinary web search. The honest control: if the keyless loop scores close to a paid backend, that is the finding.
3. **Dossier's own checking.** Whether `research_verify_citations` and `research_verify_claims` actually catch a bad citation. A detector eval, scored as a confusion matrix.
4. **Which combination of them is worth its price.** Backends, methods and lanes are scored in every subset, and the answer is a Pareto frontier per category rather than one global winner.

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
| 3 | BENCH-08, BENCH-10, BENCH-11, BENCH-13 | 08 needs the harness and the scorers; 10 needs the citation checks from 03; 11 merges stored results and needs both. |

BENCH-09 is hand-authoring work and is the long pole in wall-clock terms. It starts in wave 2 and may still be running when wave 3 begins; 08 and 10 do not depend on it.

## Ledger

| ID | Title | Deps | Status | Branch | Outcome |
|---|---|---|---|---|---|
| BENCH-01 | Task format, gold-set schema and loader | none | **Merged** | `ai/bench-01` | 853 tests green; found 4 cross-brief defects |
| BENCH-02 | The run harness | 01 | **Merged** | `ai/bench-02` | 1072 tests; adoption split on evidence |
| BENCH-03 | Citation integrity scorers | 01 | **Merged** | `ai/bench-03` | 1674 tests; falsified the registry claim |
| BENCH-04 | Accuracy and relevance scorers | 01 | **Merged** | `ai/bench-04` | accuracy and relevance |
| BENCH-05 | Due weight, viewpoint coverage | 01 | **Merged** | `ai/bench-05` | 11 defects found and fixed |
| BENCH-06 | Calibration and refusal correctness | 01 | **Merged** | `ai/bench-06` | 954 tests; took recency, found a product bug |
| BENCH-07 | Source quality and syndication | 01 | **Merged** | `ai/bench-07` | syndication, 12 critic defects |
| BENCH-08 | Reporting and comparison | 02, scorers | **Merged** | `ai/bench-08` | 1863 tests; found its own defect twice |
| BENCH-09 | The seed task corpus | 01 | **Merged** | `ai/bench-09` | 1001 tests; 7 admitted, 20 quarantined, $0 spent |
| BENCH-10 | Self-eval of Dossier's own checking | 01, 03 | **Merged** | see log | |
| BENCH-11 | Which combination is best | 02, scorers | **Merged** | see log | |
| BENCH-12 | A finished report is an input to the next one | none | **Merged** | `ai/bench-12` | 1717 tests; ships `research_ground` |
| BENCH-13 | The statistics | 02, 08 | **Merged** | `ai/bench-13` | 2209 tests; 180 comparisons, 0 runnable | |
| BENCH-14 | A fresh worktree cannot run the suite | none | **Merged** | `ai/bench-14` | 14 pass in a bare worktree, was 11 failing | deferred child, from BENCH-11 |
| BENCH-15 | Three primitives now exist twice | 04, 05, 11 | Queued | | deferred child, from BENCH-04/05/11 |
| BENCH-16 | Nothing records when a source was published | 02, 03 | Queued | | deferred child, from BENCH-08 |
| BENCH-17 | The frontier claims most on least evidence | 08, 11, 13 | **Running** | | from the audit |
| BENCH-18 | Syndication has no Unicode normalisation | 07 | **Running** | | from the audit |
| BENCH-19 | A spend gate missing, two entries untested | 09, 10, 14 | **Running** | | from the audit |

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
- **27 Jul, BENCH-11 added** — Combination scoring. It costs nothing extra to run: BENCH-02 stores every cell raw, so all 2^N subsets are evaluated by merging reports already paid for. This is the payoff from separating the run from the scoring, and it is what will replace the 27 July routing retune that currently rests on a single observation of 4% overlap.
- **27 Jul, BENCH-12 added** — Not a benchmark slice. A finished report cannot currently ground the next run without a manual export and upload, so Dossier's own output is the one evidence it cannot easily consume. From Bridgewater's Pocket Analyst, whose outputs land in the same store as its inputs. Carries a hard constraint: a prior report is a user's own document, valid primary evidence about what was concluded and never independent evidence the conclusion was right.
- **27 Jul, prior art read and acted on** — The benchmark-design panel finished; three CLI members completed, `local-codex` failed on the argument-parsing bug. 49 sources, 48 resolve, and I verified DeepTRACE and promptfoo exist directly rather than trusting the report. Exported to `docs/deep-research/benchmark-prior-art.md`, which every benchmark runner must now read in full.

  It reversed two decisions. **BENCH-02 is now an adoption, not a build**: promptfoo already is a TypeScript multi-provider harness with custom JavaScript scorers, and building a runner, provider abstraction and result store is months of undifferentiated work. **BENCH-03 adopts DeepTRACE's published dimensions** instead of metrics I invented, in particular the accuracy-versus-thoroughness-versus-necessity split that catches over-citing.

  **BENCH-13 is new and covers what the design had none of: statistics.** Paired-difference tests with bootstrap intervals, standard errors clustered on category (naive errors inflate up to threefold on a corpus of ten categories of ten related tasks, which is exactly this one), `pass^k` beside `pass@1`, and completion rate as a validity metric. That last one is not hypothetical here: `local-codex` is 0-for-3 and `openai` 0-for-2 in this repo's own ledger, and both would have silently vanished from a naive average.
- **27 Jul, BENCH-01 merged** — 853 tests green, gate run twice on the rebased branch and again on main. Its out-of-family critic found four real bugs in its own code, two only by exercising, including a directory walk that followed symlinks out of the corpus. The source-hygiene lint caught a NUL byte it had introduced, which is the exact v0.2.1 defect that lint exists for.

  It also verified four defects outside its own scope, now recorded in the owning briefs: repetition dedupe collapses `n=5` onto one paid run and would silently make every spread a single sample (BENCH-02); BENCH-07 named the wrong function for domain counting; recency is a scored dimension nobody owns and the rule it assumes does not exist (BENCH-06); and `benchmark.md` and BENCH-01 contradict each other on whether a stale task is scored.
- **27 Jul, Codex and spend fixes merged** — `local-codex` was 0-for-3 on an invalid `--search` flag, and two OpenAI runs cost $18 to fail on 429s that asked to be retried in about a second. Both fixed. `research_doctor` now argv-tests every adapter on the default path, since the check that finds this bug class was worthless behind a flag nobody sets.
- **27 Jul, wave 2 dispatched** — Seven runners: BENCH-02, 03, 04, 05, 06, 07 and 09, all unblocked by the BENCH-01 merge. Each carries the defects BENCH-01 verified in its area, so nobody rediscovers them: 02 fixes the repetition dedupe and settles the stale-task contradiction, 06 inherits recency as an orphan whose assumed rule does not exist, 07 gets the corrected function name.

  Merges stay serialized here. All seven will touch `docs/test-plan.md` and `CHANGELOG.md`, which is expected and is why they append rather than rewrite; conflicts are resolved at merge, one branch at a time, not raced in the worktrees.

## Concurrency limit, learned the hard way

**Seven concurrent Opus runners exhausted the account binding.** All seven died within minutes on `503 all-accounts-exhausted`, a capacity error rather than a fault in any of them. The ship-fleet skill permits eight slots; this account does not sustain seven.

**Resume and dispatch in batches of three.** That is the operating limit for this repo until something says otherwise.

Nothing was lost, but the cost was real: four worktrees held uncommitted source and no branch had a single commit, so a restart meant re-deriving work already done. Every resumed runner is now told to **commit early**. An uncommitted worktree is exactly what a capacity error takes.

- **27 Jul, wave 2 died and was resumed in batches** — All seven failed on capacity. Six specs and three plans survived on disk, and four worktrees held uncommitted source. Resumed BENCH-02, 06 and 09 first, being the three furthest along and therefore with the most at risk. BENCH-03, 04, 05 and 07 are paused pending a free batch. BENCH-03 reported before dying that Codex registry probes gave three findings that change its design, which is worth collecting when it resumes.
- **27 Jul, BENCH-05 resumed** — Four concurrent now rather than three. Its spec, plan and scorers were all untracked in the worktree with zero commits, so a second capacity error would have taken them; told to commit before continuing. The other three had two and three commits each by then, so the commit-early instruction is working.
- **27 Jul, BENCH-06 merged** — 954 tests green, gate twice. It closed the recency orphan rather than re-parking it, and built the durability axis the design assumed already existed. Its parity test drives the benchmark's copy and the product's `assessStaleness` side by side so the restatement cannot drift.

  It found a bug in the **product** doing so: `assessStaleness` compared a rounded day count, and `Math.round(-0.4)` is `-0` while `-0 < 0` is false, so a source stamped up to twelve hours after the as-of date was graded fresh. Fixed here, with a test proven to fail against the old check. This is the argument for building a second implementation of a rule and diffing it against the first.

  Its own reviewer found that a refusal test **locked the defect in**: a report was scored as correctly refusing whenever acknowledgement wording appeared anywhere, even with another paragraph asserting the fabrication outright with a date and venue. The test was rewritten. No Codex lane was available, so the out-of-family critic is a logged downgrade to an independent Opus reviewer with fresh context.
- **27 Jul, BENCH-09 merged** — 1001 tests green. **7 tasks admitted, 20 quarantined**, and the quarantine is the result worth having. It authored 27, verified every gold fact against a live source, then applied the fail-first rule and it rejected most of its own work.

  The finding: all 27 were anchored on immutable post-cutoff events, and closed-book none were answerable from weights, so the anchoring worked. Search-enabled, **Claude Code already passed 23 of 27**. A single primary source at a stable URL is a lookup, not research. Two shapes survived, and they are what the next batch is built from: answers that are an absence, and fabricated premises. Neither is retrievable from one document because there is no document to retrieve.

  It spent **$0**: every fail-check ran on free CLI backends, ~65 `claude -p` and 23 `codex exec`, and no paid backend was run against the corpus.

  Two categories are empty and were not padded: social-sentiment needs live X access to establish gold, and settled-with-fringe needs a documented fringe claim on a settled question, which means citing a source published to mislead.
- **27 Jul, BENCH-02 merged** — 1072 tests green. It **tested promptfoo instead of adopting it on the report's word**, which is the whole reason to send a runner rather than act on research directly. Three of four claims held; `--resume` does not work: against a fully completed four-cell eval with nothing killed, it printed "skipping 4 previously completed cases" and then called the provider four more times, leaving eight rows on four coordinates. There is also no budget gate and no extension point where one could live, since a provider and an assertion are both called per cell after the batch has started.

  So the adoption was split where the evidence splits it: promptfoo's scorer contract is adopted exactly, and the execution shell is built here, because the two missing pieces are the control loop. The dependency is not added.

  The repetition-dedupe fix needed two further fixes to actually work, both found by an out-of-family Codex review rather than by the runner: the repeat index was appended to a space-joined canonical string, so `wideSpec: "foo"` with repeat 7 hashed identically to `wideSpec: "foo repeat:7"` with none, and `runner.ts` threaded it through a truthiness test where `NaN` is falsy. The review found eight defects in total, including one the runner's own fix had introduced, and **one of the runner's tests asserted the opposite of what it proved**.

  Stale-task contradiction resolved: a stale task loads, is scored, and is counted stale. The rule now lives in one place with a dated amendment pointing at it rather than a silent edit.
- **27 Jul, the paused three resumed** — BENCH-03, 04 and 07, making four concurrent with BENCH-05. Each was told which four items merged under it and what to read before designing, since all three branched before `bench/src/score/` and `bench/src/run/` existed and a parallel tree would conflict at merge.

  BENCH-03 carries the one real risk: its only surviving artefact is a spec, and its last words before dying were that Codex registry probes had given **three findings that change the design**, which exist nowhere on disk. It has been told to recover or re-derive them before proceeding rather than continue as though the design were unchanged.
- **27 Jul, wave 2 complete** — BENCH-03, 04, 05 and 07 merged. **1674 tests green.** Two things worth carrying forward.

  BENCH-03 **falsified a claim in the design**. I had called registry existence checking exact, free hallucination detection with no judgement involved. It probed all five registries live: Crossref alone would call a genuine DOI fabricated, since it is one registration agency among several and a real Zenodo DOI is a Crossref 404; OpenLibrary answers found for a fabricated ISBN; arXiv rate-limited every probe across seven minutes. The design is corrected in place with a date, and the overclaim left visible because it is more instructive than the correction. What survives is narrower and real: an identifier the owning registry positively denies is strong evidence of fabrication, everything else is `unchecked`.

  A **name collision nearly shipped through my own merge resolution**. BENCH-07 and BENCH-03 both exported `containment`, over different objects, and my keep-both conflict resolution put both in one barrel under one name. Typecheck caught it; it is now `shingleContainment` and `tokenContainment`. Append-only merges are safe for prose and not for exports.

- **27 Jul, wave 3 dispatched** — BENCH-08, 10, 11 and 12. Four concurrent, the level that has held. BENCH-12 is the only one that changes shipped code rather than `bench/`, so it carries the CP §7 review and the third-party egress rules.
- **27 Jul, BENCH-12 merged** — 1717 tests green. It is the only fleet item that changes shipped code, and it adds `research_ground`, so Dossier's own output can finally ground the next run without a manual export and upload.

  The corroboration rule holds where it had to: a prior report is addressed `dossier://run/<id>`, `classifySource` detects it without being told and returns `private-user-owned`, and `assessSupport` excludes it from the domain count. A grounded run declares it in every read mode and in the exported front matter, so a reader can tell accumulated evidence from an echo.

  It found a real defect on the way: `research_plan` and `research_start` normalised grounding differently, so `[RUN, RUN]` priced a two-run grounding and started a one-run one, and the contract handshake then refused a request nobody had changed. The test for it was checked in both directions and fails against the pre-fix code.

  No Codex lane was available, so every reviewer on this item was Claude reviewing Claude, logged as a downgrade rather than passed off.

## The capacity limit, measured twice

Seven concurrent runners exhausted the account binding. Four then ran for hours without trouble and all four finished. Four later failed together. **So it is not a clean count threshold; the account's capacity varies through the day**, and any number can fail.

What actually bounds the cost is not the concurrency number, it is **committing early**. The first failure took four worktrees with zero commits between them and cost hours of re-derivation. The second took three worktrees holding 11, 9 and 5 commits and cost minutes. Every runner prompt now says so, and the difference between the two waves is the whole argument.

- **28 Jul, wave 3 resumed** — BENCH-08, 10 and 11, all three killed by capacity mid-flight and all three cheap to resume. BENCH-08 reported two review findings before dying, one of which is that its own matrix can print a confident-looking spread from single runs. That is the exact failure the slice exists to prevent, found in its own output, and it has been told to recover both findings before continuing.
- **28 Jul, BENCH-08 merged** — 1863 tests green. **The failure it exists to prevent appeared twice in its own output, and the second instance was only caught on review.**

  Two-stage aggregation, repetitions within a task then tasks within a category, has a hole: a backend run *once* per task across six tasks still produces a genuine six-task spread, so a naive "does this figure have a spread" check would have ranked a set of single runs. Fixed by carrying the repetition count up from stage one and testing it over the **weakest** task rather than the average. Then the same defect reappeared in rendering: with the ranking correctly withheld, the matrix still printed `74.5% [68.3%-80.8%] (n=6)`, which reads as run-to-run variance and is not.

  Two more worth naming. **Total spend was a median times a count rather than a sum**, wrong whenever cell costs differ and the one number nobody should have to check. And a malformed `--as-of` like `2026-02-31` parsed happily into 3 March, silently moving every staleness answer.

  **A real pipeline gap, needing an owner:** recency is permanently unavailable and says so on every report. The durability axis BENCH-06 built needs a publication date per source, and neither the cell store nor BENCH-03's `PageEvidence` records one; `PageEvidence` carries when a page was *checked*, which is not the same thing. Approximating from fetch time would grade every source fresh. Closing it means recording a publication date at evidence-collection time, which is BENCH-02 or BENCH-03 territory rather than a reporting fix.

  BENCH-13 is unblocked by this merge.
- **28 Jul, BENCH-10 and BENCH-11 merged; three deferred children added.** Twelve of thirteen original items are in. The fleet's own runners surfaced work that needs an owner, and it now has ledger rows rather than living in a report nobody reads twice.

  **BENCH-10 measured what this design costs.** Containment passed 11 of 23 bad citations as supporting where the judged pass let none through, and the cause is structural rather than tunable: a contradiction states the opposite of a page using that page's own numbers. That number is now in the product's tool description, because the design forbade a model in the scoring loop precisely so this could be measured rather than argued about. From the same corpus, 22 of 30 pages resolve HTTP 200 and do not support the claim attached to them, so reading a green link as a sound citation scores identically to answering "supports" to everything.

  **BENCH-11 found a shipped defect** by building a second consumer of `mergeEvidence`, which labelled provenance with the first six characters of a run id. Two ids sharing that prefix collapsed into one label and overlap then reported zero however much the runs shared. Its Codex review also caught `canonicaliseUrl` folding `http` and `https` together, understating overlap in the direction that flatters a combination.
- **28 Jul, BENCH-14 merged** — A fresh worktree now runs the suite. Verified where it matters: a worktree under `.worktrees/` with no `node_modules` of its own goes from 11 failing to **14 passing, zero skipped**.

  It corrected the acceptance criterion I wrote rather than working around it. My check used `/tmp`, where no ancestor holds a `node_modules` at all, so `tsgo`, `eslint` and `vitest` are absent and the gate dies before reaching a test. That case is not fixable here and the runner said so instead of claiming it.

  **It also refused to remove the last subprocess, for the right reason.** Nine of the ten cases became in-process calls, but making the entry point importable means guarding the top-level `await main()`, and a guard that silently stops firing makes `npm run bench:detector` print nothing and exit zero while every in-process test stays green. That is the `reading.ts` defect this repo shipped a day earlier, and the fix would have recreated it. One case still spawns, resolving tsx through Node's own resolution, and skips with a named reason if that fails.

  Swept the tree for the same habit: exactly one instance existed. The other three gate-running spawns use `npx tsx`, which already walks ancestors, proven by the baseline where only one file failed.

  **Flagged, and I recorded it wrongly.** BENCH-14 reported that `bench/src/report/cli.ts` had no wiring test, and I wrote that down twice without checking. `report-cli.test.ts` exists, 19 cases, added before the claim was made. What survives is narrower and real: nothing exercises that file's `invokedDirectly` guard and nothing spawns `bench:report`, so the guard could stop firing while every in-process test stayed green. Corrected 28 July after a cross-slice audit checked it.
- **28 Jul, BENCH-13 merged. All thirteen original items are in.** 2209 tests green.

  **The headline is a refusal, and it is the right one.** Probed with three backends at three repetitions across all seven admitted tasks, with a fabricated 70-point accuracy gap deliberately planted: **180 pairwise comparisons enumerate and 0 can run.** Every one refused as not scorable, because every category sits below the five-task floor. The report says so above every score. A benchmark that produced a confident ranking from that corpus would be the exact failure this whole design argues against, and it declined.

  **A structural limit found while building, which changes what the design can ever deliver.** Clustering on category means a category-scoped comparison has one cluster and no replication across clusters, so it can never be clustered at all. It is refused rather than computed at task level, which means only *overall* comparisons can ever produce a measured difference and a per-category ranking will print its numbers with every backend tied however far apart the medians look. That was not visible when I specified clustered errors; it is a consequence of specifying them.

  Its Codex review found five real defects, all one shape: **the report could contradict itself.** A refused comparison fell back to a weaker check and published a category ordering the paired test had just declined; the scorecard and the ranking derived the overall verdict separately and disagreed; and `pass@1` and `pass^k` ignored failures entirely, so three passes and seven failures read as perfectly reliable.

  **A third NUL byte**, in two string literals used as separators. Three runners across two days have now written a U+0000 composite-key separator, and `lint:source` caught all three. The gate exists because `contract.ts` shipped one in v0.2.1; it has now paid for itself three times in two days.

## Remaining

BENCH-15 and BENCH-16 are queued deferred children. One more was surfaced by BENCH-14 and needs restating rather than assigning: I recorded that `bench/src/report/cli.ts` had no wiring test, and it has 19. The real gap is that nothing exercises its `invokedDirectly` guard, which `bench/src/verify/cli.ts` and `bench/src/failcheck/cli.ts` also lack, and those two have no wiring test of any kind.

**The binding constraint on everything is the corpus.** Until at least two categories hold five tasks each, no comparison can run at all. Every scorer, every statistic and every frontier now exists and has nothing it can distinguish. That is BENCH-09's LiveDRBench problem-inversion follow-up, and it is worth more than any remaining code.

## Cross-slice audit, 28 July

Run after all fourteen merged, on the defects no single runner could see. Full findings in the audit; the ones acted on immediately:

**Fixed. `containment.ts` held a third magnitude table with no abbreviations**, so `$1.2bn` fell through to the bare-number pattern, backtracked across the missing word boundary between `2` and `b`, and produced the token `1`. A token of `1` is contained in very nearly any page, so the same claim scored **supported when abbreviated and refused when spelled out**: the check rewarded abbreviating, and `450m` produced no token at all. Two sibling implementations already handled these; the weakest of the three was the one wired into the default support oracle.

**That falsified a claim shipped in the product hours earlier.** `research_verify_claims` told every agent the containment gap was "structural rather than tunable". The measured 11 of 23 is sound and its cause is structural, but this was a tunable false-pass, and the detector corpus contains no abbreviated magnitudes so it could never have found it. The tool description and `docs/tools.md` now read 11 of 23 as a floor rather than a ceiling, and say why. **A measurement is only as general as the corpus behind it.**

**Corrected. I propagated a false claim.** See the BENCH-14 entry above.

Still open, in the audit's order: `bench/src/combine/` publishes a frontier with none of the four floors its sibling enforces and no path by which a tie test could reach it (latent, since nothing consumes `combine/` yet); syndication is the only text normaliser with no Unicode normalisation, and it fails open toward overstating independence; two date maskers disagree in both directions, which BENCH-15's own table says they do not; three `completionRate` implementations disagree on the empty denominator, so "never ran" prints as "failed everything"; `detector/` declares purity its own guard cannot check, and the guard omits the one leaking edge; and `failcheck/cli.ts` spends subscription quota with no confirmation gate while its sibling `detector/cli.ts` has one.
