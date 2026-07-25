# Gemini Deep Research Prompting Playbook — empirical evidence base

> Source: "Maximising Output Quality from Google Gemini Deep Research: Prompt Architecture, Techniques, and Failure Modes" (Q1 2026). This file is the evidence layer behind the protocols in `SKILL.md`. The architect should not need to read it during normal use — consult it when the user asks *why* a rule exists, when defending a recommendation against pushback, or when the scope borders a competing deep-research platform.

## Executive summary (load-bearing claims)

- **(High Confidence) The "Plan Review" Phase is the highest-leverage prompting intervention.** Output quality is less dependent on initial prompt verbosity and more reliant on manual intervention during the agent's research-plan generation. Modifying the agent's proposed directed acyclic graph of search intents prior to autonomous execution is the single most effective method for preventing topic drift and ensuring comprehensive coverage.
- **(High Confidence) Epistemic bounding prevents factual fabrication.** Explicitly instructing the agent on the protocols for handling missing information (mandating `<MISSING_DATA>` / `<INSUFFICIENT_EVIDENCE>` tags rather than allowing estimation) drastically reduces the hallucination of statistics and aligns agentic outputs with intelligence-community standards for estimative language.
- **(Medium Confidence) The Over-Specification Paradox induces format drift.** Beyond a specific threshold of structural constraint, the agent's attention budget depletes, causing it to disregard core analytical directives in an attempt to satisfy peripheral formatting rules.
- **(High Confidence) Agentic architectures exhibit inherent SEO and aggregator bias.** Without explicit source-constraint prompting, autonomous search modules default to highly ranked secondary aggregators rather than primary literature or raw datasets. Mitigation requires stringent URL-exclusion protocols and criteria-match validation.
- **(Medium Confidence) Multi-model "Debate" workflows surpass single-pass generation.** The most robust intelligence-gathering operations export the foundational Gemini 3.1 Pro research into a secondary frontier model (Claude 4.5 Sonnet, Grok 4) for adversarial validation.
- **(High Confidence) Gemini leads in synthesis breadth but requires forced citation persistence.** Gemini 3.1 Pro leads DeepSearchQA (66.1%) and Humanity's Last Exam (46.44%), but its 1M-token context window routinely triggers citation aggregation where original sources are stripped in favour of generic document references. Aggressive inline source-mapping is mandatory for auditability.

## Single-pass prompt construction — technique evidence

Deep Research operates on a continuous plan → search → read → synthesize loop over several minutes to an hour, so the prompt functions as a **compiled software instruction set**, not a conversational query.

Effective architectures use a rigid, multi-part framework that:

1. **Sets precise topic and scope boundaries** — what must be investigated *and* what must be strictly excluded.
2. **Applies temporal constraints** — explicit date ranges prevent ingestion of deprecated literature or stale market statistics.
3. **Delineates specific analytical criteria** — predefined dimensions (pricing, latency, compliance codes) force evaluation instead of generalised summary.
4. **Implements epistemic bounding** — fallback tags (`<MISSING_DATA>`, `<CONFIDENCE:LOW>`, `<INFERENCE>`) establish an audit trail and align output with estimative-language standards. Without this, the agent's desire to fulfil the request leads to hallucinated statistics.
5. **Uses pseudo-XML output architecture** — `<role>`, `<task>`, `<constraints>` provide semantic isolation that helps attention distinguish background context from executable instructions.

## Agent architecture — why specific prompt elements leverage harder

Gemini Deep Research runs on the Gemini 3.1 Pro backend with a 1M-token context window, ingesting from both public web and secure Google Workspace (Drive, Docs, Gmail). The autonomous sequence is:

1. **Query Analysis**
2. **Plan Generation** — abstracts the user's prompt into a directed acyclic graph of search intents
3. **Source Discovery** — iterative web/file search
4. **Analysis & Synthesis**
5. **Final Report Generation**

