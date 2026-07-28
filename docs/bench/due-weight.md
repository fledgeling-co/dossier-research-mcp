# Due weight: the viewpoint-coverage scorers

The failure this measures is **consensus collapse**: a genuine minority or dissenting position dropped because the weight of published material sits on the other side.

It is scoreable without a model only because the task author names the dissent in advance, at a known URL with a distinguishing term, when the gold set is written. At scoring time there is nothing to judge and everything to look up.

The design this implements is [`docs/plan/benchmark.md`](../plan/benchmark.md), section 4. The fields come from [`docs/bench/task-format.md`](task-format.md). The code is `bench/src/score/due-weight/`.

## Three metrics, and why the third one is the whole point

| Metric | Reads | Asks |
|---|---|---|
| Dissent recall | `knownDissent` | Did the report reach the dissenting source, by citing it or by using its distinguishing term? |
| Conflict acknowledgement | `conflictingFigures` | Where two authoritative sources give different figures, did the report carry both, or flag the disagreement? |
| False-balance guard | `fringeClaims` | On a question that is settled, did the report present a documented fringe claim as though it were contested? |

The first two, **on their own, reward hedging**. A backend that presents every question as contested cites every dissent, uses every distinguishing term and states every figure. It scores perfectly on both and is useless. The guard is the counterweight, and it is what makes due weight mean *due* rather than *equal*.

That is not an argument in a document. `bench/src/score/due-weight/hedging.test.ts` runs two backends written as functions of the task over a mixed corpus, and measures it:

| Backend | Dissent recall | Conflict acknowledgement | False balance | Overall |
|---|---|---|---|---|
| Hedges everything | 1.00 | 1.00 | 0.00 | **0.00** |
| Weighs the evidence | 1.00 | 1.00 | 1.00 | **1.00** |
| Hedges half the settled questions | 1.00 | 1.00 | 0.50 | **0.75** |

The hedger's recall is *equal* to the honest backend's, which is the point: the first metric cannot tell them apart, and is not supposed to.

## How the overall is computed, and when it is refused

Two decisions follow from the guard living on different tasks from the other two metrics.

**The overall is a suite-level number, not a per-task one.** The guard is recorded on `settled-with-fringe` tasks and the other two on `contested` tasks, so no single task can carry all three. A per-task overall could not express the trade at all.

**Each metric counts once, and the three are combined by harmonic mean.** Averaging over tasks lets ninety contested tasks drown ten fringe tasks, which is the dilution the guard exists to prevent. And the arithmetic mean of the hedger's three numbers is 0.67, a passing grade for a backend that calls every settled question open. The harmonic mean reads the same three numbers as 0. It is the only common aggregation where being excellent at two of three things and useless at the third does not average out to respectable.

The cost is stated rather than hidden: the harmonic mean collapses to 0 whenever any component is 0, so a perfect hedger and a backend that found nothing at all both score 0 overall. Every component is reported beside it, so nothing is concealed. The overall's job is to refuse to rank a hedger above an honest backend, not to rank two different failures against each other.

**When no task in the set recorded a fringe claim, the overall is withheld.** Not reported with a caveat: withheld, with `overall: null` and a reason. Without the counterweight the number rewards indiscriminate hedging, and a caveat printed beside a number is read as a number. The two metrics that could be measured are still reported: withholding the headline is not refusing to report anything.

## What each metric does, exactly

### Dissent recall

Per recorded dissent, the report reaches it by **citing the source** or by **using the distinguishing term**. The result says which: `url`, `term`, `url-and-term` or `missed`. The task's score is reached over recorded.

A source is matched on its canonical URL, using the product's own `canonicaliseUrl`, so tracking parameters, a `www.` prefix, a trailing slash and a fragment are all ignored. The `http`/`https` fold is layered on top: `canonicaliseUrl` deliberately preserves the scheme, because it exists to count *independent sources* for corroboration and there two schemes are two strings. For reaching one document they are the same page. That fold is `bench/src/score/source-identity.ts`, one implementation shared with `bench/src/combine/` since BENCH-15, and the file records which scorers deliberately do not apply it.

### Conflict acknowledgement

Per recorded conflicting figure, graded four ways:

| Outcome | Meaning | Score |
|---|---|---|
| `both-figures` | Every recorded value found in the report under its own tolerance | 1 |
| `flagged-only` | Not every value found, but the disagreement flagged near the quantity | 0.5 |
| `one-sided` | Exactly one value found, no flag. **This is the named failure** | 0 |
| `unaddressed` | No value found and no flag; the report never went near the quantity | 0 |

`one-sided` and `unaddressed` score the same and are named apart deliberately. One is a report that picked a side of a disagreement it never disclosed; the other never approached the subject. A scorecard that conflates them tells the reader less.

A stated number is **claimed by at most one gold value**. Without that rule, two values whose tolerances overlap are both found in a report that stated a single number, and a one-sided report scores full credit for disclosing a disagreement it never mentioned.

The assignment is a maximum matching, not a greedy pass. Claiming greedily in the order the author wrote the values enforces the rule but answers the wrong question: a loose value can take the one mention a tighter value uniquely needed, and a report that did state both figures is then reported one-sided. That error runs in the direction this benchmark is most careful about, because a false negative makes every backend look worse than it is.

### The false-balance guard

Per recorded fringe claim:

| Outcome | Meaning | Score |
|---|---|---|
| `not-surfaced` | The report neither uses the distinguishing term nor cites the fringe source | excluded |
| `surfaced-and-rejected` | It was raised, and a recorded rejection cue is attributed to it | 1 |
| `surfaced-as-contested` | It was raised with no rejection cue attributed to it. **This is the failure** | 0 |

