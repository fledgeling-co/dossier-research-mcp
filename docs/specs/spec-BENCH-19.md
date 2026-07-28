# BENCH-19: One entry point spends with no gate; two have no test

**ID:** BENCH-19
**Status:** In Review
**Created:** 2026-07-28
**Last updated:** 2026-07-28
**Brief:** [BENCH-19](../features-to-triage/BENCH-19-spend-gates.md)

> **Harness, not product.** Nothing here reaches `dist/` or a user of the npm package. It changes what the benchmark's own entry points do before they spend, and what the suite can prove about them. The rule being enforced is `CLAUDE.md`'s, and the thing violating it is the benchmark that exists to measure the product that follows it.

## Feature description

*(Verbatim from `docs/features-to-triage/BENCH-19-spend-gates.md`.)*

# BENCH-19: one entry point spends your subscription with no gate, and two have no test

## The spend asymmetry

Two benchmark entry points spend subscription quota by the same mechanism, spawning a coding CLI. One asks first and one does not.

- `bench/src/detector/cli.ts` refuses its `judge` subcommand without `--confirm`, naming the case count and saying it spends the CLI subscription quota.
- **`bench/src/failcheck/cli.ts` has no gate of any kind.** `npm run bench:failcheck` with no arguments defaults to `--mode closed-book`, `--bin claude`, `--limit 1000`, `--concurrency 4` and starts spawning immediately.

Its own header says "never point this at a paid API backend to satisfy an admission rule". That is a comment, not enforcement, and `--bin` is free-form. It does clear `ANTHROPIC_API_KEY` for the child, which is a real mitigation against metered spend but not against quota.

`CLAUDE.md` is explicit that a tool which spends money says so and gates it. This is the benchmark's own violation of the rule the product follows.

Lower severity, same file family: `detector`'s `capture` subcommand reaches the network with no gate while `judge` is gated. A fetch is not a spend, but the asymmetry is unexplained.

## The untested entry points

| entry | script | wiring test |
|---|---|---|
| `bench/src/verify/cli.ts` | `bench:verify` | **none** |
| `bench/src/failcheck/cli.ts` | `bench:failcheck` | **none** |
| `bench/src/report/cli.ts` | `bench:report` | 19 cases |
| `bench/src/detector/cli.ts` | `bench:detector` | yes, including a real spawn |
| `bench/src/run/cli.ts` | **none** | yes |

The first two carry exactly the defect BENCH-14 was created to fix, and nobody noticed because BENCH-14 was scoped to the file that had already broken.

`run/cli.ts` having no script is probably deliberate, since it is the only money-spending entry in the benchmark and is reachable only as `npx tsx`. Confirm that reading before changing it.

## The purity guard that cannot see the leak

`bench/src/detector/report.ts` declares itself "pure, synchronous, no model anywhere", and `corpus.test.ts` guards a list of modules against impure imports. Traced with a real ESM resolve hook:

```
detector/report.js  -> LOADED  ../net/safe-fetch.ts  -> LOADED undici
detector/verdicts.js -> clean (control)
```

The chain is `report.ts` to `arms.js` to `citations/collect.js` to the product's `citations.ts` to `safe-fetch.ts`. The guard forbids `./files.js`, `./capture.js`, `./judge.js` and `./cli.js`, and **not `./arms.js`**, which is the only edge that leaks. It also regexes each file's own text with no transitive walk, so it could never have caught this.

No call is made at runtime, since the arms take an injected offline fetcher. So this is capability rather than behaviour. It is still the "happened not to" versus "cannot" distinction that BENCH-11 got right and this did not, and the guard asserts the stronger thing.

For contrast, verified clean by the same trace: `combine/`, `score/`, `stats/`, `report/` including `report/cli.ts`, and `tasks/`.

## Acceptance

- `bench:failcheck` refuses to spawn anything without an explicit confirmation, naming what it will spend.
- `verify/cli.ts` and `failcheck/cli.ts` each have a wiring test that fails if the entry point stops working.
- `detector/`'s purity guard walks imports transitively, or the purity claim is narrowed to what is true.

---

## Grounding: the trace re-run, and what it found beyond the brief

