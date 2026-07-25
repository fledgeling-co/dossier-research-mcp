# xAI

> [!IMPORTANT]
> **Status: implemented on `main`, unverified against the live API.** The provider, its environment variable and the routing described here are in the code and covered by the hermetic test suite. What has *not* happened is a paid run against xAI's actual endpoints, so treat request shapes and response parsing as written-to-the-docs rather than proven. `research_import` and the browser paths remain unbuilt.

One reason to add xAI, and it's a good one: **it is the only backend that can search X.** If your question involves what people are actually saying right now, in public, at speed, nothing else reaches that corpus.

---

## 1. Get an API key

1. Go to **[console.x.ai](https://console.x.ai)** and sign in.
2. Create or select a team, then add billing. X Premium+ and SuperGrok are consumer subscriptions and are **separate from API credits**.
3. **API Keys** → create a key. Copy it now.
4. If you plan to use collections (xAI's document stores), you'll also want a **management API key**, which is a separate credential.

## 2. Set a spending limit

Set a monthly spend limit in the console's billing section. Then Dossier's ceiling:

```bash
DOSSIER_BUDGET_USD_XAI=15
```

xAI is the cheapest of the four hosted providers for most questions, but server-side tool calls run agentically. A single request in xAI's own worked example issued **13 distinct searches** on its own initiative.

## 3. Configure Dossier

```bash
claude mcp add dossier \
  -e GEMINI_API_KEY=your-gemini-key \
  -e XAI_API_KEY=xai-your-key \
  -- npx -y dossier-research-mcp
```

Verify with `research_doctor`.

---

## What it costs

Two-tier pricing: requests whose prompt reaches the token threshold are billed at the higher rate for **all** tokens in the request.

| Model | Context | Input (<200k / ≥200k) | Cached | Output (<200k / ≥200k) |
|---|---|---|---|---|
| `grok-4.5` | 500k | $2.00 / $4.00 | $0.30 / $0.60 | $6.00 / $12.00 |
| `grok-4.3` | 1M | $1.25 / $2.50 | $0.20 / $0.40 | $2.50 / $5.00 |
| `grok-4.20-*` | 1M | $1.25 / $2.50 | $0.20 / $0.40 | $2.50 / $5.00 |

`grok-4.5` has a knowledge cutoff of **1 February 2026**. It supports `reasoning_effort` of `low`, `medium` or `high`; reasoning is not fixed-on as an earlier version of this page claimed.

> [!NOTE]
> `gpt-5.6-sol`'s cutoff is 16 February 2026, so xAI is no longer the most recent. Corrected 25 July 2026 after an external review.

### Server-side tools bill per invocation, on top of tokens

| Tool | Cost per 1,000 calls |
|---|---|
| `web_search` (and image search) | **$5** |
| `x_search` | **$5** |
| `code_execution` / `code_interpreter` | **$5** |
| `attachment_search` (file attachments) | **$10** |
| `collections_search` / `file_search` | **$2.50** |
| `view_image`, `view_x_video` | no call charge, **tokens only** |
| Domain filtering | `web_search` supports **up to 5** allowed or excluded domains |
| Remote MCP tools | no call charge, **tokens only** |

This is the part that makes xAI cost estimation tractable, and it's also where an agentic run gets away from you: the model chooses its own search count. A run that issues 13 searches on its own initiative costs about 7 cents in tool calls before you count a single token.

> [!CAUTION]
> **Priority Processing doubles every token figure.** If you set `"service_tier": "priority"`, the table above stays the same but the per-token rates in the previous table double. And `grok-4.5` is **not** eligible for the 20% batch discount, so batch requests bill at standard rates.

One subtlety on the vision tools: they apply only to media **discovered by a search tool**, not to images you pass directly in messages.

Prompt caching works unusually well here: xAI's own example shows 177,518 cached prompt tokens across a 13-query agentic run, because the tool reuses context between searches.

---

## What it unlocks

### X search

The capability nothing else has.

| Parameter | What it does |
|---|---|
| `from_date` / `to_date` | ISO 8601, **inclusive on both ends** |
| `allowed_x_handles` | Restrict to specific accounts, **max 20** |
| `excluded_x_handles` | Exclude accounts, max 20 |
| `enable_image_understanding` | Interpret images in posts |
| `enable_video_understanding` | Interpret video. **X search only**, not web search |

> [!IMPORTANT]
> `allowed_x_handles` and `excluded_x_handles` are **mutually exclusive**. Setting both in one request is an error, not a merge.

Video understanding is genuinely differentiated. If the primary source for something is a clip someone posted, this is the only path to it.

### Combining tools in one run

Pass several tools together and the model decides its own strategy: collections first, then external gathering, then synthesis, with mixed citations. The documented order is internal documents, then web and X, then synthesis.

```python
tools=[collections_search(collection_ids=[...]), web_search(), x_search(), code_execution()]
```

This is server-side agentic tool use, not a client loop. You get `server_side_tool_usage` counts back so you can see what it actually did.

### Collections

xAI's document stores. Semantic search over PDFs, text, CSVs and other formats. Citations come back with their own URI scheme, which makes provenance unambiguous:

```
collections://collection_id/files/file_id
```

Web sources in the same response return ordinary `https://` URLs, so a mixed report tells you at a glance which claims came from your documents and which from the open web.

Collections must exist before you can search them. Create and populate them through the [xAI console](https://console.x.ai) or the xAI SDK; the OpenAI-compatible path can only read existing ones.

### API compatibility

xAI serves the Responses API at `https://api.x.ai/v1/responses`, so OpenAI SDKs work against it with a base-URL change. Tool names differ between surfaces:

| Surface | Collections tool |
|---|---|
| xAI SDK | `collections_search` |
| OpenAI Responses API | `file_search` |
| Vercel AI SDK | `xai.tools.xSearch()` etc. |

---

## What it's less good at

- **No true background mode**, but there is **deferred chat completions**: submit, get an id, retrieve within 24 hours. That covers a dropped connection, though whether it composes with server-side search still needs a contract test. Not the same as Perplexity's or OpenAI's background jobs.
- **Speed over depth.** On AIMultiple's DR-2T task, Grok Deep Search was roughly **10× faster** than ChatGPT Deep Research and covered about **3× more pages** (100+ in around two minutes). That's a genuinely useful profile for breadth and a poor one for careful synthesis. Use it to find things, not to conclude things.
- **The model picks its own search count**, so tool spend is harder to bound up front than with OpenAI's `max_tool_calls`. Dossier reserves a worst-case tool-call ceiling for this reason.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `400` on handle filters | `allowed_x_handles` and `excluded_x_handles` both set |
| Empty X results | Date window too narrow, or the handle list is over 20 |
| Collections search returns nothing | Documents still processing. Poll until status is `PROCESSED` |
| Higher bill than expected | Prompt crossed the 200k threshold, so *every* token in the request repriced |
| Video not interpreted | `enable_video_understanding` works on X search only, not web search |

---

**Next:** [Perplexity](perplexity.md) · [OpenAI](openai.md) · [The plan](../plan/multi-provider-research.md)
