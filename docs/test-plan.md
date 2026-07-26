# Acceptance test plan

The unit suite covers pure logic. This one covers **the contract a caller actually sees**: the real MCP protocol over stdio, driven against a seeded store.

Method borrowed from two places. The **AC-traceability matrix** comes first and drives coverage, so tests follow the requirements rather than whatever is easy to assert. The **coverage model** (enumerate the axes, sample deliberately, seed every data shape, promote every sweep to a gate) is the QA plan's, adapted from surfaces-and-viewports to tools-and-states.

## Why a separate suite

`tests/*.test.ts` calls the server's functions directly. That is fast and it covers the logic, but it skips the layer where a whole class of defects lives:

- a Zod schema FastMCP rejects at registration, so the tool never appears in `tools/list`
- a response that violates its own declared `outputSchema`
- a resource template whose URI never matches
- a stray `console.log` corrupting the stdio stream

Every one of those passes `tsgo` and every unit test, and every one is a total failure for a caller. Only driving the protocol finds them.

## Coverage model: the axes

The QA plan's unit of work is a *surface × state* cell. For an MCP server the axes are:

| Axis | Values | Sampling |
|---|---|---|
| **Surface** | 36 tools · 6 resources · 4 prompts | 100%, enumerated from `tools/list` so a new tool cannot be missed |
| **Run state** | `planning` · `running` · `completed` · `failed` · `cancelled` · `stalled` · absent | every state that changes a tool's answer |
| **Data shape** | realistic · headingless · unicode/emoji/RTL · huge · empty · malformed · adversarial | seeded via `Store`, per the plan's data-seeding section |
| **Credentials** | none (hermetic) · api-key · vertex | hermetic here; the paid paths are verified by hand and logged in the README |
| **Transport** | stdio · http+token · http without token | stdio here; HTTP auth verified live (401/401/401/200) |
| **Argument validity** | valid · missing required · wrong type · out of range · hostile | every tool takes at least one hostile input |

Seeding goes through `Store`, not the API. Driving a run into `completed` or `stalled` through Gemini would cost dollars and take an hour; seeding the state directly is what makes the state matrix testable at all.

## AC-traceability matrix

Acceptance criteria are taken from the README's tool contracts and the tool descriptions in `src/server.ts`, which are the agent's only documentation and therefore the spec.

✓ covered · ◑ partial · ✗ gap