The brief's claim was not taken on its word. It was re-run on 28 July 2026 with an ESM resolve hook registered ahead of the type stripper, recording every `(parent, specifier, resolved)` triple, over each of the five modules the guard calls pure.

| module | resolves | impure edges |
|---|---|---|
| `detector/corpus.ts` | 186 | 0 |
| `detector/schema.ts` | 183 | 0 |
| `detector/verdicts.ts` | 184 | 0 |
| `detector/confusion.ts` | 2 | 0 |
| `detector/report.ts` | 221 | **5** |

The brief is confirmed and is **incomplete in one direction that matters**. It named the network leak. The trace finds two independent leaks, both through the same unguarded `./arms.js` edge and each reaching a different forbidden thing:

```
report.ts -> arms.js -> ../citations/collect.js -> src/research/citations.ts
                                                -> src/net/safe-fetch.ts
                                                -> undici, node:net, node:dns/promises
report.ts -> arms.js -> ../citations/cache.js   -> node:fs
```

So the guard's **filesystem** half is false too, not only its network half, and it is false one hop away rather than four. A guard reading each file's own text could not see either, which is the finding rather than the particular edge: the check and the property it claims are of different kinds, and no amount of adding names to a forbidden list closes that gap.

**Still capability rather than behaviour.** Nothing in the graph is called during a score: the arms take an injected transport, `readDetectorCorpus` supplies the page text from disk before scoring begins, and the suite is green with no network. What is false is the module's own header, which says it *must never import* these things, and the guard, which asserts it does not.

## Grounding: the walk already exists, and the detector guard is the one that did not get it

Before designing a transitive walker, the tree was searched for one. **There already is one**, written by BENCH-03 and living in `bench/src/score/citations.test.ts` under INTEG-37. Its own comment states the exact distinction this item is about: reading a module's own source "proves only that it does not import a filesystem directly", and "following the edges is the difference between checking the claim and checking the first line of it".

It is also already better than a walker written fresh would be. It carries two self-checks that a purity guard needs and almost never has: one asserting **the walk actually follows edges**, so a walker that reached only the entry file cannot pass every purity assertion while proving nothing, and one asserting **the walker would notice an impure import if one appeared**, driven at a module that really does touch a disk. That second one is driven at `bench/src/citations/collect.ts`, which is a module on this item's own leak chain.

`docs/bench/citation-integrity.md` already publishes the stronger claim on the strength of it: "a test walks the import graph to prove it rather than reading the first line of each module."

So the shape of the fix changes. **Nothing new is invented.** The walk is lifted out of the one test that has it into a shared module, and the detector guard is wired to the same one. Writing a second walker beside it would produce a third spelling of a rule the detector's own guard file already warns about in a comment: it copied its regex from the task loader's guard "deliberately rather than reworded: a second spelling of the same rule is how two checks end up enforcing different things."

## Grounding: `run/cli.ts` has no script, and no record of why

Checked before changing anything, per the brief. The evidence:

- No `bench:run` script exists in `package.json`, and no `bench:run` string exists anywhere in the repo or the docs.
- `docs/bench/run-harness.md` documents the harness only as `npx tsx bench/src/run/cli.ts ... --dry-run`, under a "Plan first" instruction.
- It is the only benchmark entry that spends a **metered balance**: it goes through `Runner.start` and reserves against the ledger. Every other entry either spends nothing or spends a subscription quota.
- Its own guards are already the strongest in the benchmark: `--ceiling` is required, an unknown flag is refused rather than ignored, and the plan prints before the first dollar.
- **Nothing in `spec-BENCH-02.md` or `plan-BENCH-02.md` records the omission as a decision.**

So the reading is consistent with the evidence and cannot be shown to be a recovered intention. It is therefore adopted as a decision and written down as one, rather than claimed as archaeology: no script is added, and the reason is recorded where the next audit will look.

## Which of the brief's two options was chosen

The brief offers "either make the guard walk imports transitively, or narrow the purity claim to what is actually true", and asks which. **Both.** They close different halves and neither alone is enough:

