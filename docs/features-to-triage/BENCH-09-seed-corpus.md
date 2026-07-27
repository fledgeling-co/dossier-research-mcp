# BENCH-09: the seed task corpus

## What

The hand-authored gold sets. Ten categories, ten tasks each, to start.

| Category | What it separates |
|---|---|
| Time-bound | Enforced date windows from asked-for ones |
| Enumeration | Matrix completeness, every cell filled or marked unknown |
| Legal and regulatory | Precision and official-source reliance |
| Primary literature | Real DOIs, and reading past the abstract |
| Social and sentiment | The only category where X access matters |
| Technical | Issue trackers, changelogs, version specifics |
| Obscure entity | Correctly reporting nothing found |
| False premise | Refusing a fabricated presupposition |
| Contested | Due weight, both figures, dissent retention |
| Settled-with-fringe | The false-balance counterweight |

## This is the bottleneck and the weak point

A hundred hand-built gold sets is the long pole, and a thin suite produces confident rankings from too little evidence. Better to ship six categories properly authored than ten padded out.

## Rules for an admissible task

- Its answer is checkable by a string, a number, a set membership or an HTTP request. If it is not, it does not go in.
- Every gold fact carries the primary source it came from, so a disputed score can be adjudicated against the source rather than against the author's memory.
- `asOf` and `reverifiedAt` are both set, honestly.
- No task whose answer a frontier model already knows without searching, or the benchmark measures recall of training data rather than research.
- **A new task must be shown to fail before it is admitted.** Run it against at least one backend and confirm it does not already pass. A task that is green the day it is written is testing nothing, and a suite of them reports a score that cannot move.

  Borrowed from Bridgewater's Pocket Analyst, whose teach loop authors a benchmark *expected to fail* to prove the bad behaviour reproduces, fixes until it passes, then confirms the rest of the suite still passes. The order is the load-bearing part: a fix validated only by a test written after it is a fix validated by its own author.

## Acceptance

- Every task in the corpus loads, and a scripted dry run confirms each gold fact is actually present in its cited source at authoring time. A gold set that was wrong on the day it was written poisons every run afterwards.
