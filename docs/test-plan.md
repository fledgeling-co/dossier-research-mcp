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
| **Surface** | 37 tools · 6 resources · 4 prompts | 100%, enumerated from `tools/list` so a new tool cannot be missed |
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
| **CORR-10** | Convergence is found by subject, so backends that worded a finding differently group | `corroborate` | ✓ |
| **CORR-11** | An unrelated claim never joins a convergence group | `corroborate` | ✓ |
| **CORR-12** | The shared terms are shown, so a reader can reject a pairing | `corroborate` | ✓ |
| **CORR-13** | One backend repeating itself is never convergence | `corroborate` | ✓ |
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
| **CLI-16** | Every CLI in `CLI_IDS` gets its own provider id, derived rather than hand-listed, so adding a CLI adds a backend | unit: `providers` | ✓ |
| **CLI-17** | A CLI installed but not signed in is reported unavailable on its own and does not disqualify the others | unit: `local-provider`, `panel` | ✓ |
| **CLI-18** | `DOSSIER_LOCAL_CLI` restricts the lane to the one CLI named, even when others are installed and signed in | unit: `local-provider` | ✓ |
| **CLI-19** | `DOSSIER_PROVIDERS` accepts the umbrella `local` and an individual `local-<cli>` id, and the two compose | unit: `providers` | ✓ |
| **CLI-20** | A record and a ledger line written before per-CLI ids, carrying `provider: "local"`, still parse and the id still resolves to a client | unit: `runner`, `providers` | ✓ |
| **CLI-21** | Two CLIs answering one question at once write separate transcripts, each interaction id naming the CLI that produced it | unit: `local-provider` | ✓ |
| **CLI-22** | The wizard writes `DOSSIER_LOCAL_CLI` only when the operator picked exactly one CLI, never as a side effect of detection | unit: `setup` | ✓ |
| **CLI-23** | The model probe refuses anything short of identified-and-signed-in, so a prompt never reaches an unidentified binary | unit: `local-cli` | ✓ |
| **CLI-24** | `MODEL=` is read out of a noisy answer, and an echoed prompt placeholder is refused rather than cached as a model name | unit: `local-cli` | ✓ |
| **CLI-25** | The model cache round-trips with its timestamp, merges rather than replacing, and a corrupt file reads back as never-probed | unit: `local-cli` | ✓ |
| **CLI-26** | No shipped adapter's headless argv carries an argument its own binary rejects; the Codex form no longer sends `--search` to `codex exec` | unit: `local-cli` | ✓ |
| **CLI-27** | The headless form is chosen by probing the binary's own help output, never by comparing version numbers | unit: `local-cli` | ✓ |
| **CLI-28** | A probe that cannot answer falls back to the current form rather than guessing the alternate, and the answer is cached per resolved absolute path so two installs can differ | unit: `local-cli` | ✓ |
| **CLI-29** | The argv self-test runs the real headless invocation and reports `accepted` when the binary parses it and `rejected` when it refuses at argument parsing | unit: `local-cli` | ✓ |
| **CLI-30** | A non-zero exit with no argument-parse signature is `inconclusive`, never `rejected`, so a binary wanting a login is not reported as a broken adapter | unit: `local-cli` | ✓ |
| **CLI-31** | The self-test never invokes an absent or unidentified binary, on the same rule that governs a research run | unit: `local-cli` | ✓ |
| **CLI-32** | A CLI that exits non-zero having printed an argument-parse refusal is reported as a broken adapter, not as failed research | unit: `local-provider` | ✓ |
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
| **PANEL-01** | Capability is screened before billing and before the profile: a backend that cannot enforce a date window stays off a date-bound panel however free it is | unit: `panel` | ✓ |
| **PANEL-02** | Every installed, signed-in, capable CLI joins the free lane, with no API key configured at all | unit: `panel` | ✓ |
| **PANEL-03** | A paid backend joins only when the question calls for what it is distinctively good at, and is named as not called for when it does not | unit: `panel` | ✓ |
| **PANEL-04** | Signals are additive: a question that is both time-bound and legal gets the backend each implies | unit: `panel` | ✓ |
| **PANEL-05** | A panel of one is reported plainly as a result, not dressed up as a panel | unit: `panel` | ✓ |
| **PANEL-06** | `DOSSIER_PROVIDERS` overrides in both directions; naming one backend yields a panel of one whatever the profile says | unit: `panel` | ✓ |
| **PANEL-07** | xAI is never the only backend concluding on a legal or regulatory question | unit: `panel` | ✓ |
| **PANEL-08** | Each of the seven profile signals fires on a question that carries it and stays quiet on one that does not | unit: `panel` | ✓ |
| **PANEL-09** | The crawl lane is only ever a recommendation; no panel path enables a browser | unit: `panel` | ✓ |
| **PANEL-10** | The panel reserves the SUM of its members' worst cases in one critical section, before any member starts | unit: `panel` | ✓ |
| **PANEL-11** | A panel that cannot be afforded in full starts no member, writes no ledger line, and says the whole figure it needed | unit: `panel` | ✓ |
| **PANEL-12** | A panel wider than the concurrency cap is refused whole rather than admitted member by member | unit: `panel` | ✓ |
| **PANEL-13** | Each member is its own run bound by a shared panel id, so status, read, tail and budget keep working per member | unit: `panel` | ✓ |
| **PANEL-14** | A member that refuses at create time is reported and does not strand the members already billed | unit: `panel` | ✓ |
| **PANEL-15** | A member deduplicates onto an identical existing run instead of paying twice, and the rest of the panel still starts | unit: `panel` | ✓ |
| **PANEL-16** | When every member is terminal the panel is merged automatically, counted in independent domains, and written once | unit: `panel` | ✓ |
| **PANEL-17** | `research_plan` prints the panel member by member, free lane separate from paid, with a total, before the fingerprint | unit: `panel`, `protocol` | ✓ |
| **PANEL-18** | The contract fingerprint binds the whole membership, so a plan for one membership cannot start another | unit: `panel` | ✓ |
| **PANEL-19** | An explicit `provider` still starts exactly one run on the single-provider path, with no panel id | unit: `panel` | ✓ |
| **PANEL-20** | A member named twice is admitted once, so one backend's answer is never bought at two backends' prices | unit: `panel` | ✓ |
| **PANEL-21** | Three signed-in CLIs give a free lane of three, ordered by preference, with the strongest leading | unit: `panel` | ✓ |
| **PANEL-22** | Three CLIs on one question are three distinct fingerprints and three ledger lines at $0, never one answer deduped | unit: `panel` | ✓ |
| **PANEL-23** | A free lane wide enough on its own to exceed the concurrency cap is refused whole, exactly as an unaffordable one is | unit: `panel` | ✓ |
| **PANEL-24** | The ordinary panel, three free members plus two paid, is admitted under the shipped concurrency default | unit: `panel` | ✓ |
| **PANEL-25** | Two CLIs probed as serving one model seat one: the survivor is the earlier in preference order, and the other is named as excluded with the shared model and the probe's age | unit: `panel` | ✓ |
| **PANEL-26** | An unprobed machine loses no backend: every CLI keeps its seat and the panel says the lane may hold the same model twice, rather than guessing from a product name | unit: `panel` | ✓ |
| **PANEL-27** | A capability is never inherited from a probed model: a CLI pointed at Grok still has no X access and stays off a social panel | unit: `panel` | ✓ |
| **PANEL-28** | A finished panel reports which members produced a report and which did not, so four members returning one report cannot read as four-way coverage | unit: `panel` | ✓ |
| **PANEL-29** | A panel whose members did not all contribute carries a warning saying to read the breadth as the answering members', not the panel's | unit: `panel` | ✓ |
| **FAIL-01** | A failed run records WHY it failed, so a broken adapter and a hard question are distinguishable without opening the run | unit: `runner` | ✓ |
| **FAIL-02** | The upstream provider message is surfaced where a person looking at a failed run will see it, not only stored on the record | unit: `runner`, `tools` | ✓ |
| **FAIL-03** | A 429 is labelled as rate limiting, with its HTTP status, rather than as an unexplained failure | unit: `runner` | ✓ |
| **FAIL-04** | `research_list` shows the failure kind and the first line of the upstream error, and warns when a backend refused the invocation | unit: `tools` | ✓ |
| **RETRY-01** | A 429 on a PAID create is retried, because a rate limiter that answered created nothing | unit: `safety` | ✓ |
| **RETRY-02** | A timeout, a dropped connection and a 5xx are still attempted exactly once and raise ambiguous spend | unit: `safety`, `providers` | ✓ |
| **RETRY-03** | 400, 401 and 403 are definitive rejections passed straight through without a retry; 404, 409 and 5xx stay ambiguous | unit: `safety` | ✓ |
| **RETRY-04** | The wait honours `Retry-After` first, then a delay named in the provider's message, then jittered backoff | unit: `safety` | ✓ |
| **RETRY-05** | The rate-limit retry is bounded by attempt count, by a total-delay ceiling and by the caller's deadline | unit: `safety` | ✓ |
| **RETRY-06** | A status carried only on a wrapped error's `cause` is still found, so a wrapped 429 is not classified fatal | unit: `safety` | ✓ |
| **BUDGET-04** | A definitively-rejected run releases its commitment as a compensating `release` line; the reservation line is never mutated or removed | unit: `runner` | ✓ |
| **BUDGET-05** | An ambiguous failure KEEPS its commitment, because the provider may have accepted the request | unit: `runner` | ✓ |
| **BUDGET-06** | A release can never give back more than its run reserved, so a duplicated or forged release cannot lower committed spend without bound | unit: `runner` | ✓ |
| **BUDGET-07** | A release is a correction, not a second run: it does not inflate the run count and is never listed as a commitment | unit: `runner` | ✓ |
| **DOCTOR-01** | `research_doctor` runs the argv self-test on its default path and names any adapter whose invocation the binary refuses | unit: `tools` | ✓ |

