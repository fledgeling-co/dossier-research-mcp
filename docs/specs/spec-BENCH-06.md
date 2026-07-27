# BENCH-06: Calibration and refusal correctness

**ID:** BENCH-06
**Status:** In Review
**Created:** 2026-07-27
**Last updated:** 2026-07-27
**Brief:** [BENCH-06](../features-to-triage/BENCH-06-calibration-refusal.md) · **Design of record:** [benchmark.md](../plan/benchmark.md) · **Prior art:** [benchmark-prior-art.md](../deep-research/benchmark-prior-art.md)

## Feature description

*(Verbatim from `docs/features-to-triage/BENCH-06-calibration-refusal.md`.)*

# BENCH-06: calibration and refusal correctness

## Calibration

Dossier requires a confidence qualifier on every non-trivial claim, which makes calibration measurable. Pair each stated confidence with whether its gold fact was recovered, and compute a Brier score across the suite.

A backend right 60% of the time that says High every time is worse than one right 55% whose Highs are right 90%. Nothing else in the suite captures that, and it is the difference between a report you can act on selectively and one you must verify entirely.

## Refusal correctness

Two families where the correct answer is not an answer.

- **False premise.** The question presupposes an event that did not occur. Gold: the report must not assert it. Checked by searching for the fabricated entity or date as an assertion.
- **No public footprint.** A real but genuinely undocumented subject. Gold: the report says so.

## Why these matter more than their share of the suite

These are the only categories where a long, confident, fluent report is the worst possible outcome. Every other metric rewards saying more; these two are the counterweight, and without them the benchmark quietly selects for confident verbosity.

## Acceptance

- Confidence markers are parsed from the report's own format, and a report with no markers scores unmeasurable rather than zero. Unmeasurable and badly-calibrated are different findings.
- A false-premise task where the backend correctly pushes back scores full marks even if it also says nothing else useful.

## Orphan: recency has no owner, and the rule it assumes does not exist

`benchmark.md` lists recency as a scored dimension and says the weighting rule already exists. BENCH-01 checked: `HORIZONS` is keyed by source type with **no standard-versus-benchmark distinction**, which is exactly the distinction the design describes ("a standard from 2019 is current, a benchmark from 2019 is not"). No fleet item owns building it.

Take it here, since calibration and recency both turn on whether a report's confidence is justified by what it read, or split it out and say so. What must not happen is it staying in the design as a scored dimension nobody built.

---

## Triage — 2026-07-27

**Ready for Implementation Plan**

*(No UI preview section: this repo has no user interface and no design system. Nothing customer-facing changes; the whole item is behind the scenes.)*

**Where it shows up**

- Nothing customer-facing changes. No MCP tool is added, removed or altered, and the product's own evidence grading is untouched.
- The people affected are the reporting item, which prints these numbers, and the corpus authors, whose false-premise and obscure-entity tasks are only scoreable because of what they wrote down.

**Behaviour changes**

- Three new pure scorers under `bench/src/score/`, reading a report's text and a loaded task, returning numbers computed by code from a gold set fixed before the run. No model, no network, no filesystem.
- **Calibration** pairs each stated confidence with whether the answer it was about was recovered, and returns a Brier score plus the reliability table underneath it. A report carrying no confidence markers is reported **unmeasurable**, and unmeasurable is a distinct outcome from badly-calibrated rather than a number.
- **Refusal correctness** grades the two families where the right answer is not an answer, on three outcomes rather than two, because "never mentioned it" is neither a correct refusal nor an asserted fabrication.
- **Recency** is taken here rather than left orphaned, and the missing durability rule is built: a standard from 2019 is current, a benchmark from 2019 is not.

**Assumptions**

