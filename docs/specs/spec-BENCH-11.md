# BENCH-11: Which combination is best

**ID:** BENCH-11
**Status:** Triage
**Created:** 2026-07-27
**Last updated:** 2026-07-27
**Brief:** [BENCH-11](../features-to-triage/BENCH-11-combinations.md) · **Design of record:** [benchmark.md](../plan/benchmark.md)

## Feature description

*(Verbatim from `docs/features-to-triage/BENCH-11-combinations.md`.)*

# BENCH-11: which combination is best

## What

Score every *combination* of backends, methods and lanes, not just every backend on its own, and find which combinations are worth their price.

## The property that makes this cheap

**A combination never has to be run.** BENCH-02 stores every cell raw: one report per task per backend per repetition. A combination of backends is the merge of stored reports that already exist, so all 2^N subsets can be evaluated offline for the cost of the N runs already paid for.

That is a direct payoff from the decision in `benchmark.md` to separate the run from the scoring, and it should be stated in the code, because someone will otherwise assume combinations need their own expensive matrix and build one.

The simulation is faithful for one specific reason: Dossier's panel members are independent. Each backend receives the same brief and never sees another's output, so merging stored reports afterwards produces the same evidence base a live panel would have produced. **If that ever stops being true**, for instance if a future panel feeds one member's findings to another, this whole approach becomes invalid and the brief must be revisited rather than quietly kept.

## What a combination is

Not only backends. The axes:

- **Backends**: any subset of the CLIs and APIs.
- **Method**: hosted deep research, Dossier's free local loop, or an imported subscription report.
- **Crawl lane**: with or without browser tooling.
- **Repetition**: one run of a backend, or n runs of the same backend merged. This one matters more than it looks. If three runs of one cheap backend beat one run of a dear one, that is a finding about variance being cheaper to buy than capability.

## Metrics, all reusing the existing scorers

For each combination, on the merged evidence base:

- Every score from BENCH-03 through BENCH-07, unchanged. The merge produces a report-shaped object, so the scorers do not need to know they are looking at a combination.
- **Cost**: the sum of member costs. A free lane member contributes zero, which is the entire point of the exercise.
- **Marginal contribution per member**: how much the combination loses when that member is removed, averaged across every subset it appears in. With eight backends this is exact rather than sampled, and it answers the question the panel design keeps raising: which backend is actually earning its seat.
- **Independent-domain union**, counted with `registrableDomain` and collapsed for syndication per BENCH-07. Four backends citing one wire story is still one source, and a combination that looks broad because its members agree is the corroboration trap wearing a bigger hat.

## Overlap is a first-class metric, and it cuts both ways

Union says how much ground a combination covered. It does not say how much of that ground you paid for twice, and two combinations with identical union can be very different purchases.

Measure three things, kept separate because they mean different things:

- **Pairwise source overlap**, Jaccard over canonical URLs for each pair of members. This is the money question: two backends reading the same pages is one perspective bought twice.
- **Domain overlap**, the same over registrable domains. Higher than URL overlap by construction, and the gap between them is informative: members reading different pages on the same sites are less independent than a URL count suggests.
- **Robustness**, what share of the union survives removing any single member. A combination whose coverage collapses when one backend is dropped is one backend with expensive company.

**The trap to avoid: treating less overlap as monotonically better.** It is not.

Overlap between independent searchers is also a signal that a source is central rather than idiosyncratic. Two backends reaching the same primary document without seeing each other's work is evidence that document is what anyone competent would find. A combination with near-zero overlap may not be broad; it may contain a member that is missing what everyone else considers essential, and a metric that rewards that will select for eccentricity.

So report overlap as a curve rather than a target, and expect an optimum in the middle. The brief does not fix where that optimum sits, because that is a finding, not an assumption. What the code must do is refuse to collapse it into a single "lower is better" score.

**Keep this distinct from claim convergence.** Two backends finding the same *source* is a fact about the web. Two backends stating the same *conclusion* is the corroboration trap, and `findConvergence` in `src/research/corroborate.ts` already handles it. They are different measurements over different objects and merging them would make both meaningless.