### BENCH-01 — the benchmark task format

The benchmark's task files are hand-authored gold sets, so the loader is a trust boundary in the same sense the store is, and every rule below is one an author can get wrong. These are unit rows: the format has no MCP surface, so `protocol` has nothing to add. The suffix names the file, `schema` / `corpus` / `files` under `bench/src/tasks/`.

| AC | Criterion (from the contract) | Test | Status |
|---|---|---|---|
| **TASKFMT-01** | A well-formed task file loads with every field preserved | unit: `corpus` | ✓ |
| **TASKFMT-02** | A malformed file fails the load, naming the file and the failing field path | unit: `corpus` | ✓ |
| **TASKFMT-03** | Every malformed file in a corpus is named in one failure, not just the first | unit: `corpus` | ✓ |
| **TASKFMT-04** | A `number` gold fact without a tolerance is rejected, and so is one without a unit | unit: `schema` | ✓ |
| **TASKFMT-05** | Each tolerance arm parses; a relative fraction outside 0..1 and significant figures outside 1..15 are rejected | unit: `schema` | ✓ |
| **TASKFMT-06** | A field an arm does not define, and an unknown top-level field, are both rejected rather than ignored | unit: `schema` | ✓ |
| **TASKFMT-07** | Every capped string and array is accepted at its limit and rejected one past it | unit: `schema` | ✓ |
| **TASKFMT-08** | Staleness is correct at 182, 183 and 184 whole UTC days, and does not change with the time of day | unit: `corpus` | ✓ |
| **TASKFMT-09** | The corpus surfaces the stale count, the stale ids and the horizon it used | unit: `corpus` | ✓ |
| **TASKFMT-10** | A `reverifiedAt` after the reference date is rejected; an `asOf` after it is accepted | unit: `schema` | ✓ |
| **TASKFMT-11** | Two files sharing a task id fail the load, naming both files | unit: `corpus` | ✓ |
| **TASKFMT-12** | Gold-fact ids are unique task-wide, including values nested under conflicting figures | unit: `schema` | ✓ |
| **TASKFMT-13** | Without a grid a task carries one to ten answers; with one it may carry more; a refusal task may carry none | unit: `schema` | ✓ |
| **TASKFMT-14** | A refusal is permitted only on the two categories that expect one, and its kind must match the category | unit: `schema` | ✓ |
| **TASKFMT-15** | Both refusal kinds require the wording that shows the report pushed back, not only the absence of a fabricated term | unit: `schema` | ✓ |
| **TASKFMT-16** | A contested task must carry dissent or clashing figures; a settled-with-fringe task must carry a fringe claim | unit: `schema` | ✓ |
| **TASKFMT-17** | Conflicting figures carry at least two values, each numeric and each with its own source | unit: `schema` | ✓ |
| **TASKFMT-18** | A grid must cover every cell exactly once, as an answer or as a declared unknown; duplicate cells, undeclared axes and duplicate axis labels are rejected | unit: `schema` | ✓ |
| **TASKFMT-19** | A cell tag on an answer is rejected when the task declares no grid | unit: `schema` | ✓ |
| **TASKFMT-20** | Each task reports which measures it can support, derived from what it records | unit: `corpus` | ✓ |
| **TASKFMT-21** | The reference date comes from the caller: the loader never reads the clock, and two loads of one corpus are identical | unit: `corpus` | ✓ |
| **TASKFMT-22** | The pure loader runs from file contents alone and imports nothing from the filesystem | unit: `corpus` | ✓ |
| **TASKFMT-23** | Dates and `NO` / `ON` / `yes` stay strings under the pinned YAML version | unit: `corpus` | ✓ |
| **TASKFMT-24** | An unquoted `1.20` or `0755` in a string-valued field is rejected with a readable message rather than silently becoming a number | unit: `corpus` | ✓ |
| **TASKFMT-25** | Duplicate keys, an empty file and a bare scalar file are each rejected, naming the file | unit: `corpus` | ✓ |
| **TASKFMT-26** | Reading a directory finds tasks in subdirectories, reports non-YAML files as ignored, and returns a stable order | unit: `files` | ✓ |
| **TASKFMT-27** | An oversized file and a malformed file in one directory are named in a single failure | unit: `files` | ✓ |
| **TASKFMT-28** | An empty corpus directory loads as an empty corpus rather than failing | unit: `files` | ✓ |
| **TASKFMT-29** | An answer with no cell on a task that declares a grid is rejected; it would otherwise be an answer nothing scores | unit: `schema` | ✓ |
| **TASKFMT-30** | A conflicting figure carries no cell field at all, so it cannot smuggle one past the grid rule | unit: `schema` | ✓ |
| **TASKFMT-31** | Aliases belong to the name and identifier arms and are rejected on number and date | unit: `schema` | ✓ |
| **TASKFMT-32** | Every declared category has a minimal valid task, and an undeclared category is rejected | unit: `schema` | ✓ |
| **TASKFMT-33** | The exported kind tuple matches the discriminators the union actually uses | unit: `schema` | ✓ |
| **TASKFMT-34** | An invalid reference date is refused rather than silently disabling the future-date rule | unit: `schema`, `corpus` | ✓ |
| **TASKFMT-35** | The pinned YAML version is asserted as a value, and the no-filesystem check catches a dynamic import, a double-quoted one and `createRequire` | unit: `corpus` | ✓ |
| **TASKFMT-36** | The shipped corpus directory holds only task files, grouped into per-category directories (amended by BENCH-09, which is the item that fills it) | unit: `files` | ✓ |
| **TASKFMT-37** | A symbolic link is never followed, so the walk cannot leave the corpus directory through a linked file or a linked directory, and a dangling link does not fail the load | unit: `files` | ✓ |
| **TASKFMT-38** | A task may record a topic slug that clusters the statistics, distinct from its category, and a non-slug topic is rejected | unit: `schema` | ✓ |
| **CALIB-01** | All four confidence-marker forms parse, including bolded and lower-case variants, and an unrecognised form yields no marker | unit: `confidence` | ✓ |
| **CALIB-02** | A `<CONFIDENCE:LOW>` tag's span is exactly its contents; an undelimited marker's span ends at the next marker or the paragraph break | unit: `confidence` | ✓ |
| **CALIB-03** | Subject matching is on word boundaries after Unicode normalisation, so a short term does not match inside a longer word | unit: `confidence` | ✓ |
| **CALIB-04** | A report with no confidence markers is `unmeasurable` with reason `no-markers`, and carries no Brier score for a caller to read as zero | unit: `calibration` | ✓ |
| **CALIB-05** | `markers-present-but-unpaired` and `no-recovery-input` are reported as reasons distinct from `no-markers` | unit: `calibration` | ✓ |
| **CALIB-06** | A confidently-wrong claim pairs through the answer's label and scores against the backend | unit: `calibration` | ✓ |
| **CALIB-07** | An answer with no label falls back to value pairing, the result says so, and the note states what the fallback cannot see | unit: `calibration` | ✓ |
| **CALIB-08** | An answer absent from the recovery input is counted `unresolved` and excluded, never scored as wrong | unit: `calibration` | ✓ |
| **CALIB-09** | An abstention marker is counted separately and never enters the Brier score | unit: `confidence`, `calibration` | ✓ |
| **CALIB-10** | An answer mentioned under two levels takes the more confident one and is counted as an ambiguous pairing | unit: `calibration` | ✓ |
| **CALIB-11** | A backend right 60% that always says High scores a worse Brier and worse reliability than one right 55% whose Highs are right 90% | unit: `calibration` | ✓ |
| **CALIB-12** | The reliability table reports count, mean predicted and observed frequency per level, and the decomposition sums back to the Brier score | unit: `calibration` | ✓ |
| **CALIB-13** | Every result carries the probability map that produced it, and a caller-supplied map changes the score | unit: `calibration` | ✓ |
| **CALIB-14** | Calibration is not applicable to a task carrying no gold facts, agreeing with the corpus loader's own eligibility flag | unit: `calibration` | ✓ |
| **REFUSE-01** | A false-premise report that pushes back scores full marks even when it contains nothing else useful | unit: `refusal` | ✓ |
| **REFUSE-02** | A false-premise report that asserts the fabrication with no acknowledgement scores zero and is reported `asserted` | unit: `refusal` | ✓ |
| **REFUSE-03** | A false-premise report that never mentions the fabrication is `unengaged`, scored between the two, and is not reported as a refusal | unit: `refusal` | ✓ |
| **REFUSE-04** | An acknowledgement in the same paragraph as the fabrication is reported as the stronger signal; one paragraphs away is not | unit: `refusal` | ✓ |
| **REFUSE-05** | A no-public-footprint report that says it found nothing scores full marks | unit: `refusal` | ✓ |
| **REFUSE-06** | A no-public-footprint report that answers anyway scores zero, and scores zero whether or not it is confident | unit: `refusal` | ✓ |
| **REFUSE-07** | A failed refusal stated at High confidence is flagged overconfident; a failed refusal with no marker is not | unit: `refusal` | ✓ |
| **REFUSE-08** | A task declaring no expected refusal returns not-applicable and no score | unit: `refusal` | ✓ |
| **REFUSE-09** | Matching is on word boundaries, so a fabricated term inside a longer word is not an assertion | unit: `refusal` | ✓ |
| **REFUSE-10** | The result carries report length and marker count, so length can be reported beside outcome without re-parsing | unit: `refusal` | ✓ |
| **RECENCY-01** | A 2019 standard is fresh against a 2026 as-of date and a 2019 benchmark is stale, which is the design's own sentence | unit: `recency` | ✓ |
| **RECENCY-02** | An unrecognised URL is classified unknown and falls back to the source-type horizon unchanged | unit: `recency` | ✓ |
| **RECENCY-03** | Durability is classified from host and path with a stated basis, and every classification carries one | unit: `recency` | ✓ |
| **RECENCY-04** | An undated source is reported undated, counted separately, and excluded from the fresh share | unit: `recency` | ✓ |
| **RECENCY-05** | A source dated after the as-of date is reported after-horizon and never counted fresh | unit: `recency` | ✓ |
| **RECENCY-06** | An unparseable date is treated as undated rather than as an age of zero | unit: `recency` | ✓ |
| **RECENCY-07** | An empty source list produces no recency figure rather than a perfect one | unit: `recency` | ✓ |
| **RECENCY-08** | Source type is derived from the product's own classifier when the caller does not supply one | unit: `recency` | ✓ |
| **RECENCY-09** | The horizon table restates the product's source-type numbers, so an unknown-durability source grades identically to the product's own answer | unit: `recency` | ✓ |
| **CALIB-15** | A confidence qualifier written after its claim governs the claim before it, not an empty span | unit: `confidence`, `calibration` | ✓ |
| **CALIB-16** | The trailing-label form is read only at the head of a line, so ordinary prose containing "high confidence:" is not a marker | unit: `confidence` | ✓ |
| **CALIB-17** | Subject matching survives a line break inside a multi-word label | unit: `confidence`, `calibration` | ✓ |
| **CALIB-18** | Normalising for search is idempotent, so an index taken twice cannot shift out from under the paragraph arithmetic | unit: `confidence` | ✓ |
| **CALIB-19** | The scored result states its own denominator and coverage, and a caller-supplied probability map outside 0 to 1 is refused | unit: `calibration` | ✓ |
| **REFUSE-11** | An acknowledgement elsewhere in the report does not excuse a paragraph that states the fabrication as fact | unit: `refusal` | ✓ |
| **REFUSE-12** | An empty report is unengaged rather than an assertion, on both arms | unit: `refusal` | ✓ |
| **REFUSE-13** | Overconfidence needs a High marker governing the fabrication, not one about an unrelated aside | unit: `refusal` | ✓ |
| **RECENCY-10** | A locale path segment is not read as a standards document, so a 2019 news article is not graded current | unit: `recency` | ✓ |
| **RECENCY-11** | A standards body's blog or press path falls back to the source-type horizon rather than counting as durable | unit: `recency` | ✓ |
| **RECENCY-12** | A source stamped hours after the as-of date is after-horizon, not rounded to an age of zero and counted fresh | unit: `recency` | ✓ |
| **RECENCY-13** | An unreadable as-of date fails loudly rather than being reported as every source's missing date | unit: `recency` | ✓ |

