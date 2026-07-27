# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Operating rules; load before writing code

Two operating specs govern all code in this repo. Read them before generating code and apply them **as you write**; following them up front is what makes a review come back clean:

- **`docs/CODING_PRACTICES.md`** (cited as **CP §n**): TypeScript boundary safety, OWASP-aligned security, and cross-cutting logic-bug patterns (CP §6.14). Before reporting any change done, run the **CP §7 agent self-review** over your diff and state which files you covered. The NestJS and Next.js sections do not apply here (this is a Node library plus CLI); §1, §4, §5, §6.11–§6.12 and §7 do.
- **`docs/NEW_PROJECT_BEST_PRACTICES.md`** (cited as **BP §n**): stack defaults. This project deliberately diverges from the Next.js/Vercel/Mongo default stack (see "Deliberate divergences" below); BP §2 (install `@latest`, let the lockfile pin), §13 (env), §15 (testing), and §19 (the quality gate) apply as written.

**Behaviour under ambiguity:**
- **Think before acting.** State assumptions explicitly; if multiple interpretations exist, present them.
- **Simplicity first.** Minimum change that solves the problem. No speculative features or abstractions.
- **Surgical changes.** Don't "improve" adjacent code; match existing style; mention unrelated problems instead of fixing them.
- **Goal-driven execution.** Turn the task into verifiable success criteria before starting, and loop until verified.

### Deliberate divergences from BP

Check here before "fixing" something that looks non-compliant:

- **No Next.js, no Vercel, no Mongo, no Redis.** This is a stdio/HTTP MCP server distributed on npm. Persistence is a plain atomic-write JSON + JSONL store on the local filesystem (`src/store/`); adding a database would make the server undeployable as `npx dossier-research-mcp`.
- **npm, single package, no monorepo** (BP §17); one deployable.
- **Vitest over Playwright** (BP §15); there is no UI. The equivalent of an E2E test here is the stdio MCP handshake smoke check described below.
- **CI is release-only** (BP §19). The dev loop is still `npm run gate` run locally before pushing; there is no CI on push or PR. `.github/workflows/release.yml` re-runs the same gate on a version tag, because a package that fails its own tests must not reach the registry. Publishing is tag-triggered and never push-triggered.
- **`oxc: false` in `vitest.config.ts`** is load-bearing: Vitest 4 transforms with Oxc, and unplugin-swc only disables esbuild, so without it swc loads and does nothing.
- **`exactOptionalPropertyTypes: true`** is on, above the CP §1 baseline. Interfaces fed from Zod-parsed input declare `foo?: T | undefined` explicitly.

## Project overview

An MCP server wrapping Google Gemini's two research surfaces; the **Deep Research API** (managed research agent via the Interactions API) and the **Managed Agents API** (persisted custom agents with a Linux sandbox). TypeScript strict, ESM, Node ≥20.11, built on [FastMCP](https://github.com/punkpeye/fastmcp), with Zod at every boundary and the Vercel AI SDK v7 for cheap side-work (titles, summaries, claim extraction, follow-ups).

The three properties that shape every design decision: a task runs **4–60 minutes in the background**, costs **$1–7 every time**, and returns a **~60,000-token report**. Durability, spend control, and context discipline are therefore not features; they are the architecture.

## Repo layout