## The output that matters

**The Pareto frontier.** A combination is on it when nothing cheaper scores at least as well. Everything not on the frontier is dominated and should never be chosen, and saying so plainly is more useful than a ranked list where the reader has to notice that row nine costs six times row three for a point.

Report per category as well as overall. The best combination for a time-bound question is not the best for primary literature, and a single global winner would hide exactly the routing decision this benchmark exists to inform.

The frontier is computed over **three** axes, not two: score, cost, and redundancy. A combination that matches another's score at the same price while surviving the loss of a member better is the better buy, and a two-axis frontier cannot say so.

## What this feeds back into

The panel routing in `src/providers/registry.ts` currently joins a paid backend on question profile plus, since 27 July, a measurement of 4% overlap from **one** panel run. That retune is recorded everywhere as resting on a single observation. This slice is what replaces it with evidence: per category, which combination is on the frontier, and therefore what the join conditions should actually be.

## Honest limits

- **Merging is not identical to a live panel.** Members are independent so the evidence base matches, but any behaviour that depends on the panel as a whole, such as the automatic synthesis pass writing an overlap warning back to each member, is not reproduced by an offline merge. Score the evidence, not the ceremony.
- **2^N grows.** Eight backends is 255 subsets and exact marginal contributions are affordable. Sixteen would not be, and the code should refuse rather than silently sample when N passes the point where exactness is unaffordable. A sampled Shapley value reported as exact is the kind of quiet lie this whole benchmark exists to avoid.
- **A combination's cost is the sum of its members' worst cases**, matching how the panel actually reserves. Reporting a cheaper realistic average would flatter combinations that occasionally cost much more.

## Acceptance

- Evaluating every subset of a stored result set makes **zero** network calls and costs nothing. Asserted by a test that fails if any fetch is attempted.
- A combination of one scores identically to that backend's individual score. If it does not, the merge is doing something and the individual scores are not comparable to the combination scores.
- The frontier is computed, not eyeballed: a dominated combination never appears on it, proven by a fixture with a deliberately dominated member.
- Marginal contribution is exact for the configured backend count, and the code refuses rather than samples above the threshold.
- Overlap is reported as a distribution across combinations, never as a single "lower is better" score. A fixture where one member finds only obscure sources must not score as the most valuable member.
- Source overlap and claim convergence are computed by different code paths and reported separately. A test asserts they cannot be conflated.

### Fleet context carried with the brief

- The governing rule for the whole benchmark: **no model in the scoring loop.** Every score is computed by code from a gold set fixed before the run.
- BENCH-01 through 07 and BENCH-09 are merged. Reuse their code rather than reimplementing it; `bench/src/run/` holds the stored cells this item's input comes from and `bench/src/score/` holds every scorer.
- Shared surfaces are append-only: acceptance rows into `docs/test-plan.md` before the tests, one entry under `## [Unreleased]` in `CHANGELOG.md`, one ledger row. Never reorder another item's rows. `bench/src/score/index.ts` has been edited by several items; append rather than restructure, and note that two functions called `containment` already required disambiguation there.
- Verification is `npm run gate` plus a protocol-level stdio smoke check, and the suite is run twice. There is no user interface and no browser test.
- Do not change the routing in `src/providers/registry.ts`. Produce the measurement that would justify changing it.

---

## Triage — 2026-07-27

**Ready for Implementation Plan**

**Sentinel review:** S2 — Approve with assumptions. Rated a tier above the other benchmark items on one ground: this is the item whose output is meant to authorise changing how money is spent. Everything else here measures; this one produces the number that would move a spend decision, so a wrong default here is not a wrong measurement, it is a wrong purchase repeated.

*(No UI preview section: this repo has no user interface and no design system. Nothing customer-facing changes; the whole item is behind the scenes.)*

**Where it shows up**

