# Does Dossier's own checking actually work

The only slice of the benchmark that tests this product's own claim rather than a provider's, and the only one whose score is a confusion matrix.

The design is [`benchmark.md`](../plan/benchmark.md). The checks being measured are [`citation-integrity.md`](citation-integrity.md), and the corpus lives in `bench/detector/`.

## Why this eval cannot use the benchmark's usual method

Everywhere else, a backend produces a report and code scores it. Here the **scorer is the system under test**, so the answers have to exist before it runs. Without ground truth you can only measure whether a verifier is confident, not whether it is right.

That has one consequence worth stating before anything else: **the label vocabulary is not ours to choose.** It is the five verdicts `research_verify_claims` already asks a caller for, declared in `src/ai/utility.ts`:

`supports` · `partially_supports` · `contradicts` · `not_addressed` · `unreadable`

A corpus in a tidier vocabulary would be a measurement of a product that does not exist. A parity test reads that enum out of the product's own source and fails if the two ever diverge.

## The corpus

Two families, kept apart because they answer different questions and an average of the two is a number nobody wants.

| Family | Labels | What is being measured |
|---|---|---|
| `support` | the five above | whether a detector can tell a page that states a claim from one that does not |
| `registry` | `present` · `absent` · `unchecked` · `invalid` | whether an identifier lookup ever turns an outage into an accusation |

### It is frozen, and that is deliberate

Every support case carries the page text **as captured**, not a URL to re-fetch at scoring time. Three reasons, in order:

1. `benchmark.md` stores raw reports so a metric added later can be applied to research already paid for. A corpus that re-fetched would score differently every week and could never do that.
2. The gate has no network.
3. The prior art is explicit that live-web evaluation is not reproducible, which is why RetroSearch and BrowseComp-Plus exist at all.

The cost is a shelf life, and the honest move is to stamp it. Every fixture records where it came from, when it was captured, and the SHA-256 of the text. **The loader recomputes that digest and fails the whole load on a mismatch.** A hand-edited fixture cannot quietly change a score, and a genuine re-capture is a two-line fix rather than a mystery.

Pages are captured through `collectCitationEvidence`, which is the production path: the SSRF-safe fetcher, `extractText`, and `judgeCitationStatus` for the verdict. Not a second fetcher written for the benchmark, so the fixture is the same text the scorer would have been handed live.

### Constructed fixtures, and why some of them have to be

Most pages are real captures. Three are marked `constructed` and each says why in its own `note`:

- **the consent wall**, because a real one differs by region, by cookie jar and by week, so freezing one freezes a photograph of a moving thing;
- **the publisher block page**, captured and then edited, because the live 403 echoes the requesting IP address and a Cloudflare reference number back at the caller and neither belongs in a committed file;
- **the truncated page**, which is the captured RFC text cut at the byte cap, since that is what the cap produces on a long document.

### Every case records why

`why` is required and is at least forty characters. It is the field a dispute is settled against. A label with no argument behind it is an assertion of authority, and settling a disagreement by authority is what this whole benchmark is against.

### Several claims per page

The same captured page yields `supports` for one claim, `partially_supports` for another and `contradicts` for a third. That is the discrimination being measured, and a corpus of one claim per page would let a detector succeed by recognising the page.

## The arms

| Arm | What it is | Free? |
|---|---|---|
| `containment` | `bench/src/score/containment.ts`, called unmodified | yes |
| `judged` | what a model answered, recorded by a manual pass | no |
| `link-check` | what `research_verify_citations` decides, replayed from the capture | yes |
| `always-supports` | the degenerate strategy | yes |
| `registry` | the production lookup loop, driven with a scripted transport | yes |

The judged arm **reads recorded verdicts and never calls a model**. That is not only about cost. A model call is asynchronous, non-deterministic and billed, and a scorer with any one of those three properties cannot be re-run over a stored corpus, which is the same reason BENCH-03 split collection from scoring.

The registry arm drives the real `collectCitationEvidence` rather than a copy of its step loop, so what it tests is the rule that shipped.

## The projections, declared

