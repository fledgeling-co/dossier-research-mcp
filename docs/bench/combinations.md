# Which combination is best

Scoring every *combination* of backends rather than every backend on its own, and finding which combinations are worth their price. It sits beside [`reporting.md`](reporting.md), which covers the single-backend scorecard and the two places it refuses to answer.

## A combination never has to be run

This is the property the whole slice rests on, and it is worth stating first because someone will otherwise build an expensive combination matrix.

[`run-harness.md`](run-harness.md) stores every cell raw: one report per task, per backend, per repetition. A combination of backends is the merge of reports that already exist, so all 2^N subsets are evaluated by folding together research that was paid for once. Evaluating the whole lattice makes **zero network calls and costs nothing**, and that is an acceptance test rather than an aspiration: one test replaces `fetch` with a throwing stub and runs a full evaluation, and a second reads every source file in `bench/src/combine/` and fails if any of them imports a filesystem, a socket or a fetcher. Both exist because "it happened not to fetch this time" is a different claim from "it cannot fetch".

That is the direct payoff from [`../plan/benchmark.md`](../plan/benchmark.md) separating the run from the scoring.

### The one fact it rests on, and what would break it

The merge is faithful because **Dossier's panel members are independent**. Each backend receives the same brief and never sees another's output, so what a member found does not depend on who else was in the panel, and folding stored reports together afterwards produces the evidence base a live panel would have produced.

If that ever stops being true, if a future panel feeds one member's findings to another, every combination score computed this way becomes invalid. So it is a refusal rather than a comment: a member carries an `independence` field, and `mergeCombination` throws on any member marked as having seen another. A comment cannot refuse.

## What a member is

A member is a **named set of stored runs**, not a single run.

That one decision collapses all four axes the design asks for. A backend is a member. A backend run five times is also one member, whose material is the union of its five runs. A method and a crawl lane are members in the same way. It is also what keeps the lattice affordable, and the arithmetic is not close: eight backends at five repeats is forty runs and 2^40 subsets if a run is a member, and eight members whatever the repeat count if a member is a set of runs.

Three consequences, all named rather than discovered later.

- **Members must be disjoint.** A run appearing in two members double-counts its evidence and its cost in every subset holding both, and a credit split over overlapping members is not the Shapley value of anything. Refused.
- **One lattice cannot compare "this backend once" against "this backend five times".** Those are two member definitions over the same runs, so they are two evaluations compared afterwards.
- **A stored cell cannot tell a method or a crawl lane apart.** The cell key is task, provider and repetition only, so two variants differing solely by lane or tier collide on one key and the store keeps the last. Members carrying such variants have to be labelled by whoever built them, and the missing coordinate on the cell key is a gap belonging to the run harness. Recorded here rather than found by somebody whose "with browser" and "without browser" members turned out to be the same runs.

## What a combination's score means, and what it cannot

A combination is scored as the **union** of its members: every source any member cited and every word any member wrote. That sentence rides on every merged object rather than living only here, because the number travels further than the doc does.

The union is three different things depending on what is being counted, and quoting one of them as though it were a measurement is the failure the sentence exists to prevent.

- **Faithful** for anything counted from sources. The union is exactly the evidence base a live panel would have had.
- **The most generous reading** for anything counted as recovered. A real synthesis may drop a fact one member found, so a recall figure here is an upper bound.
- **The harshest reading** for anything counted as a penalty. One member asserting a false premise contaminates the union even when the others refused it.

Merging is also not identical to a live panel in one further way: anything depending on the panel as a whole, such as the automatic synthesis pass writing an overlap warning back to each member, is not reproduced. Score the evidence, not the ceremony.

### Why this slice calls no scorer

The design asks for "every score from BENCH-03 through BENCH-07, unchanged". Three of those cannot be reached from stored cells alone. Accuracy and relevance need the task's gold set, source quality needs fetched page text, and citation integrity needs the evidence snapshot the citation collector writes. Calling them from here would mean fabricating those inputs or silently dropping the measures that need them.