Because the agent's first action is plan generation, highly verbose instructions detailing *how* to conduct the search are frequently compressed or discarded at this step. This is why **Plan Review** (pausing after plan generation to manually prune subtopics, inject missing angles, narrow broad definitions) is the highest-leverage intervention — it operates *after* the compression that kills verbose front-loaded search heuristics.

Workspace multimodal ingestion requires an explicit **hierarchy-of-truth directive**. Without it, the agent can silently overwrite proprietary internal intelligence (strategy memos, comparison spreadsheets) with lower-fidelity web scrapes.

## The Over-Specification Paradox

Research into Universal Conditional Logic (UCL) frameworks identifies a mathematical threshold (structural-overhead function) beyond which additional directives cause a precipitous drop in logical precision. In practice:

- A rigid **macroscopic** skeleton (headings, tables, tag taxonomy) helps.
- Rigid **microscopic** constraints (paragraph-level word counts, exhaustive negative constraints, contradictory formatting rules) hurt.

Compounding this: "context rot" in Gemini's 1M-token window causes attention depletion. Critical constraints placed mid-prompt are frequently ignored by the model's attention heads, degrading accuracy on specific formatting or exclusionary directives.

**Practical consequence:** specify section structure, tables, and tag formats up front — then leave the prose loose.

## Task archetypes — why each archetype has different overrides

### Technical deep-dive
Primary risk is ingestion of derivative marketing material. Prioritise official docs, GitHub (incl. issues/PRs), engineering blogs, peer-reviewed benchmarks; deprioritise SEO listicles. Require Markdown comparison tables — technical reality lives in tables; prose buries it.

### Competitive and market
Unconstrained, the agent leans on sanitised press releases and official vendor sites. Effective prompts mandate **pain point mining** from organic platforms (Reddit, HackerNews, G2, App Store, Trustpilot) to surface raw user sentiment, then contrast those quotes with vendor positioning to identify **underserved gaps**.

### Regulatory and compliance
Requires strict categorisation: `<ENACTED>`, `<PENDING>`, `<GUIDANCE>`, `<PROPOSED>`. Demand identification of jurisdictional conflicts. Constrain the agent from providing "actionable legal advice" — it functions as a factual regulatory mapper, not counsel.

### Academic literature synthesis
Common failure: the agent merely collates abstracts of high-ranking papers. Mitigate by explicitly instructing extraction and comparison of experimental methodologies, sample sizes, and statistical significance (p-values, confidence intervals, effect sizes). Distinguish consensus from active debate; preserve credibility weighting between peer-reviewed and preprint sources.

### Forecasting and trend
High risk the agent echoes media hype or linear extrapolation. Demand identification of underlying drivers (capex patterns, demographics, patent filings, regulatory catalysts, supply chain). Require divergent scenarios (optimistic with catalysts, conservative with frictional forces) plus **break conditions** that would invalidate each.

## Documented failure modes (DEFT taxonomy — 14 modes across execution, retrieval, generation)

### High-severity: Source stripping and citation hallucination
As the context window fills with hundreds of URLs and PDFs, the agent economises tokens during synthesis by collapsing specific in-text citations into a single generic citation pointing to a context file — severing the link to original empirical data. Occasional URL fabrication also occurs.

**Mitigation:** enforce URL-level verification protocols. "Append a verifiable `<cite url>` to every quantitative claim immediately inline. Do not aggregate or consolidate citations." Integrate a Criteria Match Validator.

### High-severity: SEO bias and aggregator reliance
Autonomous search trusts high-ranking pages. For job market stats, benchmarks, or financial data, retrieval bypasses authoritative primary sources (Bureau of Labor Statistics, raw OECD datasets) in favour of SEO listicles and marketing blogs.

**Mitigation:** explicit exclusion parameters. "Exclude all aggregator sites, marketing blogs, and listicles. Prioritise primary data sources, government databases, and peer-reviewed journals."

### Medium-severity: Topic drift and context bloat
Over a 30-minute search loop, accumulated context causes drift into tangential rabbit holes. The final report is long but analytically shallow on the core question.

