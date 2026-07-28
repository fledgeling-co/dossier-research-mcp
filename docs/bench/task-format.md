# The benchmark task format

One YAML file per task under `bench/tasks/`. This page is the reference every task author writes against, and the schema in `bench/src/tasks/schema.ts` is what enforces it.

The rule that shapes everything here: **no model in the scoring loop.** Every score is computed by code from a gold set fixed before the run. A task is admissible only if its correct answer can be checked by a string, a number, a set membership or an HTTP request. So a field exists here when some measure cannot be decided without it, and the reason is written down next to it.

The design this implements is [`docs/plan/benchmark.md`](../plan/benchmark.md). What the scorers do with what you write is [`scoring.md`](scoring.md), which is worth reading before your first file: it explains why an answer wants a `label`, and what a task cannot measure without one.

## How loading behaves

Three behaviours are worth knowing before you write your first file.

**A malformed file stops the whole corpus.** This is the opposite of the store's rule elsewhere in this repo, where a bad record is skipped so one row cannot break a listing. A corpus that quietly drops a task reports a score over a sample nobody chose, which is worse than no score. Every bad file in the set is named in one error, so you fix them in one pass rather than one per run.

**An unknown field is an error, not a shrug.** Write `requiredTerm` instead of `requiredTerms` and the load fails. A silently ignored typo is a task scored on less than you wrote.

**A task goes stale after 183 days.** That is six months, counted in whole UTC days so the time of day cannot move the boundary. A stale task still loads; it is flagged, and the count travels with the corpus so every report can show it. Gold rots: a revenue figure is correct until the next filing.

## An annotated example

```yaml
id: acme-fy25-revenue          # lowercase slug, unique across the whole corpus
category: technical            # one of the ten below
question: What revenue did Acme report for the year ended 31 December 2025?

topic: acme-financials         # optional. Clusters the statistics; see below
asOf: 2026-01-10               # the date the gold was true
reverifiedAt: 2026-07-01       # when a human last checked it. Not the same date

requiredTerms: [revenue, Acme] # terms a competent answer cannot avoid
driftTerms: [Acme Corp Ltd]    # terms that mean the answer wandered

goldFacts:
  - id: fy25-revenue           # stable, unique within the task
    label: FY25 revenue        # optional, for scorecards
    kind: number
    value: 1200000000
    unit: USD                  # required. Write `dimensionless` for a pure count
    tolerance:
      kind: significantFigures
      digits: 3
    source:
      url: https://example.gov/filings/acme-2025.pdf
      quote: Total revenue for the year was $1.2 billion.
      locator: page 42
```

## Every field

### The task

| Field | Required | What it is |
|---|---|---|
| `id` | yes | Lowercase slug, unique across the corpus. Two files sharing one fail the load. |
| `category` | yes | One of the ten below. It decides which other fields you must supply. |
| `question` | yes | What the backend is asked. 10 to 2000 characters. |
| `asOf` | yes | `YYYY-MM-DD`. The date the gold was true. May be in the future, because a rule can take effect later. |
| `reverifiedAt` | yes | `YYYY-MM-DD`. When a human last confirmed it. May not be in the future. |
| `topic` | no | A slug naming what the task is about, used to cluster the statistics. Distinct from `category`, which is what the task tests. A task without one clusters by its category. |
| `window` | no | A time window the question should be asked over, one of `24h` `7d` `30d` `90d` `1y` `5y` `all`. Read by the run harness, by no scorer, and anchored to `asOf` rather than to the clock at run time. |
| `goldFacts` | see below | The answers a correct report must contain. |
| `requiredTerms` | no | Terms a competent answer cannot avoid using. Matched literally. |
| `driftTerms` | no | Terms indicating the answer wandered into an adjacent topic. |
| `knownDissent` | no | Documented dissenting positions, for due weight. |
| `conflictingFigures` | no | Two or more authoritative values for one quantity. |
| `fringeClaims` | no | A documented fringe claim on a settled question. |
| `expectedRefusal` | see below | For the two categories where the right answer is not an answer. |
| `enumeration` | see below | The grid an enumeration task asks to be filled. |

### A gold fact

Four kinds, and the kind decides what else the fact carries.

