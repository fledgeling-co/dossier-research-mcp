# OpenAI

> [!IMPORTANT]
> **Status: implemented and verified against the live API on 25 July 2026.** A real background job ran through this adapter end to end on `gpt-5.6-terra`: request accepted, `queued` then `completed`, text and citations extracted. What has *not* been exercised is a full-length research run at every tier and filter combination.
>
> If you hit `Project ... does not have access to model`, that is a per-project model allow-list rather than a billing problem, and it is separate from the organisation's. Change it under Project → Limits in the OpenAI dashboard, or use a key from an unrestricted project.
>
> Worth knowing regardless: **in background mode the Responses API accepts a job for a model you cannot use**, returns 200 with an id, and reports `in_progress` on the first poll. It only fails a second or two later. The same request without `background` 403s immediately. Anything that checks a run once and calls it started will call that a success.

OpenAI's deep research models are the strongest option for academic and primary-literature work, and the only ones that can pull private data from a remote MCP server as a first-class source. They're also the most expensive per run and the most obviously aging.

> [!CAUTION]
> **The dedicated deep-research models are gone.** OpenAI announced the deprecation of `o3-deep-research` and `o4-mini-deep-research` on 22 April 2026, with **access ending 23 July 2026**. The named replacement for both is **`gpt-5.6-sol`**.
>
> Their own deep-research *guide* has not caught up and still documents the retired models throughout. The deprecations page is the authoritative one. Verified 25 July 2026.

This changes the shape of the OpenAI path rather than removing it. Instead of a purpose-built research model, you use their strongest reasoning model with the same tools and the same background mode. Most of what follows still applies; the model id changes and a few limitations lift.

---

## 1. Get an API key

