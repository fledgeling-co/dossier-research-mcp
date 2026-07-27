# BENCH-12: A finished report is an input to the next one

**ID:** BENCH-12
**Status:** In Review
**Created:** 2026-07-27
**Last updated:** 2026-07-27
**Brief:** [BENCH-12](../features-to-triage/BENCH-12-report-as-input.md) · **Source note:** [source-notes.md](../reference/source-notes.md)

> **Not a benchmark slice.** This is the only fleet item that changes the shipped product. It lands in `src/`, reaches users, and therefore carries the product obligations `CLAUDE.md` states: a CHANGELOG entry in the same change, `docs/tools.md` updated because it owns the tool contract, and `docs/security.md` updated because the egress story changes.

## Feature description

*(Verbatim from `docs/features-to-triage/BENCH-12-report-as-input.md`.)*

# BENCH-12: a finished report is an input to the next one

*(Not a benchmark slice. Filed here because it is the same size as one and the pipeline is already running.)*

## The gap

`research_export` writes a finished report to disk. `corpusStores` grounds a run in a File Search store. **Nothing connects them.** To use what you just learned as input to the next question you export by hand, upload by hand, and remember the store name.

So Dossier's own output is the one kind of evidence it cannot easily consume, and a second question on the same subject starts from nothing.

## Where the idea comes from

Bridgewater's Pocket Analyst writes its analysis outputs back into the same database it read its inputs from. Two consequences they name, both of which apply here:

> any output from a PAT analysis is indistinguishable from any of the human uploaded series that we've been producing for many years

> any output from a PAT analysis can serve as an input to a subsequent one ... humans and agents can very easily compound and leverage each other's work

The second is the one worth having. A research tool whose findings do not accumulate makes every question the first question.

## What to build

`research_ground { runIds }`, which takes one or more completed runs and makes them available as grounding for the next run, without the export-and-upload round trip.

Two implementations, and the choice matters:

- **Local**, into the operator's `DOSSIER_LOCAL_CORPUS_DIRS`. Nothing leaves the machine, works with no key, and is searched by the existing `corpus_local_search`. This should be the default.
- **Uploaded**, into a Gemini File Search store. Needed for hosted grounding, and it **sends the report to Google**, so it must say so in the tool description and never be the default. The rule from `CLAUDE.md` applies directly: a tool that sends data to a third party says so.

## The rule this must not break

A report Dossier produced is **not** independent corroboration of anything in it. If run B is grounded in run A's report and both cite the same source, that is one source, and `countsAsCorroboration` must keep saying so.

Worse, a grounded run can launder a claim: A asserts something weakly supported, B reads A and repeats it, and the assertion now appears in two reports. That looks like accumulation and is actually amplification.

So every claim carried in from a grounding report keeps its provenance and its original confidence, and a run grounded in prior Dossier output says so in its own header. **A report that grounds a later run is a user's own document under the existing circular-verification rule**: valid primary evidence about what was previously concluded, never independent evidence that the conclusion was right.

## Acceptance

- Grounding a run in a prior report requires no manual export step.
- The local path works with no API key and sends nothing anywhere.
- The uploaded path names the third party in the tool description and is never the default.
- A claim appearing in both the grounding report and the new one counts once, proven by a fixture.
- A report grounded in prior Dossier output declares that in its header, so a reader can tell accumulated evidence from an echo.

---

## Triage — 2026-07-27

**Ready for Implementation Plan**

*(No UI preview section: this repo has no user interface and no design system. The user-visible surface is an MCP tool description and the text a tool returns, and both are specified below.)*

**Where it shows up**

- One new tool, `research_ground`, in the corpus family. It is the only new surface.
- Two existing tools grow one optional argument each: `research_plan` and `research_start` take `groundedInRunIds`.
- Two existing tools grow output: `research_read` and `research_export` declare grounding in the header of what they return or write.
- `corpus_local_search` gains nothing and changes nothing. It simply starts finding the reports `research_ground` wrote, because they are ordinary markdown inside a directory the operator already granted.

**Behaviour changes**

- `research_ground { runIds }` takes one to six completed runs and makes each available as grounding for the next run. It defaults to the **local** destination and never uploads unless the caller asks for `destination: "upload"` by name.
- The **local** destination writes each report into a fixed `dossier-grounding/` subdirectory of the **first** granted `DOSSIER_LOCAL_CORPUS_DIRS` root. It needs no credentials, opens no socket, and the caller cannot name the directory.
- The **upload** destination writes the same document to a File Search store, which **sends the report to Google**. The tool description says so, the annotation is non-read-only, and the caller must name an existing store.
- `research_start { groundedInRunIds }` records the grounding on the run, adds a `<prior_research>` block to the prompt carrying the anti-laundering rule, and makes every downstream presentation of the report declare it.
- A source that is a prior Dossier report never counts toward independent corroboration, anywhere the product states an independence number.

**Assumptions**