So `scoreCombination` is **injected**, exactly as the batch planner takes `estimateCellUsd` and the citation scorer takes a support oracle. The caller owns which scorers run and what they are handed; this slice owns the merge, the overlap, the credit split and the frontier.

### Two measurements that bound what a combination score can claim

Both come from [`detector-eval.md`](detector-eval.md), and both are measured rather than assumed. They matter here because a caller may hand this slice a citation-quality score.

- **Token containment waved through 11 of 23 bad citations as supported; the judged variant waved through none.** A combination scored on containment alone is measuring something substantially weaker than one scored with a judge, and a report presenting a combination's citation quality must not imply otherwise.
- **22 of 30 pages resolved HTTP 200 and did not support the claim attached to them.** Link resolution is close to worthless as a quality signal. Nothing in the frontier weights it, and nothing should.

## Overlap, three ways, and no direction

Union says how much ground a combination covered. It does not say how much of that ground was paid for twice, and two combinations with identical union can be very different purchases. Three measures, kept apart because they answer three different questions.

- **Pairwise source overlap**, Jaccard over canonical URLs. The money question: two backends reading the same pages is one perspective bought twice.
- **Domain overlap**, the same over registrable domains. Never below the URL figure, and **the gap between them is the finding**: members reading different pages on the same sites are less independent than a URL count suggests.
- **Robustness**, the share of the union surviving the removal of any single member. Reported as the full per-member distribution, with the **minimum** taken as the headline, because the question is "what happens if I lose one" and the honest answer to that is the worst case. A mean would let a combination of one indispensable member and four cheap ones read as robust.

### The trap, and the counterweight

**Less overlap is not monotonically better.** Nothing in this slice may imply that it is.

Overlap between independent searchers is also a signal that a source is *central* rather than idiosyncratic. Two backends reaching the same primary document without seeing each other's work is evidence that document is what anyone competent would find. A combination with near-zero overlap may not be broad at all; it may contain a member missing what everyone else considers essential, and a metric that rewards that selects for eccentricity.

So there is deliberately no `lowestOverlap`, no `bestOverlap`, no comparator and no ranking anywhere in the module, and the frontier has no axis that could accept one. Overlap is reported as a **curve** across combinations, in ascending bands with no ordering imposed on quality, and where the optimum sits is a finding this code refuses to assume.

`centrality` is what makes the two cases separable. A URL more than half the members found is central, and `missedCentral` counts the central URLs a member did not find. A member that reads nothing anyone else reads **and** misses what everyone else found is eccentric; one that reads nothing anyone else reads while still finding the central sources is genuinely broad. Only having both numbers can tell them apart.

The fixture that proves it is worth describing, because it is the same fixture read two ways. Three members: two find both central sources plus one of their own, and the third finds five sources nobody else found and neither central one. That third member has the most unique sources, the lowest overlap with everyone, and the highest missed-central count. Scored on a raw source count it tops the credit split. Scored on the measure that actually matters it comes last, at zero.

### Source overlap is not claim convergence

Two backends citing the same **source** is a fact about the web. Two backends stating the same **conclusion** is the corroboration trap, and `findConvergence` in `src/research/corroborate.ts` already handles it.

They are different measurements over different objects and merging them would make both meaningless. The separation is structural rather than a convention: the overlap function takes members and reads URL sets, the convergence function takes claim sets and reads text, neither one's input satisfies the other's signature, and neither module imports the other's measure. Two fixtures drive them apart in both directions, because a test where they happen to agree proves nothing: members sharing every URL and no claim tokens give complete source overlap and zero convergence, and members sharing no URL while stating one conclusion give zero source overlap and non-zero convergence.

