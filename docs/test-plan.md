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

## Coverage model — the axes

The QA plan's unit of work is a *surface × state* cell. For an MCP server the axes are:

| Axis | Values | Sampling |
|---|---|---|
| **Surface** | 20 tools · 6 resources · 3 prompts | 100%, enumerated from `tools/list` so a new tool cannot be missed |
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
| **PROTO-04** | All 6 resources and 3 prompts register and are readable | `protocol` | ✓ |
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

### The paid project

`tests/paid/` spends real money against the live API, so it is a **separate vitest project that is deliberately excluded from `test:all` and therefore from the gate**. It cannot block a deploy. It needs both `DOSSIER_PAID_TESTS=1` and a real `GEMINI_API_KEY`, and skips itself entirely without them.

```bash
DOSSIER_PAID_TESTS=1 GEMINI_API_KEY=... npm run test:paid
```

Roughly **$2–4** per full run at `fast` tier. `PAID-05` (the `max` tier, $3–7 on its own) needs a further `DOSSIER_PAID_MAX=1`, because it exercises the same code path with a different agent id and is rarely worth the money.

The suite gives itself a `DOSSIER_BUDGET_USD=15` ceiling so a bug in the tests cannot drain a real budget, and cancels every run it started in `afterAll`, because an abandoned run keeps billing.

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
npm test                    # unit + acceptance
npm run gate                # typecheck, lint, test, build
```