- Walking transitively is what makes the guard able to see the thing it guards. Narrowing the claim without it would leave a check that still cannot tell a pure module from an impure one, so the next module added to the list would be guarded by nothing.
- Narrowing the claim is what makes the guard pass honestly. Walking transitively without it would simply turn the guard red, because the leaking module really does reach `undici` and `node:fs` and is going to keep doing so.

So the guard walks, the five-module list splits into the four that are genuinely pure and the one that is not, and the one that is not gets a claim that says what is true about it.

## Requirements

| # | Requirement |
|---|---|
| R1 | `bench:failcheck` spawns nothing without an explicit confirmation flag. Without it the command refuses, writes no evidence file, and exits non-zero. |
| R2 | `--bin` names one of the CLI ids the product already declares. Anything else is refused, naming the ids that exist, before any selection or spawn. |
| R3 | Before the first probe is spawned, the named binary is **resolved and identified** through the shipped detection, and a binary that is absent or whose identity is unconfirmed is refused rather than run. |
| R4 | The refusal names what the run would spend: how many tasks it would probe, in which mode, through which binary, and that binary's **recorded** billing fact rather than an assertion that any named executable spends a quota. |
| R5 | A mode the named binary cannot support is refused before the count is printed, so the number in the refusal is a number that could really have run. |
| R6 | With the confirmation flag, the command **runs**: it probes each selected task, writes the evidence file and reports the tally. A test proves this over injected seams, so an implementation that refuses unconditionally cannot pass. |
| R7 | The fail-check command logic is callable in-process: arguments in, exit code out, and everything that spawns, fetches or writes injected rather than reached for. |
| R8 | The verify command logic is callable in-process on the same terms, with its fetcher injected. |
| R9 | Importing either entry module executes nothing. No corpus is loaded, no network is reached, and nothing is written as an import side effect. |
| R10 | Each of the **three** untested entry paths is proved wired by one real process over real argv, on a path that is hermetic: fail-check takes the refusal path and spawns nothing; verify is given an empty corpus directory and fetches nothing; report is given an empty cell store and reads no network. |
| R11 | Those spawns resolve their interpreter through Node's own resolution, and skip with a reason naming the missing binary and the fix when it cannot be resolved. |
| R12 | The detector purity guard decides on the **transitive import graph** of each module it guards, not on that module's own text, and it does so through the walk this repo already has rather than a second one. |
| R13 | A test proves the guard would catch the `./arms.js` edge: run over the leaking module it reports the impure modules and the path by which each is reached. |
| R14 | What the leaking module can actually reach is stated truthfully wherever the claim is made, in the module's own header and in the guard, and the statement distinguishes what is reachable from what is called. |
| R15 | The guard cannot be vacuously green: one case asserts the walk follows edges, and one asserts it still flags a module that really is impure. |
| R16 | Every place that documents how to run the fail-check is updated to the invocation that now works, and the changed behaviour gets a changelog entry. |
| R17 | `run/cli.ts` keeps no npm script, and the reason is written down where an audit will find it. |

## Assumptions

Recorded rather than left implicit; each would change the design if wrong.

1. **The gate is a refusal, not a prompt.** `detector/cli.ts` refuses and exits; it does not read a TTY. Copying that shape keeps one spelling of the rule, and a prompt would hang in the batch use these scripts are for.
2. **The confirmation flag is spelled `--confirm`.** One spelling across both spending entry points; a second word for one idea is how an operator learns to type whatever the error asked for.
3. **The verify script keeps no confirmation gate.** It fetches; it does not spend. The rule being enforced is about money, and a gate on every network call would train the operator to type `--confirm` without reading it, which is how the one that matters gets waved through.
4. **`report.ts` keeps reaching the production citation collector, and the reason is scope rather than necessity.** It could be made genuinely pure by taking the arms as an argument instead of importing them, and the collector already injects every outside interaction, so nothing about driving the shipped lookup loop forces the impurity. What forces it is module co-location. Restructuring a merged slice's module boundary is neither of the two options the brief offers, and it would be a redesign for a property that is not behavioural.
5. **The walk is lifted from the test that already has it, not written again.** BENCH-03's walker is the house pattern, it carries the two self-checks a purity guard needs, and its negative control is already driven at a module on this leak chain. One spelling, two consumers.
6. **The task loader's and the statistics' own guards are left alone.** They check weaker, differently-scoped properties of different directories, nothing in this item's evidence says either is wrong, and rewriting them is BENCH-15's consolidation work.
7. **The report entry point gains its one spawn case too.** `ORCHESTRATOR.md` names it as the surviving gap from BENCH-14, it is the same rule violated in a third place, and its entry path is free and offline. Fixing two of three and leaving the third is how the same audit finding gets raised again.
8. **The unexplained `capture` asymmetry is explained, not gated.** A fetch of one author-supplied URL through the SSRF-safe production collector is not a spend, and saying so where the asymmetry is visible is the honest fix.
9. **The two existing fail-check rows in the test plan have their command corrected in place, and nothing else about them is touched.** After this change the command they print always refuses, so leaving it would publish an instruction that cannot work. Correcting a now-false command is not the rewriting-another-item's-rows the fleet rule forbids.