One constraint on convergence that has to be said plainly. `findConvergence` takes claims that were **already extracted**, and the product's own path extracts them with a model. Obtaining claims that way inside a benchmark run would break both governing rules at once: no model in the scoring loop, and zero cost. Claims must therefore be authored or extracted by a deterministic rule fixed before scoring, and nothing on the default evaluation path calls this at all.

## The frontier is three axes

A combination is on the frontier when nothing else is at least as good everywhere and better somewhere. Everything else is **dominated** and should never be chosen, and saying that plainly is more useful than a ranked list where the reader has to notice for themselves that row nine costs six times row three for a point.

The axes are score, cost and robustness, and every dominated combination is returned with the id that beat it and a sentence naming the axes it lost on.

**Why three.** Score and cost alone cannot say the thing that matters most about a panel: a combination matching another's score at the same price while surviving the loss of a member better is the better buy, and a two-axis frontier calls that a tie.

**Why the third axis is called robustness.** The design calls it redundancy, which has no agreed direction: redundant members waste money, which argues for less, and redundancy is what stops coverage collapsing, which argues for more. A frontier cannot be computed without a direction per axis, so the axis is the one with an unambiguous one.

**Why the axis shape is closed.** The candidate type has exactly three numeric fields and there is no way to add a fourth. That is not a simplification, it is how "overlap is never collapsed into a direction" is enforced rather than merely stated. An axis *is* a direction, so admitting overlap as one would decide the very question that is supposed to be a finding.

### The score axis is a named measure

There is no single "score" in this benchmark, on purpose. Source quality refuses to blend, citation accuracy and citation volume stay two numbers, and a Brier score is lower-is-better. So a frontier answers for **one named measure with a declared direction**, an unnamed one is refused, and a lower-is-better measure is inverted once, inside, with every reported figure stated back in the caller's own units. Comparing another measure means running it again rather than reading the same output differently.

### What the sample can support

A frontier is a **stronger** claim than a ranking. Saying a combination is dominated says nobody should ever buy it.

[`reporting.md`](reporting.md) already answers the question of when a sample can support an ordering, and two answers to that in one codebase is worse than either, so the rule is imported rather than restated.

**Corrected 28 July 2026 by BENCH-17, after a cross-slice audit found that none of it was wired.** The paragraph below used to describe a tie test that existed and could not be reached: `evaluateCombinations` never set a score spread and offered no parameter through which one could arrive, so `spreadsOverlap` was dead outside its own tests and every frontier took the unchecked branch. Two members, one run each, 0.800 against 0.801, printed "nobody should ever buy alpha". None of the four floors reached this slice either, although `evaluateScopes` runs per task category, which is precisely the scope `MIN_TASKS_PER_CATEGORY` governs. The overclaim is left visible because it is more instructive than the correction.

#### The four gates, and where each comes from

A frontier is stated only when all four hold, and the result names the one that failed when it does not. Every one is `bench/src/report/`'s, taken **whole** rather than recomputed, exactly as [`comparison.ts`](../../bench/src/report/comparison.ts) takes them: a second answer to "can this sample support a claim" is how the scorecard came to call a backend invalid while the ranking ranked it.

1. **The scope is scorable.** A category below the task floor cannot produce a frontier, however many members ran in it. The refusal carries the aggregate's own sentence, not a paraphrase.
2. **Every candidate carries an eligibility.** A candidate nobody has said anything about is refused rather than admitted on a permissive default, which is the state this whole slice was in.
3. **Every candidate clears the repetition floor.** One thin candidate withholds the **whole** frontier rather than leaving a frontier over the survivors: a frontier over part of a lattice is not the frontier, and the holes would read as combinations nobody should buy.
4. **At least two candidates remain.** A blocked candidate is folded into `too-few-candidates`, the word `rank.ts` and `comparison.ts` both use, so the withheld tables read side by side.

A combination is only as eligible as its **worst** member, because its score is the union of its members: a member whose own figure was withheld cannot be half of a union that gets quoted.