**Mitigation:** inject `<core_directive>` anchors (opening *and* closing) to re-orient attention. For massive scopes, decompose into 3–4 tightly scoped runs rather than one monolith.

### Medium-severity: Format drift
The final report ignores structural requests (e.g., fails to produce tables) and defaults to continuous unstructured prose.

**Mitigation:** rigid skeleton + avoid micromanaging microscopic constraints (which trigger Over-Specification Paradox).

### Low-severity: Non-English source neglect
English-default search leaves blind spots for international markets, global supply chains, geopolitical topics.

**Mitigation:** explicit cross-lingual retrieval directive. "Formulate parallel search queries in [German, French, Mandarin, …] to retrieve regional data before synthesising in English."

## Benchmarks — Gemini vs. competing architectures

| Benchmark / Metric | Google Gemini 3.1 Pro DR | OpenAI GPT-5.4 / o3 DR | Perplexity Sonar Pro DR | Grok 4 DeepSearch |
|---|---|---|---|---|
| Humanity's Last Exam (HLE) | **46.44%** | 44.32% | N/A | N/A |
| DeepSearchQA | **66.1%** | ~62% (reported) | ~25–26.9% | N/A |
| ResearchRubrics Compliance | **~67.7%** | ~66.4% | ~56.6% | N/A |
| Citation Accuracy / Fidelity | Moderate (prone to stripping) | High | **Highest (>90%)** | Moderate |
| Processing Latency | 5–30 min | 10–30 min | 2–4 min | **Fastest (real-time)** |

**Positioning:**
- **Gemini 3.1 Pro** — leads in pure synthesis volume and multi-step information collation. Unique advantages: Workspace integration and the explicit Plan Review stage. Prompts should focus on structuring the initial brief to generate an optimal plan.
- **OpenAI o3 / GPT-5.4** — less prone to format drift; excels at strict multi-layered constraint adherence. Slightly lower on volume/comprehensiveness.
- **Perplexity Sonar** — prioritises speed and citation accuracy (>90%) over depth. Shorter reports. Push with "Expand by 10x" to approach Gemini's volume.
- **Grok 4** — fastest, strong on real-time social-signal integration (X platform). Lacks built-in citation density. Best for fast-moving trend and sentiment tracking, not historical literature reviews.

## Meta-techniques

### Pre-scoping query (single-shot LLM before the Deep Research run)
Before burning 30 minutes of compute, ask a standard chat model to identify key controversies, leading experts, and primary regulatory frameworks for the topic. Feed that terminology into the Deep Research prompt to sharpen retrieval precision.

### Iterative task decomposition
For massive briefs (>30 pages, or spanning market + regulatory + technical), run three concurrent, narrowly scoped Deep Research sessions and merge in a final non-research LLM pass. A single monolithic run triggers context burnout and format drift past the size threshold.

### The "Debate Club" pattern
- Gemini 3.1 Pro performs heavy lifting (ingest hundreds of URLs/PDFs, produce foundational report).
- Export to Claude Opus 4.7 prompted as an adversarial Red Team Analyst: identify logical leaps, cross-reference weak citations, flag unsupported claims.
- The secondary attention mechanism evaluates logical consistency without the cognitive load of initial data retrieval, catching Gemini-specific biases (source stripping, SEO reliance) invisible to Gemini itself.

## Knowledge gaps in the current evidence base

- **Algorithmic opacity in Plan Generation.** Exact heuristic weighting during the Plan Review transition is proprietary. How the internal retrieval module penalises or promotes specific DAG nodes during autonomous search remains unknown — limits reverse-engineering of optimal initial prompt structure.
- **Longitudinal consistency.** Gemini 3.1 Pro is too recent (late 2025 / early 2026) for rigorous longitudinal studies of model drift or shifting compliance rates under extended continuous use.
- **Benchmark saturation dynamics.** BrowseComp, DeepSearchQA, ResearchRubrics are trending toward saturation. Gemini's margin of superiority fluctuates as competitors iterate (OpenAI o3/o4-mini, Grok's real-time integrations).
