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

- **No Next.js, no Vercel, no Mongo, no Redis.** This is a stdio/HTTP MCP server distributed on npm. Persistence is a plain atomic-write JSON + JSONL store on the local filesystem (`src/store/`); adding a database would make the server undeployable as `npx dossier-mcp`.
- **npm, single package, no monorepo** (BP §17); one deployable.
- **Vitest over Playwright** (BP §15); there is no UI. The equivalent of an E2E test here is the stdio MCP handshake smoke check described below.
- **No hosted CI** (BP §19). The gate is `npm run gate`, run before pushing.
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
  research/
    archetypes.ts       the 5 archetype override tables + keyword selection
    prompt.ts           the prompt architect: scaffold builder + pre-engineered passthrough
    contract.ts         fingerprint / dedupe key; the two-step spend handshake
    report.ts           outline / section / grep / clamp. Pure string work
    citations.ts        citation verification + scorecard
    runner.ts           run lifecycle, poller, stall watchdog, budget + concurrency gates
  store/
    store.ts            atomic-write JSON store, JSONL journal, JSONL ledger
    types.ts            persisted Zod schemas; read back from disk = a trust boundary
  corpus/files.ts       File Search stores (private-corpus grounding)
  net/safe-fetch.ts     SSRF-safe fetch: DNS validation, per-hop redirect checks, caps
  ai/utility.ts         AI SDK v7; Output.object for every structured result
assets/                 icon.svg (master, 1024) + rendered PNGs, banner, social preview
docs/
  deep-research-api-vs-agent.md   when to use which Gemini surface (linked from the README)
skills/deep-research-prompt-creator/   the bundled Claude Code skill (shipped in the package)
tests/                  hermetic vitest; no network, no keys
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
npm run gate       # typecheck && lint && test && build; run before pushing
npm run inspect    # build, then MCP Inspector
```

**The quality gate is `npm run gate`, run manually before pushing** (BP §19). Toolchain matches the org's other repos: **tsgo** (`@typescript/native-preview`) compiles and typechecks, **eslint 9** flat + type-aware lints, **vitest** with the **swc** transform tests. `typescript@~6` is present only to satisfy typescript-eslint's peer range; tsgo does the real checking. There is intentionally no hosted CI. Run a single test file with `npx vitest run tests/runner.test.ts`.

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

## Keeping this file honest

`AGENTS.md` is a **symlink** to this file; edit only `CLAUDE.md`, and never replace the symlink with a copy. Update it in the same change as any behaviour or architecture shift; new depth goes in a routed `docs/` reference, not here. **Working if:** diffs stay scoped to the request; every "done" report includes the CP §7 self-review with files covered; commands and paths cited here exist in the tree; docs and code land in the same change.
