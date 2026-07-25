# deep-research-mcp

An MCP server for **Google Gemini Deep Research**, built so an autonomous agent can drive it without burning your month's budget in a loop, losing a 45-minute job to a dropped connection, or dumping a 60,000-token report into a context window.

Built on [FastMCP](https://github.com/punkpeye/fastmcp). Ships the [`deep-research-prompt-creator`](#the-bundled-skill) skill and wraps **both** Gemini research surfaces — the [Deep Research API and the Managed Agents API](docs/deep-research-api-vs-agent.md).

```bash
npx deep-research-mcp        # stdio, ready for any MCP client
```

---

## Why this exists

Deep Research is an unusual API to wrap. Three of its properties break the assumptions most MCP servers are built on:

| Property | What naively wrapping it does |
|---|---|
| A task runs **4–60 minutes** in the background | The tool call times out, or the client disconnects and the job is orphaned |
| A task costs **$1–7, every time** | An agent in a retry loop spends $200 overnight and nobody finds out until the invoice |
| A report is **~60,000 tokens** | Returning it inline kills the session that asked for it |

So this server is opinionated about all three:

- **Jobs outlive connections.** Every state transition is persisted before it is reported. Disconnect mid-run, restart the server, come back tomorrow — the run is still there and `research_tail` replays exactly what you missed.
- **Money is a two-step handshake.** `research_plan` is free and returns a cost band plus a contract fingerprint. `research_start` spends. An agent that does not understand the handshake makes free no-ops instead of $7 mistakes, and identical requests de-duplicate onto one paid run.
- **Reports are read, not returned.** `research_read` defaults to an outline with per-section token estimates. You pull the sections you need.

---

## Install

### Claude Code

```bash
claude mcp add deep-research -e GEMINI_API_KEY=your-key -- npx -y deep-research-mcp
```

### Claude Desktop / any `mcpServers` config

```json
{
  "mcpServers": {
    "deep-research": {
      "command": "npx",
      "args": ["-y", "deep-research-mcp"],
      "env": {
        "GEMINI_API_KEY": "your-key-here",
        "DEEP_RESEARCH_BUDGET_USD": "25"
      }
    }
  }
}
```

### From source

```bash
git clone https://github.com/fledgeling-co/deep-research-mcp.git
cd deep-research-mcp
npm install && npm run build
GEMINI_API_KEY=... node dist/index.js
```

### Auth

Either works; Vertex wins if both are set.

```bash
# A — Google AI Studio (https://aistudio.google.com/apikey)
export GEMINI_API_KEY=...

# B — Vertex AI, via Application Default Credentials
export VERTEX_PROJECT=my-project
export VERTEX_LOCATION=global
gcloud auth application-default login
```

Vertex trade-off: File Search stores (`corpusStores`) are a Gemini Developer API feature and are **not** available on Vertex. If you want private-corpus grounding, use an API key.

Without credentials the server still starts and every read-only tool works — you just cannot start a run. See [`.env.example`](.env.example) for the full configuration surface.

---

## The shape of a session

```
research_plan          free       → cost band + contract fingerprint + the engineered prompt
   ↓
research_start         $1–7       → a handle, immediately. Do not block.
   ↓
research_approve_plan  free       → (only if collaborativePlanning) edit the plan, then release it
   ↓
research_status        free       → running / stalled / completed
research_tail          free       → replay progress from a cursor
   ↓
research_read          free       → outline → sections. Never the whole thing.
research_verify_citations         → dereference every cited URL
research_followup / research_claims
```

A worked example, verbatim:

```jsonc
// 1. Free. Check what you're about to buy.
research_plan {
  "question": "Which vector database has the lowest p99 query latency at 10M vectors?",
  "tier": "max",
  "scope": { "decisionContext": "choose a store for a 3-person team" },
  "collaborativePlanning": true
}
// → Archetype: technical
// → Estimated cost: $3.00-$7.00 · duration 10-60 minutes
// → Budget: $0.00 committed of $25.00 in the last 24h
// → Contract fingerprint: `016d2a2475ce8698609b289399341f0c`
// → ...the full engineered prompt, and the operator notes

// 2. Spends money. Returns in about a second.
research_start {
  "question": "Which vector database has the lowest p99 query latency at 10M vectors?",
  "tier": "max",
  "scope": { "decisionContext": "choose a store for a 3-person team" },
  "collaborativePlanning": true,
  "contractFingerprint": "016d2a2475ce8698609b289399341f0c",
  "label": "vector-db eval"
}
// → Run started. Handle: `dr_9f2a1c4e8b3d7a05`  (state: planning)

// 3. The highest-leverage thing you can do all day.
research_approve_plan {
  "runId": "dr_9f2a1c4e8b3d7a05",
  "amendment": "Drop the managed-cloud pricing comparison. Add self-hosted memory footprint at 10M vectors, and include quantisation trade-offs."
}

// 4. Later — a minute or a day, same answer.
research_status { "runId": "dr_9f2a1c4e8b3d7a05" }
// → completed · 47 cited sources

// 5. Outline first. Always.
research_read { "runId": "dr_9f2a1c4e8b3d7a05" }
// →   1. Executive Summary        (~420 tok)
//     2. Detailed Findings        (~180 tok)
//     3.   p99 latency at scale   (~3100 tok)
//     4.   Memory footprint       (~2400 tok)
//     5. Evidence Table           (~1900 tok)
//     6. Knowledge Gaps           (~310 tok)

research_read { "runId": "dr_9f2a1c4e8b3d7a05", "mode": "section", "section": "p99 latency" }

// 6. Before anyone acts on it.
research_verify_citations { "runId": "dr_9f2a1c4e8b3d7a05" }
// → Citation scorecard: VERIFIED — 44/47 resolved (94%).
//   live 44 · not_found 1 · blocked 2 · unreachable 0 · invalid 0
```

---

## Tools

### Research

#### `research_plan` — free
Returns the fully engineered prompt, the selected archetype, a cost and duration band, your current budget position, and a **contract fingerprint**. Spends nothing. Call it first for anything non-trivial — it is where you catch a badly scoped question before it costs $7.

| Parameter | Type | Notes |
|---|---|---|
| `question` | string | Your question, or an already-engineered brief (detected and passed through verbatim) |
| `tier` | `fast` \| `max` | Default `fast` |
| `archetype` | enum | `technical` \| `competitive` \| `regulatory` \| `academic` \| `forecasting`. Omit to auto-select |
| `scope` | object | `jurisdiction`, `timeHorizon`, `decisionContext`, `analysisLenses[]`, `exclude[]` |
| `corpusStores` | string[] | File Search store names to ground the run in |
| `collaborativePlanning` | boolean | Ask for a plan to review first |

#### `research_start` — **spends money**
Starts the run and returns a handle immediately. The run then proceeds for 4–60 minutes whether or not you are still connected.

Same parameters as `research_plan`, plus `contractFingerprint`, `label`, `tags[]`, and `attachments[]` (public URIs for PDFs or images the researcher should read).

Three gates run before a single dollar moves, in this order — all free:

1. **Dedupe.** An identical request (same normalised prompt, tier, tools, planning mode) inside the TTL returns the existing run. A retry storm collapses onto one job.
2. **Concurrency.** Refused past `DEEP_RESEARCH_MAX_CONCURRENT`.
3. **Budget.** Refused if the estimated cost would cross `DEEP_RESEARCH_BUDGET_USD` in the rolling window.

Set `DEEP_RESEARCH_REQUIRE_CONTRACT=true` to make the plan→start handshake mandatory. Recommended for any server an autonomous agent can reach.

#### `research_approve_plan`
Approve — optionally amending — the plan a collaborative-planning run proposed. Pruning tangential branches and injecting missing angles here is the single highest-leverage intervention available on a Deep Research run.

#### `research_status`
One run, or every run in flight. Reports **liveness separately from status**: a run with no forward progress inside the watchdog window is marked `stalled`, which is a state you can branch on. `in_progress` alone cannot tell a thinking run from a dead one.

#### `research_tail`
Replays the durable progress journal from a cursor. `{ runId, sinceSeq }` → events plus the next cursor. A client that dropped at minute 3 of a 45-minute run loses nothing.

> **Granularity, measured against the live API.** While a run is in flight, `interactions.get` returns only the echoed `user_input` step — the full step list is populated at completion. So the journal carries **lifecycle events** (`created`, `plan`, `progress`, `stalled`, `completed`, `failed`), not token-by-token reasoning. Live thought summaries exist only on the SSE stream, which this server does not yet consume ([#1](https://github.com/fledgeling-co/deep-research-mcp/issues/1)). Durability is unaffected: the journal is what survives your disconnect.

#### `research_read`
| `mode` | Returns |
|---|---|
| `outline` *(default)* | Table of contents with per-section token estimates |
| `section` | One section, by 1-based index or heading substring |
| `grep` | Matching lines with their containing section (literal by default; `regex: true` opts in) |
| `summary` | Title, abstract, and the Executive Summary |
| `full` | Everything, capped by `maxTokens` |

`maxTokens` (default 6,000) is a hard cap and truncation is always marked explicitly — silent truncation is how someone acts confidently on half a finding.

#### `research_verify_citations`
Dereferences every cited URL and returns a per-citation verdict plus a scorecard.

| Verdict | Meaning |
|---|---|
| `live` | Resolves |
| `not_found` | 404/410 — the citation is broken or fabricated |
| `blocked` | 401/402/403 — paywalled or bot-blocked; plausible but unconfirmed |
| `unreachable` | Network failure or timeout |
| `invalid_url` | Malformed, non-HTTP, or resolves to a private address |

Badges: `verified` (≥90% live), `partial`, `suspect` (>15% broken or invalid).

**The honest limit:** `live` means the URL resolves. It does not mean the source supports the claim it is attached to. Pair it with the `research-red-team` prompt.

#### `research_followup`
A cheap single model turn continuing the original interaction — it does **not** start a new research run and does not re-search the web. Far better than re-reading a whole report into context.

#### `research_claims`
Extracts load-bearing claims as portable cards (`claim`, `confidence`, `sourceUrl`, `evidence`) via structured output. Small enough to pass between agents where a whole report is not. Confidence is copied from the report, never re-assessed.

#### `research_list` · `research_cancel` · `research_budget`
List runs (reads the local store, not the API). Cancel an in-flight run — committed spend stays on the ledger, because Google bills for work already done. Report the spend position and largest commitments.

### Corpus — private documents

`corpus_create` · `corpus_list` · `corpus_add_file` · `corpus_delete`

File Search stores let a run search **your documents alongside the public web**. Pass store names as `corpusStores` and the server appends a grounding instruction that does two things: establishes a **hierarchy of truth** (internal documents are authoritative on internal facts, so high-fidelity data is not silently overwritten by whatever the web says louder), and requires an explicit **"Contradictions with the attached corpus"** section.

That contradictions section is usually the most valuable output. What the internet says is commodity; where it disagrees with what your team already believes is not.

> `corpus_add_file` **uploads the file to Google.** It is annotated non-read-only and says so in its description. Only add documents you are willing to disclose to a third-party API.

### Managed agents — the other surface

`agent_create` · `agent_list` · `agent_run` · `agent_delete`

Persisted custom agents with a real Linux sandbox (Ubuntu, Python 3.12, Node 22) that can run code, write files, and carry your house methodology across every run. Read [**Deep Research API vs the Managed Agents API**](docs/deep-research-api-vs-agent.md) for which surface fits your job — the short version is *Deep Research for a cited report, a managed agent for artifacts and code execution*.

One constraint worth knowing up front: at preview the only `base_agent` is Antigravity. **You cannot derive a custom agent from `deep-research-*`.** A custom agent complements a Deep Research run; it does not specialise one.

---

## Resources

| URI | Contents |
|---|---|
| `research://capabilities` | Version, auth mode, `degraded` flag, tiers with cost bands, archetypes, feature flags, budget |
| `research://budget` | Ledger snapshot plus every entry in the window |
| `research://runs` | Index of all runs |
| `research://run/{runId}` | Full run record |
| `research://run/{runId}/report` | The report markdown |
| `research://run/{runId}/citations` | Verification scorecard and per-citation verdicts |

## Prompts

| Name | Purpose |
|---|---|
| `deep-research-brief` | Turn a vague need into a fully engineered brief, ready for `research_start` |
| `research-red-team` | Adversarially audit a completed report — a concrete five-step procedure, not a vibe check |
| `research-triage` | Decide whether a question warrants a run at all, and at which tier, before spending anything |

---

## The bundled skill

[`skills/deep-research-prompt-creator/`](skills/deep-research-prompt-creator/) is a Claude Code skill that turns a vague research need into an engineered Gemini Deep Research prompt — pseudo-XML scaffolding, five archetype override sets, epistemic bounding tags, inline citation protocol, and the Operator Notes that wrap around the run.

```bash
cp -r skills/deep-research-prompt-creator ~/.claude/skills/
```

**The skill and the server compose.** When the server is connected, the skill hands its prompt straight over instead of printing it for you to paste. The server **detects an already-engineered brief and sends it verbatim** — it does not re-wrap it, because two `<role>` blocks and two competing `<output_format>` sections is precisely the over-specification failure the scaffold exists to avoid.

Detection triggers on a `<core_directive>` tag, or on any two structural tags together. So this works with a prompt from the skill, from another tool, or written by hand:

```jsonc
research_start {
  "question": "<role>\nYou are a senior research analyst...\n</role>\n\n<core_directive>\nAnswer this decisively: ...\n</core_directive>\n\n<output_format>\n...\n</output_format>"
}
// → "your brief was already engineered — it will be sent verbatim"
```

The same framework is also available three other ways without installing anything: the `deep-research-brief` MCP prompt, the automatic scaffolding inside `research_plan`, and the `buildPrompt()` export if you are importing this package as a library.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | — | Google AI Studio key |
| `VERTEX_PROJECT` / `VERTEX_LOCATION` | — / `global` | Vertex AI (takes precedence over the API key) |
| `DEEP_RESEARCH_STORE_DIR` | `~/.deep-research-mcp` | Where runs, journals, reports and the ledger live |
| `DEEP_RESEARCH_BUDGET_USD` | `25` | Hard ceiling per rolling window. `0` disables the gate |
| `DEEP_RESEARCH_BUDGET_WINDOW_HOURS` | `24` | Rolling window |
| `DEEP_RESEARCH_MAX_CONCURRENT` | `3` | Runs in flight at once |
| `DEEP_RESEARCH_REQUIRE_CONTRACT` | `false` | Make the plan→start handshake mandatory |
| `DEEP_RESEARCH_DEDUPE_TTL_MINUTES` | `1440` | Window for collapsing identical requests |
| `DEEP_RESEARCH_POLL_SECONDS` | `20` | Poll interval for in-flight runs |
| `DEEP_RESEARCH_STALL_MINUTES` | `12` | Silence before a run is marked `stalled` |
| `DEEP_RESEARCH_UTILITY_MODEL` | `gemini-3.1-pro-preview` | Titles, summaries, follow-ups, claim extraction |
| `DEEP_RESEARCH_HTTP_PORT` | `8787` | Port for `--transport http` |
| `DEEP_RESEARCH_HTTP_TOKENS` | — | Comma-separated bearer tokens for the HTTP transport |

Every value is Zod-validated once at startup; an invalid one fails fast with a readable message rather than surfacing as a mystery mid-run. An empty string is treated as unset, because a committed `.env.example` key is commonly present-but-empty.

### HTTP transport

```bash
DEEP_RESEARCH_HTTP_TOKENS=$(openssl rand -hex 32) deep-research-mcp --transport http --port 8787
```

Serves streamable HTTP at `/mcp`, SSE at `/sse`, health at `/health`. Tokens are compared in constant time. **Bind to loopback unless tokens are set** — the server warns if you do not.

---

## Costs, honestly

| Tier | Agent | Searches | Estimate | Typical duration |
|---|---|---|---|---|
| `fast` | `deep-research-preview-04-2026` | ~80 | **$1–3** | 4–20 min |
| `max` | `deep-research-max-preview-04-2026` | up to ~160 | **$3–7** | 10–60 min |

These are Google's published preview *estimate bands*, and the ledger commits the midpoint at start. **It is a spend guardrail, not an invoice** — reconcile against Google billing for actuals. Cancelling does not refund; Google bills for work already done.

Cheapest habits, in order of impact: `research_plan` before starting (free); `fast` unless breadth genuinely justifies double the cost; `research_followup` instead of a second run; let dedupe work by not varying wording between retries.

---

## Security

Deep Research reads the open web on your behalf, and Google's own documentation flags prompt injection from untrusted pages, exposure to malicious sites, and exfiltration risk when internal data meets web browsing. This server takes concrete positions:

- **Citation verification is SSRF-safe.** URLs come out of a model that was reading untrusted pages, so they are treated as untrusted input: scheme allowlist, DNS resolution checked against private/loopback/link-local/CGNAT ranges (including `169.254.169.254`), redirects followed manually and re-validated per hop, explicit timeouts, response-size caps.
- **Private corpus access goes through File Search, not a live endpoint.** Deep Research can call a remote `mcp_server` tool mid-run — which means a poisoned web page could, in principle, steer it into calling your tools. This server deliberately grounds private context through Google's retrieval layer instead, so there is no live endpoint for a compromised run to reach.
- **Data-egress tools are labelled.** `corpus_add_file` is annotated non-read-only and its description states plainly that the file leaves your machine.
- **Secrets never reach a log or a fingerprint.** MCP auth headers are excluded from the dedupe hash (so a rotated token does not fork the key), and error messages carry no credential material.
- **Every boundary is Zod-parsed, never cast** — API responses, stored records, config, and model output alike. A malformed store record is skipped, not fatal; an unparseable interaction fails loudly rather than pretending to succeed.

---

## Library use

```ts
import { buildPrompt, selectArchetype } from 'deep-research-mcp/server';

const { prompt, archetype, preEngineered } = buildPrompt({
  question: 'What are the disclosure obligations for dual-listed issuers?',
  scope: { jurisdiction: 'UK and Singapore', decisionContext: 'inform a board paper' },
});
```

`createServer(deps)` and `buildDeps(config)` are exported too, so you can mount the tools inside an existing FastMCP server or inject a fake `DeepResearchClient` for tests.

---

## Development

```bash
npm install
npm run dev        # tsx src/index.ts
npm run typecheck  # tsc --noEmit, strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
npm test           # vitest — hermetic, no network, no keys
npm run build
npm run gate       # typecheck && test && build — run before pushing
npm run inspect    # MCP Inspector
```

The test suite is hermetic by construction: `DEEP_RESEARCH_HERMETIC=1` means a live client is never constructed, so a stray key in your environment cannot make the tests spend money. Every test injects a scripted `DeepResearchClient` and points the store at a temp directory.

---

## License

MIT © fledgeling-co
