<div align="center">

# What two external research skills know that Dossier did not

**A gap analysis of `Deep-Research-skills` and `last30days-skill`,<br>and the short list of things worth taking.**

<sub>Status: analysis · Written 26 July 2026 · Feeds the local loop, changes nothing about the paid backends</sub>

</div>

---

Two research systems were read in full against Dossier's local loop. The instruction was to find what is genuinely missing rather than what looks different, to avoid building something Dossier already does under another name, and to attribute anything borrowed. This records the reading, including the parts that produced nothing.

The bar for "genuine gap" is deliberately high: a capability Dossier lacks **and** whose absence causes a wrong output, not merely a thinner one.

## Contents

- [The two systems](#the-two-systems)
- [Deep-Research-skills](#deep-research-skills)
- [last30days-skill](#last30days-skill)
- [What was taken](#what-was-taken)
- [What was declined, and why](#what-was-declined-and-why)

## The two systems

| | `Deep-Research-skills` | `last30days-skill` |
|---|---|---|
| Shape | Markdown skills for Claude Code and Codex | A Python engine plus a skill wrapper |
| Scope | General research, items and fields matrices | Recency-bounded social and web research |
| Files read | 34 markdown | 37 markdown plus the ranking and retrieval modules |
| Runs its own search | No, the host does | Yes, through SERP and ScrapeCreators APIs |

That last row decides most of the analysis. `last30days-skill` owns its retrieval, so it can rank, dedupe and time-filter results itself. Dossier cannot: the host searches and the server enforces, which is the whole architecture. A ranking formula has nowhere to run in Dossier, so most of the second repo's best work is inapplicable rather than missing.

## Deep-Research-skills

Four language and host variants (English and Chinese, Claude Code and Codex) of the same five skills, plus per-source-class search modules.

**The headline finding falsifies the premise.** The repo advertises per-index search strategy, and its modules do name the right indexes: Google Scholar, arXiv, bioRxiv, Semantic Scholar, ACM and IEEE for academic work; Stack Overflow and GitHub for debugging. But grepping the entire repository for `site:`, `filetype:`, `intitle:`, `inurl:`, `after:` and `before:` returns **zero hits**. The strategy is prose advice to a model about where to look, not a query dialect. Its academic module says to "use advanced search operators" without naming one.

Dossier's `src/research/decompose.ts` emits the actual strings: `site:github.com <topic> is:issue`, `site:sec.gov <topic>`, `site:doi.org <topic>`, `<topic> 10-K OR 20-F OR annual report`. Dossier is materially ahead here and there is nothing to take.

What the repo does have, measured against Dossier:

| Their capability | Dossier's equivalent | Verdict |
|---|---|---|
| Items × fields research matrix, extensible by row and by column | `src/research/shapes.ts`, `research_wide` | Already there |
| Verbatim reproduction of a user's engineered prompt | Passthrough detection in `src/research/prompt.ts` | Already there |
| Context isolation, subagent output withheld from the lead | Shipped this change as the lead and worker split | Convergent, and taken from daymade rather than from here |
| Batch-gated approval between research waves | The two-step spend handshake and `research_approve_plan` | Already there |
| Resume by checking which output files exist | Sessions persist to the store and resume by `runId` | Already there |

Two anti-patterns worth naming so they are not copied:

- **Its completion check is schema coverage, not evidential sufficiency.** A row passes when every column has a value. A cell reading "no public data" satisfies it identically to a cited figure. Dossier's gate is the evidence profile, which counts approved sources, independent domains and single-domain concentration, and a run that fills every field from one blog fails it.
- **Uncertainty is suppressed rather than surfaced.** Contradictions between sources resolve into a single cell value, and the disagreement is gone. Dossier keeps contested claims contested: `research_counter_review`, the group B reconciliation task, and per-claim confidence markers all exist to stop exactly that flattening.

## last30days-skill

A production Python engine, and the more rigorous of the two by a distance. Most of its rigour lives in retrieval, which Dossier does not do.

### Inapplicable, because Dossier never sees a search result

- **Composite rerank**: `0.60 semantic + 0.20 RRF + 0.10 freshness + 0.05 source_quality + 0.05 min(engagement × 6, 100)`.
- **Relevance**: `0.55 × coverage^1.35 + 0.25 × informative_overlap + 0.20 × precision`, floored at `0.1`, with `MIN_ON_TOPIC = 5`.
- **Non-daemon executor threads defeat a wall-clock budget**: a real bug, in a threading model Node does not have.

These are good and they have nowhere to run here. The host ranks its own results before it ever writes a finding.

### Already in Dossier, arrived at independently

- **Honest empty state fails closed.** Their ranked output refuses to present a confident answer below a confidence floor. Dossier's black box does the same job at draft time.
- **An invisible graceful fallback is a silent product failure.** Their words. Dossier's capability block prints every degradation with what it costs, for the same reason.
- **Scraped content is fenced as untrusted input.** Dossier's rule that an agent which has just read a hostile page is precisely the caller that must not be able to search `~/.ssh` is the same instinct, applied to a different surface.

### The one genuine gap: outcomes, not booleans

Every run records **what actually happened per source**, in a typed vocabulary:

| State | Meaning |
|---|---|
| `ok` | Completed, returned items |
| `no-results` | Completed cleanly, zero matches |
| `partial` | Some items, then a failure |
| `rate-limited` | Stopped by a provider rate limit |
| `auth-failed` | Credentials missing, rejected or expired |
| `unreachable` | Source or endpoint could not be reached |
| `timeout` | Exceeded its time limit |
| `schema-drift` | Response no longer matched the expected shape |
| `skipped-unconfigured` | Skipped, required configuration absent |
| `error` | Anything else |

With the rule that makes it worth having, from `docs/reference/json-export.md`: consumers must not read a failure state as evidence that a source had no discussion. Only `no-results` means a clean completion with zero matches.

**Dossier had a boolean where this vocabulary belongs, and the boolean was wrong.** `nothingFound` was set whenever a task reported zero findings, for any reason. A worker whose search tool rate-limited, or that hit a login wall on every result, reported the same shape as one that searched a healthy index properly and established there was nothing there.

The consequence was not cosmetic. When every task came back empty, `freezeRegistry` declared the run a black box and `research_local_draft` returned "unable to verify anything about this subject from public sources", `Confidence: N/A`, and a recommendation to contact the subject directly. That output asserts a finding about the world. If the reason the registry was empty is that four workers were rate-limited, the world was never checked, and Dossier would have been stating an established negative on the strength of a failed search. That is the exact failure the black box was built to prevent, reintroduced through the back door.

Absence of evidence and absence of search look identical from the inside. Nothing but a typed outcome separates them.

## What was taken

One thing, in the smallest form that fixes the defect.

`research_local_note` gains an `outcome` field. The vocabulary is cut to what a worker driving a web search can actually distinguish, because a state nobody can report accurately is a state that gets guessed:

- `ok`, findings were returned.
- `no-results`, the search ran cleanly and the index had nothing. **This is the only empty result that establishes coverage.**
- `rate-limited`, `blocked`, `tool-failed`, the search did not complete. Coverage is **not** established.

Ten states collapse to five because Dossier's reporter is a language model rather than an HTTP client. `schema-drift` and `partial` are distinctions an API client can make and a worker cannot. `skipped-unconfigured` is already covered upstream by the capability gate, which halts or degrades before any task is dispatched.

Downstream, the black box now requires that every task completed cleanly. A run where any task failed its search gets a different and more accurate output: the search was degraded, this is not an established negative, and here is what to retry.

## What was declined, and why

**Near-duplicate detection across registry entries.** `last30days-skill` dedupes on `max(char_3gram_jaccard, token_jaccard) >= 0.7` over titles and bodies. Dossier dedupes by canonical URL only, so one wire story syndicated across four outlets counts as four independent domains, which is exactly the arithmetic that turns one source into apparent corroboration.

The gap is real and the fix offered does not transfer. Their thresholds are tuned against article titles and bodies. Dossier holds one-sentence worker-written claims, and two workers summarising genuinely independent sources on a narrow question will write near-identical sentences. Applying a 0.7 similarity merge to that text would silently collapse real corroboration, which is a worse failure than the one it fixes and an invisible one. Recorded here as known and unfixed rather than half-built.

**Per-claim `single-source` and `thin-evidence` tags.** Dossier's evidence profile already counts independent domains and single-domain concentration, and `src/research/corroborate.ts` counts support in registrable domains. Adding a per-claim tag on top would be a second, weaker implementation of a rule Dossier already enforces at the run level.

**Enterprise mode.** Named for completeness because it came up during the daymade work: SWOT grids, risk matrices and weighted scorecards are out of scope, deliberately. They are a consulting deliverable format rather than a research discipline, and a half-built one would be worse than none.

---

**Sources.** [`daymade/claude-code-skills`](https://github.com/daymade/claude-code-skills) for the loop structure shipped alongside this. `Deep-Research-skills` and `last30days-skill` as read on 26 July 2026 from local checkouts. Method borrowed from each is attributed at the point of use in the code.

**Next:** [The multi-provider plan](multi-provider-research.md) · [Tools](../tools.md) · [Test plan](../test-plan.md)
