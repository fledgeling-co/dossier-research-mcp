---
title: "Methodology and Harnesses for Evaluating Deep-Research Agents"
run_id: dr_087ca0b45d3933fa
question: "What benchmarks, evaluation frameworks and datasets exist for measuring the quality of AI deep-research agents and AI search/answer providers, that are actively maintained as of 2026? Cover: (1) named benchmarks and their scoring methodology, especially any that score citation accuracy, source attribution, source quality, hallucinated references, and whether a cited page actually supports the claim attached to it; (2) open-source evaluation harnesses and libraries for building such benchmarks, in TypeScript, Rust or Go, noting which are maintained in the last six months; (3) published head-to-head comparisons of Gemini Deep Research, OpenAI Deep Research, Perplexity Sonar, xAI Grok and agentic coding CLIs on research tasks, with their task categories and metrics; (4) methodology for building a fair multi-provider evaluation: task category design, ground-truth construction, inter-rater reliability, sample sizes needed for significance, and how to control for provider non-determinism."
provider: local-claude
model: Claude Code
tier: max
archetype: academic
sources: 49
tools: [google_search, url_context, code_execution]
estimated_cost_usd: 0.00
completed: 2026-07-27T02:39:13.328Z
---
# Deep-Research Agent Evaluation: Benchmarks, Harnesses and Methodology (as of July 2026)

> **Retrieval note (affects recall, not accuracy):** the session's general web-search tool failed with a persistent API error on every call. All findings below were gathered via direct HTTP fetches of primary sources (arXiv, NIST/TREC, GitHub, publisher pages) and DuckDuckGo HTML result pages, plus the GitHub, npm and crates.io registry APIs for maintenance verification. Registry timestamps are machine-read, not summarised. Recall is therefore weaker than a full search sweep would give; see Knowledge Gaps.

## Executive Summary

