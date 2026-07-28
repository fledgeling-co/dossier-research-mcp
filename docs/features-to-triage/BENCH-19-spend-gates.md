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