- Nothing customer-facing changes. Nobody using the research product sees anything new, and **nothing added here can spend a penny or reach the network** — that is not a side effect, it is the point of the item and it is checked by a test that fails if anything tries.
- The people affected are whoever has to decide which combination of research backends to pay for, and whoever later reads the claim that a particular pairing is worth its price.
- The one existing decision it is aimed at is the rule that decides when a paid backend joins the free ones. That rule currently rests on a single observation from one run, and everywhere it is written down says so. This item produces the evidence that would replace it. **It does not change the rule**, and that separation is deliberate: the measurement and the decision made from it are two acts, and doing both in one change means nobody can check the second against the first.

**Behaviour changes**

- A group of finished research runs can be treated as one, and every possible grouping of them can be graded without buying anything, because the reports were already bought and kept.
- Grading a group of one gives exactly the same answer as grading that run on its own. That is checked rather than assumed, because if it is not true then a group's score cannot be compared with a single run's score and the whole comparison is meaningless.
- Three separate measures of how much two runs read the same material are reported: how many of the exact same pages, how many of the same sites, and how much of the total would survive if any one run were dropped. They are reported as three numbers because they answer three different questions, and the difference between the first two is itself informative.
- **How much two runs read the same material is never turned into a score, and never turned into a target.** It is reported as a spread across every grouping, with the caution that reading the same page as somebody else is also what happens when a page is the obvious one to read, so a run that overlaps with nobody may simply be missing what everybody else found. A grouping is never ranked by it and there is deliberately no way to ask for the grouping with the least of it.
- A separate count says, for each run, how many of the pages most of the others found it missed. That is the counterweight: a run that reads nothing anyone else reads *and* misses what everyone else found is eccentric, not broad, and only having both numbers can tell those apart.
- Reading the same *page* as another run and reaching the same *conclusion* as another run are computed by two different pieces of code, take two different kinds of input, and are reported under two different names. Neither can be handed to the other by accident, and a test proves both that they cannot be swapped and that one can be high while the other is zero.
- Each run's share of the credit for a grouping's result is worked out exactly, by trying it in and out of every grouping it could belong to. When there are too many runs for that to be done exactly, the answer is a refusal that names the number and says plainly that an approximation is not offered, rather than an approximation presented as an exact answer.
- The groupings worth considering are those where nothing cheaper does at least as well on every measure. Anything else is named as beaten and by what. The comparison is over three things at once, not two: how well it did, what it cost, and how well it survives losing a member.
- The same comparison is produced for each kind of question as well as over all of them, because the best grouping for a question about last month is not the best for a question about published research, and one overall winner would hide exactly the decision this exists to inform.
- What a grouping costs is the sum of the worst cases its members reserved, never a cheaper typical figure, because a typical figure flatters a member that occasionally costs much more.

**Assumptions**