*If any of these are wrong, edit it inline (or correct an assumption) in this file and re-run `/triage BENCH-19` before the planner picks this up.*

## Out of scope

- Consolidating the three purity guards into one. They are three different scopes checking three different properties; the duplication is real and belongs to BENCH-15.
- Adding a `bench:run` script. See the grounding above: the decision is to keep it absent and record why.
- Restructuring `report.ts` so it cannot reach a network. It is neither of the two options the brief offers, and it is a module-boundary change to a merged slice for a property that is not behavioural. Recorded as a real option that was declined, not as an impossibility.
- The registry-cache disk write reached through `arms.js`. It is a real second leak in the same edge, it is covered by the same narrowed claim, and moving it is a change to the citation cache rather than to the detector.
- The reporting slice's own purity guard, which also reads each file's own text. Its claim happens to be true, verified by the same trace, so it is a weak check over a sound claim rather than a false one. Flagged, not fixed.

---

## Triage — 2026-07-28

**Ready for Implementation Plan**

**Sentinel review:** S1 — Approve with assumptions

**UI & logic preview** *(rough sanity check — is this the surface area you expected?)*
- **Where it shows up:** nothing customer-facing changes, and nothing in the published package changes. This is the benchmark's own command line, which only a contributor runs.
- **What users will see:** nothing. A contributor who runs the fail-first check sees it stop and explain what it was about to spend, instead of starting immediately.
- **Behaviour changes:** the fail-first check now needs an explicit go-ahead, and refuses a backend name it cannot identify.

**Codex cross-family spec review:** `gpt-5.6-sol` at `max` effort, read-only, over the spec plus the twelve files it is about. **Verdict: MATERIAL DEFECTS**, six findings. All six accepted; none rejected, none escalated.

| # | Finding | Disposition |
|---|---|---|
| 1 | The refusal cannot truthfully say "subscription quota" while the backend name is free-form, and this reverses a decision already recorded in BENCH-09's plan: the fail-check "reuses the same posture: never trust a bare name on `PATH`". | Accepted. Assumption 2 deleted. R2 and R3 now require the name to be a declared id and the binary to be resolved and identified before it is run; R4 makes the refusal quote the recorded billing fact rather than assert one. |
| 2 | Nothing required proving that the confirmation flag lets a run *happen*. An implementation that refused unconditionally would have satisfied every stated test and made the command useless. | Accepted. R6 added, and R7 widened so the spawning seam is injected rather than only the output sinks. |
| 3 | The report entry point's spawn case lived in an assumption and in no requirement, so every requirement could pass with the known gap intact. | Accepted. Promoted into R10. |
| 4 | The brief's acceptance permits either the walker or a narrowed claim, while the requirements demand both, so a sign-off against the weaker reading could leave the blind spot. | Accepted. A section now states which was chosen and why neither alone is enough. |
| 5 | The justification for leaving the leaking module alone was false: the collector injects every outside interaction, so reusing the shipped loop does not force the impurity. | Accepted. Assumption 4 rewritten to say the impurity is module co-location, and that the restructure is declined on scope rather than being impossible. |
| 6 | The new invocation is not propagated: two documented commands would always refuse after this change. | Accepted. R16 added, covering both documents and the changelog. |

