# Reporting and comparison

How stored benchmark cells become a report a person can act on, and every place that report refuses to answer.

The code is [`bench/src/report/`](../../bench/src/report). The design it serves is [`../plan/benchmark.md`](../plan/benchmark.md). The rule it exists to enforce is one sentence: **never report a ranking the sample cannot support.**

---

## The shape

```
bench/src/report/
  metrics.ts    the registry. Id, family, direction, and what each number cannot mean
  spread.ts     median, quartiles, and the floor a spread has to clear
  harvest.ts    one stored cell to one row of numbers
  aggregate.ts  three stages, and both refusal rules
  rank.ts       the ordering, and the five conditions under which there is not one
  render.ts     markdown and JSON
  cli.ts        the only file here that opens anything
```

Everything except `cli.ts` is pure. No filesystem, no network, no model, no wallet, and a test asserts it by reading their own source rather than by saying so here.

That is not tidiness. `benchmark.md` separates the run from the scoring so that a metric invented in three months can be applied to research already paid for, and that property is only real if rendering needs nothing but stored bytes. The moment one of these modules reads a disk, re-scoring a stored run stops being free.

Nothing in this slice can spend money. There is no code path from it to `Runner.start`, and a test asserts that too.

## Running it

```bash
npx tsx bench/src/report/cli.ts --cells bench/results/cells.jsonl > report.md
```

| Flag | Default | What it does |
|---|---|---|
| `--cells <file>` | `bench/results/cells.jsonl` | the JSONL cell store to read |
| `--tasks <dir>` | `bench/tasks` | the corpus, for categories and staleness |
| `--store <dir>` | `$DOSSIER_STORE_DIR` | the Dossier store; `reportPath` is relative to it |
| `--evidence <dir>` | beside the registry cache | BENCH-03's snapshots, keyed by cell key |
| `--min-tasks <n>` | 5 | tasks a category needs before it is scored |
| `--min-completion <s>` | 0.6 | share of attempted cells a backend must complete before its figure is a number rather than `invalid` |
| `--format <fmt>` | `markdown` | `markdown` or `json` |
| `--as-of <date>` | today | the date staleness is measured against |

The report goes to stdout; every diagnostic goes to stderr. An unknown flag is refused rather than ignored, for the same reason the run CLI refuses one: a dropped `--min-taks` would silently render against the default floor and publish a score the operator thought they had withheld.

`--as-of` is echoed on the report, because staleness is measured against it and a report that does not say which day it was rendered for cannot be compared with the next one.

## What is measured

Sixteen metrics in three families. The family is not decoration; it decides what may be done with the number.

| Family | Direction | May be ranked |
|---|---|---|
| `quality` | `higher` or `lower` | yes |
| `volume` | `none` | **no** |
| `validity` | `none` | **no** |

`direction: 'none'` is the mechanism. `rank.ts` calls `isRankable` and refuses anything without a direction, so a count cannot become a leaderboard by anybody's later convenience. There is **no blended score** anywhere in this slice, and that is a decision rather than an omission: the prior art's own inference is that citation count and citation correctness are close to orthogonal in current systems, that human preference tracks the count, and that a harness must report accuracy and volume as separate axes and never a blended one.

Quality: accuracy, relevance, calibration Brier, refusal correctness, dissent recall, conflict acknowledgement, false-balance guard, citation accuracy, citation thoroughness, source necessity, resolvability.

Volume: sources cited, citations per statement, independent domains, independent domains after syndication is collapsed, report length.

Each carries a caveat that is printed under every table it appears in, so the number and the thing it cannot mean travel together.

## Aggregation, in three stages

Taken from FutureSearch's published practice of averaging first within a task category and then across, which is what stops a large category dominating a backend's figure.

1. **Cell group.** One task on one backend, over its repetitions. The spread here is across repetitions and describes the backend's non-determinism.
2. **Category group.** One backend in one category, over stage 1's medians. The spread here is across tasks and describes something else entirely, so the two are labelled rather than left to be confused.
3. **Backend overall.** The median of stage 2's medians, over the **scorable** categories only, always carrying the list of the ones excluded and why.

## The two refusals

### The ranking

An ordering is emitted only when all of these hold, and the report names the one that failed when it does not:

1. **The metric has a direction.** A volume or validity figure is never ordered.
2. **The scope is scorable.** A category below the task floor cannot produce an ordering, however many repetitions each backend ran.
3. **Something was measured at all.** Reported as its own condition, because "nobody could be compared" reads as a sampling problem when the truth is that the metric was never measured here, and those have different fixes.
4. **Every candidate clears the spread floor, at both stages.** The value must have a reportable spread, **and** the repetitions behind it must clear the floor.
5. **At least two candidates remain.**

Condition 4's second half is the one worth reading twice, because a two-stage aggregation hides it. A backend run **once** per task across six tasks has a perfectly good six-task spread. That spread is real, and it describes how much the category varies. What it says nothing about is how much the backend varies between two runs of the same task, which is the thing repetitions exist to measure and the thing `benchmark.md` means when it calls a single run per cell a rank ordering of noise. Without the second check, the brief's headline case would have passed silently: a plausible ranking assembled out of single runs, printed by the tool whose whole purpose is to refuse one.

The floor is taken over the **weakest** task rather than the average, because one task run once is enough to make the figure partly an ordering of noise, and a rule that averaged that away would only bite when it did not matter.

Even when all five conditions pass, two adjacent backends the sample cannot separate are reported **tied at this sample size** rather than ordered.

**Amended 28 July 2026 by BENCH-13.** What decides that is now a paired difference with a cluster-bootstrap interval, over the tasks both backends answered, and the interquartile-overlap check survives only as the fallback where no interval can be computed. Which of the two ran is named on the ranking rather than left to be inferred from its wording, and the fallback still says on its face that it is a descriptive check over observed values and **not a significance test**. The statistics are [`statistics.md`](statistics.md).

### The under-sampled category

Two under-samples, named separately because they have different causes and different fixes:

- **`under-sampled-corpus`** the category holds fewer than the minimum tasks. Nobody is scored in it. The fix is authoring tasks.
- **`under-sampled-completed`** the category is big enough and *this backend* completed fewer than the minimum. Its figure is withheld and its completion rate is printed. The fix is re-running the failed cells. Without this, a backend that completed two of ten would be scored on whichever two it found easiest, which is the completion-rate lesson applied to the denominator.
- **`under-completed`**, added 28 July 2026 by BENCH-13. The category is big enough, this backend completed enough distinct tasks, and too large a share of its **attempts** failed getting there. Its figure renders `invalid`. See [`statistics.md`](statistics.md) for where the share comes from.

A third verdict, `nothing-completed`, is kept apart from both: a backend that ran nothing in a category is not the same as one that ran too little.

### The floors, and where each came from

**A spread needs three results.** Imported from [`bench/src/run/cell.ts`](../../bench/src/run/cell.ts) and never restated, because that file says in terms that the rule lives there once so the reporting item and the statistics item cannot disagree about it. Its own provenance is `benchmark.md`: `n = 5` is the target, `n = 3` is the floor at which a spread is reported at all.

This is a **recorded divergence from the BENCH-08 brief**, which says "median with spread ... wherever `n` is above 1". The design document governs. At `n = 2` the value prints with its sample size and an explicit note that the spread was withheld and why. It is never bare: every value carries `n`, which is the property the brief's sentence is protecting.

**A category needs five tasks**, by default, adjustable with `--min-tasks`, and printed on every report so a report rendered against a lower floor says so on its face. A floor nobody can defend is a floor somebody will lower, so: `benchmark.md` sets the per-category target at ten, five is half of it, and five is the smallest count at which a median has at least two values on each side, so no single task can drag it across the range.

## What is put first, and why

The report opens with a validity panel, before a single score. The brief's word is "prominently", and this repo already learned at 0.10.0 what happens to a caveat in the middle of a long output: an agent read one report of five in full and wrote a confident synthesis over all five, because the disclosure was somewhere a reader in a hurry skims.

**Completion rate, per backend, with failures by kind.** A backend that failed every cell disappears from a naive average while the benchmark rewards giving up. That is not hypothetical here: `local-codex` was 0-for-3 on this project through an argument-parsing bug and `openai` 0-for-2 through rate limits. A failed cell is counted here and reaches **no** metric denominator; it is never scored as a zero.

**The stale-task count and share.** A stale task loads, is scored and is counted stale; the rule lives in [`task-format.md`](task-format.md). A score computed over a corpus that is a third stale is a different claim from one that is not.

