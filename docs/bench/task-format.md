# The benchmark task format

One YAML file per task under `bench/tasks/`. This page is the reference every task author writes against, and the schema in `bench/src/tasks/schema.ts` is what enforces it.

The rule that shapes everything here: **no model in the scoring loop.** Every score is computed by code from a gold set fixed before the run. A task is admissible only if its correct answer can be checked by a string, a number, a set membership or an HTTP request. So a field exists here when some measure cannot be decided without it, and the reason is written down next to it.

The design this implements is [`docs/plan/benchmark.md`](../plan/benchmark.md).

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

`distinguishingTerm` is matched literally. A report that reaches the same position in its own words does not score recall, and the scorer says so rather than hiding it.

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
