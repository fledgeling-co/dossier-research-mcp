# Google Gemini

> [!NOTE]
> This is the one provider Dossier actually ships with today. Everything here works in v0.2.1 except the share-link import under [Using a subscription instead](#using-a-subscription-instead), which is flagged inline.

The default backend, and the one with the single most valuable capability nothing else offers: **you can read and edit the research plan before any money is spent.**

> [!NOTE]
> Getting a key, setting a billing cap, installing, and the full environment-variable reference all live in **[Setup](../setup.md)**. This page covers what Gemini is good and bad *at*, so you can decide when to route to it.

---

## What it costs

| | Searches | Cost | Time |
|---|---|---|---|
| **`fast`** | ~80 | **$1–3** | 4–20 min |
| **`max`** | up to ~160 | **$3–7** | 10–60 min |

Estimate bands, not quotes. Dossier reserves the **top** of the band before calling, so it refuses early rather than discovering an overage later. Cancelling does not refund, because Google bills for work already done.

## What it unlocks

### The editable plan

Ask for planning and Gemini returns a research plan you approve, edit, or reject before it spends anything. **No other API backend offers this.** Pruning irrelevant branches and adding the angle it missed changes output quality more than any other lever available to you, and it is free.

Dossier extracts the plan properly, which matters: the API wraps it behind roughly 6,700 characters of your own echoed prompt. Raw, you would be reading your own question back.

### Private-corpus grounding

File Search stores let a run read your documents alongside the public web and say **explicitly where the two disagree**. That disagreement is usually the valuable part, and it is the feature most likely to justify the cost on its own.

Developer API only. Vertex does not have it.

### Long, well-structured reports

Gemini won data accuracy on AIMultiple's DR-2T task and produces the most navigable output of any backend tested: numbered chapters, comparison tables, an executive summary. When sources conflict it flags the discrepancy and picks a side, which is more useful than silently averaging.

It also implements explicit uncertainty modelling that distinguishes confirmed information from speculative extension, per the Xu & Peng survey.

---

## What it's bad at

Stated plainly, because these are the reasons to route elsewhere.

| Missing | Consequence |
|---|---|
| **Date filters** | None at all. A time window is a request in the prompt, not an enforced filter. Use Perplexity or xAI when the window matters |
| **Domain filters** | None. You cannot exclude content farms or restrict to an allow-list |
| **Mid-run progress** | The API buffers its stream. A 7.1-minute run reported nothing until it finished ([#1](https://github.com/fledgeling-co/dossier-research-mcp/issues/1)) |
| **Speed** | Slowest of the tested backends on breadth tasks: 62 sources in over 15 minutes, against Grok's 100+ in about two |
| **Wide research** | No native mode. Asking for a table is prompt-level hope |

And the synthesis failure worth knowing about, because it is the whole reason Dossier verifies claims rather than links: in LivePlan's May 2026 test, Gemini correctly established the number of US businesses in a revenue band, QuickBooks' market share, **and** that only about half those businesses use accounting software, then ignored the third fact when multiplying. Every citation resolved. The estimate was inflated by roughly double.

---

## Vertex AI loses features

Counter-intuitively, an ordinary API key is the **fuller** backend. Setting `VERTEX_PROJECT` gives you enterprise controls and takes away:

- **Corpus grounding.** File Search is Developer-API only.
- **`research_followup`.** The Interactions API on Vertex serves agents and media models, not the standard Gemini models a follow-up needs.
- **AI titles, summaries and `research_claims`**, for the same reason.

Dossier says all of this at start-up and in `research://capabilities` rather than failing confusingly at call time. Choose Vertex for compliance, not capability. See [Setup](../setup.md#using-vertex-ai-instead).

---

## Using a subscription instead

A Google AI Pro or Ultra plan includes Deep Research in the web app, billed separately from the API. Importing those runs by share link is **designed but not yet built**; it is the intended path because it avoids automating a robots.txt-disallowed page.

Full detail, including the terms-of-service position and the verified UI flow: **[Browser sessions](browser-sessions.md)** and **[Subscriptions](subscriptions.md#google-ai-pro-or-ultra)**.

---

## When to route here

| Use Gemini when | Route elsewhere when |
|---|---|
| You want to steer the plan before spending | You need a date range → **Perplexity** or **xAI** |
| Your own documents need checking against the web | You need a strict table → **local agent** or **Perplexity wide** |
| The output needs to be readable by a human | You need X → **xAI** |
| You want the most navigable long report | You need speed → **xAI** |
| Data accuracy matters more than breadth | You want the cheapest good answer → **local agent** |

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Corpus tools refuse | Vertex is configured. File Search is Developer-API only |
| Plan shows your own prompt back | Old client. Dossier's `extractPlan` strips the echo |
| Report looks truncated | Real reports arrive split across steps; Dossier joins them all |
| Nothing in the tail until it finishes | Expected. Google buffers the stream |
| Run cost more than the estimate | Bands are guardrails, not invoices. Reconcile against Google billing |

---

**Next:** [Perplexity](perplexity.md) · [Setup](../setup.md) · [How it works](../how-it-works.md)