`MIN_COMPLETION_SHARE` needs no gate of its own here. It is already the fourth arm of `verdictFor`, so it arrives inside the verdict with the other three. `mergeCombination` computes a completion rate and the report prints the worst one as a note; thresholding that as well would be a fifth floor, disagreeing with the four in `aggregate.ts` the first time either moved. Nothing in `bench/src/combine/` compares a completion rate against anything, and a test asserts it by reading the source.

When a frontier is withheld the numbers still print. Every combination keeps its score, its cost and its overlap profile, which is `rank.ts`'s own posture one claim stronger: the numbers are the numbers, and it is the sample that cannot order them.

#### The tie test, which now reaches the production path

Supply a score spread per candidate and two combinations whose observed interquartile ranges overlap are treated as **tied on that axis**, so neither dominates the other on a difference the sample cannot establish. That is a descriptive check over observed values and not a significance test; bootstrap intervals, paired differences and errors clustered on topic are BENCH-13's, and the frontier now takes one of those **by injection** in the same shape `rank.ts` does, with the same precedence: the paired verdict where it has one, the interquartile overlap where it does not, the observed values where neither is available. A paired verdict that disagrees with the observed ordering ties, because a frontier printing an order its own test contradicts is the defect BENCH-13's review found in the ranking.

Nothing supplies a paired comparison over combinations yet. It is a seam rather than a wire, and the frontier says which check actually ran.

#### The three sentences, and the trap that made them three

Without spreads the frontier is still computed and says so, rather than presenting a point-estimate frontier as though the sample had been asked. There are **three** states rather than two, and the third is a defect found by the audit while reading:

- **checked**, when every compared pair had an instrument;
- **unchecked**, when no pair did and nobody supplied a spread;
- **mixed**, when some pairs were checked and some were not.

The old code set the checked sentence when **some** candidate had a spread, while the comparison needs **both**. A mixed set therefore advertised the stronger sentence over pairs compared as point estimates. It is worse than an overstated sentence, and the fixture that shows it is in the tests: `alpha` carries a spread of 0.79 to 0.81 and `beta` is a bare 0.801, so `spreadsOverlap` never runs and 0.001 eliminates the candidate that was actually measured. **Supplying evidence for some combinations and not others penalised the ones you measured.**


### Per category, not one global winner

The whole comparison runs per task category as well as over everything. The best combination for a time-bound question is not the best for primary literature, and a single global winner would hide exactly the routing decision this exists to inform.

A member absent from one category contributes nothing there rather than being dropped from the lattice: a backend that failed every cell in a category is a real result about that category, and removing it would change which combinations exist per scope and make the frontiers incomparable.

## Which member is earning its seat

The value a member adds is not a property of the member. A backend that finds everything a second backend finds is worth a lot alone and nearly nothing beside it. Both standard answers are computed and both are reported under their own names, because the design asks for one in words and names the other.

- **Shapley**, marginals weighted by coalition size so every ordering counts once.
- **Banzhaf**, the plain average over every subset, which is exactly "how much the combination loses when that member is removed, averaged across every subset it appears in".

They are different numbers and the difference is informative: Shapley weighting leans on the smallest and largest coalitions, so a member whose value is concentrated in the middle sizes reads lower under Shapley. Reporting either under the other's name would be the quiet substitution this benchmark exists to avoid, so neither is called simply "the marginal contribution".

**The value function is the score, never the source count.** Over a source count the member finding fifty pages nobody else found is by construction the most valuable member, whatever those pages are worth. Breadth is still measured, separately, as `uniqueUrls`, and labelled as breadth rather than value.

### It refuses rather than samples

Above 16 members the credit split returns a refusal. **Sampling is deliberately not offered**, because an approximate Shapley value is indistinguishable from an exact one once it is a number in a table, and reporting it as exact is precisely the failure being measured.