| AC | Criterion (from the contract) | Test | Status |
|---|---|---|---|
| **PROTO-01** | Every tool registers and appears in `tools/list` | `protocol` | ✓ |
| **PROTO-02** | Money-spending tools are annotated `readOnlyHint: false`; read-only ones `true` | `protocol` | ✓ |
| **PROTO-03** | Every tool description names its cost when it has one | `protocol` | ✓ |
| **PROTO-04** | All 6 resources and 4 prompts register and are readable | `protocol` | ✓ |
| **PROTO-05** | stdout carries only JSON-RPC; diagnostics go to stderr | `protocol` | ✓ |
| **PROTO-06** | The server starts and serves read-only tools with no credentials | `protocol` | ✓ |
| **PLAN-01** | `research_plan` spends nothing and needs no credentials | `plan` | ✓ |
| **PLAN-02** | It returns a cost band, a duration band and a contract fingerprint | `plan` | ✓ |
| **PLAN-03** | The fingerprint is stable for the same arguments, different for a different tier | `plan` | ✓ |
| **PLAN-04** | It auto-selects an archetype, and honours an explicit one | `plan` | ✓ |
| **PLAN-05** | An already-engineered brief is detected and passed through verbatim | `plan` | ✓ |
| **PLAN-06** | Corpus grounding lands inside the scaffold, never after the re-anchor | `plan` | ✓ |
| **PLAN-07** | Operator notes are returned with the plan | `plan` | ✓ |
| **START-01** | Starting without credentials fails cleanly, not with a crash | `state-matrix` | ✓ |
| **START-02** | A contract-fingerprint mismatch is refused with the expected value | `plan` | ✓ |
| **READ-01** | Default mode is `outline`; a full report is never returned inline | `read` | ✓ |
| **READ-02** | The outline reports per-section token estimates | `read` | ✓ |
| **READ-03** | `section` resolves by 1-based index and by heading substring | `read` | ✓ |
| **READ-04** | A missing section names the miss and shows the outline | `read` | ✓ |
| **READ-05** | `grep` is literal by default and opt-in regex | `read` | ✓ |
| **READ-06** | `maxTokens` is a hard cap and truncation is marked explicitly | `read` | ✓ |
| **READ-07** | Reading a run with no report explains the state instead of erroring opaquely | `state-matrix` | ✓ |
| **READ-08** | Every read mode survives headingless, unicode, huge and empty reports | `read` | ✓ |
| **STATE-01** | `research_status` reports liveness separately from state (`stalled` is distinguishable) | `state-matrix` | ✓ |
| **STATE-02** | Status for an unknown run says so and points at `research_list` | `state-matrix` | ✓ |
| **STATE-03** | A planning run tells the caller to approve the plan | `state-matrix` | ✓ |
| **STATE-04** | Approving a run with no plan yet is refused | `state-matrix` | ✓ |
| **STATE-05** | Cancelling a terminal run is a no-op, not an error | `state-matrix` | ✓ |
| **STATE-06** | Follow-up on a non-completed run is refused with the state named | `state-matrix` | ✓ |
| **TAIL-01** | `research_tail` replays from a cursor and returns the next cursor | `state-matrix` | ✓ |
| **TAIL-02** | An empty tail says so rather than returning nothing | `state-matrix` | ✓ |
| **BUDGET-01** | `research_budget` reports committed, remaining and the window | `budget` | ✓ |
| **BUDGET-02** | Cost figures are labelled estimates, never quotes | `budget` | ✓ |
| **BUDGET-03** | A disabled gate (`DOSSIER_BUDGET_USD=0`) is called out as disabled | `budget` | ✓ |
| **LIST-01** | `research_list` filters by state and by tag | `state-matrix` | ✓ |
| **CITE-01** | Citation verdicts distinguish live / not_found / blocked / invalid | unit: `safety` | ✓ |
| **CITE-02** | A self-redirect loop is `blocked`, not `invalid_url` | unit: `safety` | ✓ |
| **SEC-01** | A corpus store name with path traversal is rejected | `adversarial` | ✓ |
| **SEC-02** | Private and link-local addresses are blocked before any request | unit: `safety` | ✓ |
| **SEC-03** | Tool arguments are length-capped; oversized input is refused | `adversarial` | ✓ |
| **SEC-04** | A prompt-injection payload in a question is data, never instruction | `adversarial` | ✓ |
| **SEC-05** | No response leaks a credential or a store path outside the store dir | `adversarial` | ✓ |
| **HTTP-01** | Health is open; `/mcp` rejects absent, wrong, same-length-wrong and scheme-less tokens | `http-transport` | ✓ |
| **HTTP-02** | A malformed body is a 4xx, and the server survives it | `http-transport` | ✓ |
| **VERTEX-01** | The server names every Vertex limitation, at start-up and in capabilities | `known-limits` | ✓ |
| **VERTEX-02** | A live Vertex run works | `known-limits` | ◑ written, skipped without a project |
| **STREAM-03** | The tail description does not promise a live feed the API does not give | `known-limits` | ✓ |
| **PAID-01** | A real run completes with structure, confidence qualifiers and resolvable citations | `paid` | ✓ |
| **PAID-02** | Collaborative planning returns a reviewable plan, not the echoed prompt | `paid` | ✓ |
| **PAID-03** | Corpus grounding produces the contradictions section | `paid` | ✓ |
| **PAID-04** | A document attachment is actually read | `paid` | ✓ |
| **PAID-05** | The max tier runs and commits the higher band | `paid` | ◑ opt-in via `DOSSIER_PAID_MAX` |
| **DEGRADE-01** | Corpus tools explain the Vertex limitation rather than failing opaquely | `state-matrix` | ✓ |
| **DEGRADE-02** | `research://capabilities` reports `degraded` and the backend limitations | `protocol` | ✓ |
| **RES-01** | `research://run/{id}` returns the record and omits the bulky prompt | `protocol` | ✓ |
| **RES-02** | A resource for an unknown run returns an explanation, not a crash | `protocol` | ✓ |
| **STREAM-01** | Live counters surface in status when present | `state-matrix` | ✓ |
| **STREAM-02** | An abandoned stream is disclosed rather than looking stuck | `state-matrix` | ✓ |
| **CONC-01** | One budget ceiling holds across **separate OS processes** sharing a store | `concurrency` | ✓ |
| **CONC-02** | The store lock grants to one holder, breaks stale/dead locks, releases on throw | `concurrency` | ✓ |
| **CONC-03** | Concurrent plan approvals start exactly one paid continuation | `concurrency` | ◑ one process, two callers; the cross-process case is not covered |
| **CONC-04** | A cancelled run cannot be approved back into a paid run | `concurrency` | ✓ |
| **CONC-05** | A cancellation the provider refused is reported as unconfirmed, not as success | `concurrency` | ✓ |
| **CONC-06** | A paid call returning no interaction id fails loudly rather than polling forever | `concurrency` | ✓ |
| **CONC-07** | Journal sequences never duplicate under concurrent appends | `concurrency` | ✓ |
| **FAILC-01** | A corrupt ledger line is charged, not ignored | `concurrency` | ✓ |
| **FAILC-02** | An unreadable ledger throws rather than reading as zero spend | `concurrency` | ✓ |
| **FAILC-03** | Unparseable run records count as occupied concurrency slots | `concurrency` | ✓ |
| **FAILC-04** | Unrecognised env booleans fail startup instead of defaulting to false | unit: `safety` | ✓ |
| **PRIV-01** | Reports, prompts and the ledger are 0600; directories 0700 | `concurrency` | ✓ |
| **SEC-06** | IPv6 forms the URL parser canonicalises (`::ffff:7f00:1`, NAT64, 6to4) are blocked | unit: `safety` | ✓ |
| **SEC-07** | The whole `fe80::/10` range is link-local, not just the `fe80` prefix | unit: `safety` | ✓ |
| **SEC-08** | A caller regex that can backtrack exponentially is rejected before it blocks the loop | unit: `safety` | ✓ |
| **SEC-09** | Non-http citation schemes render inert rather than as clickable links | unit: `safety` | ✓ |
| **EST-01** | Duration and cost widen with corpora, MCP servers and attachments | unit: `safety` | ✓ |
| **EST-02** | Default runs keep the documented $1-3 / $3-7 bands | unit: `safety` | ✓ |
| **EST-03** | Duration never promises longer than the API's 60-minute task cap | unit: `safety` | ✓ |
| **SHAPE-01** | `research_wide` validates a finished matrix against the spec it was asked for | `shapes` | ✓ |
| **SHAPE-02** | A column absent from the returned table is a gap, not a declared uncertainty | unit: `shapes` | ✓ |
| **SHAPE-03** | A report with no table reports every row missing rather than passing | unit: `shapes` | ✓ |
| **SHAPE-04** | A wide brief ends on the re-anchor, with nothing after it | unit: `shapes` | ✓ |
| **SHAPE-05** | `research_wide` refuses a spec and a runId together, and refuses a partial spec | `shapes` | ✓ |
| **SHAPE-06** | `research_wide { runId }` on a non-wide run says so instead of guessing | `shapes` | ✓ |
| **WIN-01** | A window a backend cannot enforce is reported as requested, never as enforced | unit: `providers` | ✓ |
| **WIN-02** | A recency bucket that merely contains the window is not called enforcement | unit: `providers` | ✓ |
| **WIN-03** | Prose constraints land before the closing directive, never after it | unit: `providers` | ✓ |
| **WIN-04** | Domains past a backend's cap are trimmed, disclosed, and kept in the prompt | unit: `providers` | ✓ |
| **CMP-01** | `research_compare` refuses both entry conditions at once, and neither | `shapes` | ✓ |
| **CMP-02** | Comparison needs two configured backends and says so when it has one | `shapes` | ✓ |
| **CMP-03** | Agreement across backends citing one domain is scored single-source | unit: `shapes` | ✓ |
| **CMP-04** | A claim only one backend made is reported as a coverage gap, not an error | unit: `shapes` | ✓ |
| **EVID-01** | `research_evidence` profiles sources with no fetch, no model call and no credentials | `evidence` | ✓ |
| **EVID-02** | One organisation cited through three of its own pages counts as one domain | `evidence` | ✓ |
| **EVID-03** | The citation registry is numbered from one and deduplicated by canonical URL | `evidence` | ✓ |
| **EVID-04** | The search trace records the backend and declines to promise reproducibility | `evidence` | ✓ |
| **EVID-05** | With no key, both checking tools hand the work to the caller rather than refusing | `evidence` | ✓ |
| **EVID-12** | A verdict on a claim that was never fetched is discarded | `evidence` | ✓ |
| **EVID-13** | Four caller-supplied empty lenses are reported as a failed review | `evidence` | ✓ |
| **EVID-14** | A lens that was never applied is named, not counted as one that found nothing | `evidence` | ✓ |
| **SETUP-01** | The registration is an argument list, so a key containing shell syntax cannot execute | `setup` | ✓ |
| **SETUP-02** | A printed command never contains a key | `setup` | ✓ |
| **SETUP-03** | Subscription coverage is only claimed where confirmed, and confirmations carry a date | `setup` | ✓ |
| **SETUP-04** | Every provider warns that its consumer subscription is not API credit | `setup` | ✓ |
| **SETUP-05** | `setup` refuses a non-interactive stdout rather than drawing into an MCP stream | manual | ✓ |
| **EVID-15** | Merging deduplicates one page reached three different ways into one source | `synthesise` | ✓ |
| **EVID-16** | Support is counted in independent domains, never in how many runs agreed | `synthesise` | ✓ |
| **EVID-17** | A fan-out that mostly re-read the same pages is reported as such, with a warning | `synthesise` | ✓ |
| **EVID-18** | Several runs from the same backend stay distinguishable rather than collapsing | `synthesise` | ✓ |
| **ROUTE-05** | An ordinary deep run goes to the cheapest capable backend, not to Gemini | `providers` | ✓ |
| **ROUTE-06** | Capability still forces the backend where only one qualifies | `providers` | ✓ |
| **ROUTE-07** | Every rejected backend is named with the reason it could not run | `providers` | ✓ |
| **EVID-06** | A failed quality floor is reported as advisory; nothing is ever withheld | unit: `evidence` | ✓ |
| **EVID-07** | An unrecognised domain is classified `other`, never guessed into `official` | unit: `evidence` | ✓ |
| **EVID-08** | A user's own document is never independent corroboration of an external fact | unit: `evidence` | ✓ |
| **EVID-09** | Every follow-up answer is marked synthesised, on both the live and stored paths | unit: `tools` | ✓ |
| **EVID-10** | A follow-up answers from the frozen citation registry, not the report's prose alone | unit: `tools` | ✓ |
| **LOCAL-01** | The local corpus is off until an operator grants directories via the environment | unit: `local-corpus` | ✓ |
| **LOCAL-02** | A symlink out of a granted directory is not followed | unit: `local-corpus` | ✓ |
| **LOCAL-03** | Dotfiles, credential directories and dependency trees are skipped unread, including through an in-root alias | unit: `local-corpus` | ✓ |
| **LOCAL-04** | The query is a literal, never a caller-supplied regular expression | unit: `local-corpus` | ✓ |
| **LOCAL-05** | A missing granted directory is reported, not thrown | unit: `local-corpus` | ✓ |
| **CLI-01** | A binary of the right name reporting the wrong product is refused, not run | unit: `local-cli`, `local-provider` | ✓ |
| **CLI-09** | Identity is re-confirmed at spawn time, not only in the doctor | unit: `local-provider` | ✓ |
| **CLI-10** | Path provenance is matched against the directory, never the binary's own name | unit: `local-cli` | ✓ |
| **CLI-02** | A tool that names nothing in its version is identified by install path, or reported ambiguous | unit: `local-cli` | ✓ |
| **CLI-03** | `ready` needs identity AND a sign-in file; presence alone is not enough | unit: `local-cli` | ✓ |
| **CLI-04** | Every shipped subscription claim is dated, sourced, or marked unconfirmed | unit: `local-cli` | ✓ |
| **CLI-05** | The brief reaches the CLI as an argv element, never through a shell | unit: `local-cli`, `local-provider` | ✓ |
| **CLI-06** | A local run's outcome is readable by a different process than started it | unit: `local-provider` | ✓ |
| **CLI-07** | A non-zero exit is a failure that keeps the partial output | unit: `local-provider` | ✓ |
| **CLI-08** | An installed, signed-in CLI is preferred over a paid API backend for a job it can do | unit: `providers` | ✓ |
| **CLI-12** | A CLI on PATH with no sign-in file is not preferred; the paid backend runs instead | unit: `providers` | ✓ |
| **CLI-13** | Capability outranks the CLI preference: a date window, X or a plan still routes to the API | unit: `providers` | ✓ |
| **CLI-14** | The routing reason says a subscription quota is being spent, not an API balance | unit: `providers` | ✓ |
| **CLI-15** | `DOSSIER_PROVIDERS` overrides in both directions: it can exclude the CLI or make it the only backend | unit: `providers` | ✓ |
| **BROWSER-01** | A browser binary is identified by version string or install-path provenance, and reported ambiguous when it is neither | unit: `browser-detect` | ✓ |
| **BROWSER-02** | An MCP server package is probed by presence on disk only; `npx` is never invoked, because that would fetch and execute it | unit: `browser-detect` | ✓ |
| **BROWSER-03** | Whether an MCP server is registered with a client is always reported unknown; no client config is read | unit: `browser-detect` | ✓ |
| **BROWSER-04** | Detection never implies permission: every reported tool restates that driving needs `DOSSIER_BROWSER_PROVIDER` | unit: `browser-detect` | ✓ |
| **BROWSER-05** | No probe reads a browser profile, cookie store or session file | unit: `browser-detect` | ✓ |
| **BROWSER-06** | Every probe states which kind it is, so a package is never described as an executable | unit: `browser-detect` | ✓ |
| **IMPORT-01** | An imported report becomes a normal run: reads, greps and profiles identically | `evidence` | ✓ |
| **IMPORT-02** | Import refuses a url and markdown together, and neither | `evidence` | ✓ |
| **IMPORT-03** | An import charges nothing against the budget, with or without a utility model | `evidence` | ✓ |
| **IMPORT-04** | An imported report that cites nothing is flagged as unverifiable | `evidence` | ✓ |
| **WEB-01** | The subscription prompt hands over a real brief and the import command | `protocol` | ✓ |
| **WEB-02** | Its automated mode states the robots.txt position and the account exposure | `protocol` | ✓ |
| **LOOP-01** | The loop plans one task per source class, each in that index's query dialect | `loop`, unit: `local-loop` | ✓ |
| **LOOP-02** | One page reported by two tasks is one registry entry, not two corroborations | `loop`, unit: `local-loop` | ✓ |
| **LOOP-03** | A finding for an unknown task id is refused with the real task list | `loop` | ✓ |
| **LOOP-04** | Submitting before the freeze is refused: an unfrozen registry cannot check a draft | `loop` | ✓ |
| **LOOP-05** | Freezing closes the registry; a later finding is refused and recorded, never merged | `loop`, unit: `local-loop` | ✓ |
| **LOOP-06** | A draft citing anything outside the frozen registry is REFUSED | `loop`, unit: `local-loop` | ✓ |
| **LOOP-07** | A silent task is named as a coverage gap rather than averaged away | unit: `local-loop` | ✓ |
| **LOOP-08** | An accepted draft becomes a normal run: reads, greps and profiles identically | `loop` | ✓ |
| **SPEND-01** | A paid create is attempted exactly once; a timeout or 5xx never retries it | unit: `providers` | ✓ |
| **SPEND-02** | An unknown create outcome is reported as ambiguous spend, not as a plain failure | unit: `providers` | ✓ |
| **SPEND-03** | Reads still retry, because they are free and worth recovering | unit: `providers` | ✓ |
| **SPEND-04** | The purchase fingerprint covers provider, shape, window, matrix spec and attachments | unit: `safety` | ✓ |
| **SPEND-05** | A per-provider sub-ceiling stops one backend consuming the global budget | `concurrency` | ✓ |
| **SPEND-06** | Utility spend is recorded even when the ceiling is disabled | `concurrency` | ✓ |
| **SEC-11** | The admission lock is released only by its owner, and a live holder is never broken on age | `concurrency` | ✓ |
| **SEC-12** | A citation label cannot open a second markdown link | unit: `safety` | ✓ |
| **SEC-13** | Decoded provider options are Zod-bounded, so prompt text cannot inject wire options | unit: `providers` | ✓ |
| **SEC-14** | A bearer token shorter than 24 characters fails startup | unit: `safety` | ✓ |
| **FAILC-05** | An unreadable run directory aborts admission rather than reading as zero runs | `concurrency` | ✓ |
| **PROV-01** | A terminal status is recognised whatever its case, on every adapter | unit: `providers` | ✓ |
| **PROV-02** | Perplexity's out-of-band citations reach the report text | unit: `providers` | ✓ |
| **PROV-03** | A Perplexity handle carries its endpoint, so a restart still polls the right one | unit: `providers` | ✓ |
| **PROV-04** | Enforcement is claimed only where the request actually carries the filter | unit: `providers` | ✓ |
| **CLI-11** | The supervisor bounds runtime and output, and confirms death before recording a cancel | unit: `local-provider` | ✓ |
| **LOOP-09** | A CommonMark autolink to an ungathered source is refused | unit: `local-loop` | ✓ |
| **EVID-11** | A model saying "unknown" is not counted as an independent domain | unit: `evidence` | ✓ |
| **SHAPE-07** | An uncited wide cell is reported, not treated as a missing cell | unit: `shapes` | ✓ |
| **LOOP-10** | Group A tasks are independent; a group B task depends on all of them | unit: `local-loop` | ✓ |
| **LOOP-11** | Dispatch waves run at most three at once, and group B lands in its own wave | unit: `local-loop` | ✓ |
| **LOOP-12** | Reconciliation is suppressed below three group A tasks and in light mode | unit: `local-loop` | ✓ |
| **LOOP-13** | A group B task reporting before its dependencies is refused | `loop` | ✓ |
| **LOOP-14** | No web search halts the loop before a session is opened | unit: `local-loop`, `loop` | ✓ |
| **LOOP-15** | No page fetch forces every task to scan depth and says what that costs | unit: `local-loop`, `loop` | ✓ |
| **LOOP-16** | Missing subagents or filesystem degrade loudly, never silently | unit: `local-loop` | ✓ |
| **LOOP-17** | A source past its type's horizon is flagged stale; undated is flagged separately | unit: `local-loop` | ✓ |
| **LOOP-18** | Staleness horizons differ by source type: a two-year-old paper is fresh, a two-year-old news page is not | unit: `local-loop` | ✓ |
| **LOOP-19** | A source dated after the as-of horizon is flagged rather than treated as fresh | unit: `local-loop` | ✓ |
| **LOOP-20** | Every task ran and every one found nothing: confidence N/A, failed checks enumerated, direct contact recommended | unit: `local-loop`, `loop` | ✓ |
| **LOOP-21** | A run with a silent task is never reported as a black box | unit: `local-loop` | ✓ |
| **LOOP-22** | A task that searched and found nothing is reported separately from one that never ran | unit: `local-loop` | ✓ |
| **LOOP-23** | Sources refused after the freeze are shown at draft time and stated to be final | unit: `local-loop` | ✓ |
| **LOOP-24** | An empty finding list is accepted only with a gaps statement | `loop` | ✓ |
| **LOOP-25** | A worker may report at most ten findings | `loop` | ✓ |
| **LOOP-26** | Deep-read notes reach the lead at draft time, so it never reads a search result | unit: `local-loop`, `loop` | ✓ |
| **LOOP-27** | Light mode lowers the advisory floors rather than failing a proportionate run | unit: `local-loop` | ✓ |
| **LOOP-28** | A session persisted before groups, modes and staleness reads back with defaults | unit: `local-loop` | ✓ |
| **LOOP-29** | A task reporting empty with a failed-search outcome is not counted as having found nothing | unit: `local-loop` | ✓ |
| **LOOP-30** | An empty registry where a task's search failed is not a black box | unit: `local-loop` | ✓ |
| **LOOP-31** | A failed search is named at draft time with the reason, and stated not to be an established negative | unit: `local-loop`, `loop` | ✓ |
| **LOOP-32** | `outcome: no-results` still establishes coverage and still reaches the black box | unit: `local-loop`, `loop` | ✓ |
| **LOOP-33** | A failed-search outcome requires `gaps`, the same as any other empty report | `loop` | ✓ |
| **LOOP-34** | Findings alongside a failed outcome are kept, and coverage is still incomplete | unit: `local-loop` | ✓ |
| **LOOP-35** | `outcome: no-results` with a non-empty finding list is refused at the boundary | `loop` | ✓ |