- `[Data & scope]` A grouping's score is the score of everything its members found and wrote, taken together. *(the brief says the merge produces a report-shaped object the existing measures can grade unchanged; taking the union of the members is the only merge that requires no judgement and no model.)*
- `[Data & scope]` What that score can and cannot mean is stated on every result: for anything counted from sources it matches what a real group would have had, for anything counted as *found it* it is the most generous reading, and for anything counted as a *penalty* it is the harshest. *(the union is faithful for evidence and is a bound in opposite directions for recall and for penalties; leaving that unsaid would let a generous reading be quoted as a measurement.)*
- `[Data & scope]` A member is a named set of stored runs, not a single run. *(this is what makes the repetition axis work at all: "this backend, run five times" is one member whose material is the union of its five runs, which is exactly how the brief describes it and is also what keeps the number of members small enough for the exact calculation.)*
- `[Operations]` The requirement that members never saw each other's work is written into the code as a property each member carries, and a merge refuses outright if any member is marked as having seen another's. *(the brief says this approach becomes invalid if that ever stops being true, and a comment cannot refuse.)*
- `[Operations]` Nothing here fetches, spends or reads a model, and a test replaces the machinery for reaching the network with something that fails loudly if touched. *(explicitly required by the brief's first acceptance criterion.)*
- `[Data & scope]` The measures this item does not own are not called by it. It hands out the merged material and takes the resulting number as an input. *(each existing measure needs different extra material — gold answers, fetched pages, a snapshot of registry answers — that cannot be reconstructed from stored runs alone, so calling them from here would either fabricate that material or silently skip measures; the same injection the run planner already uses for cost avoids both.)*
- `[Data & scope]` The share of credit for each member is worked out over the result being compared, not over how many pages it found. *(the brief's own trap: a member that finds fifty pages nobody else found and contributes nothing to the answer would top a count of pages, which is exactly the eccentricity the brief says must not be rewarded. The count of pages is still reported, separately and labelled as breadth rather than value.)*
- `[Operations]` The ceiling above which the exact calculation is refused is a named constant with the arithmetic behind it written beside it. *(the brief requires a refusal rather than a sample, and a refusal at an unexplained number is one somebody raises without knowing what it costs.)*
- `[Operations]` When there are too many members, a caller may still name a specific list of groupings to grade, and each of those is graded exactly. Credit per member is then simply not reported. *(refusing everything would make the tool useless above the ceiling; reporting a share of credit from a partial lattice would be the approximation the brief forbids, wearing a different hat.)*
- `[Data & scope]` The three axes compared are how well it did, what it cost, and how well it survives losing a member, and the third is oriented so that more is better. *(the brief names the third "redundancy", which has no obvious direction — redundant members waste money and also provide resilience — and a comparison of this kind needs a stated direction per axis or it cannot be computed at all. Stated in the result rather than renamed silently.)*
- `[Operations]` How much members read the same material is never one of the three axes. *(the brief is explicit that it must not be collapsed into a direction; making it an axis would do exactly that.)*
- `[Data & scope]` The counting of separate sites, and the merging of sites carrying the same story, use the code already written for those rather than a second copy. *(two implementations of one rule eventually disagree about what the rule is; this repo has already been bitten by that.)*
- `[Operations]` No benchmark tasks are authored here beyond test material, and the routing rule this is aimed at is not touched. *(the corpus is its own item, and the brief says to produce the measurement rather than make the change.)*
- `[Experience]` The reason a grouping never has to be bought is written in the code itself. *(explicitly required by the brief; otherwise somebody builds an expensive matrix for it.)*

*If any of these are wrong, edit it inline (or correct an assumption) in this file and re-run `/triage BENCH-11`.*

**Findings carried to the planner**

- *High, Product Logic.* The brief says a grouping is graded by "every score from BENCH-03 through BENCH-07, unchanged", and that is not achievable from stored runs alone. Three of those measures need material a stored run does not carry: gold answers come from the task, fetched page text is not stored anywhere yet (BENCH-07 was declared producer-less for exactly this reason), and registry answers live in a separate snapshot. Calling them from here would mean either fabricating the missing material or quietly skipping the measures that need it. The resolution recorded above — hand out the merged material, take the score as an input — is the only one that neither fabricates nor skips, and it matches how the run planner already takes its cost estimate.
- *High, Product Logic.* The brief's own acceptance criteria pull in opposite directions unless the share-of-credit calculation runs over the *result* rather than over the count of pages found. Over a page count, the member finding only obscure pages is by construction the most valuable member, which the brief explicitly forbids. Recorded here because it is the single decision that makes two acceptance criteria compatible.
- *Medium, Product Logic.* The number of members, not the number of backends, is what the exact calculation grows with. Eight backends run five times each is forty runs if a run is a member, and no ceiling makes that affordable. Treating a member as a named set of runs keeps it at eight, which is the reading the repetition axis requires anyway.
- *Medium, Engineering Readiness.* The product's own merge already exists and already solves a subtle case this needs: when the same backend appears more than once it labels each run separately, because keying on the backend's name makes every source look unique to it and the overlap reads zero however much the runs shared. Reusing it rather than writing a second merge is both less code and the only way that case stays fixed.
- *Medium, Product Logic.* The product's merge also carries a spoken judgement about overlap — a warning above one level, an approving note below another. That judgement is right for a live panel telling an operator what their money bought and wrong here, where the brief forbids a direction. The written explanation must be left where it is and not imported into the measurement.
- *Low, Operational.* The written explanation of the measures is one file per item in this repo. This item gets its own beside the others rather than growing another item's.