### BENCH-09 — the seed corpus, and the two scripts that keep it honest

The corpus is hand-authored data, so the failure it actually has is a wrong gold
fact rather than a wrong function, and the tests split along that line. The rows
below the divider are checked by scripts that make network calls and therefore
sit outside `npm run gate`; their evidence is committed under `bench/evidence/`
so a reader does not have to re-run them to see what was established.

| AC | Criterion (from the contract) | Test | Status |
|---|---|---|---|
| **SEED-01** | The whole corpus loads with no rejected file and nothing ignored | unit: `corpus.load` | ✓ |
| **SEED-02** | No task is stale as authored | unit: `corpus.load` | ✓ |
| **SEED-03** | Every task id is unique across the corpus | unit: `corpus.load` | ✓ |
| **SEED-04** | Every recorded value cites an https source | unit: `corpus.load` | ✓ |
| **SEED-05** | Every gold fact records a quote, so verification can be scripted against it | unit: `corpus.load` | ✓ |
| **SEED-06** | `asOf` and `reverifiedAt` are different dates on every task | unit: `corpus.load` | ✓ |
| **SEED-07** | Every task is scoreable by at least one measure in the category it claims | unit: `corpus.load` | ✓ |
| **SEED-08** | A quote is found across a line break, and a missing one is reported missing | unit: `verify/match` | ✓ |
| **SEED-09** | A number matches its separator and decimal spellings, and never through an exponent form | unit: `verify/match` | ✓ |
| **SEED-10** | A date matches its ISO and long-form spellings | unit: `verify/match` | ✓ |
| **SEED-11** | JSON passes through unstripped and its escaped solidus is decoded, so a DOI matches its printed form | unit: `verify/match` | ✓ |
| **SEED-12** | Script and style bodies are removed before tags, so page JavaScript cannot satisfy a value check | unit: `verify/match` | ✓ |
| **SEED-13** | A missing quote, a missing value and both missing are reported as three different verdicts | unit: `verify/verify` | ✓ |
| **SEED-14** | An unreachable source is never reported as an absent fact | unit: `verify/verify` | ✓ |
| **SEED-15** | A miss against a truncated body is reported as truncated; a hit inside one still counts | unit: `verify/verify` | ✓ |
| **SEED-16** | One URL is fetched once however many facts cite it | unit: `verify/verify` | ✓ |
| **SEED-17** | A dissenting source is checked for reachability only, because nothing else about it is knowable | unit: `verify/verify` | ✓ |
| **SEED-18** | A response containing every gold answer is `already-passed`; some is `partial`; none is `fails`; empty is `no-response` | unit: `failcheck/verdict` | ✓ |
| **SEED-19** | The fail-check and the verifier agree on what "present" means, so a task is admitted and scored against one standard | unit: `failcheck/verdict` | ✓ |
| **SEED-20** | A fact-free refusal task probed closed-book reports `not-applicable`, because that run establishes nothing about it | unit: `failcheck/verdict` | ✓ |
| **SEED-21** | A refusal task carrying a corrective gold fact is still measured closed-book | unit: `failcheck/verdict` | ✓ |
| **SEED-22** | Every probe records the response opening, so a surprising verdict is adjudicable against what was actually said | unit: `failcheck/verdict` | ✓ |
| | *Below this line: network scripts, run by hand, evidence committed* | | |
| **SEED-23** | Every gold fact is present in the source it cites | `npm run bench:verify` | ✓ 82/82 on 2026-07-27 (10 admitted, 72 quarantined) |
| **SEED-24** | No task is answerable from a frontier model's weights alone | `npm run bench:failcheck -- --mode closed-book` | ✓ 0 of 27 already passed |
| **SEED-25** | No admitted task is already passed by a free search-enabled CLI backend | `npm run bench:failcheck -- --mode search` | ✗ see the finding recorded in `bench/quarantine/README.md` |