- `[Data & scope]` Confidence markers are parsed from the four forms this product's own prompt architect asks for, and from nothing else. *(the acceptance says "the report's own format", and this repo defines that format in `src/research/prompt.ts` and `src/gemini/agents.ts`; inventing a fifth form would score a shape nobody was asked to produce.)*
- `[Data & scope]` A marker governs a span running from the marker to the next marker or the end of the enclosing paragraph, whichever comes first. A delimited tag governs exactly its own contents. *(a bullet is one line and a paragraph is blank-line delimited, so both are structural units rather than tuned windows.)*
- `[Data & scope]` An answer is paired to a marker by its human-readable label where it has one, and by its written value and alternate wordings where it does not. *(pairing on the value alone can only ever find answers the report got right, which would hide the confidently-wrong claim that calibration exists to catch; the label is the subject and survives a wrong answer.)*
- `[Data & scope]` A task whose answers carry no labels is reported as pairing by value, and the resulting bias is printed with the score rather than hidden. *(BENCH-01 made `label` optional; a scorer that silently degrades is worse than one that says it degraded.)*
- `[Data & scope]` Whether an answer was recovered is an **input** to calibration, not something it decides. *(the accuracy scorer is BENCH-04 and owns number formatting, unit handling and Unicode normalisation; two implementations of that rule would eventually disagree about what the rule is.)*
- `[Operations]` The recovery input is keyed by the stable answer id BENCH-01 made required, as a plain serialisable record. *(the smallest possible coupling to a sibling item, and the exact reason the id exists.)*
- `[Operations]` An answer with no recovery entry is counted `unresolved` and excluded from the Brier, never treated as wrong. *(a missing input from a sibling scorer must not silently become a penalty against the backend.)*
- `[Data & scope]` The confidence-to-probability map is a named exported constant (High 0.9, Medium 0.6, Low 0.3), stated in every result, and replaceable by the caller. *(a Brier score is meaningless without the map that produced it, and a reader who disagrees must be able to re-score a stored result without re-buying the research.)*
- `[Data & scope]` An explicit abstention such as `Confidence: N/A` is counted separately and never scored as a low probability. *(the 2026 literature is explicit that abstention handling is not interchangeable preprocessing; folding an abstention into a number answers a different question from the one asked.)*
- `[Data & scope]` A refusal task scores on three outcomes: `refused`, `unengaged`, `asserted`, worth 1, 0.5 and 0. *(the design's rule is "must not assert it", under which a report that never mentioned the subject passes; BENCH-01 added acknowledgement wording precisely because absence cannot tell a correction from an assertion. Both readings are served by carrying the raw outcome beside the number.)*
- `[Data & scope]` A report that fails to refuse **and** states High confidence is flagged overconfident. *(DeepTRACE's published Overconfident Answer dimension, adopted rather than invented, per the design's amendment of 27 July.)*
- `[Experience]` Recency is **taken here**, not split out. *(the orphan is closed rather than re-parked.)*
- `[Data & scope]` The durability distinction is built as a benchmark-owned classifier over cited URLs, and the product's `assessStaleness` is left exactly as it is. *(changing the product's horizons changes what `research_evidence` prints for every user, which is a product decision and not a benchmark item's to take.)*
- `[Data & scope]` A URL the durability patterns do not recognise is `unknown` and falls back to the existing source-type horizon. *(the same conservatism `classifySource` already uses: an over-eager classifier would let a report pad its recency with whatever happened to sit on a plausible-looking path.)*
- `[Data & scope]` An undated source is counted separately and never treated as current. *(`assessStaleness` already reaches this conclusion and says why; a recency figure that quietly counts undated as fresh is a measurement of nothing.)*
- `[Operations]` Every scorer is a pure synchronous function over strings and a loaded task. *(the loader was made pure for the same reason, and a scorer that needed a filesystem could not be exercised from a stored raw cell.)*
- `[Experience]` No task files are authored here. *(the corpus is BENCH-09; the fixtures in the tests are inline strings.)*

**Findings carried to the planner**

- *High, Engineering Readiness.* The pairing rule is the whole risk in calibration. Pairing on the answer's value can only match a report that already got the answer right, so a confidently-wrong claim would never be paired and the backend would never be charged for it. The label is therefore the primary key and the value is the stated fallback, and the fallback's bias is printed. This is the same polarity defect BENCH-01 fixed on the refusal arms, arriving in a different metric.
- *Medium, Engineering Readiness.* Returning zero for a report with no confidence markers would report the **best possible** Brier score, since a Brier of zero is perfect. Collapsing unmeasurable to zero does not merely lose a finding, it inverts it.
- *Medium, Operational.* Calibration depends on a sibling item for its recovery input, and BENCH-04 is being built concurrently. The coupling is deliberately one plain record keyed by the stable answer id, so neither side can drift into the other's shape.
- *Low, Operational.* The durability classifier is a coarse heuristic over URLs, exactly like `classifySource`. It is reported with its basis string so a wrong call is arguable rather than opaque.

## Plan — 2026-07-27

Implementation plan: [`docs/plans/plan-BENCH-06.md`](../plans/plan-BENCH-06.md) (Plan size: Standard).

## Progress — 2026-07-27

Recorded at the end of the run; see the section appended below.