```
src/
  index.ts              CLI entry; arg parsing, transport selection, poller lifecycle
  server.ts             the whole FastMCP surface: tools, resources, prompts, deps assembly
  config.ts             Zod-validated env → typed Config. The only place env is read
  version.ts            kept in lockstep with package.json
  gemini/
    client.ts           DeepResearchClient interface + live adapter. The ONLY file that
                        knows about @google/genai interactions; everything else injects it
    agents.ts           Managed Agents API (the other surface)
    types.ts            Zod wire schemas + toSnapshot(). Trust boundary
    cost.ts             per-tier cost/duration estimate bands
  providers/
    types.ts            ResearchProvider, Capabilities, CredentialStatus. The seam
    gemini.ts perplexity.ts openai.ts xai.ts   one adapter each
    local.ts            a coding CLI you already pay for, as a backend
    registry.ts         detection, capability-first routing, and panel assembly
    options.ts          one neutral request shape, four dialects; enforced vs requested
  research/
    archetypes.ts       the 5 archetype override tables + keyword selection
    profile.ts          question signals on top of the archetype; drives panel membership
    prompt.ts           the prompt architect: scaffold builder + pre-engineered passthrough
    contract.ts         fingerprint / dedupe key; the two-step spend handshake
    report.ts           outline / section / grep / clamp. Pure string work
    citations.ts        citation verification + scorecard
    shapes.ts           wide (entity x field), time windows, the completion gate
    decompose.ts        one search task per source class, in that index's dialect
    local-loop.ts       the free loop's registry, freeze and draft-time check
    corroborate.ts      independent-domain counting; N-way cross-backend diff
    evidence.ts         source classes, advisory floors, citation registry, search trace
    runner.ts           run lifecycle, poller, stall watchdog, budget + concurrency gates
  store/
    store.ts            atomic-write JSON store, JSONL journal, JSONL ledger
    file-lock.ts        cross-process admission lock (write-then-link; see below)
    types.ts            persisted Zod schemas; read back from disk = a trust boundary
  corpus/
    files.ts            File Search stores (private-corpus grounding, uploaded)
    local.ts            the corpus that never leaves the machine
  local/
    cli.ts              coding-CLI detection: resolve, identify, check sign-in.
                        Plus the opt-in model probe, which is the one thing here
                        that spawns a CLI with a prompt rather than --version
    model-cache.ts      what each CLI answered when asked its model, on disk with
                        a timestamp. Read sync (routing is sync), written async
  setup/
    catalog.ts          what the wizard tells a stranger: install commands, plans,
                        costs, console steps. Data only, every claim dated
    wizard.ts           the guided setup. Asks before it changes anything
  net/
    safe-fetch.ts       SSRF-safe fetch: DNS validation, per-hop redirect checks, caps
    retry.ts            classify / backoff with full jitter / Retry-After
  ai/utility.ts         AI SDK v7; Output.object for every structured result
assets/                 icon.svg (master, 1024) + rendered PNGs, banner, social preview
CHANGELOG.md            what changed per release; updated in the same commit as the change
docs/                   the documentation set; README is the approachable entry point
  setup.md              getting a key, billing, spend caps, install, every env var
  tools.md              full contract for all 36 tools, 6 resources, 4 prompts
  how-it-works.md       tier/archetype selection, the utility model, a real session
  security.md           injection, SSRF, data egress
  development.md        toolchain and the two test suites
  test-plan.md          the AC-traceability matrix
  bench/task-format.md  the benchmark task format, for whoever hand-writes a gold set
  bench/scoring.md      what the scorers measure, and what each number cannot mean
  bench/run-harness.md  the matrix, the spend refusal, resume, and why the
                        harness is built rather than adopted from promptfoo
  bench/due-weight.md   the viewpoint-coverage scorers, and every limit they carry
  releasing.md          the tag-triggered publish flow
  deep-research-api-vs-agent.md   which Gemini surface fits which job
  providers/            per-provider guides (Gemini, Perplexity, OpenAI, xAI,
                        subscriptions, browser sessions) + a routing index.
                        setup.md keeps the Gemini key/billing walkthrough;
                        providers/gemini.md covers capability and routing
  plan/                 forward-looking design docs; multi-provider-research.md
                        is the current one. Plans are dated and never silently
                        edited to match what shipped
  reference/            source-notes.md: every external fact the plan rests on,
                        with URLs and the date gathered. Re-verify before reuse;
                        prices and quotas move monthly. Add to it rather than
                        re-fetching, and mark inferred facts as inferred
blog/                   long-form articles. Not product docs; Luke's byline
skills/deep-research-prompt-creator/   the bundled Claude Code skill (shipped in the package)
tests/                  hermetic vitest; no network, no keys
bench/                  the benchmark. NOT compiled into dist/ and NOT published;
                        typechecked, linted and unit-tested by the gate like any
                        other source. Its design is docs/plan/benchmark.md
  tasks/*.yaml          one hand-authored gold set per task, grouped by category
  quarantine/*.yaml     tasks whose gold is verified and whose question a free
                        CLI backend already answers. Kept, not deleted; its
                        README carries the per-backend evidence and the finding
  evidence/*.json       what the two network scripts established, and when
  src/verify/           proves each gold fact is really in the source it cites.
                        Pure matching rules plus one thin fetch adapter
  src/failcheck/        proves a task is not already passed, closed-book and
                        search-enabled. Spends subscription quota; never in the gate
  src/tasks/schema.ts   the task format, in Zod. The contract every scorer reads
  src/tasks/corpus.ts   the pure synchronous loader. Imports no filesystem, on
                        purpose, so a scorer is testable without one
  src/tasks/files.ts    the only part that reads a disk
  src/score/confidence.ts  the confidence markers a report states, and what each governs
  src/score/calibration.ts pairs a stated confidence with the outcome; Brier + reliability
  src/score/refusal.ts     the two families where the right answer is not an answer
  src/score/recency.ts     the durability axis the design assumed existed and did not
  src/run/cell.ts       what one matrix cell is; the resume key, the cell
                        record schema, the spread floor
  src/run/plan.ts       build the matrix, subtract what is recorded, total the
                        remainder's worst case, refuse above the ceiling
  src/run/harness.ts    bounded-concurrency execution over an injected executor
  src/run/store.ts      the append-only JSONL cell store
  src/run/dossier.ts    the only part that can spend; goes through Runner.start
  src/run/cli.ts        the entry point. --ceiling is required
  src/score/due-weight/ the viewpoint-coverage scorers. Pure functions over one
                        task and one report; the aggregate is what makes the
                        false-balance guard bite. docs/bench/due-weight.md
```