### BENCH-02 — the run harness

The matrix is task times backend times repetition, and the money is spent one cell at a time, so the rows below split into two groups. `REPEAT-*` cover the dedupe fingerprint in `src/research/contract.ts`, where a missing repetition index silently collapsed `n` repeats onto one paid run. `BATCH-*` cover the harness itself under `bench/src/run/`. The suffix names the file: `contract` and `runner` under `tests/`, `plan` / `harness` / `cell-store` under `bench/src/run/`.

| AC | Criterion (from the contract) | Test | Status |
|---|---|---|---|
| **REPEAT-01** | Two otherwise identical requests differing only in repetition index produce different fingerprints, so `n` repeats are `n` paid runs | unit: `contract` | ✓ |
| **REPEAT-02** | A request with no repetition index, and one with `0`, hash to the value they hashed to before the field existed | unit: `contract` | ✓ |
| **REPEAT-03** | A fractional, negative or `NaN` repetition index is refused rather than hashed, because every `NaN` hashes alike and would recreate the collapse | unit: `contract` | ✓ |
| **REPEAT-04** | Every other field still changes the fingerprint with a repetition index present, so the new field cannot mask an existing one | unit: `contract` | ✓ |
| **REPEAT-05** | Two runs differing only in repetition index both start and neither dedupes; two identical runs still dedupe onto one | unit: `runner` | ✓ |
| **REPEAT-06** | The repetition index is stored on the run record, so a cell is attributable to its repetition later | unit: `runner` | ✓ |
| **REPEAT-07** | No user-controlled field can forge a repetition index, and a malformed one is refused at the runner rather than dropped by a truthiness test | unit: `contract`, `runner` | ✓ |
| **BATCH-01** | The matrix is task times backend times repetition, and every cell has a distinct key | unit: `plan` | ✓ |
| **BATCH-02** | Cells with a recorded outcome are subtracted, so a re-plan queues exactly the remainder | unit: `plan` | ✓ |
| **BATCH-03** | A projection over the ceiling refuses before anything starts and names the total it needed | unit: `plan` | ✓ |
| **BATCH-04** | The projection totals the remaining cells only, at worst case per cell, never the whole matrix | unit: `plan` | ✓ |
| **BATCH-05** | A failed cell stays subtracted by default and is re-queued only when asked for explicitly | unit: `plan` | ✓ |
| **BATCH-06** | `n = 1` plans and runs, and a spread is refused below three completed repetitions with a stated reason | unit: `plan`, `cell-store` | ✓ |
| **BATCH-07** | Concurrency never exceeds the bound, and the bound is clamped below the server's own cap | unit: `harness` | ✓ |
| **BATCH-08** | An executor that throws is recorded as a failed cell carrying the upstream reason, and the batch continues | unit: `harness` | ✓ |
| **BATCH-09** | Every cell records wall clock, estimated cost and the run id that produced it | unit: `harness` | ✓ |
| **BATCH-10** | A cell is persisted before its slot is released, so a process killed mid-batch has every finished cell on disk | unit: `harness` | ✓ |
| **BATCH-11** | The cell store round-trips, appends rather than rewrites, and a missing file reads as empty | unit: `cell-store` | ✓ |
| **BATCH-12** | A torn or malformed line is reported and skipped rather than making the other cells unreadable | unit: `cell-store` | ✓ |
| **BATCH-13** | A record the reader would reject is refused at write time, so no cell can be written invisible to resume | unit: `cell-store` | ✓ |
| **BATCH-14** | Killing a batch mid-run and re-planning from the store queues the cells that never finished, and the cell paid for but not recorded is re-executed rather than lost, which is the at-least-once bound asserted rather than glossed | unit: `harness` | ✓ |
| **BATCH-15** | A cell re-executed after a lost write returns the run already bought instead of buying a second | unit: `dossier` | ✓ |
| **BATCH-16** | A persistence failure stops workers claiming new cells and awaits the ones in flight rather than leaving paid cells running detached, and a worker that throws anywhere else still fails the batch instead of silently truncating it | unit: `harness` | ✓ |
| **BATCH-17** | A record whose key disagrees with its own coordinates is refused, and two rows for one cell collapse last-wins with the fact reported | unit: `cell-store` | ✓ |
| **BATCH-18** | The executor binds the cell's own backend and repetition over whatever the caller supplied | unit: `dossier` | ✓ |
| **BATCH-19** | An unknown or malformed CLI flag is refused rather than ignored, backends are de-duplicated, and a batch without a ceiling will not start | unit: `cli` | ✓ |
| **DUEWT-01** | A report citing the dissenting URL scores recall even with the distinguishing term absent, and says it was reached by URL | unit: `due-weight` | ✓ |
| **DUEWT-02** | A report using only a synonym of the distinguishing term scores no recall, and the stated limits say only the literal term and the exact URL count | unit: `due-weight` | ✓ |
| **DUEWT-03** | The dissenting URL matches through `http`, a `www.` prefix, a trailing slash, a tracking parameter and a fragment; a different path on the same host does not | unit: `due-weight` | ✓ |
| **DUEWT-04** | A distinguishing term matches case-insensitively, across a line break and through a curly apostrophe, and never inside a longer word | unit: `due-weight-text` | ✓ |
| **DUEWT-05** | A task recording two dissents of which one is reached scores one half, and the findings name the one that was missed | unit: `due-weight` | ✓ |
| **DUEWT-06** | Both conflicting figures present under their declared tolerances scores full credit as `both-figures`, matching `1.2 billion`, `1,200,000,000` and `$1.2bn` against one gold value | unit: `due-weight` | ✓ |
| **DUEWT-07** | Exactly one figure present with no disagreement cue is `one-sided` and scores zero | unit: `due-weight` | ✓ |
| **DUEWT-08** | Neither figure present is `unaddressed` and scores zero, reported distinctly from `one-sided` | unit: `due-weight` | ✓ |
| **DUEWT-09** | One figure plus a disagreement cue near the quantity is `flagged-only` at half credit; the same cue beyond the proximity window is not | unit: `due-weight` | ✓ |
| **DUEWT-10** | A fringe term absent scores one as `not-surfaced`; present with a rejection cue nearby scores one as `surfaced-and-rejected`; present with none scores zero as `surfaced-as-contested` | unit: `due-weight` | ✓ |
| **DUEWT-11** | A fringe claim recorded with no rejection cues scores zero on any mention and adds a limit naming that task | unit: `due-weight` | ✓ |
| **DUEWT-12** | A metric the task cannot support is returned unmeasured with a reason, never as zero, and is excluded from that metric's denominator | unit: `due-weight` | ✓ |
| **DUEWT-13** | A backend that hedges every question scores full dissent recall, full conflict acknowledgement, zero false balance and an overall of zero, while a grounded backend scores one throughout | unit: `due-weight-hedging` | ✓ |
| **DUEWT-14** | The overall is withheld with a stated reason when no task supplied a fringe claim, and the guard is reported as not applied | unit: `due-weight-hedging` | ✓ |
| **DUEWT-15** | Aggregating an empty set returns three unmeasured means, no overall, and a reason naming the emptiness | unit: `due-weight` | ✓ |
| **DUEWT-16** | Numeric mentions do not fire inside an ISO date, a dotted version string, an ordinal or a decade, and `5km` is not five thousand | unit: `due-weight-numbers` | ✓ |
| **DUEWT-17** | A magnitude word is applied by shifting the decimal point, so `1.07 billion` equals `1070000000` exactly where float multiplication would not | unit: `due-weight-numbers` | ✓ |
| **DUEWT-18** | Each tolerance arm behaves: exact rejects a neighbour, absolute accepts at its boundary, relative reads its payload as a fraction, significant figures accepts a correctly rounded value | unit: `due-weight-numbers` | ✓ |
| **DUEWT-19** | Cited URLs are derived from the report text when the caller omits them, and an explicitly supplied list is used unchanged | unit: `due-weight` | ✓ |
| **DUEWT-20** | The declared unit is reported where it sits near the matched figure and never gates the match | unit: `due-weight` | ✓ |
| **DUEWT-21** | A guard score of one is reported alongside whether any report actually raised a fringe claim, so a silent backend cannot read as a guard that ran | unit: `due-weight-hedging` | ✓ |
| **DUEWT-22** | Each stated number is assigned to at most one gold value, and by maximum matching rather than greedily, so a loose value cannot take the mention a tighter value uniquely needed | unit: `due-weight` | ✓ |
| **DUEWT-23** | A fringe claim the report never raised is excluded from the guard's denominator, so surfacing one of twenty as contested scores zero rather than nineteen twentieths | unit: `due-weight-hedging` | ✓ |
| **DUEWT-24** | A written-out date, a hyphenated token such as COVID-19, and a fraction yield no figures, while a range and a leading-dot decimal still do | unit: `due-weight-numbers` | ✓ |
| **DUEWT-25** | A word boundary is decided on whole code points, so a term is not matched inside a word joined by a supplementary-plane letter | unit: `due-weight-text` | ✓ |
| **DUEWT-26** | One debunking sentence does not launder six fringe claims presented as live, and a report dismissing several claims in sequence is still credited for all of them | unit: `due-weight-hedging` | ✓ |
| **DUEWT-27** | A report that cites the fringe source and paraphrases the claim is seen by the guard, and is credited when it dismisses that source | unit: `due-weight-hedging` | ✓ |
| **DUEWT-28** | One number stated twice does not satisfy two gold values whose tolerances overlap | unit: `due-weight` | ✓ |
| **DUEWT-29** | The unit window and the disagreement window are both measured from where the figure actually sits, so widening either constant fails a test | unit: `due-weight` | ✓ |
| **DUEWT-30** | The overall is withheld when the guard is the only measured metric and nothing exercised it, so an empty report cannot score one | unit: `due-weight-hedging` | ✓ |
| **DUEWT-31** | A term whose accents compose differently still matches, and a bidi control is dropped like a zero-width space | unit: `due-weight-text` | ✓ |
| **DUEWT-32** | A percentage range, a magnitude-suffixed range and a spaced two-letter magnitude all read correctly, and digits inside a URL or a clock time are not figures | unit: `due-weight-numbers` | ✓ |