| Kind | Carries | Notes |
|---|---|---|
| `number` | `value`, `unit`, `tolerance` | Both `unit` and `tolerance` are required. |
| `date` | `value` | `YYYY-MM-DD`, validated as a real calendar date. |
| `name` | `value`, `aliases` | Aliases are other wordings a correct report may legitimately use. |
| `identifier` | `value`, `aliases` | A DOI, a version string, a ticket number. |

Every kind also carries `id` (stable, unique within the task), an optional `label`, a `source`, and an optional `cell` when the task declares a grid.

Two of these are required rather than optional for a reason worth stating. **A number always states a tolerance**, because comparing floats exactly is how a correct answer scores zero. **A number always states a unit**, because a right figure in the wrong unit has to score zero, and that is only decidable if the right unit was written down. Neither can be forgotten: leaving either out is a parse error, not a check somebody has to remember.

Tolerance comes in four shapes, and each names its payload differently so they cannot be confused:

```yaml
tolerance: { kind: exact }                        # must match exactly
tolerance: { kind: absolute, value: 0.5 }         # within plus or minus 0.5
tolerance: { kind: relative, fraction: 0.01 }     # within 1 percent. A fraction, not a percentage
tolerance: { kind: significantFigures, digits: 3 }
```

### A source

```yaml
source:
  url: https://example.gov/filings/acme-2025.pdf   # http or https only
  quote: Total revenue for the year was $1.2 billion.   # optional
  locator: page 42                                       # optional
```

The quote and the locator are optional and worth writing anyway. The corpus item has to confirm, by script, that each gold fact is really present in its cited source on the day it was authored, and a bare link to a forty-page filing cannot support that. They are also what makes a disputed score adjudicable against the source rather than against your memory.

### The ten categories, and what each one obliges you to record

| Category | What it separates | Obliges |
|---|---|---|
| `time-bound` | Enforced date windows from asked-for ones | nothing extra; set `window` |
| `enumeration` | Matrix completeness | an `enumeration` grid |
| `legal-regulatory` | Precision and official-source reliance | nothing extra |
| `primary-literature` | Real DOIs, and reading past the abstract | nothing extra |
| `social-sentiment` | The only category where X access matters | nothing extra |
| `technical` | Issue trackers, changelogs, version specifics | nothing extra |
| `obscure-entity` | Correctly reporting nothing found | `expectedRefusal` of kind `no-public-footprint` |
| `false-premise` | Refusing a fabricated presupposition | `expectedRefusal` of kind `false-premise` |
| `contested` | Due weight, both figures, dissent retention | `knownDissent` or `conflictingFigures` |
| `settled-with-fringe` | The false-balance counterweight | `fringeClaims` |

A task that promises something in its category and does not record it fails the load. That looks strict; the alternative is a task nothing can score in its own category, quietly dragging that category's number down.

### Refusal

```yaml
category: false-premise
expectedRefusal:
  kind: false-premise
  fabricatedTerms: [Acme Globex merger]      # must not be asserted
  acknowledgementTerms: [no such merger]     # must be present
```

Both kinds require `acknowledgementTerms`, and that is the point. Checking only that a fabricated name is absent cannot tell a report that asserted the fabrication from one that corrected it, because both contain the name. The positive signal is what makes the check decidable.

A refusal task may carry no gold facts at all. Accuracy over it is then reported as not applicable, never as zero.

### Due weight

```yaml
category: contested
knownDissent:
  - url: https://example.org/minority-view
    distinguishingTerm: overstated by a factor of two
conflictingFigures:
  - quantity: reported revenue
    values:
      - { id: filing-figure, kind: number, value: 1200000000, unit: USD, tolerance: { kind: exact }, source: { url: https://example.gov/a } }
      - { id: press-figure,  kind: number, value: 1150000000, unit: USD, tolerance: { kind: exact }, source: { url: https://example.com/b } }
```

`distinguishingTerm` is matched literally. A report that reaches the same position in its own words does not score recall, and the scorer says so rather than hiding it. What the scorer does with these fields, and every limit it carries, is [`docs/bench/due-weight.md`](due-weight.md).

Conflicting values are numeric only, because the check is finding both numbers in the report. Each carries its own source, because a disagreement is only interesting if both sides are attributable. Their ids share the task's namespace with the gold facts, so nothing a report might state is ambiguous, but they do not count toward the answer ceiling.