**Boundary rule:** `gemini/client.ts` and `gemini/agents.ts` are the only files that touch the Gemini SDK. Everything downstream takes a `DeepResearchClient` by injection, which is what makes the whole runner/tool layer testable without a network or a key.

## Commands

```bash
npm install
npm run dev        # tsx src/index.ts (stdio)
npm run typecheck  # tsgo --noEmit; over tests too
npm run lint       # eslint (flat config, type-aware)
npm test           # vitest run; hermetic, swc transform
npm run build      # tsgo -p tsconfig.build.json → dist/
npm run gate       # typecheck, lint, source hygiene, doc links, tests, build
npm run lint:source  # no control characters in source (see below)
npm run lint:docs    # every internal markdown link and anchor resolves
npm run inspect    # build, then MCP Inspector
npm version patch  # gate, bump, sync src/version.ts, tag, push. The workflow publishes
```

**The quality gate is `npm run gate`, run manually before pushing** (BP §19). Toolchain matches the org's other repos: **tsgo** (`@typescript/native-preview`) compiles and typechecks, **eslint 9** flat + type-aware lints, **vitest** with the **swc** transform tests. `typescript@~6` is present only to satisfy typescript-eslint's peer range; tsgo does the real checking. There is intentionally no hosted CI. Run a single test file with `npx vitest run tests/runner.test.ts`.

## Test layout

Two vitest projects, because they catch different classes of defect.

- **`tests/*.test.ts`** (`npm test`) is the unit project: pure logic, no processes, milliseconds.
- **`tests/acceptance/*.acceptance.test.ts`** (`npm run test:acceptance`) spawns the real server via tsx and speaks JSON-RPC to it. This is the only layer that catches a schema FastMCP rejects at registration, a tool absent from `tools/list`, a resource template that never matches, or stdout noise corrupting the stream. It found four real bugs on its first run, including two documented sub-resources that had never worked.

`docs/test-plan.md` holds the AC-traceability matrix and the coverage axes. **Add the AC row before the test**, so coverage follows the contract rather than whatever is convenient to assert. Acceptance tests seed state through `Store` (driving a run to `completed` through Gemini costs money and takes an hour) and run against a `mkdtemp` store per file.

Run the whole suite **twice** before claiming green; isolation breaks and leftover state only show on the second run.

## Verifying a change actually works

A green typecheck is not a working server. `npm test` covers the pure logic; the MCP surface needs a real handshake. Drive it over stdio; initialize, `tools/list`, then call `research_plan` (it is free and needs no credentials) and assert on the response text. A tool whose Zod schema FastMCP rejects at registration will pass typecheck and fail at `tools/list`.

Never write a test that spends money. `DOSSIER_HERMETIC=1` (set in `vitest.config.ts`) makes `resolveClient` return `null` unconditionally, so a stray `GEMINI_API_KEY` in the environment cannot reach the network. Every test injects a scripted client and points the store at a `mkdtemp` directory.

## Conventions (repo deltas; the specs carry the rest)