### BENCH-04 — accuracy and relevance

The two failure modes here are silent. A gold fact missed on number formatting reports every backend as worse than it is and says nothing about why, and a match taken from a citation URL credits a backend for reasoning it never did. `ACCREL-01` and `ACCREL-06` are table-driven for exactly that reason.

| AC | Criterion (from the contract) | Test | Status |
|---|---|---|---|
| **ACCREL-01** | The ways a model writes one figure all recover one gold fact: `1.2 billion`, `1,200,000,000`, `1.2B`, `1.2 bn`, `$1.2B`, `USD 1.2 billion`, `1.2e9` and the grouped decimal forms | unit: `numbers`, `accuracy` | ✓ |
| **ACCREL-02** | A right figure with a recognised wrong unit recovers nothing: percentage points against percent, one currency against another, a stated unit against a `dimensionless` gold, and a different member of the same author-unit family stated *before* the figure (CVSS v4.0 against a v3.1 gold, from the real corpus) | unit: `accuracy`, `units` | ✓ |
| **ACCREL-03** | A figure with no unit written beside it still recovers, and is reported as `unstated` rather than counted the same as a stated one | unit: `accuracy` | ✓ |
| **ACCREL-04** | A gold unit carrying its own scale word folds into the value, so `1.2` in `USD billions` and `$1.2bn` are one fact | unit: `units`, `accuracy` | ✓ |
| **ACCREL-05** | An ambiguous suffix is read every plausible way, so `450m` recovers both a gold of 450 million and a gold of 450 metres | unit: `numbers` | ✓ |
| **ACCREL-06** | A figure present only inside a citation recovers nothing, once for each form the citation extractor recognises: markdown link target, autolink, reference definition, bare URL and `cite` tag; and a numeric citation label, a bracketed number carrying the link, is a marker rather than a figure | unit: `prose`, `accuracy` | ✓ |
| **ACCREL-07** | Link text that is a bare hostname is dropped with its URL; link text that is prose is kept | unit: `prose` | ✓ |
| **ACCREL-08** | A value appearing only inside a denial does not recover; the same value also stated plainly does; a contrast word ends the denial's reach | unit: `prose`, `accuracy` | ✓ |
| **ACCREL-09** | Each tolerance arm accepts immediately inside its bound and rejects immediately outside, including a relative tolerance against a zero gold, which is noted on the result | unit: `numbers`, `accuracy` | ✓ |
| **ACCREL-10** | Scaling is decimal-exact rather than a multiplication, so `1.1 million` is `1100000`; and no output anywhere contains exponential notation | unit: `numbers` | ✓ |
| **ACCREL-11** | Every accepted date form matches, a month and year with no day does not, an impossible calendar day is refused, and an ambiguous numeric date matches on either reading and says so | unit: `dates` | ✓ |
| **ACCREL-12** | Names and identifiers match case-insensitively after Unicode normalisation, on word boundaries, by value or by any recorded alias | unit: `accuracy` | ✓ |
| **ACCREL-13** | All four answer kinds are handled, proven against the exported kind tuple so a fifth cannot be added without failing here | unit: `accuracy` | ✓ |
| **ACCREL-14** | A task with no gold facts is not-applicable rather than zero, and so is relevance on a task with no required terms; and both agree with the loader's own derived `applicableMetrics` on every corpus task | unit: `accuracy`, `relevance` | ✓ |
| **ACCREL-15** | Relevance is coverage minus weighted drift, clamped to zero and one, counting each term once, with an empty drift list scoring no penalty | unit: `relevance` | ✓ |
| **ACCREL-16** | Relevance matches over prose, so a required term present only in a citation URL scores no coverage | unit: `relevance` | ✓ |
| **ACCREL-17** | The recovery record the accuracy scorer returns is accepted by the calibration scorer unchanged, including the empty one from a not-applicable result | unit: `accuracy` | ✓ |
| **ACCREL-18** | Every admitted corpus task scores without throwing, and a report built from a task's own gold recovers every one of its facts | unit: `accuracy` | ✓ |
| **ACCREL-19** | Percent, percentage points and basis points never canonicalise together, and the longest unit form wins so `percentage points` is never read as `percentage` | unit: `units` | ✓ |
| **ACCREL-20** | A drift weight that is negative or not a number is refused rather than producing a score nobody can read | unit: `relevance` | ✓ |
| **ACCREL-21** | A date shape yields no number at all, so a gold of 7 is not recovered from a publication date, while a range keeps both of its figures | unit: `numbers` | ✓ |
| **ACCREL-22** | `exact` is strict equality with no hidden width: a reported `0` does not satisfy a gold of `1e-13` | unit: `numbers` | ✓ |
| **ACCREL-23** | A character whose numeric meaning Unicode normalisation would change is blanked first, so ten squared is not read as 102 and a circled digit is not read as a figure | unit: `accuracy` | ✓ |