The ceiling's arithmetic sits beside the constant rather than being asserted. The split itself is cheap; what binds is the lattice in front of it, 2^n merges and 2^n calls to the caller's scorer. That is 256 at eight members, 65,536 at sixteen and over a million at twenty. Sixteen is seconds and the scorer calls are the figure that actually decides it.

The refusal names both ways back under the ceiling rather than only the problem: group a backend's repetitions into one member, or pass an explicit shortlist of named combinations, each scored exactly, with the credit split omitted rather than approximated. The shortlist is itself capped, because an unbounded one is how a ceiling gets walked around one line at a time.

## Cost, and the two figures a dollar total cannot carry

A combination's cost is the sum of its members' **reserved worst cases**, matching how a panel actually reserves. A cheaper realistic average would flatter a member that occasionally costs much more.

Three figures rather than one, and the split is the point.

- **Metered dollars**, which is the frontier's cost axis.
- **Subscription runs**, counted and never costed. A subscription CLI is not free, it spends quota already paid for that Dossier cannot meter, and folding that in as zero would put every subscription combination at the cheap end of the frontier by construction.
- **Runs whose spend cannot be established**, usually a creation that failed after the ledger reserved. The reserved figure is included and the count beside it says the figure is not to be trusted alone.

## Failures count

Failed cells are carried into the combination rather than dropped. They contribute no text and no sources, and they stay in the denominator of a **completion rate** reported on every merge.

That is a validity metric rather than a footnote, and this repo's own ledger is the argument: `local-codex` was 0-for-3 and `openai` 0-for-2, and both would have silently vanished from a naive average. A combination scorer that merged only the successes would make an unreliable backend look better by scoring only the cells it happened to finish.

## What this feeds back into, and what it does not authorise

The panel routing in `src/providers/registry.ts` joins a paid backend on question profile plus a measurement of 4% overlap from **one** panel run, and everywhere it is written down says so. This slice is what replaces that with evidence: per category, which combination is on the frontier, and therefore what the join conditions should be.

**It does not change the routing**, and that separation is deliberate. The measurement and the decision made from it are two acts, and doing both in one change means nobody can check the second against the first.

One caveat travels with every result and belongs here too. These are point estimates. There are no confidence intervals, no paired-difference tests and no standard errors clustered on topic, and this corpus is exactly the shape where naive errors inflate, being ten categories of related tasks. A frontier computed from point estimates over a small category must not authorise a routing change on its own. It is the input to that decision, not the decision.

## What has no producer, and why that was left alone

**Nothing consumes this slice.** No file outside `bench/src/combine/` imports it, there is no `bench:combine` script, and the report CLI never touches it. So the design's fourth stated purpose, "which combination is worth its price", has the machinery and no producer.

BENCH-17 wired the seam to `bench/src/report/` and deliberately did not wire a CLI. The reason is that the missing piece is not plumbing.

`evaluateCombinations` takes `scoreCombination` by injection, for the reason set out above: three of the five scorers cannot be reached from stored cells at all. A `bench:combine` CLI has to answer "what number is a combination's score, and how is it computed over a merged union", and that is a scoring decision this document deliberately leaves to the caller. Making it inside a floors fix would be a second answer to a question that is documented as open, which is the same error the floors fix is correcting one level down.

There is a second reason, and it is measurable. On the corpus as it stands, seven tasks across four categories, **every category is below the five-task floor**, which is why BENCH-13 enumerated 180 pairwise comparisons and could run none. A `bench:combine` wired today would print `withheld` for every scope, so it would produce no information while committing the design decision above.

What exists instead is the join, under test end to end: real cells through `harvest` and `aggregate`, the verdicts mapped onto members by `eligibility.ts`, and the frontier withholding with the report's own sentence. So the floors are proven against BENCH-08's real output rather than against a fixture written to agree with itself, and whoever picks the named measure inherits a lattice that already refuses what the sample cannot support.

