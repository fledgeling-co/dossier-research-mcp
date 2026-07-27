# Plan: BENCH-11 — which combination is best

**Spec:** [`spec-BENCH-11.md`](../specs/spec-BENCH-11.md) · **Brief:** [BENCH-11](../features-to-triage/BENCH-11-combinations.md) · **Design of record:** [`benchmark.md`](../plan/benchmark.md)

**Plan size:** Standard. Seven small pure modules in one new directory, one doc, no change to any existing source file except two append-only barrels and the three shared docs.

---

## The shape of the thing

Everything lands in a new `bench/src/combine/`. Nothing in it imports `node:fs`, `node:http`, `node:https`, `node:net`, `src/net/`, or `bench/src/citations/`, and that is asserted by a test that reads the source rather than trusted to review. The whole slice is pure and synchronous over values that were already bought.

```
bench/src/combine/
  member.ts       what a member is, what it costs, and the independence invariant
  merge.ts        members -> one report-shaped object (reuses the product's mergeEvidence)
  overlap.ts      three separate measures; never one direction, never an objective
  convergence.ts  claim convergence, deliberately a different path over different objects
  marginal.ts     exact Shapley over an injected value function; refuses above the ceiling
  frontier.ts     three-axis Pareto over a closed axis shape
  evaluate.ts     enumerate the lattice, per category and overall
  index.ts        the barrel
```

### Why a member is a set of runs, not a run

The repetition axis in the brief says a member may be "one run of a backend, or n runs of the same backend merged". Making a member a *named set of stored runs* is what collapses all four brief axes (backend, method, crawl lane, repetition) into one concept, and it is also what keeps the lattice affordable: eight backends at five repeats is forty runs and 2^40 subsets, and eight members whatever their repeat count.

### Why this file never calls the other scorers

The brief says a combination is graded by "every score from BENCH-03 through BENCH-07, unchanged". Three of those cannot be reached from stored cells alone: accuracy and relevance need the task's gold set, source quality needs fetched page text that nothing yet stores (`docs/bench/source-quality.md` calls itself producer-less for exactly this reason), and citation integrity needs the evidence snapshot `bench/src/citations/` writes. Calling them from here would mean fabricating that material or silently dropping the measures that need it.

So `evaluate.ts` takes `scoreCombination` as an **injected function**, exactly as `planBatch` takes `estimateCellUsd`. The caller (BENCH-08, reporting) owns which scorers run and what they are given; this slice owns the merge, the overlap, the credit and the frontier. That is the seam that neither fabricates nor skips.

---

## Step 1 — `member.ts`

```ts
export type MemberIndependence = 'independent' | 'saw-other-members';

export interface MemberRun {
  readonly runId: string;
  readonly provider: string;
  readonly model?: string | undefined;
  readonly markdown: string;
  /** What the run reserved: the worst case of its band, never a quote. */
  readonly estimatedCostUsd: number;
}

export interface CombinationMember {
  readonly id: string;
  readonly independence: MemberIndependence;
  readonly runs: readonly MemberRun[];
}
```

- `PANEL_INDEPENDENCE_INVARIANT`: an exported string stating, in the code, why an offline merge is faithful and what would invalidate it.
- `assertIndependentMembers(members)`: **throws** when any member is `saw-other-members`, and the message names the member and points at the invariant. The brief says the approach becomes invalid if members ever stop being independent; a comment cannot refuse and this can.
- `memberCostUsd(member)`: sum of `estimatedCostUsd` over its runs. Worst cases summed, never averaged.
- Duplicate member ids throw. Two members sharing an id would silently collapse a subset of the lattice.

Zod is not used here: these values never cross a trust boundary, they are constructed in-process by the caller from records the cell store already Zod-parsed. Stated in the file so the omission reads as a decision.

## Step 2 — `merge.ts`

```ts
export interface MergedCombination {
  readonly memberIds: readonly string[];
  readonly evidence: MergedEvidence;        // src/research/synthesise.ts
  readonly citedUrls: readonly string[];    // canonical, deduplicated, union
  readonly markdown: string;
  readonly costUsd: number;
  readonly runCount: number;
  readonly semantics: string;               // what this score can and cannot mean
}
export function mergeCombination(members: readonly CombinationMember[]): MergedCombination;
```

- Reuses `mergeEvidence` from `src/research/synthesise.ts` rather than writing a second merge. It already solves the case this needs: when one provider contributes several runs it labels each run separately, because keying on the provider name makes every source look unique to it and the overlap reads zero however much the runs shared.
- `describeOverlap` is **not** imported. It carries a spoken direction (a warning above 60%, an approving note below 15%) that is right for a live panel and forbidden here.
- **Singleton identity.** With exactly one run, `markdown` is that run's markdown verbatim, no wrapper and no separator. With more than one, runs are joined by a provenance-marked separator. This is what makes "a combination of one scores identically to that backend's individual score" true rather than approximately true, and it is asserted directly.
- `semantics` is a fixed sentence stating that a combination's score is the score of the union of its members: faithful for anything counted from sources, the most generous reading for anything counted as recovered, and the harshest for anything counted as a penalty.