- **Every trust boundary is Zod-parsed, never cast** (CP §1); API responses, files read back from the store, env, and model output alike. `toSnapshot()` and the store's `safeParse` calls are the pattern: malformed *items* are skipped so one bad record can't break a listing, while a malformed *envelope* fails loudly.
- **Spend-affecting order is load-bearing** (`runner.ts`): dedupe → concurrency → budget → ledger write → paid API call. The ledger is written *before* the interaction so a crash between them over-counts rather than under-counts; the safe direction for a gate.
- **Never return a full report inline from a tool.** `research_read` defaults to `outline`, and any truncation is marked explicitly in the returned text.
- **Cost figures are estimate bands, never quotes.** Anywhere a dollar figure surfaces, say so.
- **Tool descriptions are the agent's only documentation.** A tool that spends money says so in its description and carries `readOnlyHint: false`; a tool that sends data to a third party says that too. Write them for a caller that will read nothing else.
- **Nothing may follow the final `<core_directive>` in a built prompt.** It is the anti-drift re-anchor and only works because it is last. Appending the corpus-grounding block after it shipped once and made the instruction invisible to the model; a run with the corpus indexed and the tool attached returned a 12,660-token report citing none of it. `tests/prompt.test.ts` locks the ordering.
- **stdout is the MCP protocol.** Diagnostics go to stderr; a stray `console.log` corrupts the stream on stdio.
- **Fail closed on anything that gates spend.** Skip-not-fatal is right for a listing and wrong for admission control: an unparseable ledger line or run record used to *vanish*, so corrupting the store raised the ceiling. Unreadable state is now counted at worst case. Same rule for env booleans, which fail startup rather than defaulting to `false`.
- **No control characters in source.** `contract.ts` shipped v0.2.1 with a NUL byte in a string literal. It compiled, linted and passed every test, while making git treat the file as binary and grep skip it silently. `npm run lint:source` blocks it.
- **A tool that invokes a model is not `readOnlyHint: true`.** Every model call bills, however small, and every one reserves against the ledger.
- **A lock file is written under a temp name and `link`ed into place.** `open(path, 'wx')` is atomic, but the holder record is a *second* syscall, so between the two the file exists and is empty; a contender reading it there breaks a live lock and two processes enter the spend gate. It failed roughly one run in three under contention, which is exactly how it survived to be found late. An unreadable lock is also given a grace window before it is broken.
- **Say whether a constraint was enforced or merely requested.** A date window is a real filter on Perplexity and xAI and a sentence in a prompt on Gemini and OpenAI. `providers/options.ts` returns both lists and every tool that shapes a request prints them. A recency bucket that merely *contains* the window counts as requested, not enforced.
- **Nothing that reads local files may be pointed anywhere by an agent.** `DOSSIER_LOCAL_CORPUS_DIRS` is operator-set and there is deliberately no tool that adds a directory. An agent that has just read a hostile page is precisely the caller that must not be able to search `~/.ssh`.
- **A binary's name on `PATH` is not its identity.** Two vendors ship `agent`, two ship `grok`, and Cursor's reports its version as a bare date and hash that names nothing. An unidentified binary is reported `ambiguous` and never run: handing a brief to a different vendor's tool is a different bill.
- **Every subscription-coverage claim is dated and sourced, or it is not made.** Gemini CLI's consumer tier vanished between two releases of its own README, which still advertises it. `unconfirmed` is an acceptable answer; a guess is not.
- **A subscription already paid for beats a metered API balance.** Routing order is capability, then billing, then cost. A `local` CLI backend that is installed, signed in and capable of the requested job is preferred over a paid API backend, and the routing reason says plainly that a subscription quota is being spent and that Dossier cannot meter it. This reverses the rule that held until 0.5.1, which kept `local` out of automatic selection because a $0 backend wins every cost tie-break; the facts behind that rule are unchanged and the owner's judgement about the default is what changed. Three things keep it honest: capability is filtered before billing is consulted, so a date window, a domain filter, X or an editable plan still routes to the backend that can enforce it; sign-in is required and is established by a session file's existence, never by opening one; and `DOSSIER_PROVIDERS` overrides in both directions.
- **A panel reserves the sum, not the members.** Without an explicit `provider`, routing assembles a panel rather than picking one backend: every capable signed-in CLI joins free, and an API backend joins when the question profile calls for what it is distinctively good at. Capability is screened before billing and before the profile, by sharing one screening pass with single-provider routing rather than reimplementing it. The whole panel's worst case is reserved in one critical section before any member starts, because reserving member by member starts the cheap half of a panel that cannot be afforded and then stops, which is money spent to be worse than one good backend. A panel of one is a legitimate outcome and is reported as a result. Each member is an ordinary run bound by a shared `panelId`: one record cannot hold two interaction ids, two reports, two lifecycles or two ledger lines, and every per-run tool keeps working unchanged. The panel merges itself through the free deterministic `research_synthesise` pass once every member is terminal, because the overlap warning is the whole point at five times the price and nobody remembers to ask for it.
- **A CLI is not a model, and a capability is not a property of the weights.** The free lane is worth running four-wide only while the four CLIs are four models, and Cursor can be pointed at Grok 4.5, so two seats can quietly become one perspective reported as two. Model identity is therefore *asked for and cached* (`research_doctor` with `probeModels`, off by default because it costs a round trip on a subscription) and never inferred from a product name: probed 27 July 2026, `cursor-agent` answers `Composer` and `grok` answers `Grok 4.5`, so a guess would drop a paid-for backend on a default install. Where two free-lane members are *known* to share a model one joins and the other is named in the rejections; where nothing is known nothing is dropped and the panel says the lane may hold duplicates. The second half is the one that will tempt someone later: a Cursor pointed at Grok still has no X access, because live X search is a first-party tool attached to xAI's API rather than something the model carries. Capabilities stay per CLI in `providers/local.ts` and are never derived from a probed model name.

