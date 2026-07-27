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

## What none of these numbers can mean

- A containment `supports` does not mean the page supports the claim. It means the page contains the numbers, years, identifiers and names the claim asserts. **Containment is not entailment.**
- A link-check `live` does not mean the citation is sound. It means the URL resolves.
- A registry `unchecked` is not a mark against a citation. It is the absence of an answer, and it leaves every denominator.
- A per-label precision over a corpus of this size is a **shape, not a significant difference**. The published power analysis puts a discriminating eval at roughly a thousand items; this is dozens. It measures what a detector is blind to, not whether one detector beats another by a margin anybody should act on.
- The labels are one author's reading of real pages. That is why every case carries its reasoning.

## Disputing a label

Open the case file, read its `why`, and argue with it. If the reasoning is wrong, the label changes and the numbers move; that is the intended way for this corpus to improve. What is not intended is a label changed to make an arm score better, which is why the reasoning is a schema requirement rather than a convention.
