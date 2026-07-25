# Deep Research API vs the Managed Agents API

Google ships two things that both look like "an AI that does research for you", and they are not variants of each other. Picking the wrong one costs you either a lot of money or a lot of quality. This is the decision, made concrete.

> **Preview caveat.** Both surfaces are in public preview. Model ids, pricing and field names move. Everything below was checked against Google's docs at the time of writing; verify pricing and agent ids against the live docs before you budget against them.

---

## The one-paragraph version

**Deep Research** is a *finished product*: one call buys you a planned, executed and synthesised research report with 80–160 web searches behind it and inline citations, and you cannot change how it works. **Managed Agents** is a *harness*: one call buys you a Linux sandbox with a Gemini Flash model that will do whatever you told it to do, including research — and the methodology, the search discipline and the citation rigour are now your job. Use Deep Research when you want the report. Use a managed agent when you want files, code execution over your data, or a reusable persona that does research as one step of something longer.

---

## Side by side

| | **Deep Research API** | **Managed Agents API** |
|---|---|---|
| What it is | A managed, opinionated research agent | A configurable agent harness with a sandbox |
| Agent ids | `deep-research-preview-04-2026` (fast)<br>`deep-research-max-preview-04-2026` (max) | `antigravity-preview-05-2026`, plus any custom agent you create |
| Underlying model | Fixed by Google | You pick: `gemini-3.6-flash` (default), `gemini-3.5-flash`, `gemini-3.5-flash-lite` |
| Reusable config | **No** — every call is configured from scratch | **Yes** — `agents.create` persists id, instructions, tools, environment (up to 1,000 agents) |
| Execution | **Background only.** `background: true` and `store: true` are mandatory | Synchronous by default; streaming available |
| Duration | 4–60 min (hard 60-min ceiling) | Seconds to minutes, bounded by your request timeout |
| Cost | **~$1–3 (fast), ~$3–7 (max) per task** | Token-metered; a single interaction typically 100k–3M tokens. Environment compute unbilled during preview |
| Web search | Built in, extensive, and the point of the product | Available as a tool, but depth and discipline are on you |
| Citations | Inline, first-class, and promptable | Only if you instruct it and check it |
| Filesystem | None | Full Ubuntu sandbox: Python 3.12, Node 22, persistent environments |
| File outputs | None (charts as base64 images) | Yes — download the environment as a tar |
| Structured output | **No** | No (extract afterwards either way) |
| Custom function calling | **No** — remote MCP servers are the substitute | Yes, plus MCP servers |
| Skills / `AGENTS.md` | No | Yes — mounted at `.agents/`, auto-discovered |
| Credential injection | Headers on an MCP tool | Egress-proxy header transformation, never exposed inside the sandbox |
| Network restriction | Not configurable | `network.allowlist` per domain |
| Human-in-the-loop planning | **Yes** — `collaborative_planning` returns a plan to edit and approve | No equivalent |
| Multi-turn | `previous_interaction_id` | `previous_interaction_id` *and* `environment` (conversation and filesystem state are independent) |

---

## The constraint that decides most cases

**You cannot currently build a custom agent on top of Deep Research.** At preview, `agents.create` accepts exactly one `base_agent`: `antigravity-preview-05-2026`. So the appealing idea — "fork the Deep Research agent, bake in our house source discipline, reuse it" — is not available. A custom agent is a *complement* to Deep Research, not a specialisation of it.

That collapses the decision to a much simpler question: **do you want Google's research loop, or your own?**

---

## Choosing

### Use the **Deep Research API** when

- The deliverable is a **cited report a human will read and act on**. Due diligence, competitive landscape, regulatory mapping, literature review, market sizing.
- **Breadth of search is the value.** 80–160 searches, planned and pursued autonomously, is genuinely hard to reproduce and would cost you far more than $3 in engineering time and tokens to approximate badly.
- **Citation discipline matters**, because someone will be held to the numbers.
- You can **wait 5–60 minutes** and can architect around a background job.
- You want the **plan-review pause** — the highest-leverage quality intervention available on any research run, and unique to this surface.

### Use the **Managed Agents API** when

- The job **produces artifacts**, not prose: a spreadsheet, a slide deck, a PDF, a chart, a code change, a populated database.
- You need **code execution over your own data** — analysis, transformation, validation — not web synthesis.
- The **same job runs repeatedly** and you want the methodology to live in one persisted place rather than in every caller's prompt.
- You need **credentialed access to private APIs**, with secrets injected at the egress proxy rather than sitting in a prompt.
- You need **environment state to persist** across turns (installed packages, working files).
- **Latency and cost matter more than search depth.** Flash-class models over a handful of searches, in seconds, for a fraction of a Deep Research task.

### Use **both** when

The natural pipeline is research → artifact:

1. `research_start` → Deep Research investigates and returns a cited report.
2. `research_claims` → extract the load-bearing claims as structured cards.
3. `agent_run` → a managed agent turns those into the deliverable: a model, a deck, a populated tracker, a set of tickets.

The reverse composition is also real, and is the most interesting thing either API supports: **Deep Research accepts an `mcp_server` tool**, so a remote MCP server you control can be called *by the researcher, mid-run*. That is how a run reads your private corpus, your decision log, or your ticket history — context it could never crawl. This server exposes the safer, simpler version of that idea through File Search stores (`corpusStores`), which keeps the data inside Google's retrieval layer rather than exposing a live endpoint to an agent that is simultaneously reading untrusted web pages.

---

## The third option: build the loop yourself

Worth naming, because for some jobs it beats both. A hand-rolled deep-research loop — a tool-calling agent with a search tool, a fetch tool, and a structured-extraction step — using the Vercel AI SDK or similar:

```ts
import { generateText, Output } from 'ai';
// … a loop: plan → search → read → extract → decide whether to continue
```

| | Roll your own |
|---|---|
| **Structured output** | **Yes** — the decisive advantage. Neither Google surface gives you a schema-validated result; both hand you prose you must post-process. |
| Model choice | Any provider, any model, swappable |
| Cost | You control every call; can be far cheaper *or* far more expensive |
| Search | You buy it (Brave, Exa, Tavily, SerpAPI) and you tune it |
| Quality | Entirely on you — this is the part people underestimate |
| Time to first result | Days, not minutes |

**Choose it when** you need typed results at scale (populating a database, scoring a thousand entities), when you need a specific model for compliance or cost reasons, or when the "research" is really structured extraction over a known source list rather than open-ended investigation.

**Do not choose it** to save $3 on a report. The 80-search planned investigation that Deep Research does for a couple of dollars is not something you will match in a weekend, and a shallow imitation that returns five links and a summary is worse than useless — it looks like research.

---

## Quick reference

```
Need a cited report a human will act on?           → Deep Research API      (research_start)
Need it decision-critical?                         → …with collaborativePlanning: true
Need files, code execution, or a reusable persona? → Managed Agents API     (agent_create / agent_run)
Need typed records at scale?                       → Roll your own loop
Need private context inside the research?          → Deep Research + corpusStores (File Search)
Need research THEN an artifact?                    → Deep Research → research_claims → agent_run
```

---

## Sources

- [Gemini API — Deep Research](https://ai.google.dev/gemini-api/docs/deep-research)
- [Gemini API — Managed agents overview](https://ai.google.dev/gemini-api/docs/agents)
- [Gemini API — Building managed agents](https://ai.google.dev/gemini-api/docs/custom-agents)
- [Gemini API — Managed agents quickstart](https://ai.google.dev/gemini-api/docs/managed-agents-quickstart)
- [Gemini API — Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview)
