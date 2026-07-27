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

## Acceptance

- Every task in the corpus loads, and a scripted dry run confirms each gold fact is actually present in its cited source at authoring time. A gold set that was wrong on the day it was written poisons every run afterwards.
