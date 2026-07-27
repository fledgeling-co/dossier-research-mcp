# BENCH-09: The seed task corpus

**ID:** BENCH-09
**Status:** In Review
**Created:** 2026-07-27
**Last updated:** 2026-07-27
**Brief:** [BENCH-09](../features-to-triage/BENCH-09-seed-corpus.md) · **Design of record:** [benchmark.md](../plan/benchmark.md) · **Format:** [task-format.md](../bench/task-format.md)

## Feature description

*(Verbatim from `docs/features-to-triage/BENCH-09-seed-corpus.md`.)*

# BENCH-09: the seed task corpus

## What

The hand-authored gold sets. Ten categories, ten tasks each, to start.

| Category | What it separates |
|---|---|
| Time-bound | Enforced date windows from asked-for ones |
| Enumeration | Matrix completeness, every cell filled or marked unknown |
| Legal and regulatory | Precision and official-source reliance |
| Primary literature | Real DOIs, and reading past the abstract |
| Social and sentiment | The only category where X access matters |
| Technical | Issue trackers, changelogs, version specifics |
| Obscure entity | Correctly reporting nothing found |
| False premise | Refusing a fabricated presupposition |
| Contested | Due weight, both figures, dissent retention |
| Settled-with-fringe | The false-balance counterweight |

## This is the bottleneck and the weak point

A hundred hand-built gold sets is the long pole, and a thin suite produces confident rankings from too little evidence. Better to ship six categories properly authored than ten padded out.

## Rules for an admissible task

- Its answer is checkable by a string, a number, a set membership or an HTTP request. If it is not, it does not go in.
- Every gold fact carries the primary source it came from, so a disputed score can be adjudicated against the source rather than against the author's memory.
- `asOf` and `reverifiedAt` are both set, honestly.
- No task whose answer a frontier model already knows without searching, or the benchmark measures recall of training data rather than research.
- **A new task must be shown to fail before it is admitted.** Run it against at least one backend and confirm it does not already pass. A task that is green the day it is written is testing nothing, and a suite of them reports a score that cannot move.

  Borrowed from Bridgewater's Pocket Analyst, whose teach loop authors a benchmark *expected to fail* to prove the bad behaviour reproduces, fixes until it passes, then confirms the rest of the suite still passes. The order is the load-bearing part: a fix validated only by a test written after it is a fix validated by its own author.

## Acceptance

- Every task in the corpus loads, and a scripted dry run confirms each gold fact is actually present in its cited source at authoring time. A gold set that was wrong on the day it was written poisons every run afterwards.

### Fleet context carried with the brief

- Quality beats quantity, and the brief says so. Six categories authored properly beats ten padded out. The prior art judges every published task set underpowered and puts the real target near a thousand; this item will not reach that, and must not pad toward a hundred at the cost of correctness.
- BENCH-01 is merged and `bench/src/tasks/schema.ts` is the contract. Use the fields it provides rather than working around them: a required unit and tolerance on every numeric answer, stable per-answer ids, a structured source, an enumeration grid, and `topic` for statistical clustering.
- Running tasks against a backend to prove they fail may spend money or subscription quota. Prefer a free CLI backend, report what was spent, and never run the whole corpus against a paid backend to satisfy the fail-first rule.

---

## Triage — 2026-07-27

**Ready for Implementation Plan**

*(No UI preview section: this repo has no user interface and no design system. Nothing customer-facing changes.)*

### What the codebase already gives this item

- `bench/src/tasks/schema.ts` and `bench/src/tasks/index.ts` — the format, and `loadCorpusFromDirectory`. The corpus is authored against them and never re-parses YAML itself.
- `src/net/safe-fetch.ts` — SSRF-safe fetch with DNS validation, per-hop redirect checks and a body cap. The gold-verification pass has to dereference author-supplied URLs, which is precisely the shape that rule guards, so it reuses that fetch rather than calling `undici` directly.
- `src/research/citations.ts` — already dereferences cited URLs and classifies the outcome. The verifier borrows its posture (a blocked or unreachable source is not the same answer as a missing fact) rather than its code, because it is answering a different question.

