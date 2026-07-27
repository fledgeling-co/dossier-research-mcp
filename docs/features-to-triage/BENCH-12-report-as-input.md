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
