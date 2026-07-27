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