Three arms speak three vocabularies and have to land in one space to be compared. The prior art is specific that the ways of handling an abstention answer different questions and are not interchangeable preprocessing, so every mapping lives in `bench/src/detector/verdicts.ts`, is exhaustive over its source enum, and is reported on the result that used it.

| Arm | Native | Becomes |
|---|---|---|
| containment | `supported` | `supports` |
| | `unsupported` | `not_addressed` |
| | `unchecked` | abstain |
| judged | the five | themselves |
| | no recorded verdict | abstain |
| link check | `blocked` | `unreadable` |
| | everything else, including `live` | abstain |

`live` abstains because a resolving URL makes no claim about support and the tool says so. Scoring it as `supports` would be scoring the tool for a claim it does not make.

### What an arm cannot express is a ceiling, not a failure

Containment has no vocabulary for `contradicts` or `partially_supports`. Link checking has none for any support verdict beyond `unreadable`. Every arm declares what it can emit and the result marks the rest `inexpressible`, because recall 0 on a label an instrument cannot see reads identically to recall 0 on one it can, and they are very different claims.

## The two views

**Five-class** is the primary one. It is also unfair to containment by construction, since three of the five are outside its vocabulary.

**Soundness** is the fair comparison, collapsing to the question a reader actually has:

- `sound` = `supports`
- `unsound` = `partially_supports`, `contradicts`, `not_addressed`
- `unreadable` **leaves the view**, because a page nobody could read has not been shown to fail its claim.

Link checking gets one further mapping in this view and it is the point of having it: `live` becomes `sound`. That is not what the tool claims. It is what somebody does with a green link, and this view prices that habit rather than warning about it in prose for a third time. The arm is named `link-check-as-read` everywhere it appears.

## Abstention, reported three ways

Every arm may decline. So every rate that an abstention can move is reported twice, and coverage beside them:

- **precision** over the cases the arm committed to;
- **recall over answered**, the same denominator;
- **recall over every case**, an abstention counted as a miss;
- **coverage**, the share it answered at all.

And two macro-F1 numbers: one over the whole vocabulary, from the all-cases recall, which punishes abstaining and punishes an inexpressible label; one over what the arm can express, from the committed recall, which is the only fair way to compare a three-answer instrument with a five-answer one. Both are named, because each flatters a different arm and picking one silently is the fudge.

## The counts aggregate accuracy hides

Pulled out of the matrix by name, because an average buries them:

- `notAddressedScoredSupports`, the failure the whole slice exists to price;
- `contradictsScoredSupports`, the same failure pointing the other way;
- `unreadableScoredSupports`;
- `liveButUnsound`, the citations whose URL resolves perfectly and whose page does not support the claim attached to it;
- `uncheckedScoredAbsent` in the registry family, which must be zero and is asserted to be.

## Running it

```bash
npm run bench:detector                    # score the corpus offline; free
npm run bench:detector -- judge --confirm # run the judged pass; spends a quota
```

The judged pass defaults to a coding CLI, which spends a subscription already paid for rather than a metered balance, on the same routing rule the product itself follows and the same approach BENCH-09 used to fail-check twenty-seven tasks for nothing. It refuses to start without `--confirm`.

**The caveat that rides on that number:** the CLI is not the utility model the product would call. The result measures a model of that class answering the product's own question, with the product's own prompt and the product's own page cap, and the evidence file records which model answered and on what date. A re-run against a different model is a new evidence file, never an edit to the old one.

## What it found, 27 July 2026

Over 30 support cases and 18 registry cases. The judged arm was run through the Claude Code CLI on the date shown; re-running it against a different model produces a new evidence file, not an edit to this one.

### Five-class

| Arm | Coverage | Accuracy (answered) | Accuracy (all) | Macro-F1 (vocabulary) | Macro-F1 (expressible) |
|---|---|---|---|---|---|
| containment | 86.7% | 30.8% | 26.7% | 0.167 | 0.440 |
| judged | 100% | **80.0%** | 80.0% | 0.804 | 0.804 |
| link-check | 3.3% | 100% | 3.3% | 0.080 | 1.000 |
| always-supports | 100% | 23.3% | 23.3% | 0.076 | 0.378 |