*If any of these are wrong, edit it inline (or correct an assumption) in this file and re-run `/triage BENCH-19` before the planner picks this up.*

---

## Plan

[plan-BENCH-19](../plans/plan-BENCH-19.md).

**Plan review gate: downgraded, and logged as one.** The Codex `gpt-5.6-sol` lane answered the spec review and then hit its usage limit before the plan review, returning `You've hit your usage limit ... try again at Aug 2nd`. The plan was therefore reviewed by an independent Opus reviewer with fresh context, which is an in-family review of in-family work and is weaker evidence. It found thirteen defects and verified every one of the plan's file:line citations. The four that changed the implementation:

- `report.ts` reaches **six** forbidden modules by three chains, not four by one, and the network chain runs through `citations/fetch` rather than `citations/collect` as both the brief and the spec said. Re-derived by running the walk rather than by argument. `node:child_process` was reachable through the product's own CLI spawner and nobody had named it.
- Nothing in the plan required proving that `--confirm` lets a run *happen*, so an implementation that refused unconditionally would have passed every stated test and left the script dead.
- `verify/cli.ts` defaults `--out` to a committed evidence file and writes unconditionally, so any test driving it over a temp corpus would have overwritten the record of what the gold set proved and stayed green.
- The `--bin` id and the executable are not the same string for every CLI the product knows, so identifying one binary and spawning another was possible.

## Progress

**Branch** `ai/bench-19`, worktree `.worktrees/BENCH-19`. Local only; not rebased, merged or pushed.

### What shipped

| Defect | Outcome |
|---|---|
| `bench:failcheck` spends with no gate | Refuses without `--confirm`, and refuses two further things in front of it. Nothing is spawned before confirmation, including the identity probe. |
| Three entry points with no wiring test | `bench:failcheck`, `bench:verify` and `bench:report` each get one real process over real argv, on a hermetic path. |
| A purity guard that could not see the leak | The guard walks the import graph, using the walk BENCH-03 already had. The claim splits into four modules proven pure and one proven impure with its only edge named. |

### The three things worth carrying forward

**The trace found more than the audit did, in the direction that matters.** The brief named one chain reaching `undici`. Re-running it found six modules by three chains, the furthest being `node:child_process` six hops out through the product's own CLI spawner. A claim narrower than the truth reads as reassuring and is still wrong, so the guard asserts the **exact** module set rather than a subset: a new reach fails, and the module's header has to be corrected with it.

**It is capability, not behaviour, and that is stated everywhere it appears.** Nothing in the graph is called during a score. The arms take a scripted transport, an offline fetcher, an in-memory cache and a fixed clock. What was false was the guarantee, not the conduct.

**The gate caught an interaction no unit run could.** Five new subprocess spawns pushed `tests/concurrency.test.ts` over its threshold: the file-lock contention test measures exclusivity in wall-clock time, and under the extra load a holder was starved past the grace window, so a contender broke the lock and two entered. `main` was green and the test passed alone three times out of three, so it was load rather than a lock defect. Loosening the lock test to accommodate my own change would have been the wrong fix; the fix was one spawn per entry point, which is what the wiring property actually needs and what BENCH-14 concluded.

### Deviations from the plan, and why

- **`--bin` is a two-item allowlist, not every `CliId`.** The plan said the id list; the code has no headless argv for the other four, and `run/cli.ts`'s own precedent is to refuse an id it cannot cost rather than run it at zero. Running `grok` with `claude`'s flags produces a process that dies at argument parsing and is recorded as a task that failed, which is a wrong admission decision rather than an error anybody notices.
- **Two checks the lift nearly dropped were restored**: a dynamic `import()`, which the old regex caught and the first version of the walk did not, and a bare `fetch(`, which needs no import at all. Comments are stripped first, since several modules explain at length why they do not call `fetch`.
- **A third was added**: a side-effect import, `import './x.js'` with no bindings. None exists in the tree today, which is exactly why one would have been added without anybody noticing.

### Verification

