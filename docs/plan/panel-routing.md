# Panel routing

**Status:** design, 27 July 2026. Not built. Supersedes the single-backend selection in `src/providers/registry.ts`.

---

## The problem

`route()` returns one provider. Every run therefore reads whatever that one backend happened to find, and the coverage of a Dossier run is capped by the coverage of a single search index.

That is the wrong shape for the product. Dossier's whole argument is that support should be counted in independent domains rather than in how many tools agreed, and it already has the machinery to merge several runs and count exactly that. Yet the default path uses one.

It is also the wrong shape for the billing. Three coding CLIs may be installed and signed in, each costing nothing per run because a subscription already paid for them. Using one and ignoring two is leaving free coverage on the table.

## The change

**Routing assembles a panel, not a pick.** `route()` becomes `assemblePanel()`, returning an ordered set of backends with a reason each, a total cost band, and the lanes they came from.

### Lane 1: free, and always on

Every CLI that is installed, signed in, and capable of the requested shape joins the panel. Claude Code, Codex, Grok CLI, Antigravity. There is no cost argument against including all of them, because the marginal cost of the second one is zero, and they read different indexes because they are different models driving different searches.

This lane is the floor. A run with no API keys at all still fans out across every CLI on the machine.

### Lane 2: paid, on profile

An API backend joins when a key exists **and** the question profile calls for what only that backend does.

| Backend | Joins when | Why it is not always on |
|---|---|---|
| **Gemini** | The question is broad, multi-part, or high stakes. Default yes for anything deep. | $1-7 a run, the dearest of the four. |
| **Perplexity** | A date window, a domain allow-list, or an enumeration ("every", "all", "list the N"). Default yes when cheap and plausible. | Returns prose where a table was asked for. |
| **xAI** | The question turns on what people are publicly saying, or names X. | Fast and broad rather than careful; wrong instrument for reading legislation. |
| **OpenAI** | Primary literature, or a domain filter above twenty sites. | Dearest per correct answer on the one benchmark we have. |

Gemini and Perplexity lean **towards** inclusion when a key exists, per the owner's judgement: Gemini because it is the most comprehensive backend available, Perplexity because at roughly $0.29 a measured run it is cheap enough that leaving it out rarely saves anything worth having.

### Lane 3: crawl, on need

Browser tooling joins when the question needs specific pages: a named site, a document behind a login, or a source no search index has reached. Detection already exists in `src/local/browser.ts`. Mode B stays opt-in behind `DOSSIER_BROWSER_PROVIDER`; the panel may *ask* for a crawl lane and must not enable one.

## The question profile

Panel composition is driven by signals read from the question, on top of the existing archetype classifier in `src/research/archetypes.ts`. Signals to extract:

- **Enumeration**: "every", "all", "list", "which companies", a count. → Perplexity wide.
- **Time bound**: "since", "last N months", a year, "current", "latest". → Perplexity or xAI, which enforce rather than ask.
- **Social**: "what are people saying", "reaction", "sentiment", "on X". → xAI, and nothing else can.
- **Primary literature**: "studies", "papers", "trials", "evidence for". → OpenAI.
- **Named sites**: any domain in the question. → OpenAI above twenty, Perplexity below.
- **Legal or regulatory**: statute names, "liability", "compliance", jurisdictions. → Gemini for comprehensiveness, and *never* xAI alone, whose own docs describe it as suited to finding things rather than concluding them.
- **Breadth**: length, sub-questions, "comprehensive", "landscape". → Gemini, and a wider panel generally.

Signals are additive. A question can be time-bound *and* legal, and gets both backends.

## Cost, which is the load-bearing risk

A panel multiplies spend. The rules that keep this honest:

1. **The panel reserves the sum of its worst cases before any member starts.** Not per member as it goes. A panel that cannot be afforded in full does not start at all, because half a panel is a worse answer than one good backend and it has already spent money to be worse.
2. **`research_plan` prints the panel, member by member, with a cost each and a total**, before the fingerprint is issued. The existing contract handshake then gates it.
3. **The free lane is always shown separately from the paid lane**, so the reader can see what the money is buying over and above what the subscriptions already cover.
4. **A panel of one is a legitimate outcome** and must not be dressed up. If only Gemini qualifies, say so and run it.

## Merging

Panel results feed `research_synthesise`, which already deduplicates by canonical URL, counts independent registrable domains, and warns when overlap is high.

That warning becomes more important, not less. A five-member panel that read the same ten pages is the corroboration trap at five times the price, and the merge already detects and reports exactly that. It should be run automatically at the end of a panel run rather than left for the caller to remember.

## What must not change

- **Capability is still filtered before anything else.** A backend that cannot enforce a date window does not join a date-bound panel merely because it is free.
- **Agreement is still not corroboration.** Five backends citing one press release is one source. Counting stays in independent domains.
- **A call that spends money is still attempted once.** A panel of five is five single attempts, never five retried ones.
- **`DOSSIER_PROVIDERS` still overrides in both directions**, and naming a single provider still produces a panel of one.

## Decided: paid backends join automatically

Settled by the owner on 27 July 2026. A paid backend joins the panel when its key exists and the question profile matches, without waiting to be asked.

The safety is the plan step, not a gate on inclusion. `research_plan` prints the whole panel with a cost per member and a total before it issues a fingerprint, and `DOSSIER_REQUIRE_CONTRACT` makes that approval mandatory for anything that spends. The reader sees the bill before the bill exists.

The alternative considered was an explicit `panel: "wide"` argument. Rejected because almost no caller would ever pass it, which in practice means the most comprehensive backend on the machine sits unused while a subscription-only panel does worse work. A default nobody triggers is not a safe default; it is an absent feature with a safety story attached.

The risk this accepts, stated plainly: a caller that skips the plan step spends more than it meant to. Two things bound it. The daily ceiling still refuses early, on the sum of the panel's worst cases rather than on any single member. And the panel is reserved in full before any member starts, so an unaffordable panel does not begin at all rather than half-running and billing for a worse answer.