### Assumptions taken

1. **Immutable, post-cutoff facts.** Every gold fact is anchored on a dated event from June or July 2026 whose value cannot change retroactively — a release date, a published CVSS score, a Federal Register citation, a DOI. Two properties fall out of that choice at once: the fact is later than a frontier model's training cutoff, which is the exclusion rule, and it does not rot the way "the latest version" would, which is what keeps `reverifiedAt` meaningful.
2. **Machine-readable primary sources.** Where a subject's human-facing page is JavaScript-rendered (NVD is the clear case), the cited source is the publisher's own API endpoint rather than its web UI. It is the same publisher and the same authority, and it is the version a second person — or a script — can actually check.
3. **Eight categories, not ten.** `social-sentiment` and `settled-with-fringe` are deliberately empty. Neither can be authored to the admission bar from here: a social-sentiment gold fact needs live X access to establish, and a settled-with-fringe task needs a documented fringe claim on a settled question, which means citing a source published to mislead. Recorded as a gap rather than padded.
4. **Fail-first is checked in two layers.** A closed-book layer over the whole corpus establishes that the answer is not already in the weights; a search-enabled layer over a stratified sample establishes that a real backend does not already pass. Both run against a free CLI backend.

### Non-goals

No scoring. No harness. This item produces YAML task files, the script that proves them true against their own sources, and the script that proves they are not already passed.

---

## Progress — 2026-07-27

**Status: In Review.** Verification green. Not rebased, not merged, not pushed.

### What shipped

| | |
|---|---|
| Authored | 27 tasks, 8 categories, every fact anchored on a June or July 2026 event |
| Gold verified | 82 of 82 source checks proven against live publisher sources |
| Closed-book fail-check | 0 of 27 answerable from a frontier model's weights |
| Search fail-check | 23 of 27 already passed by Claude Code; 20 of those also by Codex |
| **Admitted** | **7 tasks, 4 categories** (technical, contested, obscure-entity, false-premise) |
| Quarantined | 20, with their verified gold sets and the per-backend evidence |

### The finding

The corpus was authored to be verifiable and that made it trivial. Every fact
sits in one machine-readable primary source at a stable URL, so an agent with
web access fetches the source once and reads the answers off it. That is a
lookup; a research benchmark cannot measure it. The prior art names the fix,
LiveDRBench's problem inversion, and this item did not apply it.

The three shapes that survived both backends are worth carrying into the rework:
a question whose answer is an **absence**, a question that requires **searching
by properties rather than by identifier**, and a **fabricated premise** — all
three defeated at least one backend, and the pure lookups defeated neither.

### Two things for the design owner, not for this item

1. **Rule 4 and purpose 2 of `docs/plan/benchmark.md` conflict.** The design makes
   the free local loop the benchmark's control and wants to know whether it
   scores close to a paid backend. The strictest reading of the fail-first rule
   excludes every task the control passes, which forces the control to zero. The
   reading applied here is "at least one probed backend must not already pass";
   the stricter reading admits four rather than seven and the evidence names
   which.
2. **A literal acknowledgement-term check cannot separate asserting an absence
   from discussing one.** A hedging model writes "the record carries no
   effective date" while explicitly declining to assert it, and the check scored
   that as a correct refusal. Owned by BENCH-06, which scores refusal; recorded
   in `docs/bench/task-format.md` and worked around here by reporting
   `not-applicable` rather than by weakening the task.

### Deliberately not done

- `social-sentiment` and `settled-with-fringe` carry no tasks. The first needs
  live X access to establish a gold fact; the second needs a documented fringe
  claim on a settled question, which means citing a source published to mislead.
  Recorded as a gap rather than padded.