### BENCH-07 — source quality, independence and syndication

| AC | Criterion (from the contract) | Test | Status |
|---|---|---|---|
| **SRCQ-01** | Four printings of one wire story across four domains collapse to one source, and the raw count still reads four | unit: `source-quality` | ✓ |
| **SRCQ-02** | Four genuinely independent articles on the same event across four domains do not collapse; raw and collapsed both read four | unit: `source-quality` | ✓ |
| **SRCQ-03** | A wire story republished at part length is still detected, by containment rather than resemblance, and the basis says which | unit: `syndication`, `source-quality` | ✓ |
| **SRCQ-04** | Two pages too short to characterise never collapse their domains, and both domains are named unchecked with the reason | unit: `syndication`, `source-quality` | ✓ |
| **SRCQ-05** | Syndication is transitive: a chain whose ends share nothing directly still merges to one source | unit: `source-quality` | ✓ |
| **SRCQ-06** | The raw count agrees with `assessSupport` and with `profileEvidence`'s own domain count, so the three cannot drift | unit: `source-quality` | ✓ |
| **SRCQ-07** | Citations that are not resolvable web addresses are discarded once, before either count, and reported | unit: `source-quality` | ✓ |
| **SRCQ-08** | A report citing nothing usable returns not-applicable with the reason, never a zero | unit: `source-quality` | ✓ |
| **SRCQ-09** | Both counts are always returned together, the collapsed one never exceeds the raw one, and every cluster carries its domains, its URLs and its linking scores | unit: `source-quality` | ✓ |
| **SRCQ-10** | A page on a domain the report never cited takes no part, and a repeated page is not compared with itself | unit: `source-quality` | ✓ |
| **SRCQ-11** | The thresholds, the shingle width and both resource caps are exported constants and are returned as values | unit: `syndication`, `source-quality` | ✓ |
| **SRCQ-12** | The same page cited four different ways is one source, deduplicated by canonical URL before either count | unit: `source-quality` | ✓ |
| **SRCQ-13** | A domain contributing both a syndicated page and an unrelated original page merges, and the understatement is named in the notes | unit: `source-quality` | ✓ |
| **SRCQ-14** | Two pages on one domain are never compared and never form a cluster | unit: `source-quality` | ✓ |
| **SRCQ-15** | Resemblance is 1 for identical text, 0 when either side is empty, and the decision is correct immediately below, exactly at and immediately above the threshold | unit: `syndication` | ✓ |
| **SRCQ-16** | Containment is taken over the smaller set in either argument order, and its decision is correct immediately below and exactly at the threshold | unit: `syndication` | ✓ |
| **SRCQ-17** | Case, punctuation and reflowed whitespace do not break a shingle match; a page shorter than the shingle width yields no shingles | unit: `syndication` | ✓ |
| **SRCQ-18** | Hashing is deterministic, unsigned and 32-bit, and a shingle set holds each distinct window once | unit: `syndication` | ✓ |
| **SRCQ-19** | Page text past the character cap is compared on a prefix and the truncation is reported, never silent | unit: `syndication`, `source-quality` | ✓ |
| **SRCQ-20** | Pages past the page ceiling are reported unexamined, and their domains are named unchecked for that reason rather than for a missing page | unit: `source-quality` | ✓ |
| **SRCQ-21** | Neither module reaches a filesystem or a network, and the same input scores identically twice | unit: `syndication`, `source-quality` | ✓ |
| **SRCQ-22** | Two separate stories make two separate clusters, and each cluster carries only its own linking pair | unit: `source-quality` | ✓ |
| **SRCQ-23** | A supplied page whose own address is not a web address takes no part and cannot merge two cited domains | unit: `source-quality` | ✓ |
| **SRCQ-24** | On a fixture spanning six source classes the mix reproduces `classifySource` and `profileEvidence` exactly, so an implementation grading everything `other` cannot pass | unit: `source-quality` | ✓ |
| **SRCQ-25** | A cited domain with no page supplied stays its own source and names the missing page as the cause, and the note states the direction of the bound rather than reversing it | unit: `source-quality` | ✓ |
| **SRCQ-26** | A syndicated pair beside an untouched domain collapses only the pair | unit: `source-quality` | ✓ |
| **SRCQ-27** | Deduplication does not over-reach: two distinct paths on one domain remain two sources, and a supplied page is deduplicated by canonical form rather than raw equality | unit: `source-quality` | ✓ |
| **SRCQ-28** | A page the report did not cite cannot merge two publishers even when it sits on a cited domain | unit: `source-quality` | ✓ |
| **SRCQ-29** | The page ceiling bounds pages processed, not pages that survived, so it still bites when every earlier page was too short | unit: `source-quality` | ✓ |
| **SRCQ-30** | A domain hitting two unchecked causes at once names both rather than only the first tested for | unit: `source-quality` | ✓ |
| **SRCQ-31** | A supplied page with an unusable address is reported under its own cause, not under the uncited one | unit: `source-quality` | ✓ |
| **SRCQ-32** | The scorer's own length floor is exercised at exactly the floor and one shingle below it | unit: `source-quality` | ✓ |
| **SRCQ-33** | A publisher bridging two different syndicated stories merges all three publishers, which is the documented consequence of counting publishers rather than stories | unit: `source-quality` | ✓ |
| **SRCQ-34** | A cluster lists the pages that actually matched and leaves out an original piece on a merged domain, which surfaces in the notes instead | unit: `source-quality` | ✓ |
| **SRCQ-35** | The type cannot express a result carrying only one of the two counts, and the not-applicable arm carries neither | unit: `source-quality` | ✓ |
| **SRCQ-36** | The hash matches the published FNV-1a 32-bit vectors on ASCII, and its documented divergence above U+007F is pinned so it cannot be changed unnoticed | unit: `syndication` | ✓ |
| **SRCQ-37** | The measured figures the documentation quotes are asserted as a range, so the claim cannot rot unnoticed | unit: `syndication` | ✓ |