Mentioning a fringe claim in order to dismiss it is correct behaviour, and on a bare string search it is indistinguishable from presenting it as contested. `rejectionCues` on the task is what makes the category scoreable at all.

**The denominator is the claims the report raised, not every claim the task records.** A claim nobody mentioned is a non-event, not a credit. Averaging over all of them lets an unraised claim pay for one that was framed as live: a task recording twenty fringe claims where the report presents one as contested would score nineteen twentieths, and a whole suite's overall would land near 0.98 for a backend doing exactly what this guard exists to catch. The question asked is instead: of the fringe claims this report chose to raise, how many did it frame as settled rather than live? A task where nothing was raised scores 1 and is reported as a guard that did not run.

**A perfect guard score is ambiguous on its own, so the summary also reports `guardExercised`.** A report that says nothing at all scores 1 here, and correctly: it did not present a fringe claim as contested. So does a report that engaged with the question properly. The two are only separable by reading dissent recall beside the guard, which is exactly what the overall does. `guardExercised` is false when no report in the set raised any recorded fringe claim, which means the guard passed without anything ever putting it to the question, and a limit says so rather than letting a clean column imply a test that happened.

## The limits, stated

Every one of these travels in the scorer's own output as well as living here, because a limit in a document nobody opens is not a limit anyone knows about.

- **A synonym does not score recall.** Only the literal distinguishing term and the exact cited URL count. A report reaching the same position in its own words scores zero, and that is a floor on what this metric can claim, not a claim about the report.
- **Another rendering of the same document does not count.** The same paper at `/abs/` and at `/html/` is two URLs. Equating them would need a mirror list or a model.
- **A disagreement counts as flagged only in a fixed vocabulary.** The task schema records the clashing figures but no wording for a flag, so the scorer carries an enumerated cue list, matched within a stated distance of the quantity as the task names it or of a figure the report did state. Other phrasings score as not flagged.
- **The declared unit does not gate a figure match.** It is reported where it sits beside the figure. Requiring the unit token would miss every figure written with a currency symbol, and a false negative makes every backend look worse than it is.
- **A rejection cue belongs to the claim it follows.** A report states a claim and then dismisses it, so a cue is attributed to the nearest claim raised before it, and only to the nearest one after it when nothing precedes it in the window. Reading direction is what separates a report dismissing four claims in sequence, which is credited for all four, from one debunking sentence covering six claims presented as live, which is not. The cost: `neither X nor Y holds up, there is no evidence` credits only the nearer of the two.
- **A claim is raised by its literal term or by a citation of its source.** A report that paraphrases the claim in its own words and cites nothing is invisible to the guard, which is the same limit dissent recall carries and for the same reason: the distinguishing term belongs to the gold set, not to the backend.
- **A fringe claim recorded with no rejection cues scores zero on any mention**, and the output names that task. A score over a check that could not discriminate must not read like a score over one that could.
- **A number in prose is often not a number, and the exclusions are listed.** ISO, slashed and written-out dates are masked whole before anything is read, along with clock times and URLs. A hyphenated token such as `COVID-19` or `F-16` yields nothing, because the digits name the thing rather than measure it. A version string, an ordinal, a decade, a fraction and a unit suffix such as `5km` all yield nothing. A genuine range such as `1150-1200` and `50-60%` yields both numbers, because a range is exactly how a report writes two figures that disagree. The shapes are `bench/src/score/noise-shapes.ts`, shared with the accuracy scorer since BENCH-15; before that the two masks disagreed in both directions, and this one blanked a real figure beside any word merely beginning with a month abbreviation, `novel 2026` among them.
- **An accounting negative in parentheses is read as positive.** `(1.2 billion)` means a loss in a filing and an aside in prose, and nothing local distinguishes them.
- **A magnitude word is applied by shifting the decimal point, not by multiplying.** Measured rather than assumed: `1.07 * 1e9` is `1070000000.0000001`, so a report stating the gold value perfectly would fail an `exact` tolerance.
- **The magnitude vocabulary is shared with the accuracy scorer; where a word may sit is not.** One table, `SCALE_WORDS`, since BENCH-15. What stays local is the attachment policy, and the reason is structural: the accuracy scorer has a unit model, so it reads an ambiguous suffix both ways and lets the gold fact's unit decide, while this scorer produces one reading and has to choose. So a spelled-out word counts attached or after a space, an abbreviation counts attached, and after a space only `mn`, `bn` and `tn` count, because those name no unit. `mm` is in the shared table for the accuracy scorer and excluded here: `5mm` is millimetres far more often than five million, and admitting the word would turn a silence into a spurious five million, which is the error this scorer is most careful about.

## Using it

```ts
import { scoreDueWeight, aggregateDueWeight } from '../../bench/src/score/due-weight/index.js';

const results = tasks.map((task) => scoreDueWeight(task, { text: reportMarkdown }));
const summary = aggregateDueWeight(results);

summary.overall;        // null when the guard did not run
summary.overallReason;  // why, in words
summary.limits;         // what was measured, and what was not
```

The report shape is `{ text, citedUrls? }` and is structural on purpose: the run harness can satisfy it without importing anything from here. When `citedUrls` is omitted it is derived from the text with the product's own `extractCitedUrls`, which is what stops a report and its citation list disagreeing.

Eligibility comes from the loader's `applicableMetrics` and is never re-derived. A metric a task cannot support is returned as unmeasured with a reason, never as a zero, and is excluded from that metric's denominator, because a refusal task counted as a zero would report every backend as worse than it is.
