# Providers

> [!IMPORTANT]
> **All four API backends ship, and each was verified against its live API on 25 July 2026.** Routing, `research_doctor`, `research_import`, the research shapes and cross-backend corroboration landed in 0.3.0. Still unbuilt: browser automation of the Gemini web app, and Dossier acting as an OpenAI-style MCP data source. The design and what remains are in [the multi-provider plan](../plan/multi-provider-research.md).

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

Ask for one backend and you get one backend. Ask for none and Dossier assembles a **panel**: an ordered set of backends across three lanes, all working the same brief.

```
research_start(question: "...", provider: "perplexity")   # exactly one, named
research_start(question: "...")                           # a panel
```

**Capability is screened first, before anything else.** A hard requirement like a date range, a domain allow-list or an editable plan eliminates the backends that can't enforce it, however cheap or free they are. A backend that can only *ask* a model to respect a date window doesn't join a date-bound panel just because it costs nothing.

Then the lanes:

| Lane | Who joins | What it costs |
|---|---|---|
| **Free** | Every coding CLI that is installed, signed in and capable of the shape you asked for | A subscription you already pay for. Dossier can't meter it |
| **Paid** | An API backend whose distinctive strength the question actually calls for | Its own estimate band, reserved up front |
| **Crawl** | Nothing. The panel *recommends* browser tooling when the question needs specific pages | Nothing, because Dossier drives no browser |

The free lane is the floor. With no API keys at all you still get every capable CLI on the machine.

**Every one of them, not the best one of them.** Each CLI is its own backend with its own id: `local-claude`, `local-codex`, `local-grok`, `local-cursor`, `local-agy`, `local-gemini`. On a machine with Claude Code, Codex and Grok all signed in, the free lane is three members, three runs, three reports and three $0 ledger lines. You are already paying for all three subscriptions, so all three answer. They are ordered strongest first, and a CLI that is installed but not signed in loses its own seat without touching anybody else's.

**One seat per model.** Running four CLIs is only worth it because four models drive four different searches and read different parts of the web. A CLI is not a model, though: Cursor lets you point `cursor-agent` at Grok 4.5, and a lane holding that next to Grok CLI buys one perspective and reports two. So Dossier asks.

```
research_doctor(probeModels: true)
```

That asks each identified, signed-in CLI which model it serves and caches the answer with a timestamp. It is off by default because it costs a short model round trip against each of those subscriptions, where ordinary detection is offline and instant. Do it once. After that, two CLIs found to serve the same model take one seat: the earlier one in the preference order joins, and the other is listed under **Not on the panel** with the model they share and how old the reading is.

Until you run it nothing is dropped. An unprobed machine keeps every CLI and the panel says the lane may hold the same model twice, because guessing a model from a binary's name would lose a backend you pay for. On a default install the guess would be wrong anyway: probed on 27 July 2026, `cursor-agent` reports Composer and `grok` reports Grok 4.5.

**A capability is never inherited from the model.** Point Cursor at Grok 4.5 and that CLI still cannot search X. Live X search is a first-party tool attached to xAI's API, not something the model carries with it, so xAI remains the only route to X and a date window still routes to a backend that can enforce one.

Name one of those ids as `provider` and you get that CLI alone. `local` on its own still works and still means a CLI; it resolves to the strongest one available, which is what it always did. In `DOSSIER_PROVIDERS`, `local` is an umbrella for every CLI id at once.

`DOSSIER_LOCAL_CLI` **restricts** the free lane. Set it to a CLI id and the lane holds only that CLI, however many others are signed in. Unset, which is the default, every capable signed-in CLI joins.

The paid lane is driven by a **question profile** read off your question: enumeration, a time bound, social, primary literature, named sites, legal or regulatory, breadth. Each signal implies a backend. Signals are additive, so a question that is both time-bound and legal gets both. Gemini and Perplexity lean towards joining when a key exists, because Gemini is the most comprehensive backend available and Perplexity is cheap enough that leaving it out rarely saves anything worth having.

Lane 3 never acts. Mode B browser research stays behind `DOSSIER_BROWSER_PROVIDER` and you drive it yourself; a panel can point at the pages it thinks need reading and that is all it can do.

**Money.** A panel reserves the sum of every member's worst case in one go, before any member starts. A panel that can't be afforded in full doesn't start at all, because half a panel is a worse answer than one good backend and it has already spent money to be worse. `research_plan` prints the whole thing member by member with a cost each, free lane separately from paid, before the contract fingerprint is issued.

**A panel of one is a normal outcome.** If only one backend belongs on the question, Dossier says so and runs it. It doesn't pad the panel to look busy.

`DOSSIER_PROVIDERS` still overrides in both directions. Name one provider and you get a panel of one, whatever the profile thinks.

Every member is its own run with its own id, so `research_status`, `research_read` and `research_tail` work per member. When the last one finishes the panel is merged automatically and the overlap warning is written to each member's journal. Read it. Five backends that read the same ten pages is the corroboration trap at five times the price, and agreement between members is not corroboration: support is counted in independent registrable domains.

Dossier never silently upgrades you to a more expensive backend or tier. That decision stays yours.

## Cost control across all providers

Every provider shares one daily ceiling, **$100 by default**, and every run reserves its worst-case cost *before* the call is made:

```bash
DOSSIER_BUDGET_USD=100            # daily ceiling across every provider
DOSSIER_BUDGET_USD_OPENAI=20      # optional per-provider sub-ceiling
DOSSIER_MAX_CONCURRENT=10
```

Set provider-side caps too. Dossier's ceiling and the provider's own limit are independent, and you want both. Each guide shows where.