**The share of cited sources whose publication date could not be established**, split by cause. The recency score is computed over the dated ones only, so this is what says how much of the corpus that figure is about.

**The registry `unchecked` count and share**, with BENCH-03's caveat beside it. That caveat is the reason the number is here rather than in a footnote: arXiv rate-limits nearly every probe, so `unchecked` is that archive's ordinary answer rather than its exceptional one, and Crossref alone would report a genuine DOI as fabricated because it is one registration agency among several. A registry score computed over mostly-unchecked identifiers accuses backends of fabrication on the strength of checks that never ran. See [`citation-integrity.md`](citation-integrity.md).

**Pipeline gaps, named as ours.** A cell whose stored report could not be read, or which has no evidence snapshot, is a failure of this pipeline rather than a result about a backend, and it is worded that way so it cannot be read as one. A cell naming a task the corpus no longer holds is counted as an orphan rather than dropped, because a corpus that moved under a stored result is information and a silently narrower denominator is exactly what the loader refuses at the other end.

## Recency, and what it is computed over

**Amended 28 July 2026 by BENCH-16.** This section said recency was permanently unavailable, and the reason it gave was true: BENCH-06 built the durability axis, the axis needs a publication date per source, and nothing in the stored results had one. `PageEvidence` carried the time a page was *checked*, which is not the time it was published, and approximating one from the other would have graded every source fresh, in the direction that flatters every backend.

The gap is closed at the only point where it can be: `PageEvidence.published` now carries a publication date read from the fetched page, or an explicit statement that one could not be established. See [`citation-integrity.md`](citation-integrity.md) for the seven signals and the four refusals, and [`scoring.md`](scoring.md) for what the scorer does with a date once it has one.

What the report prints beside the score is the part that matters here. **The recency figure is computed over the sources that could be dated, and nothing else.** An undated source is graded `undated`, leaves the denominator, and never counts as fresh; a report where nothing could be dated is `unmeasurable` rather than zero. So the figure alone is not readable: a fresh share of 1.0 over one dated source in forty is arithmetic. The validity panel therefore carries the count, above the scores, exactly as the registry `unchecked` share does and for the same reason.

The two undated causes are kept apart, and that is not fussiness. A page read in full that states no publication date is a fact about the publisher. A page nobody could read, or one cut short at the byte cap, is a fact about this pipeline, and only the second is fixed by re-running the collection pass. Collapsing them would let a collection that fetched nothing report a corpus of publishers who date nothing.

**Measured on the benchmark's own corpus**, every distinct URL cited by `bench/tasks/`, `bench/quarantine/` and `bench/detector/`, fetched 28 July 2026: 43 of 72 pages carry no publication-date signal at all. JSON APIs, plain-text RFCs, PDFs and rebuilt documentation sites are most of what a technical research report cites. A large undated share is the ordinary condition of a corpus like this rather than a symptom, which is exactly why it is reported rather than hidden inside a denominator.

**There is deliberately no floor on the dated share.** The floors in this slice live in one place and are named above; an eighth one invented here would be a second answer to "can this sample support a claim", which is the thing [`statistics.md`](statistics.md) refused to add for the same reason. The denominator is printed instead.

The syndication-collapsed domain count is a different case and is **not** withheld for the same reason. It is withheld when no page **text** was compared, and `PageEvidence` has carried page text since BENCH-03, so the collapsed count renders whenever a snapshot exists. See [`source-quality.md`](source-quality.md).

## What none of these numbers can mean

- **A spread is not an interval.** Spreads are observed interquartile ranges over the results in hand. The paired differences in [`statistics.md`](statistics.md) carry a real bootstrap interval, and only the second says anything about how much of a gap survives resampling.
- **A withheld ranking is not a tie.** It means the sample cannot order the backends, which is a different statement from their being equal.
- **Cost is a reservation at the worst case of an estimate band**, never an invoice.
- **A stale task is still scored**, and the count is on the report so the reader can weigh it.
- **Token containment is not entailment**, so citation accuracy is a containment rate rather than claim verification.
- **A recency figure is about the datable sources only.** An undated source never counts as fresh and never enters the denominator, so the figure has to be read against the count of sources that could not be dated.
- **`not measured` is not zero.** Every absence carries a reason, and no absence enters a denominator.
