# Implementation Plan: BENCH-10

**Spec:** [spec-BENCH-10.md](../specs/spec-BENCH-10.md) · **Brief:** [BENCH-10](../features-to-triage/BENCH-10-self-eval.md) · **Design of record:** [benchmark.md](../plan/benchmark.md)
**Tier:** Standard
**Written:** 2026-07-27

## Task

Measure whether Dossier's own citation checking works, against a corpus where the answer is already known. The output is a confusion matrix per detector arm, not a quality score.

## The one decision everything else follows from

**A detector eval inverts the benchmark's usual shape.** Everywhere else, the system under test produces a report and code scores it. Here the system under test *is* the scorer, so the labels have to exist before it runs and the arithmetic is a confusion matrix.

That has a consequence worth stating before any code: **the label vocabulary is not ours to choose.** It is the five verdicts `research_verify_claims` already asks a caller for, in `src/ai/utility.ts`. A corpus in a tidier vocabulary would measure a product that does not exist.

## Approach

### Two families, two label spaces, one report

| Family | Labels | Detector under test |
|---|---|---|
| `support` | `supports` · `partially_supports` · `contradicts` · `not_addressed` · `unreadable` | containment, the judged mode, link checking |
| `registry` | `present` · `absent` · `unchecked` · `invalid` | `plan()` plus the lookup loop in `collect.ts` |

They are kept apart rather than merged into one matrix because they answer different questions and mixing them would produce an average of two things nobody wants the average of.

### Collection and scoring split, exactly as BENCH-03 split them

Two passes touch the outside world and neither of them is in the gate:

- **capture** fetches a real page through `collectCitationEvidence`, which is the *production* path (SSRF-safe fetch, `extractText`, `collectAnchors`, `judgeCitationStatus`), and writes the extracted text plus its metadata into the corpus. Going through the real collector rather than a second fetcher is what makes the fixture the same bytes the scorer would have seen live.
- **judge** runs `judgeSupport` over every support case and records what the model answered, with the date and the model id.

Everything else is pure and synchronous over what is on disk.

### The projection is the load-bearing design decision

Three arms speak three vocabularies and they have to land in one space to be compared. The prior art is blunt that abstention handling "is not interchangeable preprocessing" and must be declared, so every mapping is written down in one module and reported on every result.

| Arm | Native | Projection into the label space |
|---|---|---|
| containment | `supported` | `supports` |
| | `unsupported` | `not_addressed` — the page does not contain what the statement asserts, which is that verdict's meaning |
| | `unchecked` | abstain |
| judged | the five verdicts | identity |
| | no recorded judgement | abstain |
| link checking | `blocked` | `unreadable` — a paywall, a login gate or a bot block is exactly what that verdict names |
| | everything else | abstain — a resolving URL makes no claim about support, and the tool says so |

Containment cannot emit `contradicts` or `partially_supports`, and link checking cannot emit any of the four support verdicts. Both are declared as `expressible` sets on the arm, and the result marks the remainder `inexpressible` so recall 0 reads as a ceiling rather than a defect.

### The binary view, and why the five-class one is not enough on its own

Comparing containment against a model on five classes is unfair to containment by construction: it is scored on three classes it cannot speak. So a second view collapses to the question a reader actually has, **is this citation sound**:

- `sound` = `supports`
- `unsound` = `partially_supports`, `contradicts`, `not_addressed`
- `unreadable` leaves the binary view entirely, because soundness is undetermined when the page could not be read.

Link checking gets one further mapping here, and it is the point of the view: `live` → `sound`. That is **not** what the tool claims; it is what a reader concludes from a green link, and `docs/bench/citation-integrity.md` already warns against it in prose. The binary view turns the warning into a number.

### Reported, always, per arm

Per label: support, predicted, true positives, precision, recall over committed cases, recall over all cases, F1, abstentions, and whether the label is expressible. Per arm: the full matrix, coverage, accuracy over committed, accuracy over all, macro-F1 over the whole vocabulary and macro-F1 over the expressible part. Both macro numbers, named, because one of them flatters and the other punishes and picking either silently is the fudge.

## Reference implementation

- `bench/src/tasks/corpus.ts` + `files.ts` for the pure-loader / one-disk-adapter split and the test that proves purity by walking the import graph.
- `bench/src/citations/evidence.ts` for a snapshot schema read back as a trust boundary.
- `bench/src/score/recency.ts` for the result-union register and the "unmeasurable is not zero" rule.
- `bench/evidence/*.json` for how a network pass records what it established and when.
- `bench/src/failcheck/cli.ts` for a manual, quota-spending CLI that is never in the gate.