- **The host searches; the server enforces.** Dossier has no web search and cannot borrow one, so the local loop runs in the client. What runs server-side is the part that can only be guaranteed there: one deduplicated registry, frozen before drafting, and a draft refused if it cites anything outside it. A prompt can ask a model not to invent a supporting reference; a server holding the registry can check.
- **A call that spends money is attempted once.** `retry()` is for reads; paid creation goes through `attemptOnceThenSettle`. A create that timed out after the provider accepted it has already bought the report, so a retry buys a second one. An unknown outcome raises `AmbiguousSpendError` and says to check the provider console, because one is a support question and the other is a refund request. This rule was written in a comment for months before the function existed.
- **Verify a provider against the live API before believing its adapter.** Four defects survived a full hermetic suite and were found by one real call each: an upper-case status that never matched a lower-case terminal check, citations returned out of band on three separate providers, and a `deferred` flag accepted and ignored. Vendor documentation described none of them correctly.
- **Agreement is not corroboration.** Cross-provider support is counted in independent registrable domains after canonicalisation, never in providers and never in raw URLs. A user's own document is valid primary evidence about their own position and never independent corroboration of an external fact.

## Releasing

`npm version patch|minor|major` is the whole flow. Move the `## [Unreleased]`
entries in `CHANGELOG.md` under the new version number first. It runs the gate
first (so a failing build can't produce a tag), syncs `src/version.ts`, commits, tags, and
pushes with the tag. The tag push triggers `.github/workflows/release.yml`,
which re-runs the gate, checks the tag matches `package.json`, checks the
advertised version matches the built one, publishes with npm provenance, and
cuts a GitHub release.

`workflow_dispatch` runs the same job in dry-run mode (gate and pack, no
publish) when you want to check the pipeline without spending a version number.

## The changelog

`CHANGELOG.md` is part of the change, not part of the release. **Add the entry in the same commit as the behaviour**, under `## [Unreleased]`, and `npm version` promotes it.

What earns an entry: anything a user would notice. A new or removed tool, a changed default, a changed cost, a new requirement, a behaviour that used to do X and now does Y, a security fix. What does not: an internal refactor, a test, a doc tidy, a dependency bump nobody can observe.

Two rules that make it worth reading:

- **Say what was actually wrong, not that something was fixed.** "Routing preferred Gemini for any deep run regardless of price" tells someone whether it bit them; "improved routing" does not.
- **Record where a fact came from when it cost something to learn.** The upper-case Perplexity status and the never-implemented retry rule are in there because a real call and an adversarial review found them, and because the same class of defect will happen again.

## Documentation

`README.md` is written for someone who does not yet know what MCP is: what the thing does, what it costs, how to start, and links out. Everything technical lives in `docs/` and is linked from the README's index table.

**When you add a feature, update the doc that owns it, not the README**, unless the change alters what the product is or what it costs. The README earns its length by staying short; a tool's full contract belongs in `docs/tools.md`.

Every doc is written in Luke's voice and must pass the voice lint before it ships:

```bash
python3 <create-luke-content>/scripts/voice_lint.py --format marketing README.md
```

Hard fails are em dashes and AI clichés.

Internal links are checked by `npm run lint:docs` (`scripts/check-doc-links.mjs`), which walks every markdown link and heading anchor in `docs/`, `blog/`, `README.md` and this file. A doc split is the moment links break, and nothing else in the toolchain notices. Run it after any doc restructure.

## Keeping this file honest

`AGENTS.md` is a **symlink** to this file; edit only `CLAUDE.md`, and never replace the symlink with a copy. Update it in the same change as any behaviour or architecture shift; new depth goes in a routed `docs/` reference, not here. **Working if:** diffs stay scoped to the request; every "done" report includes the CP §7 self-review with files covered; commands and paths cited here exist in the tree; docs and code land in the same change.