### False reassurance: a bad citation waved through as `supports`

| Arm | `not_addressed` | `contradicts` | `partially_supports` | `unreadable` | total |
|---|---|---|---|---|---|
| containment | 1 | 4 | 6 | 0 | **11** |
| judged | 0 | 0 | 0 | 0 | **0** |
| link-check | 0 | 0 | 0 | 0 | 0 |
| always-supports | 6 | 7 | 6 | 4 | 23 |

**This is the result the slice exists to produce.** Containment waved through 11 of the 23 citations a reader would call bad, including every case where the claim was stronger than the page supported and four of the seven the page contradicts outright.

The cause is structural rather than tunable, which is why it is reported rather than fixed. A contradiction and an overstatement both use the page's own numbers and names: `semver-prerelease-higher-precedence` asserts the exact opposite of a sentence on the page and every token it carries is on that page, so a check asking whether the tokens appear has nothing to look at. Turning the knobs would not close that; it is what containment is.

### Containment against the judged mode, paired

| | count |
|---|---|
| both right | 5 |
| only containment right | 3 |
| only the judged mode right | **19** |
| both wrong | 3 |
| containment declined where the judged mode answered | 4 |
| the reverse | 0 |

### Soundness, the fair comparison

| Arm | Coverage | Accuracy (all) | Macro-F1 |
|---|---|---|---|
| containment | 88.5% | 38.5% | 0.404 |
| judged | 100% | **96.2%** | 0.949 |
| link-check-as-read | 100% | 26.9% | 0.212 |
| always-supports | 100% | 26.9% | 0.212 |

Containment does better here, as expected, since the binary question is inside what it is for. It still recovers only 31.6% of the unsound citations against the judged mode's 100%.

Note that link-checking-as-read scores **identically to answering `supports` to everything**. On this corpus, treating a resolving link as a sound citation is exactly as informative as not checking at all, and that is arithmetic rather than rhetoric.

### What link checking cannot see

- **22 of 30** cited pages resolve with HTTP 200 and do not support the claim attached to them, which is 75.9% of the resolving ones.
- Three of the four walls in the corpus are served with **HTTP 200**: a login wall, a script wall and a cookie-consent interstitial. No status code can see any of them. The fourth is a publisher 403, which the link check reads correctly as `unreadable`, and that one case is its whole coverage.

### The registry family

100% on all four verdicts, 18 of 18. Including all six cases whose correct answer is `unchecked`: a 429, a 500, a thrown timeout, an unparseable 200, a handle 404 whose body is not the directory's own not-found code, and an arXiv feed naming a different paper. **Zero were scored `absent`.**

### What this does not establish

The judged mode beating containment by this much on 30 cases is a shape, not a significant difference. The corpus is two orders of magnitude below where the published power analysis puts a discriminating eval, and one author wrote every label. What it does establish is a **blindness**, which needs far less evidence than a ranking: a detector that answers `supports` to a page contradicting the claim in as many words is not failing at the margin.

## What none of these numbers can mean

- A containment `supports` does not mean the page supports the claim. It means the page contains the numbers, years, identifiers and names the claim asserts. **Containment is not entailment.**
- A link-check `live` does not mean the citation is sound. It means the URL resolves.
- A registry `unchecked` is not a mark against a citation. It is the absence of an answer, and it leaves every denominator.
- A per-label precision over a corpus of this size is a **shape, not a significant difference**. The published power analysis puts a discriminating eval at roughly a thousand items; this is dozens. It measures what a detector is blind to, not whether one detector beats another by a margin anybody should act on.
- The labels are one author's reading of real pages. That is why every case carries its reasoning.

## Disputing a label

Open the case file, read its `why`, and argue with it. If the reasoning is wrong, the label changes and the numbers move; that is the intended way for this corpus to improve. What is not intended is a label changed to make an arm score better, which is why the reasoning is a schema requirement rather than a convention.
