# Changelog

Every release that changed what the server does, what it costs, or what it needs to run.

Dates are the release date. Costs are estimate bands, never quotes. Where a fact was learned from a live API call rather than from vendor documentation, it says so, because that distinction turned out to matter more than once.

This project follows [semantic versioning](https://semver.org/). Until 1.0 the minor number carries breaking changes.

## [Unreleased]

## [0.5.0] - 2026-07-26

### Added

- **`research_synthesise`** merges two or more completed runs into one evidence base and distils a single report. Different from `research_compare`, which diffs what backends claim and leaves you holding two reports. The merge is deterministic and free: deduplicate by canonical URL, count **independent registrable domains**, profile the sources, and record which run found what. The distillation goes to a model if one is configured and to the caller otherwise.
- **`research_export`** writes a full report, plus its numbered source registry, into a directory you name. The markdown carries a front-matter block recording the backend, the model, the tier, the source count, the tools used and the estimated cost, so the file stays attributable after it lands in a repo.
- **`model`** on the run record, populated by every backend at start rather than at completion, so a run that fails halfway is still attributable.

### Changed

- **Routing no longer hard-prefers Gemini.** Ordinary deep runs now go to the cheapest capable backend, which is what `docs/plan/multi-provider-research.md` specified all along: capability, then cost, then dated accuracy as weak evidence, then diversity. Capability still forces the choice where only one backend qualifies, so asking for an editable plan still routes to Gemini and asking for X still routes to xAI.
- **Every `research_read` and `research_status` now shows where the full report is and what produced it.** The absolute path, the backend, the model, the tier, the source count, the tools used and the estimated cost.

### Fixed

- Four consecutive real runs all went to Gemini while three other configured backends sat idle. Routing preferred Gemini for any `deep` run regardless of price, which is a defensible tie-break and was not written as one.
- A caller could read an outline of a 48,000-character report without ever learning the report existed on disk. `reportPath` had been recorded since the first release and was never surfaced by any tool; `toolsUsed` and `sourceCount` likewise.
- Merging several runs from the **same** backend collapsed them into one label, so every source read as unique and the overlap reported 0% however much the runs shared. Provenance now keys on the run. Found by running the merge against four real reports rather than by reasoning about it.

## [0.4.0] - 2026-07-26

### Added

- **Both checking tools now run without a key.** `research_verify_claims` takes claims, returns each cited page's text, and accepts your verdicts. `research_counter_review` hands over four lens briefs and accepts your findings. A configured utility model still does either end to end.

  What stays server-side is what only a server can do: SSRF-checked fetching, holding the sample, and enforcing the rules. **A verdict on a claim that was never fetched is discarded**, and a lens that was never applied is named rather than counted as one that found nothing. The coverage rule lives in one renderer shared by both modes.

### Changed

- The only remaining reason to add an API key is a long unattended investigation: forty minutes across a hundred sources, running while the laptop is shut. Everything else is now a choice about who does the reading. The README and `docs/tools.md` say so.

## [0.3.1] - 2026-07-25

### Changed

- README rewritten for what 0.3.0 actually shipped, and every config key documented.

## [0.3.0] - 2026-07-25

### Added

- **Three more backends.** Perplexity (`sonar-deep-research`, enforced date and domain filters, native wide research), OpenAI (`gpt-5.6-terra` / `-sol`, a 100-domain filter, the largest of the four), and xAI (`grok-4.3` / `4.5`, the only backend that reaches X).
- **Capability-first routing** that names its reasoning, its runner-up, and why each rejected backend could not run.
- **Research shapes** beyond one-question-one-essay: `research_wide` (entity × field matrix with a completion gate), `research_recent` (time-windowed), `research_compare` (one brief on several backends, claims diffed).
- **Evidence governance**: source classification, advisory quality floors, a frozen citation registry, synthesis markers, and a four-lens counter-review that reports four empty lenses as a failed review rather than a clean bill of health.
- **The free tiers.** A local loop the host drives with its own web search, `provider: "local"` for a coding CLI you already pay for, and `research_import` for a report you ran on a subscription.
- **Cross-backend corroboration counted in independent registrable domains**, never in how many backends agreed.

### Fixed

Four defects that a full hermetic suite passed and one real API call each found. Vendor documentation described none of them correctly:

- Perplexity returns `COMPLETED` in **upper case**, against its own documentation. A case-sensitive terminal check meant a finished run was never recognised as finished: it polled until the watchdog gave up and the paid-for report was never stored.
- Perplexity, OpenAI and xAI all return citations **out of band**, in a sibling array rather than in the report body, so fully cited reports were stored with zero sources.
- xAI accepts a `deferred` flag and **ignores it**. Its runs are synchronous, and the capability record claimed they were durable.
- **A call that spends money was being retried four times.** `src/net/retry.ts` opened by stating the rule that paid creation is never retried and naming the mechanism that enforced it, and that mechanism had never been written. A create that times out after the provider accepted it has already bought the report; retrying buys a second.

### Security

- Lock ownership, regex hardening, symlink resolution, prompt-injection and SSRF findings closed. The admission lock is written under a temp name and `link`ed into place: `open(path, 'wx')` is atomic but the holder record is a second syscall, and a contender reading the file in between broke a live lock, letting two processes into the spend gate. It failed roughly one run in three under contention.

## [0.2.1] - 2026-07-24

### Fixed

- Exported the library surface the README already documented.

## [0.2.0] - 2026-07-24

### Added

- Live progress streaming, an acceptance suite that drives the real MCP protocol over stdio, and a paid test project.

### Fixed

- Store schema guarded against a silent upgrade migration; spend gate hardened.
- Corrected the Vertex story: an ordinary API key is the **fuller** backend, not the lesser one, which surprises most people.

## [0.1.0] - 2026-07-23

### Added

- First release. Gemini Deep Research wrapped so an agent can drive it safely: durable runs that survive a disconnect, a spend gate that reserves the worst case before the call, and outline-first reading so a 60,000-token report never lands inline.

[Unreleased]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/fledgeling-co/dossier-research-mcp/releases/tag/v0.1.0