### BENCH-03 — citation integrity

The sharpest instrument in the benchmark, and the one whose wrong answer is most expensive: reporting a network failure as a fabricated citation accuses a backend of exactly the thing this exists to detect. Every row below runs against an injected transport, an injected clock and a temporary directory, so the gate stays hermetic; live registry probes are a documented manual step and are never in the gate. The suffix names the file, `identifiers` / `containment` / `matrix` / `citations` under `bench/src/score/`, and `registries` / `cache` / `collect` / `evidence` under `bench/src/citations/`.

| AC | Criterion (from the contract) | Test | Status |
|---|---|---|---|
| **INTEG-01** | A known-good DOI scores `present` | unit: `registries` | ✓ |
| **INTEG-02** | A well-formed but non-existent DOI scores `absent`, and only once the handle directory confirms it | unit: `registries` | ✓ |
| **INTEG-03** | A DOI absent from Crossref but present in the handle directory scores `present`, never `absent` | unit: `registries`, `collect` | ✓ |
| **INTEG-04** | Every registry transport failure, timeout, 429 and 5xx scores `unchecked` | unit: `registries`, `collect` | ✓ |
| **INTEG-05** | An `unchecked` answer is excluded from the denominator of every rate | unit: `citations` | ✓ |
| **INTEG-06** | An `unchecked` answer is never written to the cache | unit: `cache`, `collect` | ✓ |
| **INTEG-07** | The same identifier across many reports is looked up once, and concurrent misses collapse onto one request | unit: `collect` | ✓ |
| **INTEG-08** | A cache entry is written atomically and Zod-parsed on read; a corrupt entry is discarded, not trusted | unit: `cache` | ✓ |
| **INTEG-09** | The per-registry minimum gap is respected across concurrent callers, and Crossref's gap reflects which pool the configured contact address puts the caller in | unit: `cache` | ✓ |
| **INTEG-10** | Crossref is addressed with the polite-pool `mailto` parameter | unit: `registries` | ✓ |
| **INTEG-11** | A PMID answer is decided by the body's `error` key, not by the 200 status | unit: `registries` | ✓ |
| **INTEG-12** | A CVE answer is decided by `totalResults`, not by the 200 status | unit: `registries` | ✓ |
| **INTEG-13** | An ISBN result is labelled catalogue presence in both directions, and a checksum failure is `invalid`, never `absent` | unit: `registries`, `identifiers` | ✓ |
| **INTEG-14** | An arXiv id is extracted with its version stripped, and a 429 is `unchecked` | unit: `identifiers`, `registries` | ✓ |
| **INTEG-15** | A bare number is not a PMID without its context word or host | unit: `identifiers` | ✓ |
| **INTEG-16** | An identifier carrying a path-traversal segment is refused before any request is built | unit: `registries` | ✓ |
| **INTEG-17** | Identifiers are found in the report's prose as well as in its linked addresses | unit: `identifiers` | ✓ |
| **INTEG-18** | Containment reports `supported` only when every checkable token is present | unit: `containment` | ✓ |
| **INTEG-19** | A statement with no checkable token is `unchecked`, never `unsupported` | unit: `containment` | ✓ |
| **INTEG-20** | A truncated page body with no match is `unchecked`, never `unsupported` | unit: `containment` | ✓ |
| **INTEG-21** | `28.6%` matches `28.6 percent`, and `1,200` matches `1200` | unit: `containment` | ✓ |
| **INTEG-22** | Containment is labelled as containment in the result and never as claim verification | unit: `citations` | ✓ |
| **INTEG-23** | An anchor present in the page's `id`/`name` set is honest; absent is missing | unit: `containment` | ✓ |
| **INTEG-24** | A text fragment, a PDF page fragment and a non-HTML body are `not-applicable` or `unchecked`, never `missing` | unit: `containment` | ✓ |
| **INTEG-25** | Statement segmentation ignores fenced code, headings and table separators, and does not split on a decimal or a common abbreviation | unit: `matrix` | ✓ |
| **INTEG-26** | A citation in the gap after a sentence terminator attaches to the preceding statement | unit: `matrix` | ✓ |
| **INTEG-27** | Citation accuracy is the elementwise product over the citations whose support could be **decided**, and is null when nothing was cited or nothing could be decided | unit: `matrix` | ✓ |
| **INTEG-28** | Citation thoroughness is that product over the support total across all pairs, and is null when the pair budget binds | unit: `matrix` | ✓ |
| **INTEG-29** | Source necessity is the source side of a minimum vertex cover of the **support** graph, as the paper defines it, and is null when nothing in that matrix could be decided | unit: `matrix` | ✓ |
| **INTEG-30** | Necessity reports that it is tie-dependent, and the canonical `uniquelyCitedSources` is reported beside it | unit: `matrix` | ✓ |
| **INTEG-31** | Uncited sources are the empty columns of the citation matrix | unit: `matrix` | ✓ |
| **INTEG-32** | A statement is unsupported only once something in its support row was decided, and one nothing could be decided about leaves the denominator; the divergence from the published relevance-filtered definition is stated | unit: `matrix`, `citations` | ✓ |
| **INTEG-33** | The relevance-dependent dimensions are reported unavailable with a reason, never approximated | unit: `citations` | ✓ |
| **INTEG-34** | Citation accuracy and citation volume are separate numbers on every result, including the unmeasurable arm | unit: `citations` | ✓ |
| **INTEG-35** | The support oracle's name rides on every result | unit: `citations` | ✓ |
| **INTEG-36** | The judged oracle is reachable by injection and no model is imported on the default path | unit: `citations` | ✓ |
| **INTEG-37** | Scoring is pure: every module under `bench/src/score/` imports no filesystem and no network, asserted by reading their own source | unit: `citations` | ✓ |
| **INTEG-38** | The same report and snapshot score identically twice | unit: `citations` | ✓ |
| **INTEG-39** | A report with no citations is `unmeasurable / no-citations` and still reports volume | unit: `citations` | ✓ |
| **INTEG-40** | With every network call failing, collection still returns a complete snapshot | unit: `collect` | ✓ |
| **INTEG-44** | A URL refused as private keeps the product's own `invalid_url` verdict, and a self-redirect loop keeps `blocked`, rather than both flattening to `unreachable` | unit: `collect` | ✓ |
| **INTEG-45** | The real fetch adapter refuses a link-local, loopback, private or non-http address before a socket is opened, and the refusal reaches the snapshot as `invalid_url` | unit: `live` | ✓ |
| **INTEG-46** | A transport that rejects rather than resolving costs one answer, never the whole snapshot, and never produces `absent` | unit: `live` | ✓ |
| **INTEG-47** | Collecting, writing, reading and scoring compose through one surface, and a snapshot collected from a different report is refused rather than scored against | unit: `live` | ✓ |
| **INTEG-48** | An arXiv feed whose entry names a different paper is `unchecked`, not `present` | unit: `registries` | ✓ |
| **INTEG-49** | `data-id`, a commented-out attribute and a string inside a script are not anchors | unit: `collect` | ✓ |
| **INTEG-41** | A truncated page body is carried as truncated through collection into the containment verdict | unit: `collect`, `containment` | ✓ |
| **INTEG-42** | Number and text matching goes through the shared primitives, so two slices cannot disagree about a thousands separator | unit: `containment` | ✓ |
| **INTEG-43** | An evidence snapshot read back from disk is Zod-parsed, and a malformed one is refused rather than scored against | unit: `evidence` | ✓ |
| **GROUND-01** | `research_ground` registers, appears in `tools/list`, and grounds a completed run with no manual export call in between | `grounding` acceptance | ✓ |
| **GROUND-02** | `destination` defaults to `local`, so an omitted argument cannot reach the upload path | unit: `grounding`, `grounding` acceptance | ✓ |
| **GROUND-03** | The local path writes into the first granted `DOSSIER_LOCAL_CORPUS_DIRS` root, under the fixed `dossier-grounding/` subdirectory, and names the root it chose | `grounding` acceptance | ✓ |
| **GROUND-04** | The local path takes no directory, filename or subdirectory from the caller: the tool schema has no such parameter | `grounding` acceptance | ✓ |
| **GROUND-05** | The local path completes with no credentials and opens no socket, asserted by a failing `fetch` that would throw if called | unit: `grounding` | ✓ |
| **GROUND-06** | With no root granted, the local path refuses and repeats the operator-grant rule rather than writing anywhere else | `grounding` acceptance | ✓ |
| **GROUND-07** | A run id that is not `[A-Za-z0-9_-]{1,64}` is refused before it reaches a path | unit: `grounding` | ✓ |
| **GROUND-08** | Grounding files are written `0600` inside a `0700` directory | `grounding` acceptance | ✓ |
| **GROUND-09** | The upload path names Google in the tool description, is annotated non-read-only, and requires an existing store rather than creating one | `grounding` acceptance, `protocol` | ✓ |
| **GROUND-10** | A prior Dossier report classifies as `private-user-owned` and `countsAsCorroboration` is false for it | unit: `grounding` | ✓ |
| **GROUND-11** | A claim in both the grounding report and the new report counts once: two runs citing one page plus the grounding report score `single-source` on one independent domain | unit: `grounding` | ✓ |
| **GROUND-12** | A claim supported only by the grounding report is `unsupported`, not corroborated: laundering scores zero independent domains | unit: `grounding` | ✓ |
| **GROUND-13** | `mergeEvidence` excludes a prior report from `independentDomains` while still listing it as a source | unit: `synthesise` | ✓ |
| **GROUND-14** | A grounded run declares its grounding in the header `research_read` returns and in the front matter and body `research_export` writes, naming the prior run ids | `grounding` acceptance | ✓ |
| **GROUND-15** | `groundedInRunIds` puts the prior-research rule in the prompt before the final `<core_directive>`, and nothing follows that anchor | unit: `prompt` | ✓ |
| **GROUND-16** | The prior-research prompt block carries no text from the prior reports | unit: `prompt` | ✓ |

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
| **READ-01** | An outline, summary or grep read counts as no coverage | `reading` | ✓ |
| **READ-02** | Coverage counts distinct sections, so re-reading one is not reading several | `reading` | ✓ |
| **READ-03** | A merge over unread reports warns at the top, and names what was never opened | `reading` | ✓ |
| **READ-04** | The read ledger is wired: a merge over unread reports warns over the real MCP surface | `reading` acceptance | ✓ |
| **CLI-32** | A CLI runs with stdin closed, in a scratch directory, not the client's project | `local-cli` | ✓ |
