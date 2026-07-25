<div align="center">

<img src="assets/banner.png" alt="Dossier: Gemini Deep Research as an MCP server" width="820">

<br>

[![npm](https://img.shields.io/npm/v/dossier-research-mcp?color=C8321F&labelColor=1B1513)](https://www.npmjs.com/package/dossier-research-mcp)
[![node](https://img.shields.io/badge/node-%E2%89%A520.11-1B1513?labelColor=1B1513&color=C8321F)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-2025--06--18-1B1513?labelColor=1B1513&color=C8321F)](https://modelcontextprotocol.io)
[![tests](https://img.shields.io/badge/tests-231%20hermetic-1B1513?labelColor=1B1513&color=C8321F)](#development)
[![license](https://img.shields.io/badge/license-MIT-1B1513?labelColor=1B1513&color=C8321F)](LICENSE)

**Gemini Deep Research, wrapped so an agent can drive it safely.**<br>
Your runs survive a dropped connection. Your budget survives a retry loop.<br>Your context window survives the report.

```bash
npx dossier-research-mcp
```

</div>

---

## Why this exists

Deep Research is an odd API to wrap. Three of its properties break assumptions most MCP servers are built on, and you hit all three on day one.

| Property | What you get if you wrap it naively | What Dossier does |
|---|---|---|
| A task runs **4-60 minutes** in the background | The tool call times out, or your client disconnects and the job is orphaned | **Jobs outlive connections.** Every state change hits disk before it's reported |
| A task costs **$1-7, every time** | An agent in a retry loop spends $200 overnight and you find out from the invoice | **Two-step spend handshake**, plus dedupe and a budget gate |
| A report is **~60,000 tokens** | Returning it inline kills the session that asked for it | **Outline first**, sections on demand, hard token caps |

None of that is bolted on. Durability, spend control and context discipline shape every module in `src/`; take any one of them out and the design stops making sense.

---

## The shape of a session

```mermaid
flowchart LR
    A["research_plan<br/><b>free</b>"] --> B["research_start<br/><b>$1-7</b>"]
    B --> C{"collaborative<br/>planning?"}
    C -->|yes| D["research_approve_plan<br/>prune, extend, narrow"]
    C -->|no| E
    D --> E["4-60 min<br/>background"]
    E --> F["research_status<br/>research_tail"]
    F --> G["research_read<br/>outline, then section"]
    G --> H["research_verify_citations"]
    H --> I["research_claims<br/>research_followup"]

    style A fill:#1B1513,stroke:#C8321F,color:#F0E6CE
    style B fill:#C8321F,stroke:#7C1A0B,color:#ffffff
    style D fill:#1B1513,stroke:#C8321F,color:#F0E6CE
    style E fill:#2E2622,stroke:#6E1206,color:#F0E6CE
    style G fill:#1B1513,stroke:#C8321F,color:#F0E6CE
    style H fill:#1B1513,stroke:#C8321F,color:#F0E6CE
```

`research_start` hands you a **handle** in about a second. Everything after it is optional, resumable, and survives you closing the laptop.

---

## Install

<details open>
<summary><b>Claude Code</b></summary>

<br>

```bash
claude mcp add dossier -e GEMINI_API_KEY=your-key -- npx -y dossier-research-mcp
```

</details>

<details>
<summary><b>From source</b></summary>

<br>

```bash
git clone https://github.com/fledgeling-co/dossier-research-mcp.git
cd dossier-research-mcp && npm install && npm run build

# then point any MCP client at it
claude mcp add dossier -e GEMINI_API_KEY=your-key -- node "$PWD/dist/index.js"
```

</details>

<details>
<summary><b>Claude Desktop, or any <code>mcpServers</code> config</b></summary>

<br>

```json
{
  "mcpServers": {
    "dossier": {
      "command": "npx",
      "args": ["-y", "dossier-research-mcp"],
      "env": {
        "GEMINI_API_KEY": "your-key-here",
        "DOSSIER_BUDGET_USD": "25"
      }
    }
  }
}
```

</details>

<details>
<summary><b>HTTP transport</b> (remote or shared)</summary>

<br>

```bash
DOSSIER_HTTP_TOKENS=$(openssl rand -hex 32) \
  npx dossier-research-mcp --transport http --port 8787
```

Streamable HTTP on `/mcp`, SSE on `/sse`, health on `/health`. Bearer tokens are compared in constant time.

> [!WARNING]
> Bind to loopback unless you've set `DOSSIER_HTTP_TOKENS`. The server warns you on start-up if you haven't.

</details>

### Auth

Either backend works. **Vertex wins if you've set both.**

```bash
# A. Google AI Studio: https://aistudio.google.com/apikey
export GEMINI_API_KEY=...

# B. Vertex AI, via Application Default Credentials
export VERTEX_PROJECT=my-project
export VERTEX_LOCATION=global
gcloud auth application-default login
```

> [!IMPORTANT]
> **An API key is the fuller backend, not the lesser one.** Vertex adds enterprise controls (VPC-SC, CMEK, data residency, IAM) and loses capability, which is the opposite of what most people expect. On Vertex you don't get:
>
> - **Corpus grounding.** File Search stores are a Gemini Developer API feature.
> - **`research_followup`.** The Interactions API on Vertex serves agents and specialised media models, not the standard Gemini models a follow-up turn needs.
> - **AI titles, summaries and `research_claims`.** Same reason; they run on standard models.
>
> Deep Research runs and managed agents are expected to work there, but I haven't verified that against a live Vertex project. The server prints these limitations at start-up and lists them in `research://capabilities`, so pick Vertex when compliance requires it, not by default.

With no credentials the server still starts and every read-only tool works. You just can't start a run.

---

## "The Deep Research agent" vs "the Deep Research API"

Worth clearing up, because the two names get used as if they were alternatives and they are not.

**There is no separate Deep Research API.** Deep Research is an *agent*. The Interactions API is the *transport* you invoke it through. When people say "the Deep Research API" they mean the pair.

```
POST /v1beta/interactions          <- the Interactions API (transport, GA)
  { "agent": "deep-research-preview-04-2026",   <- the agent (what does the work)
    "background": true, "store": true }
```

Google currently ships **two managed agents** on that transport, and *that* is the real distinction:

| | **Deep Research** | **Antigravity** |
|---|---|---|
| What it is | A pre-built research agent you cannot modify | A general harness you build your own agent on |
| Agent ids | `deep-research-preview-04-2026` (fast)<br>`deep-research-max-preview-04-2026` (max) | `antigravity-preview-05-2026` |
| Configure it | Per call, via `agent_config` and `tools` | Persist it once with `agents.create`, then reference it by id |
| Gives you | A planned, executed, cited report | A Linux sandbox that does whatever you told it to |
| In Dossier | `research_start` | `agent_create` / `agent_run` |

Roughly how they arrived, since the naming has moved:

- **Dec 2025**: `deep-research-pro-preview-12-2025`, the first preview. Still listed, superseded, and **not exposed by this server**.
- **Apr 2026**: `deep-research-preview-04-2026` and its `-max` sibling. The current pair, and what `tier: fast | max` selects between.
- **May 2026**: `antigravity-preview-05-2026` plus `agents.create`, which is what made *custom* managed agents possible.

The trap in that timeline: **`agents.create` only accepts Antigravity as a `base_agent`.** So the appealing idea, forking Deep Research and baking in your house source discipline, is not available. A custom agent complements a Deep Research run; it does not specialise one.

📖 **[The full comparison](docs/deep-research-api-vs-agent.md)** covers which to reach for, how to compose them, and the third option of rolling your own loop.

---

## Setting up from scratch

### 1. Get a Gemini API key

Every Gemini API key belongs to a Google Cloud project. If you have never used Cloud, AI Studio makes one for you; if you have, you import an existing one.

1. Go to **[aistudio.google.com/apikey](https://aistudio.google.com/apikey)** and sign in.
2. Click **Create API key**. A brand-new account gets a default Cloud project made for it once you accept the terms; the key is created against that.
3. Copy the key. It is shown once.

Already a Cloud user and want a specific project? Open **Dashboard → [Projects](https://aistudio.google.com/projects) → Import projects**, pick it, then create the key from **API Keys**.

If **Create API key** is greyed out you lack permission on that project. You need a role covering `apikeys.keys.create` and `serviceusage.services.enable` (Project Editor covers it), or make a fresh project outside your organisation.

### 2. Decide free or paid

The free tier works and needs no card, but it has rate limits and, per Google, free-tier prompts and responses may be used to improve their products. Paid tier excludes that.

To go paid: on **[API keys](https://aistudio.google.com/api-keys)** or **[Projects](https://aistudio.google.com/projects)**, find the project and click **Set up billing** in the *Billing Tier* column. Expect a $10 minimum prepay.

> [!IMPORTANT]
> Deep Research is **not on the free tier** in any useful sense. A single run is $1-7 of metered spend, so a free-tier key will rate-limit or refuse rather than run. Budget for paid before you plan around this server.

### 3. Set a spend cap at Google's end

Do this before your first run, not after your first invoice.

| Where | What it does |
|---|---|
| **[aistudio.google.com/spend](https://aistudio.google.com/spend)** → *Monthly spend cap* → **Edit spend cap** | Per-project monthly cap. Marked experimental by Google. Needs editor, owner or admin on the project |
| **[Billing](https://aistudio.google.com/billing)** → *Manage auto-reload* → **Monthly Limit** | Prepay only. Stops auto top-ups for the cycle once reached |
| Automatic, per billing account | Tier 1 $250 · Tier 2 $2,000 · Tier 3 $20,000-$100,000. Hitting it pauses every project on that billing account until the next cycle |

Watch spend at **[Dashboard → Usage](https://aistudio.google.com/usage)**.

> [!CAUTION]
> **Google's cap is not hard, and Deep Research is the exact case where it leaks.** Their billing pipeline lags around ten minutes, and their own docs say long-running work "like batch mode and agents may incur overages beyond your project spend cap". A Deep Research run is a long-running agent.
>
> This is why Dossier keeps its own ceiling. It reserves the worst-case cost *before* the call is made rather than reconciling after, so it refuses early where Google's cap discovers the overage late. Use both: Google's as the backstop, `DOSSIER_BUDGET_USD` as the thing that actually stops a runaway agent.

### 4. Point the server at it

```bash
export GEMINI_API_KEY=your-key-here          # zsh: add to ~/.zshrc, then `source ~/.zshrc`
export DOSSIER_BUDGET_USD=100                # your daily ceiling. This is the default
claude mcp add dossier -e GEMINI_API_KEY=$GEMINI_API_KEY -- npx -y dossier-research-mcp
```

Check it took:

```
research_budget          # should report $0.00 of $100.00 committed
```

### Using Vertex AI instead

Only if compliance requires it. **Read the [Vertex trade-off](#auth) first**, because you lose corpus grounding, follow-ups, titles, summaries and claim extraction.

```bash
gcloud auth application-default login
gcloud config set project my-project
gcloud services enable aiplatform.googleapis.com
export VERTEX_PROJECT=my-project
export VERTEX_LOCATION=global
```

The account needs `aiplatform.interactions.create` (`roles/aiplatform.user` covers it). Vertex takes precedence if `GEMINI_API_KEY` is also set, and the server prints what you have lost at start-up.

---

## A real session

This is verbatim output from a live `fast`-tier run, trimmed for length.

```jsonc
// 1. Free. See exactly what you're about to buy.
research_plan {
  "question": "Which open-source vector databases support scalar and binary quantization, and what memory footprint do their own docs report at 10 million vectors?",
  "tier": "fast",
  "scope": { "decisionContext": "pick a self-hosted store for a small team" }
}
```

```text
Archetype: technical
Estimated cost: $1.00-$3.00, ~80 searches, ~250k input tokens…
Estimated duration: 4-20 minutes, background.
Budget: $0.00 committed of $10.00 in the last 24h; $10.00 remaining.
Contract fingerprint: dbc239386807d76bf5573328dd926baf
```

```jsonc
// 2. This one spends money. Returns in ~1s with a handle. Don't block on it.
research_start { /* …same args… */ "contractFingerprint": "dbc239386807d76bf5573328dd926baf" }
```

```text
Run started. Handle: dr_4dea031ff91d84fc
Committed against your budget: ~$2.00 (band $1.00-$3.00)

# call it again with identical args and you get:
De-duplicated onto an existing run, nothing new was charged.
```

```jsonc
// 3. Later. A DIFFERENT server process polled this one; the process that
//    started it was killed immediately after step 2.
research_status { "runId": "dr_4dea031ff91d84fc" }   // completed, 30 cited sources

// 4. Outline first, always. ~8,000 tokens of report, surveyed in ~200.
research_read { "runId": "dr_4dea031ff91d84fc" }
```

```text
Report outline: 19 sections, ~8070 estimated tokens total.
  1. Open-Source Vector Database Memory Economics…   (~25 tok)
  2.   Executive Summary                             (~642 tok)
  4.     Primary: Which databases support…           (~566 tok)
  5.       Qdrant                                    (~583 tok)
  6.       Milvus                                    (~458 tok)
 16.   Evidence Table                                (~539 tok)
 17.   Knowledge Gaps                                (~352 tok)
```

```jsonc
research_read { "runId": "dr_4dea031ff91d84fc", "mode": "section", "section": "Executive Summary" }
```

```text
(High Confidence) Qdrant's official capacity planning documentation provides
explicit mathematical formulas indicating that 10 million 1,024-dimensional
float32 vectors require 57.2 GB of active RAM. Scalar quantization reduces
this by a factor of 4 (~14.3 GB); binary by a factor of 32 (~1.8 GB).
```

```jsonc
// 5. Before anyone acts on it.
research_verify_citations { "runId": "dr_4dea031ff91d84fc" }
```

```text
Citation scorecard: PARTIAL, 25/30 resolved (83%).
  live 25 · not_found 0 · blocked 5 · unreachable 0 · invalid 0
  - blocked (403) https://medium.com/@…   paywalled or bot-blocked
  - blocked       https://milvus.io/docs/overview.md
    server redirects this URL to itself, typically a bot deterrent;
    the source is probably fine, open it in a browser to confirm
```

---

## Tools

<details open>
<summary><b>Research</b> (12 tools)</summary>

<br>

### `research_plan`, free

You get the engineered prompt, the archetype it picked, cost and duration bands, your budget position, and a **contract fingerprint**. It spends nothing. Call it first for anything non-trivial; it's where you catch a badly scoped question before it costs you $7.

| Parameter | Type | Notes |
|---|---|---|
| `question` | `string` | Your question, or an already-engineered brief (detected, sent verbatim) |
| `tier` | `fast` \| `max` | Defaults to `fast` |
| `archetype` | `enum` | `technical`, `competitive`, `regulatory`, `academic`, `forecasting`. Omit and it picks one |
| `scope` | `object` | `jurisdiction`, `timeHorizon`, `decisionContext`, `analysisLenses[]`, `exclude[]` |
| `corpusStores` | `string[]` | File Search stores to ground the run in |
| `collaborativePlanning` | `boolean` | Get a plan back to review before it executes |

> [!TIP]
> Of the fields here, I reckon `scope.decisionContext` is the one worth filling in. What you'll actually *do* with the findings drives the analysis lens, and telling the researcher how to think about what it finds tends to do more than telling it what to look for.

### `research_start`, spends money

Starts the run and hands back a handle. Three gates run first, and **all three are free**.

```mermaid
flowchart LR
    R["request"] --> D{"identical run<br/>inside the TTL?"}
    D -->|yes| X["return the existing one<br/><b>$0</b>"]
    D -->|no| C{"under the<br/>concurrency cap?"}
    C -->|no| E1["refused"]
    C -->|yes| B{"under the<br/>budget ceiling?"}
    B -->|no| E2["refused"]
    B -->|yes| L["ledger write"] --> P["paid API call"]

    style X fill:#1B1513,stroke:#C8321F,color:#F0E6CE
    style P fill:#C8321F,stroke:#7C1A0B,color:#ffffff
    style E1 fill:#2E2622,stroke:#6E1206,color:#F0E6CE
    style E2 fill:#2E2622,stroke:#6E1206,color:#F0E6CE
```

The ledger is written *before* the interaction, so a crash between the two over-counts rather than under-counts. That's the safe direction for a spend gate.

Set `DOSSIER_REQUIRE_CONTRACT=true` to make the plan-then-start handshake mandatory. Worth doing on any server an autonomous agent can reach.

### `research_approve_plan`

Approve the plan a collaborative-planning run proposed, amending it if you want.

> [!TIP]
> Pruning tangential branches and injecting the angles it missed is the highest-leverage thing you can do to a Deep Research run. Zero-shot autonomous execution is the wrong default for anything you'll be held to.

### `research_status` and `research_tail`

Status reports **liveness separately from state**. A run with no forward progress inside the watchdog window gets marked `stalled`, which you can branch on; `in_progress` on its own can't tell you the difference between a run that's thinking and one that's dead.

`research_tail` replays the durable journal from a cursor. Pass `{ runId, sinceSeq }`, get events plus the next cursor.

> [!NOTE]
> **Timing, measured against the live API. This is the honest version, and it is not the one I expected.**
>
> Polling shows nothing mid-run: `interactions.get` returns only the echoed `user_input` step until the run finishes, then delivers everything at once.
>
> So the server also consumes the SSE stream, which does connect and does deliver reasoning summaries. But on a 7.1-minute `fast` run it delivered **nothing until completion**: zero reasoning steps recorded while the run was in flight, then the whole thing at the end. On the evidence, a Deep Research background run buffers its stream rather than emitting incrementally.
>
> What that means for you: `research_tail` gives you clean, coalesced reasoning entries and a report you can read, but **treat mid-run progress as unavailable** rather than expecting a live feed. The plumbing is in place if the API starts emitting incrementally; it is not doing so today. Tracked in [#1](https://github.com/fledgeling-co/dossier-research-mcp/issues/1).

### `research_read`

| `mode` | What you get |
|---|---|
| `outline` *(default)* | Table of contents with per-section token estimates |
| `section` | One section, by 1-based index or heading substring |
| `grep` | Matching lines with their containing section. Literal by default; `regex: true` opts in |
| `summary` | Title, abstract, Executive Summary |
| `full` | Everything, capped by `maxTokens` |

`maxTokens` defaults to 6,000 and it's a hard cap. **Truncation is always marked in the text**, because silent truncation is exactly how someone acts confidently on half a finding.

### `research_verify_citations`

| Verdict | What it means |
|---|---|
| `live` | Resolves |
| `not_found` | 404 or 410; broken, or fabricated |
| `blocked` | 401/402/403, or a self-redirect loop. Paywalled or bot-blocked, so plausible but unconfirmed |
| `unreachable` | Network failure or timeout |
| `invalid_url` | Malformed, non-HTTP, or resolves to a private address |

Badges: `verified` at 90% live or better, then `partial`, then `suspect` above 15% broken or invalid.

> [!CAUTION]
> **`live` means the URL resolves. It doesn't mean the source supports the claim it's attached to.** Matching a claim to its source semantically would need a model call per citation and would still be a judgement rather than a fact, so this tool doesn't pretend to do it. Pair it with the `research-red-team` prompt.

### `research_followup` and `research_claims`

`research_followup` is one cheap model turn continuing the original interaction. It doesn't start a new research run and it doesn't re-search the web.

`research_claims` pulls the load-bearing claims out as portable cards (`claim`, `confidence`, `sourceUrl`, `evidence`), small enough to pass between agents where a whole report isn't. **Confidence is copied from the report, never re-assessed.**

### `research_list`, `research_cancel`, `research_budget`

List runs, which reads the local store rather than the API, so it's cheap. Cancel an in-flight run; the committed spend stays on the ledger, because Google bills for work already done. Check your spend position and largest commitments.

</details>

<details>
<summary><b>Corpus</b>: your own documents (4 tools)</summary>

<br>

`corpus_create` · `corpus_list` · `corpus_add_file` · `corpus_delete`

File Search stores let a run search **your documents alongside the public web**. Pass store names in `corpusStores` and the server appends a grounding instruction that does two things.

First, it sets a **hierarchy of truth**: your internal documents are authoritative on internal facts, so your own numbers don't get quietly overwritten by whatever the web says louder. Second, it requires a **"Contradictions with the attached corpus"** section.

When it works, that contradictions section is the most useful thing in the report. What the internet says about your problem is commodity; where it disagrees with what your team already believes isn't.

> [!WARNING]
> `corpus_add_file` **uploads the file to Google.** It's annotated non-read-only and its description says so plainly. Only add documents you're happy to hand to a third-party API.

> [!IMPORTANT]
> **Rough edge, disclosed in place.** In my one live test of this, the corpus was indexed, the `file_search` tool was attached, and both instructions were in the prompt; the researcher then produced a 12,660-token report with zero references to the corpus. The cause was almost certainly placement, since the block was being appended *after* the closing `<core_directive>`, which is both the weakest position in the prompt and a spot that broke the anti-drift anchor. That's fixed: the block now sits inside the scaffold and the contradictions section is part of `<output_format>`. I haven't re-run a paid job to confirm the fix end to end, so treat corpus grounding as attached-and-instructed rather than proven until you've seen it work on your own corpus.

</details>

<details>
<summary><b>Managed agents</b>: the other Gemini surface (4 tools)</summary>

<br>

`agent_create` · `agent_list` · `agent_run` · `agent_delete`

Persisted custom agents with a real Linux sandbox (Ubuntu, Python 3.12, Node 22) that can run code, write files, and carry your house methodology across every run.

**[Deep Research API vs the Managed Agents API](docs/deep-research-api-vs-agent.md)** covers which surface fits which job, and the third option of rolling your own.

> [!IMPORTANT]
> At preview the only `base_agent` on offer is Antigravity, so **you can't derive a custom agent from `deep-research-*`**. A custom agent complements a Deep Research run; it doesn't specialise one.

</details>

---

## Resources and prompts

| Resource URI | What's in it |
|---|---|
| `research://capabilities` | Version, auth mode, `degraded` flag, tiers and cost bands, archetypes, feature flags, budget |
| `research://budget` | Ledger snapshot plus every entry in the window |
| `research://runs` | Index of all runs |
| `research://run/{runId}` | The full run record |
| `research://run/{runId}/report` | The report markdown |
| `research://run/{runId}/citations` | Verification scorecard and per-citation verdicts |

| Prompt | What it's for |
|---|---|
| `deep-research-brief` | Turns a vague need into an engineered brief, ready for `research_start` |
| `research-red-team` | Audits a finished report adversarially. A five-step procedure, not a vibe check |
| `research-triage` | Works out whether a question deserves a run at all, and at which tier, before you spend |

---

## The bundled skill

[`skills/deep-research-prompt-creator/`](skills/deep-research-prompt-creator/) is a Claude Code skill that turns a vague research need into an engineered Gemini Deep Research prompt: pseudo-XML scaffolding, five archetype override sets, epistemic bounding tags, an inline citation protocol, and the Operator Notes that wrap around the run.

```bash
cp -r skills/deep-research-prompt-creator ~/.claude/skills/
```

**The skill and the server compose.** With the server connected, the skill hands its prompt straight over instead of printing it for you to paste. The server spots an already-engineered brief and sends it **verbatim**; it won't re-wrap it, because two `<role>` blocks and two competing `<output_format>` sections is precisely the over-specification failure the scaffold exists to prevent.

Detection fires on a `<core_directive>` tag, or on any two structural tags together. So it works with a prompt from the skill, from another tool, or one you wrote by hand.

```jsonc
research_start {
  "question": "<role>…</role>\n\n<core_directive>…</core_directive>\n\n<output_format>…</output_format>"
}
// "your brief was already engineered, it will be sent verbatim"
```

You can get the same framework three other ways without installing anything: the `deep-research-brief` MCP prompt, the automatic scaffolding inside `research_plan`, or the `buildPrompt()` export.

---

## How it picks what to run

Two decisions get made for you unless you override them. Both are worth understanding, because one costs money and the other costs quality.

### The tier: `fast` or `max`

**It does not choose.** `tier` defaults to `fast` and nothing infers it, deliberately. An automatic escalation to `max` is a silent decision to spend $3-7 instead of $1-3, and a server that quietly triples your bill because it judged a question "complex" is not one you can leave an agent alone with.

So the choice is yours, and `research_plan` exists to make it an informed one: it shows the band and your remaining budget before anything is spent.

| Use `fast` | Use `max` |
|---|---|
| A scoped question with a handful of sub-questions | Breadth genuinely needs ~160 searches rather than ~80 |
| You will read it today | A decision you will be held to |
| The default, and right most of the time | Roughly double the cost and up to triple the wall-clock |

The `research-triage` prompt walks the prior question, which is whether it warrants a run at all. Most questions do not: if a single model call or one web search answers it, that is the correct tool.

### The archetype: how the brief gets written

This one **is** automatic, because it changes the prompt rather than the price. Five archetypes, each a self-contained override set applied to the pseudo-XML scaffold. Exactly one is applied; they are never blended.

Selection is keyword scoring over your question, and the counts are what decide it, not a model call. Ties and no-match fall to `competitive`, because its overrides are the broadest and the cost of guessing it wrong is mild (some extra sentiment mining) where guessing `regulatory` wrong puts a legal disclaimer on a technical report.

| Archetype | Triggered by | What it changes |
|---|---|---|
| `technical` | api, architecture, latency, benchmark, sdk, throughput, runtime | Prioritises official docs, repos, published benchmarks. Demands exact latency figures, schemas and rate limits verbatim. Requires a comparison table |
| `competitive` | market, pricing, positioning, gtm, rival, landscape, churn | Prioritises filed financials and organic customer sentiment. Adds pain-point mining and demands two named underserved gaps |
| `regulatory` | regulation, compliance, disclosure, jurisdiction, statute, enforcement | Prioritises primary legal texts and regulator publications. Tags every finding `<ENACTED>`/`<PENDING>`/`<GUIDANCE>`/`<PROPOSED>`. Appends a not-legal-advice notice |
| `academic` | peer-reviewed, methodology, p-value, sample size, systematic review | Prioritises journals and proceedings. Demands methodology, sample size and effect sizes per study, not just abstracts |
| `forecasting` | forecast, outlook, projection, scenario, capex, five-year | Demands underlying drivers over surface trends, and divergent scenarios with named break conditions |

Pass `archetype` explicitly to override. `research_plan` tells you which one it picked and shows the prompt it produced, so you can check before spending.

> [!TIP]
> If your question spans two archetypes, that is a **decomposition signal, not a reason to widen the prompt**. A run trying to satisfy both competitive and regulatory analysis satisfies neither. Split it into separate runs sharing a role and context but varying the core directive, then synthesise.

---

## The utility model

Deep Research returns prose and offers no structured output, so anything typed has to be extracted afterwards. A second, much cheaper model does that work: titles and summaries when a run lands, `research_claims`, and the fallback path in `research_followup`.

It is a rounding error next to the research itself. A run is $1-7; these calls are fractions of a cent each. **`DOSSIER_UTILITY_MODEL` is about latency, quality and availability, not cost.**

Default: `gemini-3.1-pro-preview`.

| Model | Why you would pick it |
|---|---|
| `gemini-3.1-pro-preview` *(default)* | Best extraction quality of the practical options. Claim cards keep the report's own confidence qualifiers instead of drifting, and summaries stay specific rather than generic. Slowest and dearest of these, which does not matter at this volume |
| `gemini-3.6-flash` | Newest Flash. Noticeably faster; good when you extract claims in bulk or want a title the instant a run completes. Slightly likelier to smooth a hedged claim into a confident one, which matters because these cards get passed to other agents |
| `gemini-3.5-flash` | The stable Flash, no preview label. Reach for it if you would rather not depend on a preview model for a production path |
| `gemini-3.1-flash-lite-preview` / `gemini-3.5-flash-lite` | Cheapest and fastest. Fine for titles and summaries; I would not use it for `research_claims`, where the job is to copy confidence levels faithfully rather than paraphrase |
| `gemini-3-pro-preview` | The prior Pro. Useful only if you have measured something you dislike about 3.1 |

Check what your key can actually reach, since availability varies by project and tier:

```bash
curl -s "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200" \
  -H "x-goog-api-key: $GEMINI_API_KEY" | grep -o '"name": "models/[^"]*"'
```

> [!NOTE]
> The utility model is **not** the researcher. It never runs the investigation and it cannot change what the report says; it only reads a finished report and extracts from it. Changing it will not make research better or worse, only the titles, summaries and claim cards.
>
> It is also Developer-API only. On Vertex there is no utility model, so titles, summaries and `research_claims` are unavailable there.

---

## Configuration

<details>
<summary><b>Every environment variable</b></summary>

<br>

Every value is Zod-validated once at start-up, so an invalid one fails fast with a readable message rather than surfacing as a mystery mid-run. An empty string counts as unset, because a committed `.env.example` key is very often present-but-empty.

**Credentials.** Set one of these two. Vertex wins if you set both.

| Variable | Default | What it does |
|---|---|---|
| `GEMINI_API_KEY` | | Google AI Studio key. The full-capability backend |
| `GOOGLE_API_KEY` | | Accepted as an alias if `GEMINI_API_KEY` is unset |
| `VERTEX_PROJECT` | | GCP project id. Setting it switches to Vertex and **disables corpus grounding, follow-ups, titles, summaries and claim extraction** |
| `VERTEX_LOCATION` | `global` | Vertex region. Only read when `VERTEX_PROJECT` is set |

**Spend control.** The reason this server exists in the shape it does.

| Variable | Default | What it does |
|---|---|---|
| `DOSSIER_BUDGET_USD` | `100` | Hard ceiling per rolling window, in USD. A run reserves its **worst-case** cost against this before the call is made, so the gate refuses early rather than discovering an overage. `0` disables it, which the budget tool then says out loud |
| `DOSSIER_BUDGET_WINDOW_HOURS` | `24` | The rolling window. With the default budget that is $100/day |
| `DOSSIER_MAX_CONCURRENT` | `10` | Runs in flight at once. Checked inside the same lock as the budget, so parallel calls cannot slip past it |
| `DOSSIER_REQUIRE_CONTRACT` | `false` | Makes `research_plan` → `research_start` mandatory. **Turn this on for any server an autonomous agent can reach**: without the fingerprint from a plan, a looping agent makes free no-ops instead of $7 mistakes |
| `DOSSIER_DEDUPE_TTL_MINUTES` | `1440` | How long an identical request collapses onto the existing run instead of paying again. Set `0` to disable, which you almost never want |

**Runtime.**

| Variable | Default | What it does |
|---|---|---|
| `DOSSIER_STORE_DIR` | `~/.dossier-research-mcp` | Where runs, journals, reports and the ledger live. Point two servers at one directory and they share history but keep separate spend locks, so prefer one server per store |
| `DOSSIER_POLL_SECONDS` | `20` | How often in-flight runs are polled. Lower is more responsive and more API calls; polling itself is not billed, but there is no reason to go below ~10 |
| `DOSSIER_STALL_MINUTES` | `12` | Silence before a run is marked `stalled`. Raise it if you use `max` tier a lot, since a long synthesis phase is quiet by nature |
| `DOSSIER_UTILITY_MODEL` | `gemini-3.1-pro-preview` | The cheap model behind titles, summaries and claim extraction. See [The utility model](#the-utility-model) |

**HTTP transport.** Only read with `--transport http`.

| Variable | Default | What it does |
|---|---|---|
| `DOSSIER_HTTP_PORT` | `8787` | Port to listen on |
| `DOSSIER_HTTP_TOKENS` | | Comma-separated bearer tokens. Compared in constant time, and the `Bearer` scheme is required. **Bind to loopback if you leave this empty**; the server warns you |

**Testing.**

| Variable | Default | What it does |
|---|---|---|
| `DOSSIER_HERMETIC` | `false` | Refuses to construct a live client at all, so no call can reach the network. Set by `vitest.config.ts`; you should not need it by hand |
| `DOSSIER_PAID_TESTS` | `false` | Opt in to the paid test project. Needs a real key too |
| `DOSSIER_PAID_MAX` | `false` | Additionally run the `max`-tier paid case, which is $3-7 on its own |

</details>

---

## What it costs, honestly

| Tier | Agent | Searches | Estimate | Typical duration |
|---|---|---|---|---|
| `fast` | `deep-research-preview-04-2026` | ~80 | **$1-3** | 4-20 min |
| `max` | `deep-research-max-preview-04-2026` | up to ~160 | **$3-7** | 10-60 min |

> [!CAUTION]
> These are Google's published preview **estimate bands**, and the ledger commits the midpoint when a run starts. It's a spend guardrail, not an invoice; reconcile against Google billing for the real numbers. Cancelling doesn't refund, because Google bills for work already done.

The habits that save you the most, roughly in order: run `research_plan` before you start, since it's free. Stay on `fast` unless the breadth genuinely justifies double the cost. Use `research_followup` rather than a second run. And let dedupe do its job by not fiddling with the wording between retries.

---

## Security

Deep Research reads the open web for you, and Google's own documentation flags prompt injection from untrusted pages, exposure to malicious sites, and exfiltration risk when internal data meets web browsing. Dossier takes a position on each.

Citation verification is **SSRF-safe**. Those URLs came out of a model that was reading untrusted pages, so they get treated as untrusted input: scheme allowlist, DNS resolution checked against private, loopback, link-local and CGNAT ranges (`169.254.169.254` included), redirects followed manually and re-validated on every hop, explicit timeouts, response-size caps.

Private context goes through **File Search rather than a live endpoint**. Deep Research can call a remote `mcp_server` tool mid-run, so a poisoned page could in principle steer it into calling your tools. Grounding through Google's retrieval layer means there's no live endpoint for a compromised run to reach.

Anything that **sends your data somewhere** says so. `corpus_add_file` is annotated non-read-only and its description states plainly that the file leaves your machine.

Secrets stay out of **logs and fingerprints**. MCP auth headers are excluded from the dedupe hash, so rotating a token doesn't fork the key, and error messages carry no credential material.

Every boundary is **Zod-parsed, never cast**. API responses, stored records, config, model output, all of it.

---

## Development

```bash
npm install
npm run dev             # tsx src/index.ts
npm run typecheck       # tsgo --noEmit
npm run lint            # eslint 9 flat, type-aware
npm test                # unit: pure logic, milliseconds
npm run test:acceptance # acceptance: drives the real MCP protocol over stdio
npm run test:all        # both of the above. This is what the gate runs
npm run test:paid       # spends real money. Never in the gate, opt-in only
npm run build
npm run gate            # typecheck, lint, test:all, build. Run it before you push
npm run inspect         # MCP Inspector
```

**Toolchain:** [tsgo](https://github.com/microsoft/typescript-go) (`@typescript/native-preview`) compiles and typechecks, eslint 9 flat and type-aware lints, vitest runs the tests on the swc transform.

**Two suites, because they catch different things.** The unit project covers pure logic in milliseconds. The acceptance project spawns the actual server and speaks JSON-RPC to it, which is the only place a registration or schema defect can surface: a tool missing from `tools/list`, a resource template that never matches, a response violating its own `outputSchema`. It found four real bugs the day it was written, including two documented sub-resources that were silently dead.

There is a third project, `paid`, which runs real research against the live API and asserts on what comes back: that a report has structure and confidence qualifiers, that most of its citations resolve, that collaborative planning returns a reviewable plan rather than your own prompt echoed, that corpus grounding produces its contradictions section. **It is deliberately excluded from the gate and cannot block a deploy.** It needs `DOSSIER_PAID_TESTS=1` and a real key, skips itself without them, gives itself a budget ceiling, and cancels whatever it started.

```bash
DOSSIER_PAID_TESTS=1 GEMINI_API_KEY=... npm run test:paid   # roughly $2-4
```

[`docs/test-plan.md`](docs/test-plan.md) is the AC-traceability matrix: every criterion, the test that verifies it, and the gaps named with reasons rather than left implied.

> [!NOTE]
> Both suites are hermetic by construction. `DOSSIER_HERMETIC=1` is set in `vitest.config.ts` and the acceptance harness blanks the credential vars, so a stray key in your environment can't make the tests spend money. Unit tests inject a scripted `DeepResearchClient`; acceptance tests seed state through `Store` and point each server at its own temp directory.

Using it as a library:

```ts
import { buildPrompt } from 'dossier-research-mcp/server';

const { prompt, archetype, preEngineered } = buildPrompt({
  question: 'What disclosure obligations apply to dual-listed issuers?',
  scope: { jurisdiction: 'UK and Singapore', decisionContext: 'inform a board paper' },
});
```

`createServer(deps)` and `buildDeps(config)` are exported too, so you can mount the tools inside an existing FastMCP server, or inject a fake client for your own tests.

Releasing is `npm version patch`, which gates, bumps, tags and pushes; the workflow publishes from the tag. [docs/releasing.md](docs/releasing.md) has the detail, including how to retire the npm token in favour of Trusted Publishing.

---

<div align="center">

**MIT** © fledgeling-co · [Report an issue](https://github.com/fledgeling-co/dossier-research-mcp/issues)

<sub>Dossier isn't affiliated with Google. "Gemini" and "Vertex AI" are trademarks of Google LLC.</sub>

</div>