- `[Security]` The local destination writes **into** an already-granted root and the caller cannot choose which directory, which file name, or which subdirectory. *(`CLAUDE.md`: nothing that reads local files may be pointed anywhere by an agent, and `DOSSIER_LOCAL_CORPUS_DIRS` is deliberately operator-set with no tool that adds one. A write primitive an agent can aim is strictly worse than a read primitive an agent can aim, so the same boundary applies with the same force.)*
- `[Security]` The root used is `localCorpusDirs[0]`, the first one the operator listed, and the tool prints which root it chose. *(picking one is unavoidable; letting the caller pick is the thing being prevented. Announcing it means the operator can reorder the variable if they want a different one, which keeps the choice with the human.)*
- `[Security]` The subdirectory is the constant `dossier-grounding` and the file name is `dossier-run-<runId>.md`. *(one fixed, obvious, greppable location, so an operator can see and delete everything the tool ever wrote with one command.)*
- `[Security]` A run id is checked against `/^[A-Za-z0-9_-]{1,64}$/` before it is used to build a path, even though the id must already resolve to a stored run. *(defence in depth against path traversal, CP §4 A03. The lookup would fail on a traversal id anyway; relying on that is relying on a property of another function.)*
- `[Security]` Grounding files are written `0600` inside a `0700` directory. *(the July 2026 review found store files inheriting the umask and made reports `0600`; a report copied out of the store must not become world-readable on the way.)*
- `[Data & scope]` The local destination is proven to send nothing by a test that installs a failing `globalThis.fetch` and fails if it is called. *(the acceptance says "sends nothing anywhere", which is an assertion about behaviour rather than about intent, and only a test that would notice can make it.)*
- `[Data & scope]` `destination` defaults to `local` in the Zod schema, so an omitted argument cannot reach the upload path. *(the acceptance says the uploaded path is never the default; a default in the schema is the only place that cannot be forgotten.)*
- `[Data & scope]` The upload destination requires an existing `storeName` and never creates a store implicitly. *(a tool that silently creates a remote resource as a side effect of a grounding request is doing a second thing the caller did not ask for. `corpus_create` already exists and is one call.)*
- `[Data & scope]` A prior report is addressed by the canonical URI `dossier://run/<runId>`, and the same document is recognisable by its file name `dossier-run-<runId>.md`. *(a stable identifier is what lets the corroboration rule bite without a lookup: `countsAsCorroboration` is pure over one classified source and cannot consult a store.)*
- `[Data & scope]` `classifySource` recognises that URI without being told, and returns `private-user-owned` with a basis naming it a prior Dossier report. *(auto-detection cannot be forgotten at a call site; an opt-in flag can, and there are already two such flags in that signature that no production path sets.)*
- `[Data & scope]` The independence rule is applied where the product states an **independence** number, which is `assessSupport` and `mergeEvidence.independentDomains`, and not to `profileEvidence`'s source mix. *(the mix is a description of what was read, and a prior report was genuinely read. The floors are advisory and never refuse. Stated here so it is a decision rather than an oversight; the mix shows the prior report classified as yours, which is the honest rendering.)*
- `[Data & scope]` The `<prior_research>` prompt block carries **no text from the prior reports**, only their number and the rule. *(sending a locally-grounded report's content to a provider inside the next prompt would break the promise the local path just made. It also does not fit: a report is ~60,000 tokens.)*
- `[Experience]` "In its header" is implemented as: the front matter and banner of the exported file, the banner `research_read` returns above the report, and the front matter of the grounding document itself. *(a header the model was asked to write is a header that sometimes is not there. These three are written by code and are the same declaration in three places.)*
- `[Experience]` The declaration names the prior run ids, so a reader can go and read the echo for themselves. *(the acceptance is that a reader can tell accumulated evidence from an echo, which needs the pointer as well as the warning.)*
- `[Operations]` `groundedIn` is an optional array on `RunRecord`, absent on every record written before it existed. *(the same reasoning `panelId`, `model` and `repeat` already use: a migration that invalidated existing runs would lose reports people paid for.)*
- `[Operations]` `groundedInRunIds` changes the prompt, and the prompt is already hashed into the contract fingerprint, so the handshake binds it with no change to `contract.ts`. *(a plan for an ungrounded run must not start a grounded one; getting that for free is the argument for putting the declaration in the prompt.)*
- `[Operations]` The local path is a synchronous filesystem write with no network and no credentials, so it works with `auth.mode === 'none'` and under `DOSSIER_HERMETIC=1`. *(the acceptance says "works with no API key"; hermetic mode is how the test suite proves it.)*

**Deliberately out of scope**

- Automatic grounding. A run is grounded because a caller asked for it, never because a previous run existed on a similar subject. Guessing which prior work is relevant is a research judgement, and a wrong guess is precisely the amplification failure this item exists to prevent.
- Grounding a run in a report Dossier did not produce. `research_import` already brings an outside report in as a normal run, and a normal run can be grounded in.
- Deleting or expiring grounding documents. They are ordinary files in a directory the operator owns; a tool that deletes files from a granted root is a new primitive and a separate decision.
- Changing `profileEvidence`'s advisory floors, per the assumption above.

## Codex cross-family review

**Requested lane:** `gpt-5.6-sol`, `max` effort, read-only, spec against the codebase.
**Outcome:** `unavailable → claude`. No Codex lane was free in this fleet batch, matching the logged downgrade BENCH-06 recorded for the same reason. The review was run by an independent reviewer with fresh context and is carried into the pre-merge evidence as a **known weakness**: every reviewer on this item is Claude reviewing Claude.

Findings dispositioned:

1. **Accepted.** A write into a granted root is a new primitive and the brief only constrains where. Answered by the fixed subdirectory, the fixed file name, the announced root, and the id shape check.
2. **Accepted.** `mergeEvidence.independentDomains` counted every domain, so a `dossier://` reference would have added one. Fixed at the same time as `assessSupport`, because a rule enforced in one of two places is a rule that will be found broken in the other.
3. **Accepted.** `research_read` had no place for a header; the provenance block is a footer. Added as a banner above the body in every mode that returns one.
4. **Rejected, with a reason.** "Create the File Search store when it is missing." Declined: see the assumption above. A grounding request must not create a remote resource as a side effect.
5. **Accepted.** The `<prior_research>` block must sit before the final `<core_directive>`, on exactly the rule `tests/prompt.test.ts` already locks. Built that way and tested.
