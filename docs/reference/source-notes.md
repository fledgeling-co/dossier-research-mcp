# Source notes

Everything gathered while writing the [multi-provider plan](../plan/multi-provider-research.md), with URLs, so nobody has to fetch it twice. This is a working reference, not documentation: it records what the sources said and when, including the bits that didn't make it into the plan.

> [!IMPORTANT]
> **Gathered 25 July 2026.** Model ids, prices and quotas move monthly. Anything here older than a quarter should be re-verified before it goes in front of a user. Where a fact was inferred rather than read, it says so.

---

## Contents

| | |
|---|---|
| [1. Provider APIs](#1-provider-apis) | Endpoints, capabilities, gotchas |
| [2. Model lineup and pricing](#2-model-lineup-and-pricing) | Cross-provider table |
| [3. Reasoning and effort controls](#3-reasoning-and-effort-controls) | The exact parameter names |
| [4. Benchmarks](#4-benchmarks) | AIMultiple, with dates |
| [5. The review corpus](#5-the-review-corpus) | Fourteen months of evaluations |
| [6. Academic survey](#6-academic-survey) | Xu & Peng taxonomy |
| [7. Gemini web app](#7-gemini-web-app) | DOM, flow, limits, ToS |
| [8. Browser automation](#8-browser-automation-tooling) | Which drivers reach a signed-in session |
| [9. CLI agents](#9-cli-agents-and-subscriptions) | agy, Claude Code, Codex, Gemini CLI |
| [10. Prior art](#10-prior-art-repos) | What each repo contributes |
| [11. URL index](#11-url-index) | Everything, in one list |
| [12. ChatGPT Deep Research](#12-chatgpt-deep-research-the-consumer-product) | The consumer product, and where it beats the API |

---

## 1. Provider APIs

### Perplexity

Docs index: `https://docs.perplexity.ai/llms.txt` (worth fetching first; it lists every page).

**Two generations coexist.** Sonar Chat Completions is being superseded by the **Agent API**, and the deprecation banner points at `/docs/agent-api/quickstart` and a migration guide.

| | Sonar (older) | Agent API (current direction) |
|---|---|---|
| Endpoint | `POST /v1/sonar`, async variants | `POST /v1/agent`, alias `/v1/responses` |
| Shape | `messages` array, `choices` | `input` + `instructions`, heterogeneous `output` list |
| Tools | Baked into the model | Explicit per request |
| Deep research | `sonar-deep-research` | **Not documented on the Agent API yet** |

**`sonar-deep-research` pricing** (per 1M tokens unless noted): input $2, output $8, citation $2, reasoning $3, search $5 per 1,000 requests. 128k context.

Their own worked example: 33 prompt tokens, 11,395 completion, 19,028 citation, 193,947 **reasoning**, 21 searches, total cost $0.816 of which $0.582 was reasoning. **Reasoning dominates the bill.**

**Response fields:** `citations` (plain URL strings) plus `search_results` (`title`, `url`, `date`, `last_updated`, `snippet`). Assistant content opens with a `<think>` block before the report body. Usage carries a `cost` object breaking out input/output/citation/reasoning/search and `total_cost`, **in USD, per request**. Worth recording as *actual* against our *estimate*.

**Agent API background mode:** `background: true` → returns id immediately. Poll `GET /v1/agent/{id}`. Non-terminal `queued`, `in_progress`; terminal `completed`, `failed`, `cancelled`, `incomplete`. Streaming resume via `sequence_number` cursor and `?stream=true&starting_after=N`; outside the reconnect window it 400s. Cancel is `POST /v1/agent/{id}/cancel`, asynchronous, returns `cancelling`. **Retention and timeouts are undocumented.**

**Wide research** (`preset: "wide-research"`): builds large evidence-backed collections, maps to their WANDR benchmark ("Wide ANd Deep Research"). Requires `background: true` in practice. Results are written to a sandbox file surfacing as `share_file` in `output`; download via `/v1/agent/{id}/files` then `/files/{file_id}/content`. Prompt quality guidance: numeric target, explicit qualification rules, mandatory source per record, named output file with enumerated fields. **Parallelisation details and cost are not documented.**

**Filters:** domain (max 20), language (ISO 639-1, max 20), country, recency (`hour`/`day`/`week`/`month`/`year`), date range, search mode (`web`/`academic`/`sec`).

**Presets** bundle model, token ceiling, tools and a system prompt. `preset: "low"` resolved to `openai/gpt-5.1` in their example. Also documented: `skills`, `model-fallback`, `finance_search`, `people_search`, `fetch_url`, `sandbox`, `mcp`, `custom-functions`.

**MCP server:** `@perplexity-ai/mcp-server`. Four tools: `perplexity_search` (Search API), `perplexity_ask` (`sonar-pro`), `perplexity_research` (`sonar-deep-research`), `perplexity_reason` (`sonar-reasoning-pro`). **Requires `PERPLEXITY_API_KEY`; a Pro subscription is not an accepted auth method.**

### OpenAI

**RETIRED.** `o3-deep-research` and `o4-mini-deep-research` were deprecated 2026-04-22 with **access ending 23 July 2026**; the named replacement for both is **`gpt-5.6-sol`**. Verbatim from the deprecations page: `"July 23, 2026 | o3-deep-research-2025-06-26 | o3-deep-research | gpt-5.6-sol"`, and the same row for the mini. **OpenAI's own deep-research guide has NOT been updated** and still documents them throughout; the deprecations page is authoritative. Confirmed 25 July 2026.

Specs while they lived: snapshots `-2025-06-26`, **June 2024 cutoff**, 200k context, 100k max output, reasoning tokens supported. Everything below about tools, MCP and background mode was written against them and carries over, except that `gpt-5.6-sol` **does** support structured outputs and function calling, which they did not.

**Endpoint:** Responses API. Must supply at least one of web search, remote MCP, or file search over vector stores. Code interpreter optional.

```python
client.responses.create(
    model="o3-deep-research",
    input=input_text,
    background=True,
    tools=[{"type": "web_search_preview"},
           {"type": "file_search", "vector_store_ids": ids},
           {"type": "code_interpreter", "container": {"type": "auto"}}])
```

**Not supported (on the retired DR models):** function calling, structured outputs, fine-tuning, predicted outputs. You could not schema-force them. **This constraint lifts on `gpt-5.6-sol`**, which is the main upside of the forced migration.

**`max_tool_calls`** is described in their own docs as "the primary tool available to you to constrain cost and latency."

**Background mode:** retained "roughly 10 minutes so that polling works reliably", which makes it **incompatible with Zero Data Retention**. Webhooks supported. With `store: true`, request data retained 30 days unless ZDR.

**Citations:** `annotations` inside an `output_text` block, each with `url`, `title`, `start_index`, `end_index`. Output item types: `web_search_call` (action `search`/`open_page`/`find_in_page`), `code_interpreter_call`, `mcp_tool_call`, `file_search_call`, `message`.

**MCP data sources:** the server must expose exactly `search` (query → results with ids) and `fetch` (id → document). `require_approval` must be `"never"`. Nothing else is supported. **This is how Dossier could become a data source for an OpenAI deep-research run.**

**Vector stores:** only `type` and `vector_store_ids` params; **max two attached at once**.

**No clarification stage in the API.** ChatGPT's Deep Research runs clarify → prompt-rewrite → research. The API does neither: it "expects fully-formed prompts up front and will not ask for additional context." Their suggested rewriter guidance is eight rules: maximise specificity, mark unstated dimensions open-ended, don't invent details, first person, request tables where useful, specify output format and headers, match the user's language, prioritise primary sources.

**Prompt injection:** documented at length. Worked example: a lead-qualification agent reads CRM over MCP, hits an attacker page with hidden CSS text telling it to append lead JSON to a later search query, exfiltrating via URL params. Controls recommended: trusted MCP only, staged workflows (public web first, then private with no web), log tool calls, validate tool args, screen returned links.

**Rate limits (RPM / TPM / batch):** `o3-deep-research` Tier 1 500 / 200k / 200k up to Tier 5 10k / 30M / 10M. `o4-mini-deep-research` Tier 1 1,000 / 200k / 200k up to Tier 5 30k / 150M / 10M. **Not available on the free tier.**

### xAI

**Endpoint:** `https://api.x.ai/v1/responses` (OpenAI Responses-compatible). Server-side agentic tool use: the model runs its own search loop. Their Tesla example issued **13 distinct queries** unprompted, reasoning tokens climbing 199 → 3,352.

**Tools:** `web_search`, `x_search`, `collections_search` (`file_search` under the OpenAI SDK), `code_execution` (`code_interpreter`). Pass several and the model picks its strategy; documented order is collections → external → synthesis → mixed citations.

**`x_search` parameters:** `allowed_x_handles` (max 20), `excluded_x_handles` (max 20), `from_date`, `to_date` (ISO 8601, **inclusive both ends**), `enable_image_understanding`, `enable_video_understanding`. The two handle params are **mutually exclusive**. Video understanding is **X search only**. No documented result-limit or engagement-threshold params.

**Collections:** citations use `collections://collection_id/files/file_id`; web sources return ordinary `https://`. Management via `client.collections.create/upload_document/get_document`, polling until `DOCUMENT_STATUS_PROCESSED`. Needs a separate **management API key**. The OpenAI-compatible path can only read existing collections.

**Telemetry:** `citations`, `usage`, `server_side_tool_usage` (e.g. `{'SERVER_SIDE_TOOL_COLLECTIONS_SEARCH': 13}`), `tool_calls`. Caching is strong: 177,518 cached prompt tokens across that 13-query run.

**Pricing is two-tier**: requests whose prompt reaches the threshold are billed at the higher rate for **all** tokens in the request (200k for grok-4.5 and the 4.20s).

**Server-side tool pricing IS published**, at `https://docs.x.ai/developers/pricing`, as "Cost / 1k Calls":

| Tool | Per 1,000 calls |
|---|---|
| `web_search` (image search bills at this rate) | $5 |
| `x_search` | $5 |
| `code_execution` / `code_interpreter` | $5 |
| `attachment_search` (file attachments) | $10 |
| `collections_search` / `file_search` | $2.50 |
| `view_image`, `view_x_video` | tokens only, no invocation charge |
| Remote MCP tools | tokens only, no invocation charge |

Vision tools apply only to media **discovered by a search tool**, not images passed directly in messages. `"service_tier": "priority"` **doubles** the token rates. `grok-4.5` is **not** eligible for the 20% batch discount.

**No background mode.** Runs are synchronous.

### Google Gemini

Already covered in [setup.md](../setup.md) and [deep-research-api-vs-agent.md](../deep-research-api-vs-agent.md). Additions learned this round:

- The Interactions API controls thinking depth **solely** via `generation_config.thinking_level`; `thinkingBudget` is not a thing there.
- `gemini-3.1-pro-preview` accepts only `low`/`medium`/`high` (no `minimal`). `gemini-3-pro-preview` accepts only `low`/`high`.
- Response pricing is "the sum of output tokens and thinking tokens", tracked via `total_thought_tokens`.
- `thinking_summaries` (`auto`/`none`) is separate from depth.

---

## 2. Model lineup and pricing

From Perplexity's Agent API models page, which aggregates first-party provider pricing with no markup. Cross-checked against xAI's own pricing page. Two figures separated by `/` mean tiered pricing above a context threshold (272k for OpenAI, 200k for Gemini 3.1 Pro and Grok).

| Model id | Provider | In $/1M | Out $/1M |
|---|---|---|---|
| `anthropic/claude-opus-5` | Anthropic | 5 | 25 |
| `anthropic/claude-sonnet-5` | Anthropic | 2 | 10 |
| `anthropic/claude-haiku-4-5` | Anthropic | 1 | 5 |
| `anthropic/claude-opus-4-8` … `4-5` | Anthropic | 5 | 25 |
| `anthropic/claude-sonnet-4-6` / `4-5` | Anthropic | 3 | 15 |
| `openai/gpt-5.6-sol` | OpenAI | 5 / 10 | 30 / 45 |
| `openai/gpt-5.6-terra` | OpenAI | 2.50 / 5 | 15 / 22.50 |
| `openai/gpt-5.6-luna` | OpenAI | 1 / 2 | 6 / 9 |
| `openai/gpt-5.5` | OpenAI | 5 / 10 | 30 / 45 |
| `openai/gpt-5.4` | OpenAI | 2.50 / 5 | 15 / 22.50 |
| `openai/gpt-5.4-mini` | OpenAI | 0.75 | 4.50 |
| `openai/gpt-5.4-nano` | OpenAI | 0.20 | 1.25 |
| `openai/gpt-5.2` / `5.1` / `5` | OpenAI | 1.75 / 1.25 / 1.25 | 14 / 10 / 10 |
| `openai/gpt-5-mini` | OpenAI | 0.25 | 2 |
| `google/gemini-3.6-flash` | Google | 1.50 | 7.50 |
| `google/gemini-3.5-flash` | Google | 1.50 | 9 |
| `google/gemini-3.5-flash-lite` | Google | 0.30 | 2.50 |
| `google/gemini-3.1-pro-preview` | Google | 2 / 4 | 12 / 18 |
| `google/gemini-3.1-flash-lite` | Google | 0.25 | 1.50 |
| `google/gemini-3-flash-preview` | Google | 0.50 | 3 |
| `xai/grok-4.5` | xAI | 2 / 4 | 6 / 12 |
| `xai/grok-4.3` | xAI | 1.25 / 2.50 | 2.50 / 5 |
| `xai/grok-4.20-{reasoning,non-reasoning,multi-agent}` | xAI | 1.25 / 2.50 | 2.50 / 5 |
| `perplexity/sonar` | Perplexity | 0.25 | 2.50 |
| `perplexity/glm-5.2` | Z.AI | 1.40 | 4.40 |
| `perplexity/kimi-k2.7-code` | Moonshot | 0.95 | 4 |
| `nvidia/nemotron-3-super-120b-a12b` | NVIDIA | 0.25 | 2.50 |

**Deep research models** (billed separately, not in the table above):

| Model | In | Cached | Out | Context | Cutoff |
|---|---|---|---|---|---|
| `o3-deep-research` | $10 | $2.50 | $40 | 200k | Jun 2024 |
| `o4-mini-deep-research` | $2 | $0.50 | $8 | 200k | Jun 2024 |
| `sonar-deep-research` | $2 | | $8 (+$2 citation, +$3 reasoning, +$5/1k searches) | 128k | |

**Context windows and cutoffs worth remembering:** `grok-4.5` 500k context, **Feb 2026 cutoff** (the most recent of anything here). `grok-4.3` and the 4.20 family 1M context.

**OpenAI suffix meanings:** `gpt-5.6` is the recommended default. `-sol` is the highest-intelligence option, used with `reasoning.mode: "pro"`. `-terra` is lower cost. `-luna` is lowest cost and latency.

---

## 3. Reasoning and effort controls

Every provider spells this differently and getting it wrong is a 400.

| Provider | Parameter | Values |
|---|---|---|
| **Anthropic** | `output_config.effort` with `thinking: {type: "adaptive"}` | `low` · `medium` · `high` (default) · `xhigh` · `max` |
| **OpenAI** | `reasoning.effort` (+ `reasoning.mode`: `standard`/`pro`) | `none` · `minimal` · `low` · `medium` · `high` · `xhigh` · `max`, model-dependent |
| **Google** | `generation_config.thinking_level` | `minimal` · `low` · `medium` · `high`, model-dependent |
| **xAI** | intrinsic on `grok-4.5` | n/a |

**Anthropic:** `thinking.type: "enabled"` with `budget_tokens` is **deprecated on 4.6 and returns a 400 on 4.7 and later** (Opus 4.7/4.8/5, Sonnet 5, Fable 5, Mythos 5). Migration is: drop `budget_tokens`, set `thinking: {type: "adaptive"}`, use `output_config.effort`. `effort: "high"` is identical to omitting it. `xhigh` is supported on Fable 5, Mythos 5, Opus 5, Opus 4.8, Opus 4.7, Sonnet 5. On Opus 5, thinking **cannot be disabled** at `xhigh` or `max` (400). Effort affects all tokens including tool calls, so lower effort means fewer tool calls. Changing effort mid-conversation invalidates prompt caching.

**Anthropic guidance:** `max` "adds significant cost for relatively small quality gains" on most workloads and can cause overthinking on structured-output tasks. At `xhigh`/`max`, set `max_tokens` large (64k is a reasonable start).

**OpenAI guidance:** `xhigh` is named specifically for "deep research, async and long-running agentic runs" and should be used "only when your evals show a clear benefit". gpt-5.5 and gpt-5.6 default to `medium`.

---

## 4. Benchmarks

### AIMultiple (run April 2026, page updated 22 June 2026)

`https://aimultiple.com/ai-deep-research`

**Bench 1: agents vs deep research.** 6 tools, 5 tasks, 33 binary ground-truth checkpoints against primary sources (Unity docs, an Atlassian SEC 8-K, Paramount press releases, the ARC-AGI-3 arXiv paper). Identical prompts, all ending "Cite all sources you used with URLs." Scoring: pattern matching for numbers/dates/names, GPT-4o judge for explanations, human validation. Agents ran via CLI with web search and **no MCP tools** (Claude Code on Opus 4.6, Codex on GPT 5.4, both medium effort).

| Model | Track | Accuracy | Words/task | Citations | Cost | Time |
|---|---|---|---|---|---|---|
| Claude Code | Agent | 97.0% | 483 | 48 | $1.54 | ~1.7 min |
| Parallel Ultra | DR | 97.0% | 1,601 | 94 | $2.10 | 16.7 min |
| Codex | Agent | 93.9% | 398 | 33 | $1.30 | |
| Perplexity Sonar | DR | 87.9% | 5,253 | 123 | | 2.3 min |
| o4-mini DR | DR | 81.8% | 513 | 62 | | |
| o3 DR | DR | 75.8% | 991 | 71 | $10.92 | |

Qualitative findings that matter more than the numbers:
- **Verbosity is anti-correlated with accuracy.** Sonar wrote 4,509 words on a Unity struct and named one of five public methods; Codex named all five in 248 words.
- **Three of six fetched Unity 6.0 docs when 6.3 was specified** (o3, o4-mini, Claude Code). A guide following o3 would target Android API 23 instead of 25.
- **No tool read all four upgrade guides in sequence.** Called a structural weakness in multi-document research.

**Bench 2: DR-50.** 50 questions, six categories (simple lookup, comparative, multi-hop, calculation, JSON extraction, categorical listing). GPT-4o-mini judge. Perplexity Sonar DR led at **34%**; Parallel Ultra and o4-mini ~22-24%; o3-deep-research lowest with high latency. o4-mini gave the most citations, o3 the fewest despite premium pricing. **Everything scores low here**, which is the real finding.

**Bench 3: DR-2T.** 7 tools, 2 tasks, five dimensions; each requested data point = 1 point, **non-table output scores 0**. Task 1 (enterprise password managers): Gemini and Claude rewarded for synthesised reports; Bright Data Deep Lookup skewed to raw structured data with confidence levels; Kimi produced an interactive report with visualisations. **Perplexity scored zero** by delivering prose instead of the requested table. Task 2 (RPA adoption): Grok Deep Search ~10× faster than ChatGPT DR and ~3× more pages (100+ in ~2 min); Claude indexed 261 sources in just over 6 min; Gemini 62 sources in over 15 min. **Gemini won data accuracy, Claude won indexed source count.**

Stated limitations: source counts don't necessarily correlate with quality; Task 2 had no objective ground truth so only reference counts were compared; Bright Data results provisional pending beta exit.

---

## 5. The review corpus

Ordered by date, because the contradictions between them are entirely explained by when they were written.

| Date | Source | Finding |
|---|---|---|
| **14 Mar 2025** | [SectionAI](https://www.sectionai.com/blog/chatgpt-vs-gemini-deep-research) | Competitive analysis for a board deck. OpenAI usability 4/5, quality 4.5/5, surfaced non-obvious competitors. Gemini usability 5/5, quality **2.5/5**, called "unusable", stayed at generic edtech level. Gemini did show an editable research plan; OpenAI did not |
| **24 Mar 2025** | [Sarah Constantin, *Rough Diamonds*](https://sarahconstantin.substack.com/p/ai-deep-research-tools-reviewed) | Five tools, one identical prompt on disease prodromes. ChatGPT A (33 sources, 15 conditions), PaperQA A, Elicit A− (credibility A+, all-paper sourcing), Gemini B (6 conditions from 38 sources, claims not attached to sources), Perplexity C+ (15 sources, 8 conditions). **"None had a problem with overt hallucination."** All capped ~40 sources. ChatGPT alone extended to precancerous lesions despite "cancer prodrome" being non-standard phrasing |
| **26 Mar 2025** | [MIT Sloan](https://mitsloanedtech.mit.edu/2025/03/26/deep-research-transforming-the-creation-of-learning-materials-with-research-backed-ai/) | 16-page case study, 22 sources, ~6 minutes. **Fabricated a citation** to a non-existent "Kumar and colleagues (2024)". A second instance quoted an unnamed "researcher" with no citation, which he notes is easier to spot precisely because attribution is missing |
| **5 Dec 2025** | [Hassan Lâasri, Data Science Collective](https://medium.com/data-science-collective/deep-research-in-ai-the-insight-gap-446118ebe76e) | The "insight gap". Quotes Nathan Lambert: "powerful information engines, not insight engines" and "a new discovery is indistinguishable from an error". Cites *Royal Society Open Science* (Peters & Chin-Yee) on persistent overgeneralisation in scientific summarisation, and Apple's "Illusion of Thinking" |
| **13 May 2026** | [LivePlan](https://www.liveplan.com/blog/planning/deep-research-chatgpt-vs-gemini) | Two real jobs. **No factual errors in either.** ChatGPT asks clarifying questions, 18 sources, inline clickable citations. Gemini 47 sources, numbered chapters, comparison tables, flags conflicts and picks a side, but buries the plan behind an expandable widget. **The synthesis failure**: Gemini found the business count, QuickBooks' share, *and* that only ~half use accounting software, then ignored the third when multiplying |
| **22 Jun 2026** | AIMultiple | See [§4](#4-benchmarks) |

**The durable finding:** the failure mode migrated. 2025 reviews worry about fabricated citations; 2026 reviews find correct facts assembled into wrong conclusions. Link-checking defends against the earlier problem.

**Paperguide** (vendor marketing, treat accordingly): cites a 2024 JMIR analysis reporting reference-hallucination rates of **28.6% for GPT-4 and 39.6% for GPT-3.5** for systematic-review citations; a 2025 Acta Orthopaedica Belgica study finding **45.4% of references contained bibliographic errors**; and SANRA (Baethge et al. 2019) as the narrative-review analogue to PRISMA. Their narrative-review workflow is a six-stage extraction matrix (up to 100 papers × 50 parameters, **each cell linked to its source passage**), which is the same shape as Perplexity's wide research and `Deep-Research-skills`' items × fields.

---

## 6. Academic survey

**Xu & Peng, *A Comprehensive Survey of Deep Research: Systems, Methodologies, and Applications***. arXiv 2506.12594v1, 14 June 2025, Zhejiang University. 80+ implementations. Resources at `https://github.com/scienceaix/deepresearch`.

**Four technical dimensions** (the taxonomy the provider interface mirrors):
1. Foundation models and reasoning engines
2. Tool utilisation and environmental interaction
3. Task planning and execution control
4. Knowledge synthesis and output generation

**Four architectural patterns:** monolithic, pipeline-based, multi-agent, hybrid.

**Domain suitability** (their §3.2):
- **Academic research** → OpenAI/DeepResearch. arXiv, IEEE Xplore, PubMed, Google Scholar integration; statistical method identification; IEEE/APA/MLA/Chicago citation management. Also PaperQA, Scite, NotebookLM.
- **Enterprise decision-making** → Gemini/DeepResearch. Information currency, analytical depth, actionable output formats.
- **Personal knowledge management** → Perplexity/DeepResearch. Accessibility and a free tier, weaker personalisation.

**Benchmark scores they collate:** OpenAI DR 26.6% HLE / 67.36% GAIA; Perplexity DR 21.1% HLE / 93.9% SimpleQA; Manus 86.5% GAIA; Grok3Beta 92.7% MMLU; Agent-RL/ReSearch 37.51% HotpotQA. Also cite Gemini 2.5 Pro user-preference wins over OpenAI DR: instruction following 60.6% vs 39.4%, comprehensiveness 76.9% vs 23.1%, completeness 73.3% vs 26.7%, writing quality 58.2% vs 41.8%.

**Response times:** OpenAI DR 5-30 min, Perplexity DR ~3 min.

**Timeline:** Google Gemini DR Dec 2024 (first), OpenAI DR Feb 2025, Perplexity DR Feb 2025, Anthropic Claude Research Apr 2025.

---

## 7. Gemini web app

### DOM, verified by inspection 25 July 2026 (signed out)

| Control | Accessible name | Role |
|---|---|---|
| Prompt input | `Enter a prompt for Gemini` | `textbox` |
| Tools menu | `Upload & tools` | `button` (has `expanded` state) |
| **Deep Research** | `Deep research` | **`menuitemcheckbox`**, `checked=false` |
| Model picker | `Open mode picker, currently <name>` | `button` |
| Model options | `3.6 Flash All-around help`, `3.1 Pro Advanced math & code` | `menuitem` |
| Other tools | `Create image`, `Create video`, `Canvas` | `menuitemcheckbox` |

Signed out, every tool menuitem is `disabled` and the model picker offers only `3.5 Flash-Lite`.

**Label drift:** Google's support docs still call the entry point "Add Files"; a third-party walkthrough calls it a globe icon; the live DOM says "Upload & tools". The `menuitemcheckbox "Deep research"` child has been stable across all three. **Anchor on the child, resolve the parent by role.**

### Flow, from Google support doc 15719111

```
gemini.google.com → tools → Deep research
  → (optional) Sources: Gmail / Drive / uploads / NotebookLM
     (Google Search is a source BY DEFAULT and must be deselected to exclude)
  → prompt → Submit
  → research plan appears
  → [Edit plan] to revise  |  [Start research] to approve
  → ~5-10 min (longer for complex topics)
  → [Open] → report renders in the CANVAS PANEL on the right, not the chat
  → Share & export → Share Canvas | Export to Docs | Copy Contents
```

No direct PDF export; PDF goes via Docs. Past reports under **Recent**, only if Keep Activity is on. Runs are asynchronous: you can leave the app or shut the machine down and be notified next visit. **Unconfirmed:** whether "Edit plan" is an inline editor or a conversational turn; whether mid-run refresh is safe (documented async design implies yes).

### Model tiers

All users get **Thinking**; AI Pro and Ultra add **Pro**. Docs use capability names (Thinking/Pro/Fast) while the DOM shows versions (3.6 Flash, 3.1 Pro); **the mapping is never stated explicitly**.

### Limits

**Personal accounts** moved to compute-based limits on **17 May 2026**: allowance refreshes every 5 hours until a weekly cap; consumption factors in prompt complexity, features used and chat length. Deep Research is a premium feature that draws down faster. Relative caps: no plan standard, AI Plus 2×, AI Pro 4×, AI Ultra 5× or 20× AI Pro depending on subscription. **No per-run Deep Research number is published**; any specific figure in blog posts is third-party. Free users may find Deep Research unavailable during high demand. Under-18 accounts unaffected by the change.

**Workspace** (support 14620100), which has hard numbers and a different limit *shape*:

| Tier | Deep Research | Pro model | Context |
|---|---|---|---|
| Additional service (Cloud Identity, Chrome Enterprise, Business Base, Essentials Starter, G Suite, Workspace Individual) | 5 / month | basic, varies | 32k |
| Core standard (Business Starter, Essentials, Enterprise Essentials(+), Frontline, Nonprofits) | 20 / day | basic, varies | |
| Core Pro (Business Standard, Business Plus, Enterprise Standard, Enterprise Plus) | 30 / day | **up to 25 prompts / 4 hours** | 1M |
| AI Expanded Access | 120 / day | up to 200 prompts / day | 1M |
| AI Ultra Access | unconfirmed | up to 500 prompts / day | 1M |

The per-4-hours metering on Business Standard/Plus is the business-vs-consumer difference. Users self-identify by the Pro/Expanded/Ultra badge at the top of gemini.google.com; no badge means standard. The older "10 reports per user per 30 days" figure (Workspace Updates, 13 Mar 2025) is superseded.

**Admin gating is real.** Admin console → Generative AI → Gemini app → **Service status**, On/Off for everyone or scoped by OU or group (group overrides OU), needs Gemini Settings admin privilege, up to 24h propagation. ON by default for licensed users 18+, but additional-service editions need explicit enabling. A separate **User access** setting can extend the app to unlicensed users. **An automation can find Deep Research simply absent on a business account.**

### Share links

Public. `g.co/gemini/share/<id>` 301s once to `https://gemini.google.com/share/<id>`, returns HTTP 200, ~779KB `text/html` with server-rendered Open Graph tags and a Google `AF_initDataCallback` payload. Anyone with the link can read it; Google does not put your name or account in the URL. Sharing is all-or-nothing for the whole conversation. Revoke via Settings & help → **Your public links**.

**Unconfirmed:** whether the full report body sits in the server-rendered payload (only a bogus id was probed).

**Workspace conflict:** support 14620100 says work/school users cannot create public links, while the Workspace Updates post of 4 March 2026 says admins can now enable it, **off by default**, scoped by domain/OU/group. Assume unavailable unless an admin opted in.

### Terms of service

> `https://gemini.google.com/robots.txt` is four lines:
> ```
> User-agent: *
> Allow: /app/download
> Disallow: /app/
> Disallow: /chat/
> ```

Google's main ToS (`https://policies.google.com/terms`), under **Don't abuse our services**, prohibits "using automated means to access content from any of our services" where that violates machine-readable instructions on Google's pages, **naming robots.txt as its own example**. The Gemini web app runs at `/app`. On a plain reading, driving that UI with an agent is what the clause describes. Account suspension is separately listed as a consequence of scraping content that isn't yours.

Counterweight: robots.txt is a crawler convention and an agent operating inside the user's own signed-in session at their direction is arguably not crawling. No carve-out published, no enforcement precedent found. **Untested rather than settled.**

**`/share/` is not disallowed.** This is the basis for the share-link-import design.

Two more: the ToS also prohibits using AI-generated output from Google's services to develop machine learning models or related AI technology (an independent problem if output feeds training or evals). And `https://policies.google.com/terms/generative-ai` is **stale**: those Generative AI Additional Terms ceased to apply 22 May 2024 when the provisions folded into the main ToS. Cite the main terms.

---

## 8. Browser automation tooling

| Driver | Official? | Reaches an existing Google login | One-time manual setup |
|---|---|---|---|
| **claude-in-chrome** | Anthropic | ✅ by default, shares browser login state | Install extension, `/login`, `claude --chrome` |
| **chrome-devtools-mcp** `--autoConnect` | Google (Chrome DevTools team) | ✅ Chrome 144+ | Visit `chrome://inspect/#remote-debugging`, click Allow. Chrome must already be running |
| **chrome-devtools-mcp** default / `--browserUrl` | same | ❌ | `--remote-debugging-port` *requires* a non-default `--user-data-dir`, so your logins aren't there |
| **@playwright/mcp** `--extension` | Microsoft | ✅ | Install Playwright extension from the Web Store, run with `--extension`, pick the tab |
| **@playwright/mcp** default | same | ❌ | Separate persistent profile under `~/Library/Caches/ms-playwright/mcp-{channel}-{hash}` |
| **Safari MCP** | **Apple** | ❌ isolated automation window | Safari 27 beta or STP 247+; Settings → Advanced → "Show features for web developers", then Developer → "Allow remote automation and external agents" |
| **safari-mcp** (npm) | Third party | ✅ claims to keep logins | Develop → "Allow JavaScript from Apple Events", grant Automation + Screen Recording |
| **agent-browser** | Third party | ❌ own profile, `state save` persists | `npm i -g agent-browser && agent-browser install` |

```bash
claude --chrome
claude mcp add chrome-devtools --scope user -- npx chrome-devtools-mcp@latest --autoConnect
claude mcp add playwright -- npx @playwright/mcp@latest --extension
```

**Key finding:** Google actively blocks sign-in from browsers flagged as automated. chrome-devtools-mcp's README cites exactly this as the reason `--autoConnect` exists. So for Google-authenticated pages the isolated-profile options aren't merely inconvenient, **manually logging in inside the automation window will likely fail too**.

**There is no official Google "Chrome MCP"** distinct from chrome-devtools-mcp. Google's DevTools-for-agents page lists exactly one product. "Chrome MCP Server" listings on the Web Store are third-party (`hangwin/mcp-chrome`). WebMCP (`navigator.modelContext`, Chrome 146 Canary behind a flag) is a **web standard**, not an installable server.

**Safari MCP is real and Apple-official**: announced on the WebKit blog 1 July 2026, a `--mcp` flag on `safaridriver`, 17 tools, Safari 27 beta and STP 247+. **This machine has macOS 26.5 / Safari 26.5 and `safaridriver` shows only `--port, --bidi, --enable, --diagnose`; no `--mcp`.** STP 248 (22 July 2026) runs on macOS 26. Its automation windows are documented as isolated from normal browsing with no AutoFill or history access, which is inference from the AutoFill exclusion plus safaridriver's long-documented model rather than a direct statement in the July 2026 post.

**chrome-devtools-mcp details:** ~52 tools across input/navigation/emulation/performance/network/debugging/memory/extensions; `--slim` reduces to 3. Default profile at `$HOME/.cache/chrome-devtools-mcp/chrome-profile-$CHANNEL`. Flags worth knowing: `--isolated`, `--headless`, `--viewport`, `--blockedUrlPattern`/`--allowedUrlPattern`, `--redactNetworkHeaders`. Usage statistics are **on by default**; opt out with `--no-usage-statistics`. Performance traces may send URLs to Google's CrUX API (`--no-performance-crux`).

**Playwright MCP correction:** no standalone `--channel` flag; channel folds into `--browser` or `launchOptions.channel`.

---

## 9. CLI agents and subscriptions

### agy (Antigravity CLI), the best free path

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash   # → ~/.local/bin/agy
irm https://antigravity.google/cli/install.ps1 | iex          # Windows PowerShell
```

Flags: `--skip-aliases`, `--skip-path`. Windows installs to `%LOCALAPPDATA%\agy\bin`. Version seen: **1.1.7**.

**Auth is account sign-in only.** Checks the OS keyring first (Apple Keychain / Linux Secret Service / Windows Credential Manager), signs in silently if a valid token profile exists, otherwise opens a browser. Over SSH it prints an authorisation URL and takes a pasted code. `/logout` clears keyring profiles and caches. **No documented API-key or Vertex path; bring-your-own-key is explicitly not supported.**

**Tiers map to Google AI subscriptions:**

| Plan | Quota |
|---|---|
| **Ultra** | Highest quota, refreshed **every 5 hours**, highest weekly rate limits |
| **Pro** | High quota, refreshed **every 5 hours** until weekly limit, plus a flexible AI credit pool |
| **Free, $0/month** | "Basic weekly rate limits", unlimited tab completions and command requests |

**Free-tier model list, verbatim from `https://antigravity.google/pricing`:** "Agent model: access to Gemini 3.5 Flash, Gemini 3.1 Pro, Gemini 3 Flash, **Claude Sonnet & Opus 4.6**, gpt-oss-120b." Third-party models are **not** gated behind a paid plan; Pro and Ultra buy throughput, not model selection. (`/docs/plans` phrases Ultra as adding "access to third-party models", which conflicts with the pricing page's explicit free-tier list. The pricing page is more specific and is quoted above.) BYO API key is explicitly unsupported on consumer plans; consumption pricing exists only via the Organization plan on Google Cloud. Antigravity was announced 18 Nov 2025 alongside Gemini 3; the CLI shipped ~19 May 2026 and is the official Gemini CLI migration target.

All tiers get all product features **including the CLI and Scheduled Tasks**. No numeric quotas published; limits scale with work performed rather than prompt count. Overage via AI credits at Gemini Enterprise Agent Platform consumption pricing, controlled by `useG1Credits` in `~/.gemini/antigravity-cli/settings.json` or `/config` → "Use G1 Credits" (also surfaced as "AI Credit Overages": Never | Always). `/credits`, `/usage`, `/quota` report status; statusline shows `AI Credits: N`.

**MCP config** (read by both the IDE and the CLI):

| Scope | Path |
|---|---|
| Global | `~/.gemini/config/mcp_config.json` |
| Workspace | `.agents/mcp_config.json` |

`mcpServers` object; `command` for stdio, **`serverUrl`** for Streamable HTTP / SSE. **`url` and `httpUrl` are documented as unsupported.** Optional: `args`, `env`, `cwd`, `headers`, `authProviderType` (`"google_credentials"` for ADC), `oauth`, `disabled`, `disabledTools`. There is **no `agy mcp add`**; use `/mcp` for the MCP Manager overlay or edit the JSON. Unconfigured MCP tools default to "Ask"; policy patterns `mcp(server/tool)`, `mcp(server/*)`, `mcp(*)`.

Other CLI surface: `/config` `/settings` `/permissions` `/rewind` `/undo` `/fork` `/clear` `/resume` `/keybindings` `/agents` `/codesearch` `/diff` `/statusline` `/title`. Launch flags include `--sandbox` and `--dangerously-skip-permissions`. Keybindings at `~/.gemini/antigravity-cli/keybindings.json`; `cli.exit` and `cli.enter` cannot be disabled.

**Not installed on this machine** as of 25 July 2026 (`agy` not on PATH, no `~/.gemini/antigravity*`).

### Claude Code

Subscription-covered on Pro / Max / Team / Enterprise. Usage draws a per-seat allowance on a **rolling five-hour window plus a weekly window**, shared with Claude chat and Cowork. `/usage` shows plan bars and attributes usage to skills, subagents, plugins and individual MCP servers. Usage credits extend past the limit (`/usage-credits`, unavailable under API-key auth). Cache lifetime is **an hour on a subscription**, dropping to five minutes on usage credits or API keys.

Enterprise averages quoted: ~$13/developer/active day, $150-250/developer/month, under $30/active day for 90% of users.

**Bundled `/deep-research` workflow**, verbatim: "Fans out web searches on a question across several angles, fetches and cross-checks the sources it finds, votes on each claim, and returns a cited report with claims that didn't survive cross-checking filtered out." Requires **v2.1.154+**, all paid plans; **on Pro you must enable Dynamic workflows in `/config`**. Runtime caps: **16 concurrent agents, 1,000 agents per run**. Since v2.1.196 an unverifiable claim is reported as *unverified* rather than counted as refuted. Since v2.1.218 it runs only when invoked. Requires the WebSearch tool.

Convergent evidence for the plan's design: fan out, cross-check, vote per claim, filter what does not survive. Anthropic arrived at the same shape independently.

**Cost trap worth documenting:** `ANTHROPIC_API_KEY` in the environment **outranks** the subscription, and in `-p`/non-interactive mode it is used unconditionally with no prompt, so an exported key silently converts every call to per-token billing. Verify with `/status`. Also: `claude setup-token` produces a `CLAUDE_CODE_OAUTH_TOKEN` that works for SDK use and draws the plan, **but** the Agent SDK docs state Anthropic "does not allow third party developers to offer claude.ai login or rate limits for their products" unless previously approved. Local self-use is supported; distributing something that runs other people's work on your login is the restricted case. Whether CLI subprocess invocation is treated identically is unconfirmed.

WebSearch/WebFetch are built in with **no per-search fee on a subscription** (the API charges $10/1,000 searches). Limit of **200 WebSearch calls per session**, shared across subagents; raise with `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`.

### Codex CLI

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex                # first run offers "Sign in with ChatGPT"
codex --search       # live web search
codex mcp            # connect MCP servers
codex exec           # non-interactive, for scripts and CI
```

**Sign in with ChatGPT is a documented option.** Which tiers qualify and what the limits are is **not** on the CLI page; it defers to `/codex/auth` and `/codex/pricing`. The deep-research models remain API-key-billed.

### Gemini CLI

> **Consumer access was withdrawn 18 June 2026.** Per `https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals`: Gemini Code Assist IDE extensions "stopped serving requests for the Gemini Code Assist for individuals, Google AI Pro, and Google AI Ultra tiers", and this "also applies to usage of Gemini CLI". Also: "you can no longer use the **Login with Google** option to access the IDE extensions or Gemini CLI." Code Assist **Standard/Enterprise unchanged**. Migration target is Antigravity.
>
> **The `google-gemini/gemini-cli` README and GitHub Pages docs are STALE**: they still advertise the 60 rpm / 1,000 rpd OAuth free tier and still say Pro/Ultra raise CLI limits. The Google Cloud deprecation page is authoritative. That stale figure is what I originally wrote here; corrected 25 July 2026.

Remaining paths: `GEMINI_API_KEY` (API billing), Vertex via `GOOGLE_GENAI_USE_VERTEXAI=true`, or a Code Assist Standard/Enterprise seat. Install `npm install -g @google/gemini-cli` or `brew install gemini-cli`; channels `@preview` (Tue 23:59 UTC), `@latest` (Tue 20:00 UTC), `@nightly`. **Never had Deep Research**; capabilities are Google Search grounding, checkpointing, GEMINI.md context. Issue #25165 (closed May 2026) records "no immediate plans" for it.

### Grok Build (xAI official CLI)

```bash
curl -fsSL https://x.ai/cli/install.sh | bash    # → ~/.grok/bin
irm https://x.ai/cli/install.ps1 | iex
```

Source `https://github.com/xai-org/grok-build` (Rust, Apache-2.0, beta ~May 2026). Binary is **`grok`**; the installer also drops a binary named **`agent`** into `~/.grok/bin`. Default model `grok-4.5`; coding model `grok-build-0.1` (256k ctx). Config at `~/.grok/config.toml`, credentials at `~/.grok/auth.json` (0600). Headless via `grok -p "..."` with `--output-format streaming-json`. `grok inspect` reports discovered config, skills, plugins, hooks and MCP servers.

**Auth:** browser opens on first launch; `XAI_API_KEY` is the documented fallback "for non-browser environments". Also enterprise OIDC and `grok login --device-auth`. Precedence: per-model key > session token > `XAI_API_KEY`.

**MCP:** `grok mcp add|list|remove|doctor`, and it reads `~/.claude.json` and `~/.cursor/mcp.json` for compatibility. Official marketplace at `xai-org/plugin-marketplace`; Claude Code bridge at `xai-org/grok-build-plugin-cc`.

**Billing, carefully:** the **REST API is credits-only** ("Sign up at accounts.x.ai, then load it with credits"; the billing FAQ notes web and app payments "are not affected"). X help lists Premium/Premium+ as giving only "higher limits on Grok", not API access. **Whether the CLI's browser-OAuth path draws on a SuperGrok subscription is not stated in xAI's own docs.** Two third-party integrations using the same OAuth flow say a Grok or X Premium plan with Grok API access works without a key (OpenCode's provider docs; Kilo Code's xAI page: "Usage counts against your subscription, not a pay-per-token API account"). Corroboration, not confirmation. Tiers: SuperGrok Lite $10, SuperGrok $30, SuperGrok Heavy $300. Grok Build **on the web** is gated behind SuperGrok Heavy per a config string on grok.com; whether the CLI carries the same gate is unconfirmed.

**Verified against a real install, 25 July 2026** (this machine): `grok --version` prints `grok 0.2.112 (9bbd559437aa)`: the product name and a hash, with nothing that separates it from the third-party package of the same name. The installer puts symlinks in `~/.grok/bin/{grok,agent}` pointing at `~/.grok/downloads/grok-macos-aarch64`, **and also symlinks `~/.local/bin/agent` to it**, replacing whatever was there: on this machine that had been Cursor's `agent` an hour earlier. Config home is `~/.grok/` with `auth.json` (0600), `config.toml` and `trusted_folders.toml`. So identity for this CLI has to come from install provenance rather than the version string, and Cursor must be detected as `cursor-agent` rather than `agent`.

**Name collisions:** the third-party `superagent-ai/grok-cli` (now npm `grok-dev`, formerly `@vibe-kit/grok-cli`) also claims `grok` and needs its own `GROK_API_KEY`; its README states it is "not affiliated with, endorsed by, or sponsored by xAI Corp." Cursor also puts an `agent` binary on PATH. PATH order decides.

**Also:** `grok-code-fast-1` was retired 15 May 2026 and its slug redirects to `grok-build-0.1`. xAI's docs MCP server at `https://docs.x.ai/api/mcp` is a **documentation** server (`list_doc_pages`, `get_doc_page`, `search_docs`), not an MCP interface to Grok. DeepSearch/DeeperSearch no longer appear in current Grok docs; the grok.com mode picker is Auto / Fast / Expert / Heavy.

### Cursor CLI

```bash
curl https://cursor.com/install -fsS | bash                 # → ~/.local/bin
irm 'https://cursor.com/install?win32=true' | iex
```

Binary is **`agent`**, not `cursor-agent`. Needs `~/.local/bin` on PATH. Auth: `agent login` (browser; `NO_OPEN_BROWSER=1` prints the URL), `agent status`, `agent logout`, or `CURSOR_API_KEY` / `--api-key`.

**Subscription-covered.** Cursor's launch post: "The CLI works with any model as part of your Cursor subscription." Same request pools as the IDE and Cloud Agents; `/usage` shows plan meters and cycle reset. Two pools: Cursor Models (generous included usage) and Other Models (third-party at API price; Pro $20/mo includes $20 of Other Models). The pricing pages themselves don't mention the CLI, so the pool detail is inferred from the blog, SDK docs and `/usage`.

**MCP:** same `mcp.json` as the editor; `agent mcp list|list-tools|login|enable|disable`, `/mcp`, `--approve-mcps`.

**Headless:** `-p/--print` with full tool access, `--output-format text|json|stream-json`, `--stream-partial-output`, `--model`, `--mode plan|ask`, `--resume`/`--continue`, `--sandbox`, `--force`/`--yolo`, `--trust`. **`--force` is required for the agent to write files in print mode.** Web search exists but is documented only in the 13 July 2026 changelog (`autoAcceptWebSearch` in `cli-config.json`); the permissions reference page lags and shows only `WebFetch(domainOrPattern)`.

### Perplexity

MCP **requires an API key**; Pro is not accepted.

MCP config paths seen across clients: Cursor `~/.cursor/mcp.json`; VS Code `.vscode/mcp.json` (uses `"servers"` with `"type": "stdio"`, not `"mcpServers"`); Claude Desktop `claude_desktop_config.json`; Windsurf `~/.codeium/windsurf/mcp_config.json`.

---

## 10. Prior art repos

### `Weizhena/Deep-Research-skills` (cloned to `../Deep-Research-skills`)

Two-phase: outline generation then deep investigation, human-in-the-loop. Inspired by RhinoInsight (arXiv 2511.18743). Ships for Claude Code, OpenCode and Codex.

Commands: `/research` (outline), `/research-add-items`, `/research-add-fields`, `/research-deep`, `/research-report`.

**The core idea is entity × field.** `outline.yaml` holds topic, items, and execution config (`batch_size`, `items_per_agent`, `output_dir`). `fields.yaml` holds field definitions with `detail_level` (brief → moderate → detailed) and an `uncertain` list. `/research-deep` dispatches one agent per item batch, each writing a JSON file, then runs `validate_json.py -f fields.yaml -j output.json` as a **completion gate**.

Worth stealing: `[uncertain]` markers per value plus an `uncertain[]` array; validation as a gate; resume by skipping completed files; batch approval between waves; time-range asked explicitly at outline time.

Its `web-search-agent` routes to **source-class modules** that must be loaded before any search: `github-debug.md`, `general-web.md`, `academic-papers.md`, `chinese-tech.md`, `stackoverflow.md`. Multi-module routing for cross-domain tasks. Generates 5-10 query variations per topic, including novice-vs-expert phrasings and quoted error strings.

### `daymade/claude-code-skills` deep-research

Lead agent coordinates subagents; raw search results stay out of the coordinator context (claimed 60-70% reduction) by having subagents write to `research-notes/`.

**Accessibility classes:** `public`, `semi-public`, `exclusive-user-provided` (allowed and encouraged for third-party research), `private-user-owned` (**forbidden**, "circular verification": using the user's own private data to discover facts they already possess).

**Source types:** official, academic, secondary-industry, journalism, community, other.

**Quality gates.** Standard: ≥30% official, ≥12 approved sources, ≥5 domains, ≤25% single-source share. Lightweight: ≥20%, ≥6, ≥3, ≤30%.

**AS_OF policy:** set the date at P0, attach publication dates to citations, downgrade confidence for stale material (studies >3 years, news >6 months on fast-moving topics).

**Pipeline P0-P7:** capability check and policy setting; task board (expert role, objective, queries, DEEP/SCAN depth, output path, parallel group max 3); parallel dispatch; **merge and dedupe by URL into a numbered registry where numbers are final and dropped sources are listed**; evidence-mapped outline; draft from notes only with `[unverified]` markers and per-section confidence; **mandatory counter-review requiring ≥3 issues** via four agents (claim-validator, source-diversity-checker, recency-validator, contradiction-finder); verify every citation against the registry, spot-check 5+ claims, confirm no dropped source reappeared.

**Information black box:** if an entity has no public footprint, report zero sources and document each failed check rather than filling gaps.

**Anti-patterns:** single-pass drafting, uncited claims, invented URLs, resurrecting dropped sources, missing AS_OF, skipping counter-review, circular verification, failing to use exclusive sources the user offers.

### `mvanhorn/last30days-skill` (cloned to `../last30days-skill`)

Multi-source recency research: Reddit, X, YouTube, TikTok, Instagram, Hacker News, **Polymarket**, GitHub, Digg, Bluesky, Truth Social, Threads, Pinterest, Xiaohongshu, Trustpilot.

Concepts worth importing (from `CONCEPTS.md`):
- **Primary entity / intent modifier**: strip "review", "pricing" etc. to get what the research is *about*.
- **Entity grounding**: check a candidate mentions the primary entity's *head token* before final ranking. Decisive demotion on failure, so the bar is deliberately conservative; failures degrade toward "no penalty", never toward burying on-entity signal.
- **Keyless path**: scraping and RSS, local scoring instead of LLM reranking. The free tier.
- **Confidence floor**: engagement junk-gate, then either independent cross-source corroboration or a genuinely strong single-source spike. **Absolute, not relative to the current pool**, because a relative bar degrades with the pool.
- **Nothing-solid**: the honest empty outcome. Reports that nothing cleared the floor and names the closest sub-floor candidate.
- **Junk shape**: a leading item reading as a help-me question rather than a story. A host junk verdict excludes outright; a heuristic one only removes the single-source bypass.
- **Discovery**: topic-less mode that finds what's worth researching. Three-leg host-judged protocol with a **handoff checkpoint** (identity-bound by bundle id, time-bound by TTL; structurally empty state is treated as corruption and fails closed).
- **Topic queue / Covered**: memory of what's been surfaced. Annotate-only identity, so a false match costs one noisy line, never a hidden story.

**Provider priority ladders**, directly relevant to our routing:
- *Reasoning*: Gemini → OpenAI → xAI → OpenRouter → local deterministic. On Claude Code / Codex / Gemini hosts, **the host model is the reasoning provider** and no keys are needed.
- *Web search*: host web search → paid backend (Brave, Exa, Serper, Parallel) → keyless floor (DuckDuckGo + optional SearXNG, Jina Reader for fetch). The floor runs **only** when there's no host search and no paid key, signalled by `LAST30DAYS_NATIVE_SEARCH=1`.

**`doctor`**: four-state audit (WORKING / TURNED ON-UNVERIFIED / NOT WORKING / COULD BE ON), one line per source, with an exact fix for anything broken, plus `--json` and `--cached`.

**Local corpus privacy model**: `LAST30DAYS_CORPUS_DIRS`, read locally, never sent through a source HTTP client, never forwarded to a remote backend or reranker, excluded from exports by default, cached by mtime at `0600`. A configured corpus **bypasses the hosted backend** rather than forwarding file-derived input.

Their Perplexity integration notes (useful precedent): `--deep-research` uses `sonar-deep-research` via the async endpoint with a **deterministic idempotency key derived from the request body**, polls to a hard wall-clock deadline, and on timeout records the async id, idempotency key, last status, lifecycle timestamps and poll count so a run can be resumed by id outside the process.

### `UditAkhourii/adhd` (`~/Downloads/ADHD.md`)

Parallel divergent ideation. Two strict phases: **diverge with no critic** (5 frames × 6 ideas, "the first three obvious answers everyone would give are banned"), then **focus with critic on** (score novelty/viability/fit, cluster by underlying angle, deepen top 3).

**The critical invariant:** branches must be **parallel and isolated**. "Branches that see each other anchor each other and the whole method collapses to a wider single thought."

Frames: hardware engineer, regulator, 10-year-old, competitor trying to break it, biology, logistics, game design, markets, inversion, $0 budget/1 hour, infinite budget/10 years, remove the load-bearing assumption, speedrunner, ant colony, 3am on-call.

Anti-patterns: convergence disguised as divergence ("ten minor variations of one idea is not breadth"), weird-for-weird's-sake with no convergence, walls of equally-weighted prose, and **refusing to commit** ("here are 20 ideas, you decide" is a cop-out).

Applied to research this becomes **frame-diverse sweeps**: the same question run under different vantages, each generating different search terms, which is the same mechanism as last30days' multi-modal sweep arrived at independently.

---

## 11. URL index

**Provider docs**
- `https://docs.perplexity.ai/llms.txt` (index)
- `https://docs.perplexity.ai/docs/sonar/models/sonar-deep-research`
- `https://docs.perplexity.ai/docs/agent-api/quickstart` · `/models.md` · `/wide-research.md` · `/background-mode.md`
- `https://docs.perplexity.ai/docs/getting-started/integrations/mcp-server.md`
- `https://developers.openai.com/api/docs/guides/deep-research`
- `https://developers.openai.com/api/docs/models/o3-deep-research` · `/o4-mini-deep-research`
- `https://developers.openai.com/api/docs/guides/reasoning`
- `https://learn.chatgpt.com/docs/codex/cli`
- `https://docs.x.ai/developers/tools/collections-search` · `/x-search` · `https://docs.x.ai/docs/models`
- `https://ai.google.dev/gemini-api/docs/thinking`
- `https://platform.claude.com/docs/en/docs/build-with-claude/effort` · `/extended-thinking`
- `https://code.claude.com/docs/en/costs`

**Antigravity**
- `https://antigravity.google/docs/cli/using` · `/install` · `/credits` · `https://antigravity.google/docs/mcp` · `https://antigravity.google/docs/plans`

**Gemini web app**
- `https://support.google.com/gemini/answer/15719111` (Deep Research flow)
- `https://support.google.com/gemini/answer/14620100` (Workspace tiers)
- `https://support.google.com/gemini/answer/13743730` (share links)
- `https://support.google.com/gemini/answer/17004136` · `/16275805` (May 2026 compute limits)
- `https://knowledge.workspace.google.com/admin/generative-ai/gemini-app/turn-the-gemini-app-on-or-off`
- `https://workspaceupdates.googleblog.com/2026/03/workspace-admins-can-allow-gemini-app-conversation-for-their-organizations.html`
- `https://gemini.google.com/robots.txt` · `https://policies.google.com/terms`

**Browser tooling**
- `https://github.com/ChromeDevTools/chrome-devtools-mcp`
- `https://developer.chrome.com/docs/devtools/agents`
- `https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/`
- `https://webkit.org/blog/6900/webdriver-support-in-safari-10/`
- `https://developer.apple.com/safari/resources/`

**Evaluations**
- `https://aimultiple.com/ai-deep-research`
- `https://sarahconstantin.substack.com/p/ai-deep-research-tools-reviewed`
- `https://medium.com/data-science-collective/deep-research-in-ai-the-insight-gap-446118ebe76e`
- `https://www.liveplan.com/blog/planning/deep-research-chatgpt-vs-gemini`
- `https://www.sectionai.com/blog/chatgpt-vs-gemini-deep-research`
- `https://mitsloanedtech.mit.edu/2025/03/26/deep-research-transforming-the-creation-of-learning-materials-with-research-backed-ai/`
- `https://paperguide.ai/blog/ai-tools-for-narrative-review/` · `/ai-for-references-and-citations/` · `/ai-tools-for-research-papers/` · `/ai-tools-for-research-methodology/`
- `https://paperguide.ai/deep-research-ai/` · `/research-agent/` · `/writer/`

**Supplied by hand, not fetchable.** `chatgpt.com/features/deep-research/`, `help.openai.com/.../deep-research-in-chatgpt` and `openai.com/index/introducing-deep-research/` all return **403** to WebFetch, and the browser path serves a Cloudflare bot-detection challenge that does not resolve for an automated session. Bypassing bot detection is off-limits, so Luke pasted the page text in. Findings in [§12](#12-chatgpt-deep-research-the-consumer-product).

Worth recording as evidence for the plan's own argument: the anti-automation wall that blocked a research agent from reading these pages is exactly what makes browser-driven research fragile.

**Academic**
- arXiv 2506.12594 (Xu & Peng survey) · `https://github.com/scienceaix/deepresearch`
- arXiv 2511.18743 (RhinoInsight, cited by Deep-Research-skills)

**Prior-art repos**
- `https://github.com/Weizhena/deep-research-skills`
- `https://github.com/daymade/claude-code-skills`
- `https://github.com/mvanhorn/last30days-skill`
- `https://github.com/UditAkhourii/adhd`

---

**See also:** [the plan](../plan/multi-provider-research.md) · [provider guides](../providers/README.md) · [the article](../../blog/the-state-of-deep-research.md)

---

## 12. ChatGPT Deep Research, the consumer product

Distinct from the API, and in several ways **more capable**. Sources: OpenAI help centre (updated ~mid July 2026), the product page, and the launch post of 2 February 2025 with its four dated updates.

### Query limits per plan

From the 24 April 2025 update, verbatim: "Plus, Team, Enterprise, and Edu users now get **25 queries per month**, Pro users get **250**, and Free users get **5**." Once the full version is exhausted, "your queries will automatically switch to the lightweight version", powered by a version of **o4-mini**. The original launch gave Pro 100/month. Allowances reset "every 30 days from the date of your first use". Availability depends on plan **and** country.

### The flow

Describe the outcome → choose sources → **ChatGPT proposes a research plan you can review and modify before research begins** → follow progress live and **interrupt at any time to refine focus**, including changing sources mid-run → structured report with citations. Runs take **5 to 30 minutes**. Started via `/Deepresearch`, the `+` tools menu, or the sidebar.

This is the same pre-spend plan review Gemini offers, and which **neither company exposes through its API**.

### Sources, and two things the API cannot do

- Public web, uploaded files, and **connected apps**: Google Drive, SharePoint, plus authenticated industry data sources named as **FactSet, PitchBook, Scholar Gateway**.
- **Domain filtering exists in the product.** Sites → Manage sites, comma-separated list, with a choice between restricting to only those domains or "Prioritize these sites, but allow full-web search". **The API has no domain filter.**
- **10 February 2026 update:** "You can now connect deep research to **any MCP or app** and restrict web searches to trusted sites." So Dossier could serve ChatGPT Deep Research as an MCP source in the consumer product, not only through the API.
- **17 July 2025 update:** deep research gained a visual browser via ChatGPT agent mode; the original remains under the deep research tool.

> Verbatim, and it matches the API's `search`/`fetch` contract exactly: "Deep research only uses **read actions** from connected apps. It does not use app write actions as part of research."

### Output

Fullscreen report view with a table of contents, a "sources used" section, and an **activity history showing how the research progressed**. Downloads as **Markdown, Word and PDF**. Deleting the chat deletes the outputs. Enterprise and Edu gate access by RBAC; activity is exposed through the Conversation API for compliance.

### OpenAI's own stated limitations, verbatim

The most useful paragraph in the entire corpus, because it is the vendor conceding the point at launch:

> "It can sometimes hallucinate facts in responses or **make incorrect inferences**, though at a notably lower rate than existing ChatGPT models, according to internal evaluations. It may **struggle with distinguishing authoritative information from rumors**, and currently shows **weakness in confidence calibration, often failing to convey uncertainty accurately**."

Three admissions in one paragraph: incorrect inference, poor source discrimination, uncalibrated confidence. All three are the 2026 failure mode rather than the 2025 one, stated by OpenAI in February 2025.

### Benchmarks, and the tool-call finding

HLE **26.6%**, against o1 at 9.1%, o3-mini-high at 13.0%, DeepSeek-R1 at 9.4%, Claude 3.5 Sonnet at 4.3%, GPT-4o at 3.3%. GAIA: **67.36 pass@1** and **72.57 cons@64** average, which resolves the two GAIA figures in circulation; the Xu & Peng survey quotes the cons@64 number.

The chart *Pass Rate vs Max Tool Calls* carries a caption worth acting on: **"The more the model browses and thinks about what its browsing, the better it does, which is why giving it time to think is important."** Pass rate rises with the tool-call ceiling across the plotted range.

> [!IMPORTANT]
> This qualifies the `max_tool_calls` advice. OpenAI's API docs call it "the primary tool available to you to constrain cost and latency"; their own launch data shows it is **also the primary lever on quality**. Capping it is a cost/quality trade, not a free saving, and any documentation presenting it as pure savings is misleading.

One more finding worth keeping: "Estimated economic value of task is more correlated with pass rate than # of hours it would take a human. The things that models find difficult are different to what humans find time-consuming." The o3 version powering it was assessed **Medium risk** under OpenAI's preparedness framework.

### Paperguide, the remaining pages

All vendor marketing, read for completeness. Genuinely useful items: a **2021 European Science Editing study** (1,653 manuscripts, `doi.org/10.3897/ese.2021.e51999`) reporting an 80% rejection rate with weak reporting implicated in 66% of reviewer rejections; a **2024 JMIR** analysis reporting reference-hallucination rates of **28.6% for GPT-4 and 39.6% for GPT-3.5** on systematic-review citations; and **SANRA** (Baethge et al. 2019) as the narrative-review analogue to PRISMA.

The transferable finding, attributed to Elicit: **"Repeated searches can return different paper sets, complicating search documentation."** AI-assisted search is not reproducible by default, which matters for any research tool claiming a documented method. Everything else on those pages is unbenchmarked product claims.