### The paid project

`tests/paid/` spends real money against the live API, so it is a **separate vitest project that is deliberately excluded from `test:all` and therefore from the gate**. It cannot block a deploy. It needs both `DOSSIER_PAID_TESTS=1` and a real `GEMINI_API_KEY`, and skips itself entirely without them.

```bash
DOSSIER_PAID_TESTS=1 GEMINI_API_KEY=... npm run test:paid
```

Roughly **$2–4** per full run at `fast` tier. `PAID-05` (the `max` tier, $3–7 on its own) needs a further `DOSSIER_PAID_MAX=1`, because it exercises the same code path with a different agent id and is rarely worth the money.

The suite gives itself a `DOSSIER_BUDGET_USD=15` ceiling so a bug in the tests cannot drain a real budget, and cancels every run it started in `afterAll`, because an abandoned run keeps billing.

### The multi-process test

`tests/concurrency.test.ts` spawns **real OS processes** against one store rather than using worker threads, because threads share the in-process mutex, which was the mechanism that already worked. With a $15 ceiling and $7 reserved per `max` run, three processes racing to start six runs each must admit exactly two.

Verified to fail against the pre-fix implementation: **3 admitted, $21 committed against a $15 ceiling.** A concurrency test that passes both before and after the fix proves nothing, so this one was checked in both directions.

