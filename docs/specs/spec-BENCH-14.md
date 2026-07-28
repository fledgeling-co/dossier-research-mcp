# BENCH-14: A fresh worktree cannot run the suite

**ID:** BENCH-14
**Status:** In Review
**Created:** 2026-07-28
**Last updated:** 2026-07-28
**Brief:** [BENCH-14](../features-to-triage/BENCH-14-worktree-tsx.md)

> **Harness, not product.** Nothing here reaches `dist/` or a user of the npm package. It changes what a *contributor* has to do before the suite is honest, which is why it is worth more than the eleven tests it repairs.

## Feature description

*(Verbatim from `docs/features-to-triage/BENCH-14-worktree-tsx.md`.)*

# BENCH-14: a fresh worktree cannot run the suite

## The defect

`bench/src/detector/cli.test.ts` resolves the tsx binary as a literal path:

```ts
const TSX = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));
```

A git worktree has no `node_modules` of its own, so eleven tests fail there until somebody runs `npm install` inside it. Found by BENCH-11, which hit it on a fresh worktree and reported that it "will bite every future worktree runner".

## Why it matters more than eleven tests

The whole feature pipeline runs in worktrees. A runner that clones a branch, runs the gate and sees eleven red tests has to work out whether it broke something, and the honest answer is that the harness did. That costs a runner minutes at best and a wrong conclusion at worst, which is exactly the "worked around a red test" pattern this project keeps finding.

## What to do

Resolve the binary rather than assuming its location. Options, in preference order:

1. Do not spawn tsx at all. Import the CLI's entry function and call it, so the test exercises the same code without a subprocess. Most of what that test asserts does not need a process.
2. Resolve through Node's own resolution rather than a relative path, so a worktree finds the root install.
3. Skip with a stated reason when the binary is absent, so the suite is honest rather than red. Weakest of the three: a skipped test that nobody notices is a test that stops working.

Whichever is chosen, **a fresh worktree with no `npm install` must produce a green gate or a clearly-explained skip, never eleven unexplained failures.**

## Acceptance

- `git worktree add` a fresh branch, run `npm run gate` without `npm install`, and get a green or explicitly-skipped result.
- If a skip is used, the reason names the missing binary and the fix.

## Grounding: what the baseline actually printed

The defect was reproduced before anything was designed, because the brief's acceptance criterion turns out to have two distinct cases and only one of them is fixable here.

**A worktree inside the repo, at `.worktrees/<name>`, which is where the pipeline puts them.** `npm run` prepends every ancestor `node_modules/.bin` to `PATH`, and `npx` walks ancestors the same way, so `tsgo`, `eslint`, `vitest` and `npx tsx` all resolve from the parent checkout. The gate reaches the tests and prints:

```
Test Files  1 failed | 91 passed (92)
     Tests  11 failed | 2102 passed | 2 skipped (2115)
Error: spawn /Users/.../.worktrees/bench14-baseline/node_modules/.bin/tsx ENOENT
```

Every failure is in one file. Nothing else in the repo is affected.

**A worktree outside the repo, at `/tmp/...`.** No ancestor holds a `node_modules`, so the gate dies before it reaches a test at all:

```
> tsgo --noEmit
sh: tsgo: command not found
```

**This second case is not fixable by BENCH-14 and must not be claimed as fixed.** A checkout with no toolchain anywhere above it cannot run a gate built on that toolchain: `vitest` itself is absent, so there is no suite to make honest. The brief's acceptance criterion is therefore read as applying to the location the pipeline actually uses, and the out-of-tree case is documented rather than papered over.

## Requirements

| # | Requirement |
|---|---|
| R1 | No test in the repo resolves an executable by a literal relative path into `node_modules`. |
| R2 | The detector CLI's command logic is callable in-process: argv in, exit code out, output through injected sinks. |
| R3 | Importing the detector CLI module does not execute it. A test that imports it must not score a corpus and write to stdout as an import side effect. |
| R4 | The wiring guarantee the test file exists for survives. Exactly one case still spawns the real CLI over real argv, because nothing an import can see proves that anything calls the entry point. |
| R5 | That one case resolves its interpreter through Node's own resolution, so a worktree finds the root install. |
| R6 | If the interpreter cannot be resolved at all, that one case skips with a message naming the binary and the fix. Never eleven unexplained failures, and never a silent pass. |
| R7 | A fresh `.worktrees/` worktree with no `npm install` runs `npm run gate` green. |

## Assumptions

Recorded rather than left implicit, because each one would change the design if wrong.

1. **The wiring assertion is load-bearing and is kept.** The test file's own header records why it exists: this repo shipped a module with nine passing unit tests that was imported nowhere and ran never. Converting every case to an import would remove the only check that distinguishes live code from dead code. The brief's option 1 is applied to the ten cases that assert *content*, and option 2 to the one that asserts *wiring*.
2. **`bench/src/report/cli.ts` is the house pattern and is copied rather than re-invented.** It already exports `main(args)` returning an exit code and guards its own invocation with `invokedDirectly`. Matching it is CP §5 "match existing style", and it means one reviewer's mental model covers both CLIs.
3. **`npx tsx` in `tests/concurrency.test.ts` and the acceptance harness is already option 2 and is left alone.** Those resolve through the ancestor walk and were proven green in the baseline. Changing them would be drive-by work outside the defect.
4. **SELF-23, SELF-24 and SELF-25 stay true and are not rewritten.** They belong to BENCH-10 and `ORCHESTRATOR.md` forbids rewriting another item's rows. The retained subprocess case is deliberately the one that keeps SELF-23's wording ("the real CLI, spawned over its real argv, prints both families") literally accurate.

## Out of scope

- Making a checkout with no toolchain above it run the gate. See the grounding section: there is nothing to run.
- `bench/src/report/cli.ts` has no wiring test of its own, so `bench:report` could break its entry point and the gate would stay green. Flagged, not fixed: it is a different file and a different item's work.
- The `npx tsx` calls fall back to a registry download if tsx is ever absent entirely, which would put a network fetch inside a hermetic suite. Latent, not triggered by a worktree, and out of this defect's scope.
