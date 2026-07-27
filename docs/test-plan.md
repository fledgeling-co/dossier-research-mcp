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