`npm run gate` twice, green both times, in `.worktrees/BENCH-19` after `npm install`: 101 files, 2,265 passing, 2 skipped. Plus the stdio smoke against `dist/index.js`, which this repo substitutes for Playwright: initialize, `tools/list` (37 tools), `research_plan` returning a plan with a cost band and a contract fingerprint. And the real command, run rather than reasoned about: `npm run bench:failcheck` with no arguments prints what it would spend and exits 1 without spawning anything.

### Not done, and why

- Not rebased, merged or pushed. The instruction was to reach verification green and stop.
- The reporting slice's purity guard also reads each file's own text. Its claim is true, verified by the same trace, so it is a weak check over a sound claim rather than a false one. Flagged, not fixed.
- The task loader's and the statistics' purity guards keep their own text-level checks. Consolidating all of them is BENCH-15's work.

### What a second adversarial read found, after the first gate was already green

The diff was reviewed again once it was complete. It found fourteen defects, and four of them were the same shape as the one this whole item is about: **a check that reports success without having checked.**

| Severity | Defect | Fix |
|---|---|---|
| Critical | `--concurrency abc` parsed to `NaN`, so the worker pool was zero lanes wide. It probed **nothing**, wrote an evidence file recording that no task was already passed, exited 0, and overwrote the committed evidence doing it. Reproduced before fixing; the clobbered file was restored from git. | Numeric flags must be whole numbers of at least one. |
| Critical | Stripping `//` comments with a regex that does not know what a string is deleted the rest of any line holding a URL, taking a `fetch(` with it. `fetch` is a global with no import to walk to, so that check is the only thing that can see it, and the walk returned clean for a module that opens sockets. | `stripComments` is a scanner that tracks string state. |
| High | `IMPURE_MODULES` carried only the `node:` spelling, so `require('fs')` walked past. The regex it replaced had `(?:node:)?`. **The smuggling case had been edited to the `node:` form to make it pass**, which is the weakening CP §5 bans. | Both spellings listed; the case restored to the bare form. |
| High | An unknown flag was ignored, so `--limt 2 --confirm` ran the whole corpus; and a flag whose value was forgotten swallowed the next token, so `--category --confirm` ran **unconfirmed**. | Unknown flags, bare positionals and flag-shaped values are all refused. |

Three more were claims that were true of the prose and not of the code: the "only edge" assertion did not close, because the walk memoises by file and reports the shortest path, so it is now proven by enumerating `report.ts`'s direct imports and showing every non-arms one clean; the verify test asserted the committed evidence still *existed*, which passes over the exact damage of it being overwritten, so it compares a digest; and comment stripping ran in one direction only, so a comment naming `node:fs` was reported as a real reach while a comment naming an unresolvable specifier threw and took the walk down.

**The lesson is the item's own.** Every one of these was a check that would have reported success. The first version of this change replaced a guard that could not see what it guarded with a guard that could not see four other things, and only an adversarial read found them. That is the argument for the mutation testing below rather than for trusting a green suite.

### Proven by mutation, not by assertion

Each acceptance criterion was checked by breaking the thing it covers and confirming the suite goes red.

| Criterion | Mutation | Result |
|---|---|---|
| The gate refuses without confirmation | Removed the `--confirm` branch | 9 cases fail |
| Each entry point has a wiring test | Killed the entry guard in each of the three CLIs | the one spawn case in each file fails, in-process cases stay green |
| The guard catches the `arms.js` edge | Put `report.ts` back in the pure list, as the old guard had it | fails, printing the full path to `node:child_process` through `arms.js` |

### Rebased

Onto `main` at BENCH-17 and BENCH-18. Two conflicts, both in append-only shared files and both resolved keeping every side: `CHANGELOG.md`, where my entries were merged into the existing `Changed` and `Fixed` sections rather than added as duplicate headers, and `docs/test-plan.md`, where both slices had appended a section at the end. `CLAUDE.md`'s repo-layout block took both BENCH-17's `combine/` rewrite and my two new modules.

The spec and plan are committed on the branch, not left in the main tree: `main` already carries a ledger row linking to both, and BENCH-17 and BENCH-18 both committed theirs, so leaving mine untracked broke `npm run lint:docs` for anyone who did not have them on disk.