- **(High Confidence) Citation-support verification is a solved *measurement* problem with at least four independent, published implementations — but none of them ships inside a general-purpose eval harness.** DeepTRACE defines citation accuracy as `Σ(CitationMatrix ⊙ FactualSupportMatrix) / Σ(CitationMatrix)` [arxiv.org](https://arxiv.org/html/2509.04499v1), DeepResearch Bench's FACT framework extracts statement–URL pairs, deduplicates, re-scrapes via Jina and LLM-judges support [github.com](https://github.com/Ayanami0730/deep_research_bench), TREC DRAGUN uses four-way Supports/Partial/Contradicts/None assessor labels [arxiv.org](https://arxiv.org/html/2602.24277v1), and Mind2Web 2 checks source attribution with tree-structured judge agents [arxiv.org](https://arxiv.org/abs/2506.21506). The build/adopt answer follows directly: **adopt the metric definitions, build the scorer, adopt the harness shell.**

- **(High Confidence) Measured citation accuracy across commercial systems ranges roughly 31–90%, and the spread between systems is far larger than the spread between models on answer-quality metrics.** DeepTRACE reports 39.8–79.1% across nine systems, with unsupported-statement fractions from 12.5% (GPT-5 Deep Research) to 97.5% (Perplexity Deep Research) [arxiv.org](https://arxiv.org/html/2509.04499v1). DeepResearch Bench's FACT reports 39.36% (Perplexity Sonar Reasoning Pro) to 94.04% (Claude-3.5-Sonnet w/Search) [deepresearch-bench.github.io](https://deepresearch-bench.github.io/). This is the highest-signal axis to instrument first.

- **(High Confidence) There is no maintained TypeScript, Rust or Go benchmark harness for deep-research evaluation; there are maintained *general* LLM eval harnesses in TS and Go, a thin one in Rust, and the benchmark ecosystem is essentially all Python.** promptfoo (TypeScript, 23,631 stars, pushed 2026-07-27, npm 0.121.19 published 2026-07-14) is the only TS option with the required primitives — multiple providers per eval, `factuality` / `context-faithfulness` / `llm-rubric` / `g-eval` model-graded assertions, and custom JavaScript assertions returning `{pass, score, reason}` [promptfoo.dev](https://www.promptfoo.dev/docs/configuration/expected-outputs/). It has **no citation-checking assertion**.

- **(Medium Confidence) "Published" and "maintained" have already diverged sharply in this field, and the most-cited deep-research benchmark leaderboard is dead.** FutureSearch's Deep Research Bench paper (89 tasks, 8 categories, RetroSearch frozen web) [arxiv.org](https://arxiv.org/abs/2506.06287) is widely cited, but its live leaderboard at drb.futuresearch.ai now renders "No data available" with a task count of 0, while the same site actively maintains BTF-3 (evaluated June–July 2026) and ForecastBench (updated 2026-07-26) [drb.futuresearch.ai](https://drb.futuresearch.ai/). Microsoft's LiveDRBench, self-described as "live," was last pushed 2025-10-16 — nine months stale [api.github.com](https://api.github.com/repos/microsoft/livedrbench).

- **(High Confidence) Every major deep-research benchmark is statistically underpowered for the comparisons it is used to make.** Miller's power analysis gives n ≈ 969 questions to detect a 3-percentage-point difference at 80% power, and recommends ≥1,000 questions for new evals [arxiv.org](https://arxiv.org/html/2411.00640v1). DeepResearch Bench has 100 tasks [deepresearch-bench.github.io](https://deepresearch-bench.github.io/), Deep Research Bench 89 [arxiv.org](https://arxiv.org/abs/2506.06287), Mind2Web 2 130 [arxiv.org](https://arxiv.org/abs/2506.21506), LiveDRBench 100 [github.com](https://github.com/microsoft/LiveDRBench), DeepTRACE 303 [arxiv.org](https://arxiv.org/html/2509.04499v1).

- **(High Confidence) LLM-judge validation practice is systematically overstated, by a measurable and large amount.** The largest study to date — 21 judges, nine providers, 118 runs, ~541,000 judgments — finds kappa deflation between exact-match agreement and Cohen's κ of **33–41 percentage points on MT-Bench**, judge rankings shifting by up to 14 positions across benchmarks, and two production-deployed judges combining >0.95 test–retest reliability with >0.10 position bias [arxiv.org](https://arxiv.org/abs/2606.19544). Any harness you build must report chance-corrected agreement, not raw agreement.

- **(Medium Confidence) Non-determinism is now understood as an engineering defect rather than a physical inevitability, but you cannot fix it on hosted APIs — so you must budget repeats.** Thinking Machines attributes temperature-0 variation to kernels that lack batch invariance, where output depends on the server-side batch a request lands in [thinkingmachines.ai](https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/). For hosted deep-research products this is not controllable; published practice is k ≥ 3 repeats [arxiv.org](https://arxiv.org/html/2603.29231v1), with τ-bench showing agents at 61% pass@1 collapsing to 25% pass@8 [arxiv.org](https://arxiv.org/html/2603.29231v1).

- **(Medium Confidence) Head-to-head data covering exactly your provider set exists in one place — DeepResearch Bench — and it shows Gemini and OpenAI leading on report quality while Perplexity leads on citation accuracy and Grok trails on retrieval volume.** Gemini-2.5-Pro Deep Research 48.88 RACE / 81.44% citation accuracy / 111.21 effective citations; OpenAI Deep Research 46.98 / 77.96% / 40.79; Perplexity Deep Research 42.25 / 90.24% / 31.26; Grok Deeper Search 40.24 / 83.59% / 8.15 [deepresearch-bench.github.io](https://deepresearch-bench.github.io/). **No published head-to-head evaluates agentic coding CLIs on research tasks.**

---

## Detailed Findings

### (1) Named benchmarks and their scoring methodology — especially citation accuracy, source attribution, source quality, hallucinated references, and whether a cited page supports its claim

Nine benchmarks are live enough to matter. They split cleanly into three families by what they treat as the unit of truth: **the report** (rubric-scored), **the claim–source pair** (support-verified), and **the retrieved document set** (corpus-controlled).

#### Claim–source support verification (directly relevant to your citation-verification capability)

**DeepTRACE** is the most complete published instrument and the one whose metric algebra you should copy. It converts community-reported failure modes into eight measurable dimensions over answer text, sources and citations [arxiv.org](https://arxiv.org/abs/2509.04499). Its mechanism is a pair of binary matrices over (statement × source): a **citation matrix** (did the system cite source *j* for statement *i*) and a **factual support matrix** (does source *j* actually support statement *i*). All citation metrics are then elementwise products:

| Dimension | Definition | Family |
|---|---|---|
| One-Sided Answer | 0 if both pro and con statements present, else 1 (debate queries only) | Answer text |
| Overconfident Answer | 1 iff One-Sided = 1 **and** confidence = 5 on a 1–5 Likert scale | Answer text |
| Relevant Statements | Relevant ÷ Total statements | Answer text |
| Uncited Sources | Derived from empty columns of the citation matrix | Sources |
| Unsupported Statements | Unsupported ÷ Relevant statements (row entirely unchecked in support matrix) | Sources |
| Source Necessity | Necessary ÷ Listed sources, via **minimum vertex cover over the bipartite (statement, source) graph using Hopcroft–Karp** | Sources |
| Citation Accuracy | `Σ(CitationMatrix ⊙ FactualSupportMatrix) / Σ(CitationMatrix)` | Citations |
| Citation Thoroughness | `Σ(CitationMatrix ⊙ FactualSupportMatrix) / Σ(FactualSupportMatrix)` | Citations |

[arxiv.org](https://arxiv.org/html/2509.04499v1)

Corpus: 303 queries — 168 debate questions from ProCon.org plus 135 expertise questions from meteorology, medicine and HCI experts — across 9 systems for 2,727 samples and roughly 80,000 factual-support evaluations [arxiv.org](https://arxiv.org/html/2509.04499v1). Judge validation used GPT-5 against four annotators at $25/hour: **Pearson 0.72 for confidence scoring and only 0.62 for factual support**, which the authors themselves call "moderate agreement" and flag as a limitation [arxiv.org](https://arxiv.org/html/2509.04499v1). Results as of 2025-08-27:

| System | %Citation Accuracy | %Unsupported | %Source Necessity | %Uncited Sources | Citations/Statement |
|---|---|---|---|---|---|
| GPT-5 (Deep Research) | 79.1 | 12.5 | 87.5 | 0.0 | 1.4 |
| YouChat (DR) | 72.3 | 74.6 | 63.2 | 66.3 | 0.8 |
| You.com (GSE) | 68.3 | 30.8 | 69.0 | 1.1 | 0.4 |
| BingChat (GSE) | 65.8 | 23.1 | 50.4 | 36.2 | 0.4 |
| Copilot Think Deeper | 62.1 | 90.2 | 31.2 | 32.6 | 0.3 |
| Perplexity (DR) | 58.0 | 97.5 | 5.5 | 57.5 | 0.2 |
| Gemini (DR) | 50.3 | 53.6 | 33.1 | 14.5 | 0.2 |
| Perplexity (GSE) | 49.0 | 31.6 | 68.9 | 8.4 | 0.5 |
| GPT-4.5 (GSE) | 39.8 | 47.0 | 67.3 | 0.0 | 0.4 |
| GPT-5 (Search) | 31.4 | 58.9 | 32.8 | 51.7 | 0.4 |

[arxiv.org](https://arxiv.org/html/2509.04499v1)

<CONFLICTING_EVIDENCE>DeepTRACE's own Table 1 lists Gemini(DR) citation accuracy at 50.3%, while its Results prose states "only 40.3% citation accuracy (problematic)." The two figures fall on opposite sides of the paper's own 50% problematic/borderline threshold. Source: the paper's HTML at arxiv.org/html/2509.04499v1. Nature of disagreement: internal transcription inconsistency, unresolved in the published version. Treat Gemini's DeepTRACE citation accuracy as approximately 40–50% with the exact value unresolved.</CONFLICTING_EVIDENCE>

**DeepResearch Bench** pairs a rubric scorer (RACE — Reference-based Adaptive Criteria-driven Evaluation, scoring Comprehensiveness, Insight/Depth, Instruction-Following and Readability against reference reports with task-adapted dynamic weights) with **FACT** (Framework for Factual Abundance and Citation Trustworthiness) [github.com](https://github.com/Ayanami0730/deep_research_bench). FACT's pipeline is the one closest to what a citation-verification MCP capability actually does: extract statement–URL pairs from the report → deduplicate → **re-scrape the cited page via the Jina API** → LLM-judge whether the source supports the claim → emit **Citation Accuracy** (% correctly supported) and **Effective Citations** (average verifiably-supported citations per task) [github.com](https://github.com/Ayanami0730/deep_research_bench). Benchmark size: 100 PhD-level tasks by domain experts across 22 fields, split 50 Chinese / 50 English [arxiv.org](https://arxiv.org/abs/2506.11763)[deepresearch-bench.github.io](https://deepresearch-bench.github.io/).

Critically for a build-vs-adopt decision, this project publishes **evaluator-vs-human agreement on a 50-task × 4-agent annotated subset with a stated human baseline of 68.78%**:

| Evaluator | Overall | PAR | OPC | FAP | FAS |
|---|---|---|---|---|---|
| GPT-5.5 (current official evaluator) | 71.82 | 73.00 | 89.70 | 65.35 | 59.23 |
| Gemini-3.1-Pro | 70.58 | 71.33 | 90.14 | 65.39 | 55.45 |
| Claude-Opus-4-7 | 70.11 | 71.00 | 86.76 | 66.70 | 55.99 |

[github.com](https://github.com/Ayanami0730/deep_research_bench)

The repo's most recent update (2026-05-11) switched the official evaluator to GPT-5.5 with GPT-5.4-mini for FACT, and shipped "Evaluation Pipeline v2" with chunk-based cleaning for long articles [github.com](https://github.com/Ayanami0730/deep_research_bench). Repo `pushed_at` = 2026-05-11T06:14:30Z [api.github.com](https://api.github.com/repos/Ayanami0730/deep_research_bench).

**SourceBench** attacks the adjacent question — not "does the page support the claim" but "is the page worth citing at all." 100 real-world queries across five intent types (informational, factual, argumentative, social, shopping), **3,996 cited sources**, eight metrics split into content quality (relevance, factual accuracy, objectivity) and page-level signals (freshness, authority/accountability, clarity), evaluated over eight LLMs, Google Search and three AI search tools — twelve systems — using a human-labelled dataset with a calibrated LLM judge [arxiv.org](https://arxiv.org/abs/2602.16942). Submitted 2026-02-18, making it the most recent purpose-built source-quality benchmark found. <MISSING_DATA>[Sought: the specific model/tool names evaluated and per-system scores. Unavailable: the arXiv abstract page does not enumerate them and the HTML full text was not retrieved within this session's budget. Needed: fetch arxiv.org/html/2602.16942v1.]</MISSING_DATA>

**TREC 2025 DRAGUN** is the most methodologically rigorous of the set because it is a NIST-assessed track with released human judgments. Task 2 asks for a 250-word attributed report, each sentence carrying at most three segment-ID references. Assessors label each report against each rubric answer as **Supports / Partial / Contradicts / None**, with *Contradicts taking precedence* over Supports, mapped to 1.0 / 0.5 / 0, and aggregated with importance weights of **Have to Know = 4, Good to Know = 2, Nice to Know = 1** [arxiv.org](https://arxiv.org/html/2602.24277v1). Scale: 30 topics, 236 rubric questions (avg 7.9 per rubric), 551 rubric answers, 28 runs from 8 teams, 15,428 answer–report pairs all human-judged [arxiv.org](https://arxiv.org/html/2602.24277v1). Its **AutoJudge** (few-shot gpt-oss-120b, temperature 0, top_p 1) achieves run-level Kendall's τ = **0.872** on Task 2 and 0.678 on Task 1; at label level, Task 2 reached 86.7% raw agreement with **κ = 0.50 and Gwet's AC1 = 0.85** — AC1 reported alongside κ explicitly because kappa deflates under class imbalance (Task 2 labels were 86.4% "None") [arxiv.org](https://arxiv.org/html/2602.24277v1). Resources including AutoJudge, human judgments and scoring scripts are released at github.com/trec-dragun/resources [arxiv.org](https://arxiv.org/html/2602.24277v1).

**Mind2Web 2** contributes the Agent-as-a-Judge pattern: 130 realistic long-horizon tasks built with over 1,000 hours of human labour, evaluated by task-specific judge agents constructed from a **tree-structured rubric** that checks answer correctness *and* source attribution together [arxiv.org](https://arxiv.org/abs/2506.21506). Headline: OpenAI Deep Research was best, reaching 50–70% of human performance at half the time, across ten frontier agentic search systems [arxiv.org](https://arxiv.org/abs/2506.21506).

#### Rubric-scored report quality

**ResearchRubrics** (Scale AI, ICLR 2026) is the largest human-authored rubric set: **2,800+ hours of human labour and 2,500+ expert-written fine-grained rubrics** covering factual grounding, reasoning soundness and clarity, plus a complexity taxonomy sorting tasks by conceptual breadth, logical nesting and exploration [arxiv.org](https://arxiv.org/abs/2511.07685). Headline finding: leading agents including Gemini's and OpenAI's Deep Research products fall **under 68% average rubric compliance**, with failures attributed chiefly to missed implicit context and inadequate reasoning over retrieved information [arxiv.org](https://arxiv.org/abs/2511.07685). Repo `scaleapi/researchrubrics` last pushed 2026-02-10 [api.github.com](https://api.github.com/repos/scaleapi/researchrubrics). <INSUFFICIENT_EVIDENCE>ResearchRubrics' inter-annotator agreement statistics, judge model identity, and judge–human kappa are not reported on the arXiv abstract page and were not recoverable from the sources fetched. For a benchmark whose entire value proposition is rubric quality, the absence of published IRR is a material gap.</INSUFFICIENT_EVIDENCE>

#### Corpus-controlled retrieval evaluation

**BrowseComp-Plus** (ACL 2026) is the right tool if you want to separate *your retriever/backend* from *the model*. It rebuilds BrowseComp over a fixed curated corpus with **human-verified supporting documents and mined hard negatives**, explicitly to stop black-box live web APIs from confounding comparisons [arxiv.org](https://arxiv.org/abs/2508.06600). The separation works: Search-R1 with BM25 scores 3.86%, GPT-5 scores 55.9%, and GPT-5 with a Qwen3-Embedding-8B retriever reaches 70.1% *with fewer search calls* [arxiv.org](https://arxiv.org/abs/2508.06600). The authors state it enables analysis of "retrieval effectiveness, citation accuracy, and context engineering" [arxiv.org](https://arxiv.org/abs/2508.06600). Repo pushed 2026-05-28 [api.github.com](https://api.github.com/repos/texttron/BrowseComp-Plus).

**TREC 2025 RAG Track** uses MS MARCO V2.1 with "a multi-layered evaluation framework encompassing relevance assessment, response completeness, **attribution verification**, and agreement analysis," over 150 submissions [arxiv.org](https://arxiv.org/abs/2603.09891). TREC RAG 2026 is announced as "The first Agent-first track at TREC!" [trec-rag.github.io](https://trec-rag.github.io/> — the strongest signal that institutional evaluation is moving toward exactly your problem.

#### The user-preference counterweight

**Search Arena** (ICLR 2026) is important because it measures what *users* reward, and the answer is uncomfortable: across 24,000+ paired multi-turn interactions with ~12,000 human preference votes, ). Preferences also skew toward community-driven platforms over static encyclopedic sources [arxiv.org](https://arxiv.org/abs/2506.05334).

<INFERENCE from="Search Arena's finding that vote outcomes track citation count independent of support; DeepTRACE's finding that Perplexity(DR) has 97.5% unsupported statements yet only 0.2 citations per statement; DeepResearch Bench's finding that Gemini DR emits 111.21 effective citations vs Grok's 8.15">Citation *count* and citation *correctness* are close to orthogonal in current systems, and human preference tracks the former. A benchmark that scores only preference or only rubric quality will systematically fail to penalise the failure mode you are trying to catch. Any harness you build must report accuracy and volume as separate axes, never a blended score.</INFERENCE>

#### Journalistic / attribution audit

The Tow Center's March 2025 study remains the most-cited real-world attribution audit: 1,600 queries (20 publishers × 10 articles × 8 chatbots), tested February 2025, grading whether the engine returned the correct article, publisher and URL for a hand-picked excerpt, on a six-level scale (Correct / Correct but Incomplete / Partially Incorrect / Completely Incorrect / Not Provided / Crawler Blocked) [cjr.org](https://www.cjr.org/tow_center/we-compared-eight-ai-search-engines-theyre-all-bad-at-citing-news.php). Over 60% of queries drew incorrect answers overall; **Perplexity was best at 37% wrong, Grok 3 worst at 94% wrong**; Grok 3 produced 154 of 200 citations resolving to error pages; ChatGPT misidentified 134 of 200 while hedging only fifteen times and never refusing [cjr.org](https://www.cjr.org/tow_center/we-compared-eight-ai-search-engines-theyre-all-bad-at-citing-news.php). The authors explicitly flag that **each excerpt was queried once**, so repeat runs would yield different results [cjr.org](https://www.cjr.org/tow_center/we-compared-eight-ai-search-engines-theyre-all-bad-at-citing-news.php) — a design flaw you should not replicate.

#### Methodological Comparison — five studies measuring "does the cited page support the claim"

| Study | Unit judged | Verification mechanism | Judge | Judge–human agreement | n | Ground truth source | Maintained? |
|---|---|---|---|---|---|---|---|
| DeepTRACE [arxiv.org](https://arxiv.org/html/2509.04499v1) | Statement × source cell | Bipartite citation + factual-support matrices; Hopcroft–Karp vertex cover for necessity | GPT-5 | Pearson **0.62** (factual support); 0.72 (confidence) | 303 queries × 9 systems = 2,727 samples; ~80k support judgements | ProCon.org + domain experts | Paper Sep 2025; ICLR 2026 — no public repo found |
| DeepResearch Bench FACT [github.com](https://github.com/Ayanami0730/deep_research_bench) | Deduplicated statement–URL pair | Re-scrape cited URL (Jina API) → LLM support judgement | GPT-5.4-mini (FACT); GPT-5.5 (RACE) | Overall 71.82 vs **68.78 human baseline** | 100 tasks × 22 fields | Domain experts, 50 zh + 50 en | **Yes** — repo pushed 2026-05-11, Pipeline v2 |
| TREC DRAGUN [arxiv.org](https://arxiv.org/html/2602.24277v1) | Rubric answer × report | Human assessors label Supports/Partial/Contradicts/None; Contradicts precedence | AutoJudge (gpt-oss-120b, T=0) | **Kendall τ 0.872**; κ 0.50; Gwet AC1 0.85 | 30 topics, 236 questions, 551 answers, 15,428 pairs | NIST assessors, open-web research (deliberately not corpus-restricted) | **Yes** — resources released 2026-02 |
| Mind2Web 2 [arxiv.org](https://arxiv.org/abs/2506.21506) | Rubric tree node | Task-specific judge agents verify correctness + attribution | Agent-as-a-Judge | Not reported on abstract page | 130 tasks, 1,000+ human hours | Human task authors | Repo pushed 2026-05-17 |
| SourceBench [arxiv.org](https://arxiv.org/abs/2602.16942) | Cited source (quality, not support) | 8-metric framework, content + page-level | Calibrated LLM evaluator | "matches expert judgments closely" (unquantified on abstract page) | 100 queries, 3,996 sources, 12 systems | Human-labelled dataset | Paper Feb 2026; repo not located |

The consensus across all five: **statement-level decomposition followed by per-claim source re-fetch and an LLM support judgement is the accepted method.** The active debate is entirely about judge reliability — agreement figures range from Pearson 0.62 (DeepTRACE, self-described as a limitation) to Kendall τ 0.872 (DRAGUN, with released human labels to check against). That spread is the single most important number for your build decision.

---

### (2) Open-source evaluation harnesses in TypeScript, Rust or Go, and which are maintained in the last six months

All timestamps below are read directly from the GitHub, npm and crates.io APIs on 2026-07-27. "Maintained" = repository `pushed_at` within six months (after 2026-01-27).

#### TypeScript — viable

| Project | Stars | Repo `pushed_at` | Registry latest | Maintained (6mo)? | Fit for this job |
|---|---|---|---|---|---|
| **promptfoo/promptfoo** | 23,631 | **2026-07-27** | `promptfoo` 0.121.19, published 2026-07-14 | **Yes — daily** | **Best fit.** Multi-provider per eval, model-graded `factuality`/`context-faithfulness`/`context-recall`/`context-relevance`/`llm-rubric`/`g-eval`, custom `javascript`/`python`/`ruby` assertions with `GradingResult` return, `assertScoringFunction` to override weighted-average aggregation, `trajectory:*` and `trace-span-*` assertions for agent traces [promptfoo.dev](https://www.promptfoo.dev/docs/configuration/expected-outputs/) |
| **mastra-ai/mastra** (`@mastra/evals`) | 26,595 | 2026-07-27 | `@mastra/evals` 1.6.0, 2026-07-23 | Yes | Agent-framework-coupled; evals are a subpackage rather than a benchmark runner |
| **langfuse/langfuse** | 31,900 | 2026-07-26 | `langfuse` 3.38.20, 2026-04-01 | Yes | Observability + dataset/score storage; not a runner. Good as the results store |
| **braintrustdata/autoevals** | 979 | 2026-07-24 | `autoevals` 0.3.0, 2026-06-09 | Yes | Scorer library (ships JS + Python); complements rather than replaces a runner |
| **mattpocock/evalite** | 1,624 | 2026-04-28 | `evalite` 0.19.0, **published 2025-11-06** | Borderline | Repo touched within 6mo but **no npm release in ~9 months**. Vitest-native and elegant, but release cadence has stalled |
| Agenta, Helicone, openai-agents-js | 4,350 / 6,000 / 3,471 | 2026-07-26 / 2026-07-25 / 2026-07-27 | — | Yes | Platform/SDK, not benchmark harnesses |

[api.github.com](https://api.github.com/repos/promptfoo/promptfoo)[registry.npmjs.org](https://registry.npmjs.org/promptfoo)[registry.npmjs.org](https://registry.npmjs.org/evalite)

promptfoo's release cadence is verifiable and tight: 0.121.16 and 0.121.17 on 2026-06-16, 0.121.18 on 2026-07-08, 0.121.19 on 2026-07-14 [api.github.com](https://api.github.com/repos/promptfoo/promptfoo/releases).

**The gap you will have to fill yourself:** promptfoo's assertion catalogue has no citation-checking assertion. `context-faithfulness` checks output against *supplied* context; it does not fetch a cited URL and test support [promptfoo.dev](https://www.promptfoo.dev/docs/configuration/expected-outputs/).

#### Go — viable but thinner

| Project | Stars | `pushed_at` | Maintained? | Notes |
|---|---|---|---|---|
| **genkit-ai/genkit** | 6,291 | **2026-07-27** | Yes | Ships a Go evaluation framework with dataset management, a UI and a CLI [mastering-genkit.github.io](https://mastering-genkit.github.io/mastering-genkit-go/chapters/11-evaluations.html); module at `github.com/firebase/genkit/go` [pkg.go.dev](https://pkg.go.dev/github.com/firebase/genkit/go). Note the repo moved from `firebase/genkit` to `genkit-ai/genkit` |
| **cloudwego/eino** | 12,478 | 2026-07-24 | Yes | ByteDance Go LLM framework; `eino-ext` (781 stars, pushed 2026-07-24) carries integrations |
| **maragudk/gai** | 54 | 2026-07-25 | Yes | Small; evals integrate with Go's `testing` package via `TestEval`-prefixed functions and `eval.Run` mirroring `t.Run` [maragu.dev](https://www.maragu.dev/blog/evaluate-llm-apps-in-go) |
| maragudk/evals | 1 | 2026-01-05 | **No** (6.7 months) | |
| tmc/langchaingo | 9,563 | 2026-01-11 | **No** (6.5 months) | |

[api.github.com](https://api.github.com/repos/genkit-ai/genkit)[api.github.com](https://api.github.com/repos/cloudwego/eino)

#### Rust — effectively absent

Only one crate found that is purpose-built for LLM evaluation: **`adk-eval` v1.0.0, updated 2026-06-08, 2,513 downloads**, with an `llm_judge` module for LLM-based scoring [docs.rs](https://docs.rs/adk-eval/latest/adk_eval/llm_judge/index.html)[crates.io](https://crates.io/api/v1/crates/adk-eval). Two caveats that matter: it is part of **`zavora-ai/adk-rust`, a third-party Rust port of the Agent Development Kit — not a Google project** (568 stars, pushed 2026-07-26, licence field `NOASSERTION`) [api.github.com](https://api.github.com/repos/zavora-ai/adk-rust), and it was created only 2025-12-09 [crates.io](https://crates.io/api/v1/crates/adk-eval).

The broader Rust LLM ecosystem is alive but has no eval layer: `rig-core` v0.40.0 updated 2026-07-11 with 1,817,302 downloads offers no documented evaluation module [crates.io](https://crates.io/api/v1/crates/rig-core); `swiftide`'s repo is active (pushed 2026-07-24) but its **crates have not been released since 0.32.1 on 2025-11-15** [crates.io](https://crates.io/api/v1/crates/swiftide)[api.github.com](https://api.github.com/repos/bosun-ai/swiftide).

**Verdict on Rust: do not build the harness in Rust.** <INFERENCE from="adk-eval is the only purpose-built Rust eval crate, is third-party, is seven months old, has 2,513 total downloads, and carries a NOASSERTION licence; rig-core and swiftide have no eval layer">There is no Rust eval harness with enough adoption, licence clarity or maturity to depend on for a benchmark whose results you intend to defend publicly. Choosing Rust means building the entire harness, not adopting one.</INFERENCE>

#### The uncomfortable comparison: Python

Every benchmark you would want to reuse ships Python, and the Python harnesses are all actively maintained: `inspect_ai` pushed 2026-07-25 (and is specifically cited by Miller as computing the correct CLT standard error rather than the Bernoulli one [arxiv.org](https://arxiv.org/html/2411.00640v1)), `deepeval` 2026-07-26, `lm-evaluation-harness` 2026-07-13, `lighteval` 2026-06-29, `stanford-crfm/helm` 2026-07-01, `openai/simple-evals` 2026-04-22 [api.github.com](https://api.github.com/repos/UKGovernmentBEIS/inspect_ai)[api.github.com](https://api.github.com/repos/EleutherAI/lm-evaluation-harness). DeepResearch Bench, BrowseComp-Plus, LiveDRBench, ResearchRubrics, Mind2Web 2 and DRAGUN's AutoJudge are all Python [api.github.com](https://api.github.com/repos/Ayanami0730/deep_research_bench)[api.github.com](https://api.github.com/repos/texttron/BrowseComp-Plus).

---

### (3) Published head-to-head comparisons of Gemini Deep Research, OpenAI Deep Research, Perplexity Sonar, xAI Grok and agentic coding CLIs

**One benchmark covers four of your five provider families simultaneously.** DeepResearch Bench's public leaderboard (100 tasks, 22 fields):

| System | RACE Overall | Comp. | Depth | Instr. | Read. | Citation Acc. | Effective Citations |
|---|---|---|---|---|---|---|---|
| **Gemini-2.5-Pro Deep Research** | **48.88** | 48.53 | 48.50 | 49.18 | 49.44 | 81.44 | **111.21** |
| **OpenAI Deep Research** | 46.98 | 46.87 | 45.25 | **49.27** | 47.14 | 77.96 | 40.79 |
| **Perplexity Deep Research** | 42.25 | 40.69 | 39.39 | 46.40 | 44.28 | **90.24** | 31.26 |
| **Grok Deeper Search** | 40.24 | 37.97 | 35.37 | 46.30 | 44.05 | 83.59 | 8.15 |
| Claude-3.7-Sonnet w/Search | 40.67 | 38.99 | 37.66 | 45.77 | 41.46 | 93.68 | 32.48 |
| Perplexity-Sonar-Reasoning-Pro (high) | 40.22 | 37.38 | 36.11 | 45.66 | 44.74 | **39.36** | 8.35 |
| Perplexity-Sonar-Reasoning (high) | 40.18 | 37.14 | 36.73 | 45.15 | 44.35 | 48.67 | 11.34 |
| Perplexity-Sonar-Pro (high) | 38.93 | 36.38 | 34.26 | 44.70 | 43.35 | 78.66 | 14.74 |
| Perplexity-Sonar (high) | 34.54 | 30.95 | 27.51 | 42.33 | 41.60 | 74.42 | 8.67 |
| Gemini-2.5-Pro-Grounding | 35.12 | 34.06 | 29.79 | 41.67 | 37.16 | 81.81 | 32.88 |
| GPT-4o-Search-Preview (high) | 35.10 | 31.99 | 27.57 | 43.17 | 41.23 | 88.41 | 4.79 |
| GPT-4.1 w/Search (high) | 33.46 | 29.42 | 25.38 | 42.33 | 40.77 | 87.83 | 4.42 |
| Claude-3.5-Sonnet w/Search | 28.48 | 24.82 | 22.82 | 35.12 | 35.08 | **94.04** | 9.78 |

[deepresearch-bench.github.io](https://deepresearch-bench.github.io/)

Two structural findings are visible here and matter more than the ranking. First, **the Sonar family's citation accuracy collapses as reasoning increases** — Sonar-Pro 78.66% → Sonar-Reasoning 48.67% → Sonar-Reasoning-Pro 39.36% [deepresearch-bench.github.io](https://deepresearch-bench.github.io/), the reverse of what you would expect. Second, **effective-citation counts span 13× among deep-research agents** (Gemini 111.21 vs Grok 8.15) while RACE overall spans only 1.2× [deepresearch-bench.github.io](https://deepresearch-bench.github.io/).

<INFERENCE from="The DeepResearch Bench public leaderboard lists only 2025-era systems (Claude-3.7, GPT-4.1, Gemini-2.5, Sonar); the repo's May 2026 news mentions Kimi-Researcher, Doubao-DeepResearch and Claude-Researcher plus a leaderboard migration to Hugging Face and an evaluator switch to GPT-5.5">The public deepresearch-bench.github.io table is a stale snapshot relative to the repository's own pipeline. Numbers above should be treated as a mid-2025 measurement, not a current ranking, and the Hugging Face Space (muset-ai/DeepResearch-Bench-Leaderboard) is the live surface — which did not render for automated fetching in this session.</INFERENCE>

**Second head-to-head: DeepTRACE**, comparing nine generative search engines and deep-research configurations on citation reliability rather than answer quality — table reproduced in section (1) [arxiv.org](https://arxiv.org/html/2509.04499v1). Its category design is the most transferable: 168 *debate* queries (where one-sidedness is the failure mode) plus 135 *expertise* queries (where support is the failure mode) [arxiv.org](https://arxiv.org/html/2509.04499v1).

**Third: Tow Center**, comparing ChatGPT Search, Perplexity, Perplexity Pro, DeepSeek Search, Copilot, Grok-2, Grok-3 beta and Gemini on pure attribution retrieval [cjr.org](https://www.cjr.org/tow_center/we-compared-eight-ai-search-engines-theyre-all-bad-at-citing-news.php).

**Fourth: Search Arena / LMArena**, crowdsourced blind pairwise votes rendered as Bradley-Terry Elo-scale ratings [evals.report](https://evals.report/benchmarks/search-arena), backed by an open 24k-interaction dataset [arxiv.org](https://arxiv.org/abs/2506.05334). Repo `lmarena/search-arena` pushed 2026-02-23 [api.github.com](https://api.github.com/repos/lmarena/search-arena).

**Fifth: FutureSearch**, which does have current cross-provider data — but on *forecasting*, not research. BTF-3 (evaluated June–July 2026, 1,907 resolved questions: 1,515 binary, 392 numeric) ranks Claude Opus 4.8 (xhigh) at 0.130 pooled Brier, Claude Fable 5 (high) 0.131, GPT-5.5 (high, agent SDK) 0.134, GPT-5.6 Sol (high) 0.135; BTF-2 (updated 2026-04-20, 1,417 questions against a frozen 15M-document corpus) gives Opus 4.6 Agent 0.130, Gemini 3.1 Pro Agent 0.141, GPT-5.4 Agent 0.152, Grok 4.20 Beta Agent 0.165 [drb.futuresearch.ai](https://drb.futuresearch.ai/). Their statistical treatment is the strongest of any leaderboard found: **95% confidence intervals from percentile bootstrap with 5,000 resamples, and a pairwise matrix of paired-bootstrap differences computed only on questions both agents answered, with significance at p<.05/.01/.001** [drb.futuresearch.ai](https://drb.futuresearch.ai/). Copy this.

**Agentic coding CLIs on research tasks: this does not exist.** A targeted search returned ten comparisons of Claude Code, Codex CLI, Gemini CLI, Cline, Cursor and others — all scoped to coding, pricing, sandboxing, context windows and CI/CD ergonomics, none evaluating them on research or web-research tasks; the two that reference benchmarks at all frame them in a coding context [html.duckduckgo.com](https://html.duckduckgo.com/html/?q=agentic+coding+CLI+benchmark+research+tasks+Claude+Code+Codex+Gemini+CLI+comparison+evaluation+2026). All ten hits are vendor or SEO-aggregator content and none meet the source-discipline bar; they are named here only to evidence the absence. <MISSING_DATA>[Sought: any published, methodologically-specified evaluation of agentic coding CLIs on deep-research tasks. Unavailable: none found. Needed: this appears to be a genuine open niche — if your harness routes to coding CLIs as research backends, you would be producing the first such comparison, which means no external result exists to validate your numbers against.]</MISSING_DATA>

---

### (4) Methodology for a fair multi-provider evaluation

#### Task category design

The published designs converge on 8–22 categories with **failure-mode-driven rather than topic-driven** partitioning. DeepTRACE's split is the sharpest: debate queries (168, from ProCon.org) isolate one-sidedness and overconfidence; expertise queries (135, from meteorology/medicine/HCI experts) isolate factual support [arxiv.org](https://arxiv.org/html/2509.04499v1). LiveDRBench uses eight categories built around *retrieval difficulty*: SciFacts-Geo, SciFacts-Materials, NovelDatasets identification, NovelDatasets identification-and-extraction, NovelDatasets peer retrieval, PriorArt search, Entities, Flight incidents [github.com](https://github.com/microsoft/LiveDRBench). SourceBench partitions by *user intent*: informational, factual, argumentative, social, shopping [arxiv.org](https://arxiv.org/abs/2602.16942). ResearchRubrics adds an orthogonal complexity taxonomy over conceptual breadth, logical nesting and exploration [arxiv.org](https://arxiv.org/abs/2511.07685). FutureSearch scores by averaging **first within task category, then across tasks** [drb.futuresearch.ai](https://drb.futuresearch.ai/), which prevents a large category dominating.

#### Ground-truth construction

Three distinct, well-documented techniques:

1. **Problem inversion** (LiveDRBench): start from a long-context reasoning problem with a known answer, invert it into a question asking for the entity matching those properties, refine until the answer is unique, then update the reference document set. Answers are **encrypted in the released dataset to reduce test-set leakage**, following BrowseComp's approach [github.com](https://github.com/microsoft/LiveDRBench).
2. **Open-web rubric authoring, deliberately not corpus-restricted** (DRAGUN): each of 30 topics went to one primary and two secondary NIST assessors who independently researched the article on the open web; the primary merged all three into a final rubric capped at ten questions, each with short answers backed by reference URLs. The authors explicitly chose this to avoid "the pitfall where evaluation targets are limited to whatever participating systems happened to surface," accepting that some rubric answers may not exist in the fixed corpus [arxiv.org](https://arxiv.org/html/2602.24277v1).
3. **Frozen-corpus replay** (RetroSearch / BrowseComp-Plus): FutureSearch reports that offline agents operating in a frozen scrape "perform comparably to 'live web' agents, enabling reliable evaluations of models over time" [arxiv.org](https://arxiv.org/abs/2506.06287); BrowseComp-Plus pairs each query with human-verified supporting documents plus mined hard negatives [arxiv.org](https://arxiv.org/abs/2508.06600).

#### Inter-rater reliability — the scholarly consensus has shifted, and recently

This is where the literature is most decisive and most at odds with common practice.

**Do not report raw agreement.** Norman, Rivera and Hughes (2026-06-17) evaluated 21 judges from nine providers across MT-Bench, JudgeBench and RewardBench under agreement/consistency/bias protocols — 118 runs, ~541,000 judgments — and found kappa deflation between exact-match agreement and Cohen's κ of **33–41 percentage points on MT-Bench**, "universal" across the cohort including the April 2026 frontier [arxiv.org](https://arxiv.org/abs/2606.19544). They also found judge rankings shift by **up to 14 positions** depending on benchmark, and identify a "consistency–bias paradox": two production-deployed judges with test–retest reliability >0.95 *and* position bias >0.10. Verbosity bias was small (<0.011) under a single pairwise rubric [arxiv.org](https://arxiv.org/abs/2606.19544).

**Do not report a battery of correlations.** Rao and Callison-Burch (2026-05-25) surveyed 24 recent LLM-as-judge papers and found metric choice entangled with judgment scale, tie handling, invalid outputs and abstention handling — "and those choices rarely stated" [arxiv.org](https://arxiv.org/abs/2606.00093). Their central technical result: for binary criteria (the rubric case, where each criterion is MET or UNMET), **Pearson's r, Spearman's ρ, Kendall's τ_b, φ and MCC all reduce to a single number on non-degenerate binary data**, so reporting several "only creates an illusion of corroborating evidence." Cohen's κ genuinely adds information because it shares φ's numerator but normalises differently; the gap between them measures how far the judge's positive-label rate has drifted from the human's [arxiv.org](https://arxiv.org/abs/2606.00093). They further warn that the three common ways of handling abstentions (`CANNOT_ASSESS`) "are not interchangeable preprocessing choices but answer different questions, and they break the binary equivalences," and prescribe a reporting checklist naming judgment scale, abstention/tie handling mode, coverage, the confusion matrix and aggregation level [arxiv.org](https://arxiv.org/abs/2606.00093). For multi-judge ensembles, Fleiss' κ and Krippendorff's α restore the same equivalences up to a negligible finite-sample correction [arxiv.org](https://arxiv.org/abs/2606.00093).

**Report Gwet's AC1 alongside κ when classes are imbalanced.** DRAGUN reports κ = 0.50 with AC1 = 0.85 on Task 2, explicitly because kappa deflates under class imbalance — their label distribution was 86.4% "None" [arxiv.org](https://arxiv.org/html/2602.24277v1). Citation-support judging is exactly this shape: most (statement, source) cells are unsupported.

**Benchmark your judge against a published human baseline.** DeepResearch Bench's is 68.78%, and its best evaluator (GPT-5.5) reaches 71.82% [github.com](https://github.com/Ayanami0730/deep_research_bench). DRAGUN's AutoJudge achieves run-level Kendall τ = 0.872, which the authors situate against comparable IR auto-judging work reporting τ ≈ 0.8, range 0.727–0.901 [arxiv.org](https://arxiv.org/html/2602.24277v1). DeepTRACE's factual-support Pearson of 0.62 sits well below all of these [arxiv.org](https://arxiv.org/html/2509.04499v1).

For human raters: physician inter-rater ICC(3,k) has been measured between **0.653 and 0.887**, with test–retest below 1.0 [iclr-blogposts.github.io](https://iclr-blogposts.github.io/2026/blog/2026/why-ai-evaluations-need-error-bars/>.

#### Sample size and significance

Miller's framework is the reference. Treating eval questions as drawn from an unseen super-population, with each score decomposing as `s_i = x_i + ε_i` <cite url=):

- **Standard error:** use `SE_CLT = √(Var(s)/n)`, not the Bernoulli form, unless scores are strictly 0/1. Miller notes the Llama 3 report applied the Bernoulli formula even to fractional F1 scores, yielding overly wide intervals, and credits Inspect's `stderr()` with computing SE_CLT correctly [arxiv.org](https://arxiv.org/html/2411.00640v1).
- **Clustered SE** where questions come in groups: `SE_clustered = [SE_CLT² + (1/n²) Σ_c Σ_i Σ_{j≠i}(s_{i,c} − s̄)(s_{j,c} − s̄)]^(1/2)`. Measured inflation on Anthropic models: DROP 1.34 vs 0.44 naive (**ratio 3.05×**), MGSM 1.62 vs 0.86 (1.88×), RACE-H 0.51 vs 0.46 (1.10×). Miller judges the Llama 3 report's reading-comprehension intervals "likely anti-conservative (too narrow)" as a result [arxiv.org](https://arxiv.org/html/2411.00640v1). Independently, the ICLR 2026 blogpost gives the design effect `DE = 1 + (m−1)ρ` and notes realistic intracluster correlations of ρ ≈ 0.2–0.4 inflate true standard errors "by a factor of two or three" [iclr-blogposts.github.io](https://iclr-blogposts.github.io/2026/blog/2026/why-ai-evaluations-need-error-bars/>.
- **Paired comparison, always:** `SE_paired = √(SE_A² + SE_B² − 2·SE_A·SE_B·Corr(s_A,s_B))`, equivalently `Var(paired) = Var(unpaired) − 2·Cov(x_A,x_B)/n`. Worked example: two models each with Var 1/12 and correlation 0.5 → covariance 1/24, cutting variance by one third <cite url=).
- **Power:** `n = (z_{α/2} + z_β)²(ω² + σ_A²/K_A + σ_B²/K_B)/δ²` where `ω² = Var(x_A) + Var(x_B) − 2Cov(x_A,x_B)`. Worked: σ² = 0, ω² = 1/9, δ = 0.03, α = 0.05, β = 0.20 → **n ≈ 969**, generalised to "new evals should have at least ~1,000 questions" [arxiv.org](https://arxiv.org/html/2411.00640v1). Second worked example: at n = 198 with σ² = 1/6 each and correlation 0.5, raising repeats K from 1 to 10 shrinks the minimum detectable effect from **13.2% to 7.5%** [arxiv.org](https://arxiv.org/html/2411.00640v1).
- **Variance reduction:** resampling K times gives `Var(s_i) = σ_i²/K`; in the uniform-difficulty binary example, K=2 cuts variance by 1/3, K=4 by 1/2, K=6 by 5/9, asymptotic ceiling 2/3. **Do not lower temperature to reduce variance** — Miller gives two counterexamples where T=0 *triples* and *quintuples* variance and shifts the mean [arxiv.org](https://arxiv.org/html/2411.00640v1).
- **Multiple comparisons:** comparing ten models across twenty benchmarks generates many implicit pairwise tests; Bonferroni, Holm–Bonferroni or FDR correction is recommended but "almost absent" in current LLM work [iclr-blogposts.github.io](https://iclr-blogposts.github.io/2026/blog/2026/why-ai-evaluations-need-error-bars/>.

<INFERENCE from=)The published Gemini-vs-OpenAI Deep Research ordering on DeepResearch Bench is very unlikely to be statistically distinguishable at n=100. Illustratively, if per-task RACE scores had a standard deviation of 15 points and the two agents' scores correlated at 0.5, the paired standard error would be √(2·15²·0.5/100) = 1.5 points, giving a minimum detectable effect of roughly 4.2 points at 80% power — more than double the observed 1.90-point gap. The 15-point SD is my assumption, not a published figure.</INFERENCE>

<MISSING_DATA>[Sought: per-task score standard deviations, confidence intervals, or paired-difference tests for DeepResearch Bench, ResearchRubrics, Mind2Web 2 or LiveDRBench. Unavailable: none of these publish uncertainty on their leaderboards. Needed: raw per-task score files, which DeepResearch Bench's repo may contain but which were not retrieved. Consequence: every published deep-research agent ranking found in this investigation is a point-estimate ordering with unquantified uncertainty. The sole exception is FutureSearch, which publishes bootstrap CIs and a paired-significance matrix.]</MISSING_DATA>

#### Controlling provider non-determinism

The root cause is now well characterised: the common "GPU parallelism plus floating-point rounding" explanation is largely wrong; the culprit is that inference kernels **lack batch invariance**, so a request's output depends on the batch size of the forward pass it lands in, and servers batch dynamically by load [thinkingmachines.ai](https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/). The fix — pinning matmul kernel configurations and using fixed-size split reductions in attention and RMSNorm regardless of batch shape, demonstrated with `batch_invariant_ops` running Qwen3-8B deterministically under vLLM at some throughput cost [thinkingmachines.ai](https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/) — **is unavailable to you for hosted deep-research products.** You control neither their kernels nor their batching.

What remains controllable:

| Control | Evidence | Practical setting |
|---|---|---|
| Repeats per task | k ≥ 3 is cited survey best practice; the "Beyond pass@1" protocol uses k=3 at temperature 0.7 [arxiv.org](https://arxiv.org/html/2603.29231v1); DevStral uses three independent attempts even at temperature 0 [iclr-blogposts.github.io](https://iclr-blogposts.github.io/2026/blog/2026/why-ai-evaluations-need-error-bars/>; one practitioner source recommends 10–20 <cite url=) | k = 3 minimum; use Miller's MDE formula to decide whether more buys anything |
| Freeze the corpus | RetroSearch offline agents perform comparably to live-web agents [arxiv.org](https://arxiv.org/abs/2506.06287); BrowseComp-Plus exists specifically because "dynamic and opaque web APIs hinder fair comparisons and reproducibility" [arxiv.org](https://arxiv.org/abs/2508.06600) | Only viable for backends you can point at a corpus; hosted DR products cannot be frozen |
| Report reliability as a first-class metric, not noise | pass^k requires success on all k attempts; τ-bench GPT-4o 61% pass@1 vs 25% pass@8 [arxiv.org](https://arxiv.org/html/2603.29231v1); τ-bench agents at 60% pass@1 showing 25% consistency across trials [arxiv.org](https://arxiv.org/html/2601.06112) | Report pass@1 *and* pass^k |
| Track variance amplification | Variance Amplification Factor by model: MiniMax M2.5 2.60 [1.53, 5.24], DeepSeek V3 2.49, Kimi K2.5 2.48, GLM-4.5 Air 2.37 vs Qwen3 32B 1.26, Llama 3.1 8B 0.26 — a clean split at ≥2.37 vs ≤1.26, interpreted as "high variance amplification is a capability signature, not an instability signature" [arxiv.org](https://arxiv.org/html/2603.29231v1) | Bootstrap 95% CIs on VAF; non-overlap is your evidence |
| Treat completion rate as a validity metric | Quota exhaustion and provider 404s biased earlier runs; the authors elevate "episodes finishing without infrastructure error" to a first-class metric [arxiv.org](https://arxiv.org/html/2603.29231v1) | Essential for a multi-provider MCP harness where one backend's rate limits silently shrink its sample |
| Budget for judge variance separately | With model outputs held fixed and only judge sampling varied, LLMEval-3 scores moved 0.5–1.6pp; changing only the evaluation seed shifts accuracy 1–3pp for mid-sized models (Meta, 2024) [iclr-blogposts.github.io](https://iclr-blogposts.github.io/2026/blog/2026/why-ai-evaluations-need-error-bars/> | Model and judge uncertainty are additive |

#### Secondary questions: state, dissent, trajectory

**Current state and strongest evidence.** The consensus that deep-research systems produce many unsupported cited statements is now supported by convergent evidence from three methodologically independent designs: a matrix-based audit (DeepTRACE, 303 queries, ~80k support judgements, citation accuracy 39.8–79.1%) <cite url=), a re-scrape-and-judge pipeline (DeepResearch Bench FACT, 100 expert tasks, 39.36–94.04%) [deepresearch-bench.github.io](https://deepresearch-bench.github.io/), and a NIST-assessed human rubric protocol (DRAGUN, 15,428 human-judged answer–report pairs) [arxiv.org](https://arxiv.org/html/2602.24277v1). Convergence across three designs with different judges and different ground truth is the strongest evidence in this field.

**Contrasting evidence.** The dissent is not about whether the failure exists but whether LLM judges can measure it reliably. DeepTRACE's own factual-support agreement with humans is Pearson 0.62 [arxiv.org](https://arxiv.org/html/2509.04499v1), while DRAGUN's AutoJudge reaches Kendall τ 0.872 [arxiv.org](https://arxiv.org/html/2602.24277v1) — and Norman et al. demonstrate that the headline agreement numbers most papers report overstate discriminative ability by 33–41 points once chance-corrected [arxiv.org](https://arxiv.org/abs/2606.19544). A second, orthogonal dissent comes from Search Arena: human preference does not track support at all, so preference-based leaderboards and support-based benchmarks measure different things and should not be reconciled [arxiv.org](https://arxiv.org/abs/2506.05334).

**Trajectory.** Three movements are visible. Toward **institutional assessment**: TREC RAG 2026 is announced as "The first Agent-first track at TREC!" [trec-rag.github.io](https://trec-rag.github.io/), and TREC 2025 RAG already drew over 150 submissions with attribution verification as a named evaluation layer [arxiv.org](https://arxiv.org/abs/2603.09891). Toward **statistical rigour**: three of the most relevant methodology papers found are dated 2026 (Rao & Callison-Burch 2026-05-25 [arxiv.org](https://arxiv.org/abs/2606.00093), Norman et al. 2026-06-17 [arxiv.org](https://arxiv.org/abs/2606.19544), Khanal et al. 2026-03-31 [arxiv.org](https://arxiv.org/html/2603.29231v1)), all arguing current practice overstates confidence. Toward **corpus control**: BrowseComp-Plus (ACL 2026) and RetroSearch both exist to remove the live web as a confound [arxiv.org](https://arxiv.org/abs/2508.06600)[arxiv.org](https://arxiv.org/abs/2506.06287).

---

## The build-versus-adopt decision

**Adopt the harness shell. Build the citation scorer. Adopt the metric definitions and task categories. Do not build a benchmark.**

| Layer | Verdict | Rationale |
|---|---|---|
| **Runner / provider abstraction / result store** | **Adopt — promptfoo (TypeScript)** | Only TS project with multi-provider evals, model-graded assertions, custom JS scorers returning `{pass, score, reason}`, custom scoring aggregation, and agent-trajectory assertions, shipped daily [promptfoo.dev](https://www.promptfoo.dev/docs/configuration/expected-outputs/)[api.github.com](https://api.github.com/repos/promptfoo/promptfoo). Building this is months of undifferentiated work |
| **Citation-support scorer** | **Build** | No harness in any of the three target languages ships one. The algorithm is public: statement–URL extraction → dedup → re-fetch → LLM support judgement → `Σ(C⊙F)/Σ(C)` [arxiv.org](https://arxiv.org/html/2509.04499v1)[github.com](https://github.com/Ayanami0730/deep_research_bench). Implement as a promptfoo custom `javascript` assertion |
| **Metric definitions** | **Adopt — DeepTRACE's eight dimensions** | Published, peer-reviewed at ICLR 2026, formula-level specified, and separates accuracy from thoroughness from necessity — the distinction that catches over-citing [arxiv.org](https://arxiv.org/html/2509.04499v1) |
| **Judge validation protocol** | **Adopt — DRAGUN's** | Human-labelled release lets you calibrate; reports Kendall τ, κ *and* Gwet's AC1 for imbalanced labels [arxiv.org](https://arxiv.org/html/2602.24277v1) |
| **Task set** | **Adopt + extend** | DeepTRACE's debate/expertise split [arxiv.org](https://arxiv.org/html/2509.04499v1) plus DeepResearch Bench's 100 expert tasks [deepresearch-bench.github.io](https://deepresearch-bench.github.io/). Extending to n≈1,000 is where your effort should go, since every existing set is underpowered [arxiv.org](https://arxiv.org/html/2411.00640v1) |
| **Rust** | **Reject** | `adk-eval` is the only candidate: third-party, seven months old, 2,513 downloads, `NOASSERTION` licence [crates.io](https://crates.io/api/v1/crates/adk-eval)[api.github.com](https://api.github.com/repos/zavora-ai/adk-rust) |
| **Go** | **Viable second choice** | genkit-ai/genkit ships Go evaluators and is pushed daily [api.github.com](https://api.github.com/repos/genkit-ai/genkit), but you would write more glue than in TS |

**Non-negotiable reporting requirements** implied by the 2026 literature: paired-difference tests with bootstrap CIs (5,000 resamples, following FutureSearch [drb.futuresearch.ai](https://drb.futuresearch.ai/)), clustered standard errors if tasks share topics (up to 3× inflation [arxiv.org](https://arxiv.org/html/2411.00640v1)), chance-corrected judge agreement with abstention handling declared (33–41pp deflation otherwise [arxiv.org](https://arxiv.org/abs/2606.19544)), k ≥ 3 repeats with pass^k reported alongside pass@1 [arxiv.org](https://arxiv.org/html/2603.29231v1), completion rate as a validity metric [arxiv.org](https://arxiv.org/html/2603.29231v1), and citation accuracy reported separately from citation volume [arxiv.org](https://arxiv.org/abs/2506.05334).

---

## Evidence Table

| Claim | Primary Source | Publication Date | Evidence Type | URL |
|---|---|---|---|---|
| Citation Accuracy = Σ(CitationMatrix ⊙ FactualSupportMatrix)/Σ(CitationMatrix); eight dimensions; 303 queries; judge Pearson 0.62 on factual support | Venkit, Laban, Zhou, Huang, Mao, Wu (DeepTRACE), ICLR 2026 | 2025-09-02 | Peer-reviewed conference paper (preprint HTML) | https://arxiv.org/html/2509.04499v1 |
| Citation accuracy 39.8–79.1% across 9 systems; unsupported statements 12.5–97.5% | Same | 2025-09-02 (results as of 2025-08-27) | Empirical results table | https://arxiv.org/html/2509.04499v1 |
| FACT: statement–URL extraction → dedup → Jina re-scrape → LLM support judgement; evaluator GPT-5.5; human baseline 68.78% | DeepResearch Bench repo (Du, Xu, Zhu, Wang, Mao) | Repo updated 2026-05-11 | Open-source implementation + docs | https://github.com/Ayanami0730/deep_research_bench |
| 100 PhD-level tasks, 22 fields; RACE + citation accuracy/effective citations | Du et al., DeepResearch Bench | 2025-06-13 | Preprint (31pp, 5 figs) | https://arxiv.org/abs/2506.11763 |
| Gemini DR 48.88/81.44%/111.21; OpenAI DR 46.98/77.96%/40.79; Perplexity DR 42.25/90.24%/31.26; Grok Deeper Search 40.24/83.59%/8.15 | DeepResearch Bench leaderboard | Undated snapshot (2025-era models) | Published leaderboard | https://deepresearch-bench.github.io/ |
| 89 task instances, 8 categories, RetroSearch frozen web; offline ≈ live-web performance | Bosse, Evans, Gambee et al. (FutureSearch) | 2025-05-06 | Preprint | https://arxiv.org/abs/2506.06287 |
| DRB leaderboard shows 0 tasks / "No data available"; BTF-3 evaluated June–July 2026 on 1,907 questions; 95% CIs from 5,000-resample percentile bootstrap; paired-bootstrap significance matrix | FutureSearch leaderboard site | Retrieved 2026-07-27 | Live leaderboard | https://drb.futuresearch.ai/ |
| 130 long-horizon tasks, 1,000+ human hours; tree-structured rubric judge agents check correctness + source attribution; OpenAI DR at 50–70% of human performance | Gou, Huang, Ning et al. (Mind2Web 2) | 2025-06-26 (v1), 2025-07-03 (v2) | Preprint | https://arxiv.org/abs/2506.21506 |
| 2,800+ hours human labour, 2,500+ expert rubrics; leading DR agents under 68% rubric compliance | Sharma, Zhang, Bandi et al. (ResearchRubrics), ICLR 2026 | 2025-11-10 | Preprint (27pp, 21 figs) | https://arxiv.org/abs/2511.07685 |
| 100 queries, 3,996 cited sources, 8 source-quality metrics, 12 systems | Jin, Liu, Li, Malik, Zhang (SourceBench) | 2026-02-18 | Preprint | https://arxiv.org/abs/2602.16942 |
| Fixed corpus + human-verified supporting docs + mined negatives; Search-R1+BM25 3.86%, GPT-5 55.9%, GPT-5+Qwen3-Embedding-8B 70.1% | Chen, Ma, Zhuang et al. (BrowseComp-Plus), ACL 2026 | 2025-08-08 | Peer-reviewed conference paper (preprint) | https://arxiv.org/abs/2508.06600 |
| 30 topics, 236 rubric questions, 551 answers, 15,428 human-judged pairs; Supports/Partial/Contradicts/None with Contradicts precedence; weights 4/2/1; AutoJudge τ=0.872, κ=0.50, AC1=0.85 | Zhang, Smucker, Clarke (Univ. Waterloo), TREC 2025 DRAGUN | 2026-02-27 | NIST track resource paper | https://arxiv.org/html/2602.24277v1 |
| TREC 2025 RAG: MS MARCO V2.1; relevance + completeness + attribution verification + agreement analysis; 150+ submissions | Upadhyay, Thakur, Pradeep, Craswell, Campos, Lin | 2026-03-10 | NIST track overview (21pp, 13 tables) | https://arxiv.org/abs/2603.09891 |
| TREC RAG 2026 announced as first Agent-first TREC track | TREC RAG track site | Retrieved 2026-07-27 | Official track page | https://trec-rag.github.io/ |
| 24,000+ interactions, ~12,000 votes; users reward citation count even when cited content does not support the claim | Miroyan, Wu, King et al. (Search Arena), ICLR 2026 | 2025-06-05 (v1), 2026-03-02 (v2) | Peer-reviewed conference paper | https://arxiv.org/abs/2506.05334 |
| 1,600 queries, 8 engines, >60% incorrect; Perplexity 37% wrong, Grok 3 94% wrong; each excerpt queried once | Tow Center for Digital Journalism, CJR | 2025-03 (tests Feb 2025) | Institutional research study | https://www.cjr.org/tow_center/we-compared-eight-ai-search-engines-theyre-all-bad-at-citing-news.php |
| SE_CLT vs Bernoulli; clustered SE inflation up to 3.05× on DROP; paired-difference formula; n≈969 for δ=3pp; ≥1,000-question rule of thumb; do not lower temperature | Evan Miller | 2024-11-01 | Peer-review-adjacent statistics paper (stat.AP) | https://arxiv.org/html/2411.00640v1 |
| 21 judges, 9 providers, 118 runs, ~541k judgments; kappa deflation 33–41pp on MT-Bench; rankings shift up to 14 positions; position bias >0.10 with test–retest >0.95; verbosity bias <0.011 | Norman, Rivera, Hughes | 2026-06-17 | Preprint, largest systematic judge study to date | https://arxiv.org/abs/2606.19544 |
| Binary-scale correlation metrics all collapse to one number; report Cohen's κ; abstention handling is not interchangeable preprocessing; reporting checklist | Rao, Callison-Burch | 2026-05-25 | Preprint (12pp), survey of 24 papers | https://arxiv.org/abs/2606.00093 |
| pass^k, RDC, VAF, GDS, MOP; k=3 repeats; VAF 2.37–2.60 frontier vs ≤1.26 mid-tier; τ-bench 61% pass@1 → 25% pass@8; completion rate as validity metric | Khanal, Tao, Zhou (Northern Kentucky University) | 2026-03-31 | Preprint | https://arxiv.org/html/2603.29231v1 |
| Non-determinism caused by lack of batch invariance, not FP non-associativity; fix = fixed reduction order regardless of batch size | Horace He et al., Thinking Machines Lab | 2025-09-11 | Primary technical blog + open-source `batch_invariant_ops` | https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/ |
| DE = 1+(m−1)ρ; ρ≈0.2–0.4 inflates SE 2–3×; seed change shifts accuracy 1–3pp (Meta 2024); judge sampling alone 0.5–1.6pp (LLMEval-3); physician ICC(3,k) 0.653–0.887 | ICLR 2026 Blogposts track | 2026 | Peer-reviewed blogpost track | https://iclr-blogposts.github.io/2026/blog/2026/why-ai-evaluations-need-error-bars/ |
| promptfoo assertion catalogue: factuality, context-faithfulness/recall/relevance, llm-rubric, g-eval, custom javascript/python/ruby, assertScoringFunction, multi-provider; no citation assertion | promptfoo documentation | Retrieved 2026-07-27 | Official documentation | https://www.promptfoo.dev/docs/configuration/expected-outputs/ |
| promptfoo 23,631 stars, pushed 2026-07-27, releases 0.121.16–19 between 2026-06-16 and 2026-07-14 | GitHub REST API | Retrieved 2026-07-27 | Machine-read registry metadata | https://api.github.com/repos/promptfoo/promptfoo |
| genkit-ai/genkit 6,291 stars pushed 2026-07-27; cloudwego/eino 12,478 pushed 2026-07-24; maragudk/gai pushed 2026-07-25; langchaingo pushed 2026-01-11 (stale) | GitHub REST API | Retrieved 2026-07-27 | Machine-read registry metadata | https://api.github.com/repos/genkit-ai/genkit |
| adk-eval v1.0.0 updated 2026-06-08, 2,513 downloads, repo zavora-ai/adk-rust (568 stars, NOASSERTION licence); rig-core v0.40.0 2026-07-11 with no eval module; swiftide crates unreleased since 2025-11-15 | crates.io + GitHub APIs | Retrieved 2026-07-27 | Machine-read registry metadata | https://crates.io/api/v1/crates/adk-eval |
| evalite npm latest 0.19.0 published 2025-11-06 despite repo pushed 2026-04-28 | npm registry API | Retrieved 2026-07-27 | Machine-read registry metadata | https://registry.npmjs.org/evalite |
| LiveDRBench: 100 tasks, 8 categories, precision/recall/F1 via LLM judge, problem-inversion ground truth, encrypted answers; repo pushed 2025-10-16 | Microsoft Research repo + GitHub API | Data collected May–June 2025; repo last pushed 2025-10-16 | Open-source benchmark + registry metadata | https://github.com/microsoft/LiveDRBench |

---

## Knowledge Gaps

**Caused by tool failure (recall limitation).** The session's general web-search tool errored on every invocation. All discovery ran through DuckDuckGo HTML result pages and direct fetches. Benchmarks that exist but did not surface in the ~15 queries run are plausibly missed — particularly non-English work, and benchmarks whose names I did not guess. <MISSING_DATA>[Sought: exhaustive benchmark enumeration. Unavailable: full search coverage. Needed: a re-run with working web search, or a systematic sweep of ACL 2026 / ICLR 2026 / SIGIR 2026 / NeurIPS 2025 proceedings indexes.]</MISSING_DATA>

**Caused by paywall.** SourceCheckup, published in *Nature Communications* and the only peer-reviewed journal (rather than preprint) source-verification framework identified, redirected to an authentication gate on fetch. Its methodology, sample sizes, model list, unsupported-statement percentages and physician-annotator agreement are all unretrieved. <MISSING_DATA>[Sought: nature.com/articles/s41467-025-58551-6 full text. Unavailable: IDP authorization redirect. Needed: institutional access or the PMC mirror. This is the single most valuable gap to close, since it is the only peer-reviewed journal source in the set.]</MISSING_DATA>

**Caused by abstract-only access.** Full-text details were not retrieved for SourceBench (systems evaluated, per-system scores, the "four key insights"), ResearchRubrics (prompt count, rubric construction and validation procedure, inter-annotator agreement, judge identity, per-agent scores), BrowseComp-Plus (corpus size, annotation pipeline, citation-accuracy formula), and TREC 2025 RAG (topic count, AutoNuggetizer methodology, automatic-vs-human correlation, R/AG/RAG task structure). For ResearchRubrics specifically, the absence of published IRR is a substantive concern, not merely a retrieval gap.

**Caused by dynamic rendering.** The live DeepResearch Bench leaderboard is hosted as a Hugging Face Space (`muset-ai/DeepResearch-Bench-Leaderboard`) that had not finished initialising when fetched; a second Space returned HTTP 401. The current rankings — including whichever 2026-era agents have been added since the static site snapshot — are therefore unretrieved.

**Caused by API rate limiting.** Unauthenticated GitHub `stats/participation` and `commits?since=` endpoints returned unusable results, so commit *counts* over the last six months could not be established. Maintenance judgements above rest on `pushed_at` plus npm/crates publish dates, which are reliable for "is it alive" but cannot distinguish a repo receiving daily substantive commits from one receiving dependency-bot pushes.

**Genuinely absent from the literature.** No published evaluation of agentic coding CLIs on research tasks exists, on the evidence gathered. No deep-research benchmark publishes per-task variance, confidence intervals, or paired significance tests except FutureSearch — and FutureSearch's deep-research leaderboard is empty.

---

## Recommended Next Steps

1. **Retrieve SourceCheckup (Nature Communications) and SourceBench full text, then diff their metric definitions against DeepTRACE's.** *Rationale:* you are about to implement a citation-support scorer, and DeepTRACE's own judge–human agreement on exactly that judgement is Pearson 0.62 [arxiv.org](https://arxiv.org/html/2509.04499v1). SourceCheckup is the only peer-reviewed journal treatment found and reports physician-annotator agreement; if its verification procedure differs materially from DeepTRACE's, that difference is the specification of your scorer, not a footnote.

2. **Calibrate your judge against DRAGUN's released human labels before running a single provider comparison.** *Rationale:* DRAGUN ships 15,428 human-judged answer–report pairs, an AutoJudge reference implementation, and scoring scripts that accept either human or LLM labels [arxiv.org](https://arxiv.org/html/2602.24277v1). This gives you a free, published ceiling (τ = 0.872, κ = 0.50, AC1 = 0.85) to measure your own judge against. Given that raw agreement overstates discriminative ability by 33–41 points [arxiv.org](https://arxiv.org/abs/2606.19544), a judge you have not chance-corrected against a public gold set will produce provider rankings you cannot defend.

3. **Run a pilot of 30–50 tasks × k=3 repeats × all backends purely to estimate variance components, then compute your required n from Miller's formula before committing to the full task set.** *Rationale:* Miller's `n = (z_{α/2}+z_β)²(ω² + σ_A²/K_A + σ_B²/K_B)/δ²` requires ω² and σ² which you cannot know a priori, and no deep-research benchmark publishes them [arxiv.org](https://arxiv.org/html/2411.00640v1). Authoring 1,000 tasks before knowing your minimum detectable effect risks either a wasted corpus or an underpowered one — and every existing benchmark chose the latter.

4. **Prototype the citation scorer as a promptfoo custom JavaScript assertion and measure the cost and wall-clock of the re-fetch step across your full task set.** *Rationale:* DeepTRACE ran ~80,000 factual-support evaluations for 303 queries × 9 systems [arxiv.org](https://arxiv.org/html/2509.04499v1), and DeepResearch Bench's Gemini entry averages 111.21 effective citations per task [deepresearch-bench.github.io](https://deepresearch-bench.github.io/). At n=1,000 tasks across five backends with k=3 repeats, statement-level support verification is plausibly millions of judge calls. Whether the design is affordable is a build-blocking question that a 50-task pilot answers cheaply.

5. **Decide explicitly whether you are benchmarking against the live web or a frozen corpus, and if live, instrument completion rate and collection date as first-class outputs.** *Rationale:* RetroSearch and BrowseComp-Plus both exist because live-web evaluation is not reproducible [arxiv.org](https://arxiv.org/abs/2506.06287)[arxiv.org](https://arxiv.org/abs/2508.06600), and quota exhaustion plus provider 404s have been documented biasing agent-benchmark results badly enough that completion rate was promoted to a validity metric [arxiv.org](https://arxiv.org/html/2603.29231v1). For hosted deep-research products you cannot freeze the corpus, which means your results have a shelf life — and the honest move is to stamp it rather than discover it later, as the DeepResearch Bench static leaderboard appears to have done.