### Remaining gaps, named

| AC | Why it is still open |
|---|---|
| **VERTEX-02** a live Vertex run | Needs a GCP project with `aiplatform.interactions.create`; the one available returns `PERMISSION_DENIED`. The test is written and skips itself, so it runs the moment a project exists. |
| **STREAM-03** live mid-run progress | Not a gap in the tests. The API buffers its stream: a 7.1-minute run delivered nothing until completion. There is nothing to observe, so the suite asserts the docs do not promise it. Tracked in [#1](https://github.com/fledgeling-co/dossier-research-mcp/issues/1). |

## Discipline

- **Assert the outcome, not the chrome.** "The outline reports token estimates" asserts a number is present per section, not that the call returned a string.
- **Isolation.** Every test gets a `mkdtemp` store and its own server process. Nothing is shared, so the suite is green on a second consecutive run, which is the check that catches leftover state.
- **Hermetic by construction.** The harness exports `DOSSIER_HERMETIC=1` and blanks the credential vars, so a real key in a developer's shell cannot make the suite spend money.
- **Every fix becomes a guard.** Bugs found live this session (report truncation, thought parsing, corpus placement, plan extraction, redirect classification) all have a test here or in the unit suite.

## Running

```bash
npm run test:acceptance     # this suite
npm run test:all            # unit + acceptance (npm test runs unit only)
npm run gate                # typecheck, lint, test, build
```
