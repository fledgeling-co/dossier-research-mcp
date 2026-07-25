# Perplexity

> [!IMPORTANT]
> **Status: implemented on `main`, unverified against the live API.** The provider, its environment variable and the routing described here are in the code and covered by the hermetic test suite. What has *not* happened is a paid run against Perplexity's actual endpoints, so treat request shapes and response parsing as written-to-the-docs rather than proven. `research_import` and the browser paths remain unbuilt.

Perplexity is the most useful second key to add. It brings two things Gemini has none of: **filters** (date ranges, domain allow-lists) and **wide research**, which enumerates a list and cites every entry.

> [!NOTE]
> Verified July 2026. Perplexity is actively migrating from Sonar Chat Completions to a new Agent API, so some of this will move. Where the two paths differ, this page says which is which.

---

## 1. Get an API key

1. Go to **[console.perplexity.ai](https://console.perplexity.ai)** and sign in.
2. Add a payment method under **Billing**. The API is pay-as-you-go and separate from a Pro subscription.
3. Open **API Keys** and generate a key. Copy it immediately; you won't see it again.

> [!IMPORTANT]
> **A Perplexity Pro subscription does not include API access.** They're separate products with separate billing. This catches people out constantly, including via the official Perplexity MCP server, which requires an API key rather than your Pro login.

## 2. Set a spending limit

In the console under **Billing**, set a monthly spend cap before your first run. Perplexity bills per token *and* per search request, so a wide-research job that runs hundreds of searches costs meaningfully more than a single question.

Then set Dossier's own ceiling, which is independent:

```bash
DOSSIER_BUDGET_USD_PERPLEXITY=25
```

Use both. Dossier's gate refuses before spending; Perplexity's cap is your backstop if something reaches the API another way.

## 3. Configure Dossier

```bash
claude mcp add dossier \
  -e GEMINI_API_KEY=your-gemini-key \
  -e PERPLEXITY_API_KEY=your-perplexity-key \
  -- npx -y dossier-research-mcp
```

Check it registered:

```
research_doctor
```

You should see `perplexity` as configured, with wide research and filters listed.

---

## What it costs

`sonar-deep-research` pricing, per Perplexity's published rates:

| | Rate |
|---|---|
| Input tokens | **$2** / 1M |
| Output tokens | **$8** / 1M |
| Citation tokens | **$2** / 1M |
| Reasoning tokens | **$3** / 1M |
| Search queries | **$5** / 1,000 |

Context window: 128k.

> [!TIP]
> **Reasoning tokens usually dominate the bill.** Perplexity's own worked example bills $0.816 for a single run, of which $0.582 was reasoning; the actual answer was only 11,395 output tokens. If a run costs more than you expected, that's almost always why.

The useful part: every response carries a real `usage.cost` object in USD. Dossier records that as the *actual* cost next to its own *estimate*, so you can see the gap rather than assume it.

---

## What it unlocks

### Wide research

The one genuinely distinctive capability. You describe a set, a qualification rule, and a required output shape; it finds the members and cites each one.

```
Find at least 70 US-based companies with a CEO or CFO appointment first
announced between March 1 and April 30, 2026. For each, cite an authoritative
page naming the company, the appointee, the role and the date. Write results
to results.jsonl, one JSON record per line with fields:
company, appointee, role, announcement_date, url.
```

Quality tracks how precisely you specify it. Give it four things: a **numeric target**, explicit **qualification rules** (dates, geography, thresholds), a **mandatory source per record**, and a **named output file with enumerated fields**. Vague wide-research prompts produce vague lists.

Runs in background mode and writes to a sandbox file that Dossier downloads for you.

### Filters Gemini doesn't have

| Filter | Values |
|---|---|
| Recency | `hour` · `day` · `week` · `month` · `year` |
| Date range | Explicit from/to |
| Domain | Allow or deny list, **max 20 domains** |
| Language | ISO 639-1 codes, max 20 |
| Country | Two-letter code |
| Search mode | `web` · `academic` · `sec` |

The domain filter is the one worth knowing about. If your results keep filling up with content farms restating the same press release, a 20-domain allow-list fixes it in one parameter.

### Background mode

Submit, get an id, poll. Survives your client disconnecting. Lifecycle states are `queued` and `in_progress`, then terminal `completed`, `failed`, `cancelled` or `incomplete`. Streaming supports resume-after-drop via a `sequence_number` cursor.

Cancellation is asynchronous: the call returns `cancelling` and you keep polling until it settles.

---

## What it's bad at

Stated plainly, because it will cost you a run otherwise.

- **Format compliance.** On AIMultiple's June 2026 table-extraction benchmark, Perplexity scored **zero**: the task wanted a table and it returned prose. If you need a specific structure, use wide research (which writes a real file to a schema) rather than asking a Sonar model for a table.
- **Verbosity without accuracy.** It averaged 5,253 words per task on one benchmark, the longest of any tool tested, while scoring below two agents that wrote a tenth as much.
- **Consumer-source lean.** Sarah Constantin's March 2025 review found it reaching for WebMD and Healthline over papers on a medical question, and it scored lowest of five tools there. Use `search_mode: academic` when sourcing matters.

It's genuinely strong at breadth, recency and citation volume. Treat it as a wide, fast, well-cited first pass rather than the final word.

---

## The Perplexity MCP server

Perplexity ships its own MCP server, which you can run alongside Dossier:

```bash
claude mcp add perplexity \
  --env PERPLEXITY_API_KEY="your_key_here" \
  -- npx -y @perplexity-ai/mcp-server
```

It exposes four tools: `perplexity_search` (ranked results), `perplexity_ask` (`sonar-pro`), `perplexity_research` (`sonar-deep-research`), and `perplexity_reason` (`sonar-reasoning-pro`).

**Do you need both?** They overlap but don't duplicate. Perplexity's server is a thin, well-made wrapper over their API. Dossier adds durability across restarts, a spend gate that reserves before calling, outline-first reading so a long report doesn't flood your context, citation verification, and the ability to compare Perplexity's answer against another provider's. If you only ever use Perplexity, their server is the simpler choice.

It requires the same API key. There is no subscription-authenticated path.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401` | Key revoked, or copied with whitespace |
| Costs far above the estimate | Reasoning tokens. Check `usage.cost` in the response breakdown |
| Empty or thin results with a date filter | The window is too narrow. Widen it before assuming the topic is dead |
| Prose when you asked for a table | Known weakness. Use wide research instead |
| `400` on a domain filter | More than 20 domains |

---

**Next:** [OpenAI](openai.md) · [xAI](xai.md) · [Using subscriptions](subscriptions.md) · [The plan](../plan/multi-provider-research.md)