### The false-balance counterweight

```yaml
category: settled-with-fringe
fringeClaims:
  - claim: The figure was restated downward in secret.
    distinguishingTerm: secret restatement
    source: { url: https://example.net/the-claim }
    rejectionCues: [no evidence, debunked, widely rejected]
```

`rejectionCues` is what makes this category scoreable at all. Mentioning a fringe claim in order to dismiss it is the correct behaviour, and on a bare string search it looks identical to presenting the claim as contested. Recording the wording that marks a rejection lets the scorer tell them apart. It is weaker than a reader's judgement and it is exact, repeatable and free, which for a regression suite is the better bargain, and the scorer reports it as what it is.

### The enumeration grid

```yaml
category: enumeration
enumeration:
  entities: [acme, globex]
  fields: [founded]
  unknownCells:
    - { entity: globex, field: founded }   # genuinely not public
goldFacts:
  - id: acme-founded
    kind: date
    value: 1998-04-01
    source: { url: https://example.gov/acme }
    cell: { entity: acme, field: founded }
```

Every cell of `entities` by `fields` must be covered exactly once, either by a gold fact tagged with that cell or by an entry in `unknownCells`. That is what turns "every cell filled or explicitly marked unknown" into a check rather than an aspiration: a report inventing a value for a declared-unknown cell is wrong, and one that says it could not find it is right.

Entity and field labels must each be free of duplicates. Two identically named rows collapse onto one cell, so an apparently complete grid would cover fewer cells than it declares.

## Why `topic` is separate from `category`

`category` is what a task tests. `topic` is what it is about. A hundred tasks across ten categories are not a hundred independent samples: ten tasks about one company share a subject, and reporting a paired difference over them as if they were independent can understate the error by up to a factor of three. The statistics therefore cluster, and the cluster key has to be recorded per task because nothing can infer it afterwards.

Set it when several tasks share a subject. Leave it off when a task stands alone, and it clusters by its category, which is the honest fallback rather than pretending the task is its own cluster.

## How many answers a task may carry

A task without a grid carries **one to ten** gold facts. A task with a grid may carry up to **two hundred**, one per cell.

The second number widens what `docs/plan/benchmark.md` states flatly as one to ten. A three by four grid is already twelve cells, so the flat ceiling would make the completeness category unable to test completeness. The widening is deliberate and is recorded here rather than left to be discovered at the hundredth file.

A task with no gold facts at all is rejected unless it declares an `expectedRefusal`, because otherwise there is nothing to score.

## Quoting: three traps that bite silently

The parser is pinned to YAML 1.2 core. Under YAML 1.1 an unquoted `2026-01-15` becomes a timestamp and `NO`, `ON` and `yes` become booleans, which is the Norway problem arriving inside a gold set. Pinning the version rules all of that out.

Two traps survive both versions, so **quote any identifier that looks like a number**:

- `value: 1.20` arrives as the number `1.2`. The version string you meant is gone.
- `value: 0755` arrives as the number `755`.

Neither corrupts a score, because a `name` or `identifier` fact requires a string and rejects a number with a readable message. But the message is easier to act on if you know why. Write `value: '1.20'`.

## What the loader gives a scorer

```ts
import { loadCorpusFromDirectory } from '../../bench/src/tasks/index.js';

const corpus = loadCorpusFromDirectory('bench/tasks', { now: new Date() });
corpus.staleCount;   // how many tasks have gone unchecked for 183 days
corpus.staleIds;     // which ones
corpus.ignoredFiles; // anything under the directory that was not a task file
```

Each loaded task carries its file, `stale`, `reverifiedAgeDays`, and `applicableMetrics`: which measures the task can support, derived from what it actually records. That last one is derived once, here, because four separate scorers each re-deriving the same eligibility rule is how two implementations of one rule end up disagreeing about what the rule is.

The reference date is a required argument and is never read from the clock. That is what makes loading reproducible: the same corpus and the same date give the same answer, so a raw result stored today can be re-scored in six months against the date it was scored under.

For the pure form, which needs no filesystem at all and is what a scorer's own tests should use:

```ts
import { loadCorpus } from '../../bench/src/tasks/index.js';

const corpus = loadCorpus([{ file: 'a.yaml', text: '...' }], { now: new Date('2026-07-27') });
```

## Authoring a task, and the two scripts that keep it honest

The format is the contract; this section is the loop. Both scripts make network
calls and neither runs inside `npm run gate`, which is hermetic by construction.
What the gate covers is their pure halves, which is where every decision they
make actually lives, plus `bench/src/corpus.load.test.ts`, which holds the
corpus to the invariants a hand edit can break.

### 1. Anchor the fact so it cannot rot and cannot be recalled

Prefer an **immutable dated event** over a current state. "Which version was
published on 8 July 2026" is true forever; "the latest version" is true until
Tuesday. The corpus authored under BENCH-09 anchors every fact on a June or July
2026 event for a second reason as well: a fact later than a model's training
cutoff cannot be answered from its weights, which is the exclusion rule.

### 2. Cite a source a script can check

Where a publisher's human-facing page is JavaScript-rendered, cite the
publisher's **own API endpoint** instead. It is the same publisher and the same
authority, and it is the version a second person, or a script, can actually
open. Copy the `quote` out of the response body rather than typing it from
memory, and put the field path in `locator`.

### 3. Prove the fact against its source

```bash
npm run bench:verify
```

Fetches every cited source through the repo's SSRF-safe `safeFetch`, checks that
the recorded quote and the recorded value are both present, and writes
`bench/evidence/gold-verification.json`. It exits non-zero if any fact is
unproven.

Three of its verdicts are worth knowing, because they are deliberately not the
same answer:

| Verdict | What it means |
|---|---|
| `quote-absent` / `value-absent` | The source loaded and the string is not in it. Fix the task. |
| `unreachable` | The publisher would not answer. Says nothing about the fact. |
| `source-truncated` | The read stopped at the byte cap before the string could be found. Also says nothing about the fact. |

The last one exists because `safeFetch` truncates silently, and npm's registry
document for `typescript` is 15.5 MB. Under the first byte cap this script used,
a true gold fact sitting past the cap read exactly like a fabricated one.

### 4. Prove the task is not already passed

```bash
npm run bench:failcheck -- --mode closed-book --confirm
npm run bench:failcheck -- --mode search --ids one-task,another-task --confirm
```

Runs each question through a local coding CLI and reports whether the gold
answers are already in the response. The two modes prove different things and
both are needed: `closed-book` disables every tool, so an answer can only come
from the weights, and `search` leaves web search on, which is a real free
research backend.

**It refuses to start without `--confirm`, and prints what it would spend
first.** Run it with no arguments and it names how many tasks it would probe, in
which mode, through which binary, and what that binary's coverage actually is,
then stops without spawning anything. That is the same posture
`npm run bench:detector -- judge` takes, and for the same reason: this spends a
subscription quota, and `CLAUDE.md`'s rule is that anything spending money says
so and gates it.

Two more refusals sit in front of that one, and both are about running the
wrong thing rather than running too much:

| Refused | Why |
|---|---|
| `--bin` naming anything but `claude` or `codex` | A CLI's headless form is a property of that binary. Handing one vendor's flags to another's produces a run that dies at argument parsing and gets recorded as a task that failed, which is a wrong admission decision rather than an error anybody notices. |
| a binary whose identity the `--version` probe cannot confirm | Two vendors ship binaries with the same names. An unidentified one is a different vendor's bill, and one that is not signed in answers nothing, which this check would score as a task that failed. |

The identity probe runs *after* `--confirm` and before the first question,
because a `--version` probe is itself a spawn and "nothing is spawned without
confirmation" would otherwise be untrue.

One verdict is a statement about the *check* rather than the task.
`not-applicable` is reported for a refusal task carrying no gold facts when it
is probed closed-book, because a model with no tools cannot know that a
publisher records nothing, and its honest "I do not know" is written in the same
words as a correct refusal. Measured, not assumed: one run reasoned aloud that
`"the record carries no effective date"` was a plausible-sounding answer it was
declining to assert, and a literal term match scored that as a correct refusal.
That is the same weakness this page already declares for `rejectionCues`, and
the honest response is to say what the run established rather than to weaken the
task until the check agrees with it.
