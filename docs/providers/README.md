# Providers

> [!IMPORTANT]
> **Dossier v0.2.1 ships with Gemini only.** Every other provider on this page is designed but not implemented, and so are the routing, `research_doctor` and `research_import` described below. The design lives in [the multi-provider plan](../plan/multi-provider-research.md); this page is what it will look like, not what runs today.

Dossier is designed to drive several research backends. You don't need all of them. You need the one that answers your question, and this page is about working out which that is.

> [!TIP]
> **Start with one key.** Gemini if you want to steer the research before it spends anything, Perplexity if you want date filters and enumerated lists. Add others when you hit something the first one can't do.

## Setup guides

| Provider | Guide | What it unlocks | Typical cost |
|---|---|---|---|
| **Google Gemini** | [gemini.md](gemini.md) | Deep reports, an editable plan, private-corpus grounding | $1–7 per run |
| **Perplexity** | [perplexity.md](perplexity.md) | Wide research, date filters, domain allow-lists | ~$0.50–2 per run |
| **OpenAI** | [openai.md](openai.md) | Academic depth, vector-store corpora, MCP data sources | $1–10 per run |
| **xAI** | [xai.md](xai.md) | X/Twitter search, collections | ~$0.20–1 per run |
| **Subscriptions and MCPs** | [subscriptions.md](subscriptions.md) | Using what you already pay for | $0 marginal |
| **Browser sessions** | [browser-sessions.md](browser-sessions.md) | Content behind your own login | $0 marginal |

## Which one for which job

| If you want to... | Use |
|---|---|
| Read and edit the research plan before any money is spent | **Gemini** (nothing else offers this) |
| Restrict results to a date range | **Perplexity** or **xAI** (Gemini has no date filter) |
| Get a list of 70 things with a source for each | **Perplexity** wide research |
| Search X / Twitter | **xAI** (nothing else reaches it) |
| Exclude SEO aggregator sites | **Perplexity** domain filter, max 20 domains |
| Search academic literature properly | **OpenAI** |
| Compare your internal docs against the public web | **Gemini** File Search |
| Spend nothing extra | **Subscriptions** or the **local agent loop** |

## The honest summary

No backend wins across the board. From AIMultiple's April 2026 benchmarks:

- A plain CLI agent with web search **tied the best deep-research API** on factual accuracy, at a seventh of the cost.
- Perplexity led on one benchmark and scored **zero** on another, because it returned prose when a table was requested.
- The most expensive deep-research model tested came **last** on accuracy.
- Verbosity did not track accuracy. One tool wrote 4,509 words about a code struct and named one of its five public methods; another named all five in 248 words.

So the routing advice above is not marketing copy about who is best. It's about which backend can physically do the thing you asked for. Full evidence, with dates, is in the [multi-provider plan](../plan/multi-provider-research.md#appendix-a-the-evidence-base).

## How Dossier picks

If more than one provider is configured, Dossier chooses on **capability first**: a hard requirement like a date range or an editable plan rules out providers that can't do it, regardless of price. Then cost, then measured accuracy, then source diversity if it's commissioning a second opinion.

It always tells you which it picked and why, it always names the runner-up, and you can always override it:

```
research_start(question: "...", provider: "perplexity")
```

Dossier never silently upgrades you to a more expensive backend or tier. That decision stays yours.

## Cost control across all providers

Every provider shares one daily ceiling, **$100 by default**, and every run reserves its worst-case cost *before* the call is made:

```bash
DOSSIER_BUDGET_USD=100            # daily ceiling across every provider
DOSSIER_BUDGET_USD_OPENAI=20      # optional per-provider sub-ceiling
DOSSIER_MAX_CONCURRENT=10
```

Set provider-side caps too. Dossier's ceiling and the provider's own limit are independent, and you want both. Each guide shows where.
