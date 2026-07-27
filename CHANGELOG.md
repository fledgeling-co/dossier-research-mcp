# Changelog

Every release that changed what the server does, what it costs, or what it needs to run.

Dates are the release date. Costs are estimate bands, never quotes. Where a fact was learned from a live API call rather than from vendor documentation, it says so, because that distinction turned out to matter more than once.

This project follows [semantic versioning](https://semver.org/). Until 1.0 the minor number carries breaking changes.

## [Unreleased]

### Added

- **`research_start` without a `provider` now assembles a panel instead of picking one backend.** One brief goes to every backend that belongs on the question, in three lanes. Lane 1 is free: every coding CLI that is installed, signed in and capable of the shape you asked for. It is the floor, and it runs with no API keys configured at all. Lane 2 is paid, and an API backend joins only when a key exists *and* the question calls for what that backend is distinctively good at. Lane 3 is a crawl, and the panel can only ever recommend one: Mode B stays behind `DOSSIER_BROWSER_PROVIDER` and Dossier drives no browser.

  **Capability is screened before billing and before the profile.** A backend that cannot enforce a date window does not join a date-bound panel merely because it is free. This is the same rule that has governed single-provider routing since 0.5.1, applied to the panel by sharing the same screening pass rather than by reimplementing it.

  Membership is driven by a **question profile** read off the question on top of the existing archetype classifier: enumeration, time bound, social, primary literature, named sites, legal or regulatory, breadth. Signals are additive, so a question that is both time-bound and legal gets the backend each one implies. The profile is keyword and archetype work only, with no model call, because it runs inside `research_plan` and `research_plan` is free.

  Two judgements are deliberate and not derived from the signals. Gemini and Perplexity lean towards joining whenever a key exists, Gemini because it is the most comprehensive backend available and Perplexity because at roughly $0.29 a measured run it is cheap enough that omitting it rarely saves anything worth having. And xAI is never the only backend concluding on a legal or regulatory question, because its own documentation describes it as suited to finding things rather than to concluding them. Naming it explicitly in `DOSSIER_PROVIDERS` overrides that, because an instruction outranks a guard whose job is to second-guess an automatic choice.

  **A panel reserves the sum of its members' worst cases before any member starts, not member by member as it goes.** A panel that cannot be afforded in full starts nothing at all, writes no ledger line, and reports the whole figure it needed rather than the amount by which the next member missed. Half a panel is a worse answer than one good backend and it has already spent money to be worse. The same rule covers concurrency: a panel of five needs five slots at once and is refused whole.

  **A panel of one is a legitimate outcome** and is reported as a result rather than as a fallback.

  Each member is its own run, bound by a shared panel id, so `research_status`, `research_read`, `research_tail` and `research_budget` work per member with no change. A member that deduplicates onto an identical existing run is handed it and is not charged again while the rest still start; a member that refuses at create time is reported without stranding the members already billed. Every member is attempted once, through the same `attemptOnceThenSettle` path as a single run.

  **`research_plan` now prints the panel** member by member with a cost against each, free lane separately from paid, with a total and the question profile, before the contract fingerprint is issued. It names every configured backend it left out and why. The fingerprint binds the whole membership, so a plan for a three-backend panel will not start a two-backend one.

  **When every member reaches a terminal state the panel is merged automatically** with `research_synthesise`'s free deterministic pass, and the result is written to every member's journal. The overlap warning matters more here, not less: five backends that read the same ten pages is the corroboration trap at five times the price, and it now surfaces at the moment the panel finishes rather than when someone remembers to ask. Agreement between members is still not corroboration, and support is still counted in independent registrable domains.

  Naming a `provider` is unchanged in every respect and still starts exactly one run on exactly the path it always took, with no panel id.

## [0.7.0] - 2026-07-26

### Added

- **The free local loop now runs as a lead with workers, and the lead does not read search results.** `research_local_start` returns a dispatch plan rather than a flat task list: one worker per task, each doing its own searching and handing back at most ten one-sentence findings. The cap is in the schema, not in the prose, because a worker that returns everything it saw has moved the sifting to the lead, which is the job it was dispatched to do. The lead drafts from the registry plus the deep-read notes the workers send back, and never goes near a result page.

  This is the change that makes a long run finish. Raw listings are the bulk of what a search returns and almost none of it is evidence; a lead that reads them spends its context on snippets and has none left for the report, which is how a run with good sources still produces a shallow synthesis.

  **Tasks now come back in dependency groups.** Group A is independent and source-diverse and goes out in parallel, at most three at a time. Group B is a single reconciliation task that reads what group A found and searches the disagreements rather than the subject. `research_local_note` refuses a group B report while its dependencies are outstanding, and hands the registry over the moment the last group A task lands. Reconciliation is skipped below three group A tasks and in `light` mode, because there is nothing to reconcile across two sources.

  **`research_local_note` now takes `gaps` and `deepReadNotes`, and an empty `findings` array is legitimate when `gaps` says what was searched and not found.** A task that establishes there is nothing there has produced a real result about the public record, and it used to be indistinguishable from a task that crashed. Draft time now keeps three outcomes apart that used to look alike: a task that never reported (a coverage gap), a task that ran and found nothing (an established negative), and a source refused after the freeze.

  **`have` declares what your client can actually do**, and the loop degrades out loud. No web search halts the run before a session is opened, because a loop that continued would write a fluent report from the model's own memory with citations attached. No page fetch forces every task to scan depth, including the reconciliation task, which asks for a deep read by default and would otherwise keep telling a worker to open pages on a host with no way to open one. No subagents means sequential; no filesystem means report as you go. Each degradation prints what it costs. Capabilities are declared rather than probed because a stdio server cannot see its client's tools, and a guess would be wrong in the direction that matters.

  **`asOf` and `mode`.** Every session carries an as-of date, and at freeze time anything stale, undated or dated after the horizon is listed with a rule to downgrade what rests on it. Recency is judged by source type: a standard from 2019 is current, a benchmark from 2019 is not. `mode: 'light'` lowers the evidence floors to 6 sources across 3 domains for a narrow single-entity question, because holding a small question to the large floors fails it for being proportionate and teaches people to ignore the gates.

  **When every task ran and the registry is still empty, `research_local_draft` returns the failed checks, `Confidence: N/A` and a recommendation to contact the subject directly**, instead of drafting rules. Handing back drafting rules there is an invitation to write a report about a subject on which nothing was found.

  The structure is adapted from [daymade's deep-research skill](https://github.com/daymade/claude-code-skills). Dossier keeps its own counter-review rule rather than the skill's: coverage is required and an issue quota is not, because demanding a minimum number of objections rewards inventing them. Enterprise mode is deliberately not implemented.

- **`research_local_note` now records what actually happened when a task searched, and a failed search no longer counts as an established negative.** The new `outcome` says whether the search completed: `ok`, `no-results` for a clean search of a healthy index that turned up nothing, and `rate-limited`, `blocked` or `tool-failed` for a search that never finished.

  The boolean this replaces was wrong, and had shipped. Any empty report was recorded as having found nothing, so a worker whose search tool was throttled looked identical to one that queried the index properly and established the absence. When every task came back empty, the run rendered the black box: "unable to verify anything about this subject from public sources", `Confidence: N/A`, contact them directly. That is an assertion about the world, and it was being made on the strength of four searches that never ran. It is the exact failure the black box was built to prevent, arriving through the back door.

  Draft time now keeps four outcomes apart rather than three, and the black box requires that every task completed cleanly. A run with a failed search gets a warning naming the task, its source class, and why its absence proves nothing, with an instruction not to write it up as a negative and to rerun it if the answer turns on it. `no-results` alongside a non-empty finding list is refused at the boundary, because whichever was meant the other is wrong and only the worker knows which. A findings-then-throttled task keeps its findings and is still counted as incomplete coverage.

  Adapted from `last30days-skill`'s per-source status vocabulary and its rule that a failure state is never evidence a source had nothing. Ten states collapse to five because Dossier's reporter is a model driving a search tool rather than an HTTP client, and a state nobody can report accurately is a state that gets guessed. `docs/plan/external-skill-gap-analysis.md` records what else was read across two external research skills, what turned out to be already present under another name, and what was declined.

- **`research_doctor` now reports the browser tooling on your machine**, and the setup wizard stops offering you an install for a driver you already have. Playwright, browser-use, `chrome-devtools-mcp` and `@playwright/mcp`, in the same section as the coding CLIs and under the same rule: an unidentified binary is reported `ambiguous` and nothing is run.

  **Detection is not permission**, and every reported entry says so. Mode B automation stays behind `DOSSIER_BROWSER_PROVIDER`, Dossier still has no browser of its own, and it still will never type a password. Finding a driver changes nothing about what runs.

  The four tools get two different probes because they are two different kinds of thing, and two of the rules make the weaker-looking probe the correct one.

  **`npx` is never invoked.** `npx chrome-devtools-mcp@latest --version` on a machine without the package downloads it from the registry and executes it, so a detector that asked would answer its own question by making it true. Presence is established by looking for the package directory and never opening it. A test puts a marker-writing fake `npx` and `npm` on `PATH` during a full probe and fails if either is ever called.

  **Your client's MCP config is never read.** Whether a server is registered with Claude Code, Cursor or VS Code lives in that client's own config file, next to every other server's `env` block, and those blocks routinely hold API keys. Registration is therefore reported `unknown`, permanently, and you are pointed at your client to check.

  Nothing reports whether you are signed in. A coding CLI has a session file whose existence can be checked without opening it; a browser driver has no equivalent, because the session belongs to Chrome and finding it would mean walking a browser profile and its cookie store.

### Changed

- **A coding CLI you have already paid for is now preferred over a metered API balance.** If a supported CLI is installed, signed in, and capable of the job, it runs it. A paid backend runs only when the CLI cannot do the work or is not there.

  This reverses the previous rule, at the project owner's direction. Until now the CLI backend was excluded from automatic selection entirely: it costs $0, so any cost tie-break picks it every time, and it draws on a subscription quota Dossier can neither see nor meter while running a third-party binary on your machine. **Every one of those facts still holds.** What changed is the judgement about which default serves the person paying. Billing an API when a capable CLI is sitting there signed in spends real money to avoid spending an allowance already bought.

  Three things keep it honest.

  **Capability still decides first, and this did not touch it.** A CLI cannot enforce a date window, reach X, filter domains or offer an editable plan, so those jobs still route to the backend that can. Preference only ever chooses between backends that can all do the work.

  **Sign-in is required, and it is established by the existence of a session file, never by opening one.** A CLI on `PATH` that nobody has signed into is now rejected outright with `installed but not signed in, so it cannot run`, rather than quietly winning on price and then failing at spawn.

  **The routing reason says what is being spent.** It states that a subscription quota is going rather than an API balance, and that Dossier cannot meter that quota. The word "free" is never used, and a test enforces its absence.

  `DOSSIER_PROVIDERS` still overrides in both directions: name the CLI to force it, or leave it out of a non-empty list to remove it from the registry entirely. `DOSSIER_LOCAL_CLI` still picks which CLI when several are on `PATH`. Identity is still confirmed at spawn by resolving the binary and checking its version string, not at routing time.

### Fixed

- **`research_plan` reported the routed backend even when you asked for a specific one.** `research_start` honoured `provider` correctly and the contract fingerprint included it, but the plan's own **Backend** line came from a second routing call that ignored the argument. So asking for Gemini and being shown xAI made the override look broken, in the one tool whose entire job is to tell you what the run will do before it spends. Reported by a user against 0.6.0.


## [0.6.0] - 2026-07-26

### Added

- **A guided setup, in one command:** `npx -y dossier-research-mcp@latest setup`.

  It reads what is already on the machine, offers the coding CLIs by the subscription that pays for them (Claude Pro, ChatGPT Plus, SuperGrok or X Premium+, Cursor, and Google's free Antigravity tier), installs and signs into the ones you pick, and only then asks about API keys. The default is one paid backend rather than four, and doing nothing at all is offered before either.

  Each provider comes with what it costs per run, what only it can do, and the parts of its console that are not just copying a key: Gemini's $10 minimum prepay and soft spend cap, OpenAI's per-project model allow-list, and the fact that a Perplexity, ChatGPT or SuperGrok subscription does **not** include API access.

  Nothing is installed, signed into, or charged without an explicit yes, and every command is printed before it runs. Sign-in is always handed to the human: the wizard never types a password.


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

[Unreleased]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/fledgeling-co/dossier-research-mcp/releases/tag/v0.1.0
