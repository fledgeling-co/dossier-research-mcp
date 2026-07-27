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
