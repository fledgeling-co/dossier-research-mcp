# Implementation Plan: BENCH-09

**Title:** The seed task corpus
**Spec ID:** BENCH-09
**Spec:** docs/specs/spec-BENCH-09.md
**Plan size:** Standard

## Task

Hand-author the first gold sets under `bench/tasks/`, and build the two scripts that make them trustworthy: one that proves every gold fact is really present in its cited source, and one that proves a backend does not already answer the question. The corpus is the input every scorer in the fleet reads, so its correctness is the deliverable and its size is not.

## Approach

Three parts, in this order, because the order is what makes the result checkable.

1. **The verifier first.** `bench/src/verify/` fetches each source a task cites and asks whether the recorded quote, and the recorded value, are actually in it. Written before the tasks so authoring is a loop against a check rather than a loop against memory.
2. **The tasks.** One YAML file per task under `bench/tasks/<category>/`, authored from raw responses read directly from publisher APIs, never from recall.
3. **The fail-first check.** `bench/src/failcheck/` runs a task's question through a local coding CLI and reports whether the gold answers are already in the response. Closed-book over the whole corpus; search-enabled over a stratified sample.

Both scripts touch the network, so neither runs inside `npm run gate`. The gate covers their pure halves through unit tests, which is where every decision they make actually lives; the network layer is a thin adapter around `safeFetch` and `spawn`.

## Reference implementation

- `bench/src/tasks/{schema,corpus,files}.ts` — the split this item copies: a pure core with the rules in it, and a separate adapter that is the only thing touching the outside world. The verifier follows it exactly, so the matching rules are testable with no network.
- `src/net/safe-fetch.ts` — `safeFetch` is used unchanged. A verifier that dereferences author-supplied URLs is the caller `CLAUDE.md`'s SSRF rule exists for, even when the author is the repo owner.
- `src/research/citations.ts` — the posture, not the code. It distinguishes an unreachable source from a wrong one, and the verifier must too: a 403 from a publisher is not evidence that a fact is fabricated, and reporting it as one would be the same defect this item exists to prevent.
- `src/local/cli.ts` — how a coding CLI is resolved and identified before being run. The fail-check reuses the same posture: never trust a bare name on `PATH`.

## Steps

### 1. The gold-fact verifier

- **Files:** `bench/src/verify/match.ts`, `bench/src/verify/verify.ts`, `bench/src/verify/cli.ts`, `bench/src/verify/index.ts`, `bench/src/verify/match.test.ts`, `bench/src/verify/verify.test.ts`
- **Action:** Create
- **Details:** `match.ts` is pure: extract readable text from a fetched body (JSON passes through, HTML has script/style removed and tags stripped, entities decoded), normalise whitespace, and decide whether a quote and a value are present. Numbers are matched through their plausible written forms rather than as a raw string, because `8.8` and `1500000` and `1,500,000` are the same fact and a naive substring check would report a true gold fact as missing. `verify.ts` walks a loaded corpus and produces a verdict per fact; `cli.ts` prints the report, writes the JSON evidence file, and exits non-zero if any fact is unproven.
- **Verify:** unit tests over `match.ts` cover each verdict; `npm run bench:verify` against the authored corpus reports every fact proven.

### 2. The tasks

- **Files:** `bench/tasks/**/*.yaml`
- **Action:** Create
- **Details:** Eight categories. Every fact anchored on a dated June or July 2026 event, cited to a publisher API or a static publisher page, with a quote copied from the response body rather than typed from memory. `asOf` is the event date; `reverifiedAt` is the date the verifier last proved it. `topic` is set wherever several tasks share a subject, so the statistics can cluster them.
- **Verify:** `loadCorpusFromDirectory` loads the whole directory with no failures and no stale tasks; the verifier is green over every fact.

### 3. The fail-first check

- **Files:** `bench/src/failcheck/verdict.ts`, `bench/src/failcheck/cli.ts`, `bench/src/failcheck/index.ts`, `bench/src/failcheck/verdict.test.ts`
- **Action:** Create
- **Details:** `verdict.ts` is pure: given a response text and a task, decide `already-passed` / `partial` / `fails`, reusing the same value-matching rules as the verifier so a fact counted as present by one is counted as present by the other. `cli.ts` spawns the configured CLI once per task, in either closed-book or search-enabled mode, and writes the evidence file. Closed-book mode passes the CLI's own flags for disabling web tools and asserts they were accepted rather than assuming.
- **Verify:** unit tests over `verdict.ts`; a real run recorded in `bench/evidence/`.

### 4. Corpus-level tests in the gate

- **Files:** `bench/tasks/corpus.load.test.ts`
- **Action:** Create
- **Details:** A test that loads the real `bench/tasks` directory and asserts the invariants the corpus must keep for the whole fleet: it loads at all, no task is stale, every id is unique, every category present is represented, every numeric fact carries a unit and a tolerance, every source is https, and every task carries a source on every fact. This is the guard that a later hand-edit cannot quietly break the corpus, and it is hermetic, so it belongs in the gate where the network scripts do not.
- **Verify:** `npm run test:all`, twice.

### 5. Wiring and documentation

- **Files:** `package.json`, `docs/bench/task-format.md`, `docs/test-plan.md`, `CHANGELOG.md`, `docs/features-to-triage/LEDGER.md`
- **Action:** Modify
- **Details:** Two npm scripts, `bench:verify` and `bench:failcheck`, both outside the gate and both described as making network calls. A section in the task-format doc recording how the corpus is authored and what the two scripts prove, because the next person to add a task needs the loop, not just the schema. AC rows appended to the test plan before the tests are written. A CHANGELOG entry under Unreleased.
- **Verify:** `npm run gate`, twice; `npm run lint:docs` resolves every new link.

## Risks

- **Gold rot.** Every fact is immutable by construction, but a *publisher* can restate one: NVD reanalyses CVSS scores, and a `Deferred` record can be rescored. The mitigation is the one the format already has — `reverifiedAt` plus the 183-day staleness flag — and the verifier is the thing that refreshes it.
- **A cited API changing shape.** A quote is matched against the response body, so a publisher reformatting its JSON could turn a true fact into a failed verification. The verifier reports that as unproven rather than as wrong, and the distinction is in its output.
- **The fail-check spends subscription quota.** Bounded deliberately: closed-book runs are short, the search-enabled layer is a sample rather than the corpus, and the evidence file records exactly what was run so nobody has to re-run it to find out.
