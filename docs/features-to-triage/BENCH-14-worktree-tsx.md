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