## Step 3 — `overlap.ts`

Three measures, three names, no blend.

```ts
export interface PairOverlap { a; b; urlJaccard; domainJaccard; sharedUrls; sharedDomains; }
export interface MemberRobustness { memberId; survivingShare; lostUrls; }
export interface Centrality { centralUrls; perMember: { memberId; missedCentral; unique; }[]; }
export interface OverlapProfile {
  pairs; meanUrlJaccard; meanDomainJaccard; urlToDomainGap;
  robustness: { unionSize; perMember; worstCaseSurvivingShare };
  centrality; caution: string;
}
export function overlapProfile(members): OverlapProfile;
export function overlapCurve(points): OverlapBin[];
```

- **Pairwise source overlap** is Jaccard over canonical URLs; **domain overlap** the same over registrable domains, using `canonicaliseUrl` and `registrableDomain` from the product. `urlToDomainGap` is reported because members reading different pages on the same sites are less independent than a URL count suggests.
- **Robustness** is, per member, the share of the union that survives dropping it; the axis value is the **minimum** across members, so a combination is only as robust as its most load-bearing member.
- **Centrality is the counterweight the brief asks for.** A URL found by more than half the members is central. `missedCentral` counts the central URLs a member did not find. A member with low overlap *and* high `missedCentral` is eccentric rather than broad, and only having both numbers can tell those apart.
- `overlapCurve` bins combinations by mean pairwise overlap and reports the score distribution per bin. It returns bins in ascending overlap order and **imposes no ordering on quality**; there is deliberately no `bestOverlap`, no `lowestOverlap` and no comparator. `caution` rides on every profile.

## Step 4 — `convergence.ts`

A thin, deliberately separate path over `findConvergence` from `src/research/corroborate.ts`. It takes `ProviderClaimSet[]` (claim *text*), where `overlap.ts` takes `CombinationMember[]` (URL *sets*). The two are structurally incompatible, which is the enforcement: neither function's output can be passed to the other and neither's input satisfies the other's signature.

`index.ts` exports them under names that cannot be mistaken (`sourceOverlapProfile`, `claimConvergence`) with a comment saying why, following the precedent already set in `bench/src/score/index.ts` where two functions called `containment` had to be disambiguated.

## Step 5 — `marginal.ts`

```ts
export const MAX_EXACT_MEMBERS = 16;
export type CoalitionValue = (memberIds: readonly string[]) => number;
export type MarginalResult =
  | { exact: true; perMember: { memberId; shapley; meanDrop; appearsIn }[] }
  | { exact: false; refusal: string };
export function marginalContributions(memberIds, value): MarginalResult;
```

- Exact Shapley: `phi_i = sum over S in N\{i} of |S|!(n-|S|-1)!/n! * (v(S+i) - v(S))`, enumerated over the full lattice. Factorial weights are computed in log space and exponentiated once per coalition size, so `n = 16` does not overflow (`16!` is fine in a double, but the ratio is computed as a weight table rather than as three factorials).
- **The value function is injected and defaults to nothing.** The caller passes the combination's *score*, not its source count. Over a source count the member finding fifty pages nobody else found is by construction the most valuable member, which the brief explicitly forbids. Breadth is still reported, separately, as `uniqueUrls` in the overlap profile and labelled as breadth rather than value.
- **Above `MAX_EXACT_MEMBERS` it refuses.** The refusal names `n`, names `2^n`, says plainly that sampling is not offered and why, and names the two ways under the ceiling: group repeats into one member, or pass an explicit shortlist to `evaluate` (which is exact for what it evaluates, and for which credit per member is then simply not reported rather than approximated).
- The ceiling's arithmetic is written beside the constant: the lattice is `2^n` coalitions and each is one set union over up to `n` URL sets, so the work is `O(n * 2^n)` set insertions. At 16 that is about a million and runs in seconds; at 20 it is twenty million and at 24 it is four hundred million.

## Step 6 — `frontier.ts`

```ts
export interface FrontierCandidate {
  readonly id: string;
  readonly score: number;      // maximise
  readonly costUsd: number;    // minimise
  readonly robustness: number; // maximise
}
export function paretoFrontier(candidates): { frontier; dominated: { id; dominatedBy; why }[] };
```

- A dominates B when `score_A >= score_B && cost_A <= cost_B && robustness_A >= robustness_B` and at least one is strict. Ties on all three keep both.
- **The axis shape is closed and there is no way to add a fourth.** That is how "overlap is never collapsed into a direction" is enforced rather than merely stated: overlap has no field here and the type will not accept one.
- Every dominated candidate is returned with the id that beat it and a sentence naming on which axes, because "row nine is dominated" is only useful with "by row three, cheaper and no worse anywhere".