1. Go to **[platform.openai.com](https://platform.openai.com)** and sign in.
2. **Billing** → add a payment method. The API is billed separately from ChatGPT Plus or Pro; a subscription does not include API credits.
3. **API keys** → create a secret key. Copy it now.
4. Note your **usage tier**. Research-grade models are **not available on the free tier**; you need billing set up and at least Tier 1.

## 2. Set a spending limit

**Settings → Limits** lets you set a hard monthly cap and a soft notification threshold. Set the hard cap. Deep research runs read hundreds of sources and a runaway loop is expensive.

Then Dossier's own ceiling:

```bash
DOSSIER_BUDGET_USD_OPENAI=25
```

## 3. Configure Dossier

```bash
claude mcp add dossier \
  -e GEMINI_API_KEY=your-gemini-key \
  -e OPENAI_API_KEY=sk-your-openai-key \
  -- npx -y dossier-research-mcp
```

Verify with `research_doctor`.

---

## What it costs

**Current, the replacement path:**

| Model | Input | Output | Notes |
|---|---|---|---|
| `gpt-5.6-sol` | **$5 / $10** per 1M | **$30 / $45** per 1M | The named successor. Highest-intelligence option; pair with `reasoning.mode: "pro"` |
| `gpt-5.6-terra` | $2.50 / $5 | $15 / $22.50 | Lower cost, same shape |
| `gpt-5.6-luna` | $1 / $2 | $6 / $9 | Lowest cost and latency |

Two figures separated by `/` mean tiered pricing: prompts at or above 272k tokens bill the higher rate for the whole request.

**Retired 23 July 2026, for reference when you meet them in stale docs:**

| Model | Input | Cached | Output | Context | Cutoff |
|---|---|---|---|---|---|
| `o3-deep-research` | $10 / 1M | $2.50 / 1M | $40 / 1M | 200k | Jun 2024 |
| `o4-mini-deep-research` | $2 / 1M | $0.50 / 1M | $8 / 1M | 200k | Jun 2024 |

They are worth knowing about for one reason: on AIMultiple's April 2026 benchmark `o3-deep-research` scored **75.8%**, the lowest of six tools tested, at **$10.92** per task, the highest cost of any. The mini scored higher on their DR-50 bench at a fifth of the price. A dedicated research model was never automatically the better buy, which makes the move to a general reasoning model less of a loss than it sounds.

### The cost lever that matters

`max_tool_calls` caps how many searches, fetches and MCP calls the model makes before it must answer. OpenAI's own documentation calls it "the primary tool available to you to constrain cost and latency when using these models".

Dossier surfaces it directly:

```bash
DOSSIER_MAX_TOOL_CALLS=40
```

> [!IMPORTANT]
> **It is also the primary lever on quality, which the API docs don't mention.** OpenAI's deep research launch post plots pass rate against max tool calls and the line rises across the whole range, captioned: "The more the model browses and thinks about what its browsing, the better it does, which is why giving it time to think is important."
>
> So capping tool calls is a cost/quality trade, not a free saving. Set it to bound a runaway loop, not to economise on a question you actually care about.

---

## What it unlocks

### Academic and primary-literature depth

The Xu & Peng survey (June 2025) rates OpenAI's implementation highest for academic research specifically: arXiv, IEEE Xplore, PubMed and Google Scholar integration, statistical-method identification, and proper IEEE/APA/MLA/Chicago citation formatting. If your question is "what does the literature actually say", this is the backend to reach for.

### Vector-store corpora

Upload documents to a vector store and attach it via the `file_search` tool. **Maximum two vector stores per request**, and only `type` and `vector_store_ids` are supported as parameters.

### Remote MCP servers as data sources

The most architecturally interesting capability: deep research can call *your* MCP server to search *your* systems, and blend those results with the public web.

The interface is strict. Your server must expose exactly two tools:

| Tool | Contract |
|---|---|
| `search` | Takes a query, returns results with ids |
| `fetch` | Takes an id from those results, returns the document |

```json
{
  "type": "mcp",
  "server_label": "mycompany_mcp_server",
  "server_url": "https://mycompany.com/mcp",
  "require_approval": "never"
}
```

`require_approval` must be `"never"`; human-in-the-loop approval isn't supported for these models. Both operations are read-only, which is what makes that acceptable.

> [!TIP]
> Dossier can act as one of these servers, exposing your corpus to an OpenAI deep-research run through the `search`/`fetch` pair. That's a planned capability, not a shipped one; see [the plan](../plan/multi-provider-research.md).

### Background mode

Set `background: true` and poll, or register a webhook. Necessary in practice, because runs take tens of minutes.

Two caveats. Background responses are retained "for roughly 10 minutes so that polling works reliably", which makes the mode **incompatible with Zero Data Retention** setups. And with `store: true`, request data is retained by OpenAI for 30 days unless ZDR is enabled.

---

## What it can't do

| Missing | On the retired DR models | On `gpt-5.6-sol` |
|---|---|---|
| **Structured outputs** | ❌ unsupported | ✅ supported |
| **Function calling** | ❌ unsupported | ✅ supported |
| **Clarifying questions** | ❌ never asks | ⚠️ a general model *can* ask, but there is no guaranteed clarification phase |
| **Domain filtering** | ❌ none | ✅ **up to 100** allowed or blocked domains on web search |
| **Date filters** | ❌ none | ❌ none. Recency goes in the prompt and isn't enforced |

Three of those lifting is the real upside of the migration, and the domain filter is the one that matters most for research quality: it is how you keep a run off content farms.

The first two Schema-forcing was impossible on the deep-research models, which made them a poor choice whenever the answer needed a defined shape. On `gpt-5.6-sol` that constraint is gone.

The third is worth dwelling on, because it's the gap between the ChatGPT product and the API, and it did not change. In ChatGPT, Deep Research asks you clarifying questions and rewrites your prompt before it starts. **The API does neither.** You get exactly what you asked for, and vague questions produce vague reports.

### The consumer product does things the API can't

Worth knowing before you assume the API is the fuller surface. It isn't:

| | ChatGPT product | API |
|---|:-:|:-:|
| Editable research plan before it spends | ✅ | ❌ |
| Interrupt mid-run to refine focus or change sources | ✅ | ❌ |
| Domain restrict / prioritise (Sites → Manage sites) | ✅ | ❌ |
| Connect any MCP server as a source | ✅ since Feb 2026 | ✅ |
| Authenticated data sources (FactSet, PitchBook, Scholar Gateway) | ✅ | ❌ |
| Export to Markdown, Word, PDF with an activity history | ✅ | ❌ |

If you have a ChatGPT subscription, the product is the better research surface and the API is the better *integration* surface. That asymmetry is why [subscriptions.md](subscriptions.md) recommends the share-and-import pattern rather than paying twice.

Dossier's prompt architect covers this: it compiles a scaffolded brief with explicit scope, output structure and epistemic bounding before anything is sent. That's the same job ChatGPT's clarification stage does, done locally and for free.

---

## Prompt-injection risk

OpenAI documents this at unusual length, and it's worth taking seriously because deep research reads attacker-controllable content by design: web pages, file-search results, MCP responses.

Their worked example is a lead-qualification agent that reads CRM records over MCP, then hits a page with hidden CSS text instructing it to append the lead JSON to a subsequent search query. The record leaves via URL parameters.

Their recommended controls, all of which apply here:

- Connect only to MCP servers you operate or have audited.
- Stage workflows: public web research first, then a separate private-data call with no web access.
- Log and review tool calls and outbound messages.
- Screen returned links before opening. A URL path can carry data.

Dossier's own posture is in [security.md](../security.md): all retrieved content is treated as data, never as instruction, and citation dereferencing goes through an SSRF-safe fetch with per-hop redirect validation.

---

## Rate limits, and why a 429 is not a failed run

OpenAI publishes per-minute token and request limits per usage tier, and a research run is input-heavy enough to hit the token ceiling on an otherwise quiet account. The response is an HTTP 429 whose body names the wait, usually a second or two:

```
Rate limit reached for gpt-5.6-sol on tokens per min (TPM):
Limit 1000000, Used 923902, Requested 96709. Please try again in 1.236s.
```

Dossier used to treat that as a hard failure, on the rule that a paid create is attempted exactly once. The rule exists because a create that timed out **after** the provider accepted it has already bought the report, so a retry buys a second. That reasoning is right, and it was applied too broadly: a 429 is the provider declining to admit the request, so nothing was created and a retry cannot buy anything twice.

Two runs failed that way at $9 each, for want of about a second.

Now: a 429 is retried, honouring `Retry-After` where OpenAI sends one and the delay named in the message where it does not, bounded by attempt count, by a total-delay ceiling, and by the caller's deadline. A timeout, a dropped connection and a 5xx are still attempted exactly once and reported as an unknown outcome, because any of those may have been accepted.

If it still fails after the retries, the budget commitment is released and the run says so. See [releasing a commitment for a request that bought nothing](../tools.md#releasing-a-commitment-for-a-request-that-bought-nothing).

## Troubleshooting

| Symptom | Cause |
|---|---|
| Model not found | Deep research is unavailable on the free tier. Add billing and reach Tier 1 |
| Run never completes | Missing a data source. At least one of web search, MCP or file search is required |
| Cost far above estimate | No `max_tool_calls` cap |
| Report ignores recent events | June 2024 cutoff, plus no date filter. Ask for sources by date explicitly |
| `400` on structured output | Not supported on these models. Use a different backend for schema-bound work |
| `429` on starting a run | You are over a per-minute token or request limit. Dossier retries this now, honouring the wait OpenAI names in the message, and releases the budget commitment if it still fails, because a 429 creates nothing |

---

**Next:** [Perplexity](perplexity.md) · [xAI](xai.md) · [The plan](../plan/multi-provider-research.md)