## Prerequisites

Merged: BENCH-01, 02, 03, 04, 05, 06, 07, 09. BENCH-03 is the dependency that matters; it shipped `containmentOracle` and `judgedOracle` with a comment naming this slice.

## Steps

### 1. AC rows into the test plan, before the tests

Append a `### BENCH-10` section to `docs/test-plan.md` with the `SELF-nn` rows. Append only.

### 2. The corpus format — `bench/src/detector/schema.ts`

Zod, strict objects, every string capped (CP §1).

`SupportCaseSchema`: `id`, `claim`, `url`, `label`, `why` (min 40), `topic`, and a `page` block carrying `provenance` (`captured` | `constructed`), `capturedAt`, `verdict` (the product's own six), `httpStatus?`, `truncated`, `completeHtml`, `anchors`, `textFile`, `textSha256`, `textChars`.

`RegistryCaseSchema`: `id`, `kind`, `identifier`, `reportSnippet`, `label`, `why`, `provenance`, `observedAt`, and `responses`, the ordered list of what the scripted transport answers.

The text lives in a sidecar file rather than inline: a captured page is tens of kilobytes and a YAML file nobody can read is a corpus nobody can audit.

### 3. The loader — `corpus.ts` (pure) and `files.ts` (the only disk adapter)

`corpus.ts` takes file *contents* and never imports `node:fs`, proven by walking its import graph. It parses, and it **recomputes the SHA-256 of every page text and fails the load on a mismatch**. Fatal rather than skip-the-bad-record: a listing that drops a row still shows the rest, while a confusion matrix computed over a corpus somebody edited is a number about a sample nobody chose.

`files.ts` walks the directory with the same `lstat`-not-`stat`, never-follow-a-symlink discipline BENCH-01 arrived at, and reads the sidecar text files.

### 4. The vocabularies and the projections — `verdicts.ts`

One module holding both label spaces, the arm capability declarations, every projection above, and the binary collapse. Nothing else may map a verdict.

### 5. The arithmetic — `confusion.ts`

Generic over a label set. Builds the matrix with an explicit `abstain` column, then per-label precision, recall (committed), recall (all), F1, and the arm-level aggregates. No detector logic here at all, so the arithmetic is testable against a hand-computed fixture.

### 6. The arms — `arms.ts`

- `containmentArm` builds a `SourceEvidence` from the case and calls `containment` unchanged.
- `judgedArm(recorded)` looks up the stored verdict by case id.
- `linkCheckArm` reads the page verdict the capture pass recorded, which `judgeCitationStatus` produced.
- `alwaysSupportsArm` is the degenerate strategy, present so the corpus's own balance can be asserted against it rather than argued for.
- `registryArm` drives the **real** `collectCitationEvidence` with a scripted transport and an offline page fetcher, so the thing under test is the production loop and not a copy of it.

### 7. The report — `report.ts`

Renders both families, every arm, the matrices and the derived headline counts: `notAddressedScoredSupports` (the failure the brief names) and `liveButUnsound` (what link checking cannot see).

### 8. Capture and judge — `capture.ts`, `judge.ts`, `cli.ts`

`bench:detector` scores offline. `bench:detector capture` and `bench:detector judge` touch the network and the judge one spends money, says so in its own output, and refuses without an explicit confirmation flag.

### 9. Author the corpus

Capture real pages; write several claims against each; label them; write the reasoning. Target the balance in R3 and check it with the arm that answers `supports` to everything.

### 10. Docs

`docs/bench/detector-eval.md` owns this: what the corpus is, every projection and why, what each number cannot mean, and how to dispute a label. Linked from `CLAUDE.md`'s repo map and `docs/bench/citation-integrity.md`. A CHANGELOG entry under Unreleased.

## Risks

- **The corpus is small.** Miller's power analysis puts a discriminating eval at n ≈ 1000 and this is dozens. It measures a detector's shape, not a significant difference between two detectors, and the doc says so rather than implying otherwise.
- **The labels are one author's.** Mitigated by R2 rather than solved: every label carries its reasoning, so a dispute is settled against argument.
- **The judged arm costs money and moves.** Its verdicts are stamped with the model id and the date. A re-run against a newer model is a new evidence file, not an edit to the old one.