## Step 7 — `evaluate.ts`

```ts
export interface EvaluateInput {
  readonly members: readonly CombinationMember[];
  readonly scoreCombination: (merged: MergedCombination) => number;
  /** Escape hatch above the ceiling: exact for what it evaluates. */
  readonly combinations?: readonly (readonly string[])[];
}
export function evaluateCombinations(input): CombinationReport;
export function evaluateScopes(input): ScopedCombinationReport;  // per category + overall
```

- Enumerates every non-empty subset when no shortlist is given, refusing above the ceiling with the same message `marginal.ts` uses (one refusal, one wording).
- Per combination: the merge, the injected score, the summed worst-case cost, the overlap profile.
- Then the frontier, the dominated list, the marginal contributions and the overlap curve.
- `evaluateScopes` runs the same thing per task category and once over everything, because the best combination for a time-bound question is not the best for primary literature. Categories come from the caller as named scopes; this file does not read the corpus.
- `costUsd` is summed from member worst cases, and the report says so.

## Step 8 — the doc

`docs/bench/combinations.md`, beside the other five bench docs and linked from `CLAUDE.md`'s repo-layout block and from `docs/bench/scoring.md` if it carries an index. It covers: why a combination is never run, the independence invariant and what would break it, what the union score can and cannot mean, the three overlap measures and why none of them is an objective, the centrality counterweight, the exact-credit ceiling and its arithmetic, and the three frontier axes with their directions.

## Step 9 — shared surfaces, append-only

- `docs/test-plan.md`: a new `### BENCH-11 — combinations` section appended after BENCH-03's, with the AC rows **written before the tests**.
- `CHANGELOG.md`: one entry under `## [Unreleased]`.
- `docs/features-to-triage/LEDGER.md`: the BENCH-11 row updated in place, nobody else's touched.
- `bench/src/score/index.ts`: **not touched.** The combine slice is not a scorer and gets its own barrel. Appending to a file five items have edited buys nothing here.

---

## Acceptance, mapped to tests

| Brief criterion | How it is proven |
|---|---|
| Zero network calls, costs nothing | A test stubs `globalThis.fetch` to throw, runs a full lattice evaluation, and asserts it completes. A second test reads every file in `bench/src/combine/` and asserts none imports `node:fs`, `node:http`, `node:https`, `node:net`, `src/net/`, `bench/src/citations/` or `src/research/citations.js`. |
| A combination of one scores identically | `mergeCombination([m])` for a one-run member returns markdown byte-identical to the run's, and a citedUrls list identical to that run's canonical set. Asserted directly, and again through an injected scorer that returns a hash of what it was given. |
| The frontier is computed, not eyeballed | A fixture with a deliberately dominated candidate: same score, higher cost, lower robustness. It never appears on the frontier and its `dominatedBy` names the winner. Plus the three near-miss cases, one per axis, where domination must **not** fire. |
| Marginal contribution is exact, and refuses above the threshold | Shapley values are checked against a hand-computed three-member example, and against the efficiency property (they sum to `v(N) - v(empty)`). At `MAX_EXACT_MEMBERS + 1` the result is a refusal whose text names the count and says sampling is not offered. |
| Overlap is a distribution, never a direction; obscure sources are not value | A fixture with three members where one finds only obscure sources nobody else found: its `uniqueUrls` is highest and its mean pairwise overlap is lowest, and its Shapley value over the score is **lowest**, and its `missedCentral` is highest. Plus: `paretoFrontier`'s candidate type has no overlap field, and `overlapCurve` returns bins with no ordering on quality. |
| Source overlap and claim convergence cannot be conflated | Two fixtures. One where members share every URL and no claim tokens: high source overlap, zero convergence. One where they share no URL and state the same conclusion: zero source overlap, non-zero convergence. Plus a type-level assertion that neither function accepts the other's input. |

## Verification

`npm run gate` (typecheck, lint, lint:source, lint:docs, test:all, build) plus a stdio smoke against `dist/index.js` proving the MCP surface is unchanged, since this slice adds no tool. Suite run **twice**.

## Risks

- **The union score is a bound, not a measurement, for two of the scorer families.** Mitigated by carrying `semantics` on every merged object rather than in a doc nobody reads.
- **The ceiling will fire in practice.** Eight backends is fine; anyone treating each repeat as its own member hits it immediately. Mitigated by the refusal naming the fix rather than only the problem.
- **`mergeEvidence` returns `overlapRatio`, a single number.** It is carried through as part of the product's own evidence object and must not be promoted to the frontier or to a ranking. Named in the doc and enforced by the closed axis shape.
