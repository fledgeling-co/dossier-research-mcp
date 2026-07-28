/**
 * What one member of a combination is, and the invariant that makes the whole
 * slice valid.
 *
 * **A combination never has to be run.** `docs/plan/benchmark.md` separates the
 * run from the scoring so a metric invented in three months can be applied to
 * research already paid for, and `bench/src/run/store.ts` keeps one raw record
 * per cell for exactly that reason. A combination of backends is therefore the
 * *merge of reports that already exist*, so all 2^N subsets can be evaluated
 * offline for the cost of the N runs already bought. Nothing in
 * `bench/src/combine/` reaches a network, spends a penny or calls a model, and
 * that is asserted by a test rather than left as an intention.
 *
 * Somebody will otherwise assume combinations need their own expensive matrix
 * and build one. They do not.
 *
 * **This file must never import `node:fs`.** Same rule as `bench/src/run/cell.ts`
 * and `bench/src/tasks/corpus.ts`, and the same reason: everything that decides
 * anything is testable without a filesystem, a network or a wallet. This slice
 * takes report *text*, never a report *path*, which is also what keeps the
 * path-traversal question where the filesystem is rather than importing it here.
 */

import type { CombinationIndependenceError } from './errors.js';

/**
 * Why an offline merge is faithful, and the single fact it rests on.
 *
 * Exported as a value rather than written only in a comment because it is a
 * *precondition*, not a note. `assertIndependentMembers` refuses on it, so the
 * next person to change the panel meets a failing test rather than a paragraph
 * they can skim.
 */
export const PANEL_INDEPENDENCE_INVARIANT =
  'Merging stored reports reproduces the evidence base a live panel would have produced, and it is ' +
  'valid for exactly one reason: Dossier panel members are independent. Each backend receives the ' +
  'same brief and never sees another member\'s output, so what a member found does not depend on who ' +
  'else was in the panel. If that ever stops being true, for instance if a future panel feeds one ' +
  "member's findings to another, every combination score computed this way becomes invalid and this " +
  'whole approach has to be revisited rather than quietly kept. A member that saw another member is ' +
  'refused here rather than silently averaged in.';

/**
 * Whether this member's research was produced without seeing another member's.
 *
 * `saw-other-members` is not a degraded mode that scores lower. It is refused,
 * because a merge over a dependent member does not measure what it claims to
 * measure and a number that is wrong for a structural reason is worse than no
 * number at all.
 */
export type MemberIndependence = 'independent' | 'saw-other-members';

/**
 * How a run was billed.
 *
 * Three ways, kept apart, because collapsing them is how a frontier learns to
 * prefer a backend whose spend nobody can see. `src/providers/registry.ts` is
 * explicit that a subscription CLI is not free: it consumes quota already paid
 * for, which Dossier cannot meter. Reporting that as `$0` would put every
 * subscription member at the cheap end of the frontier by construction.
 *
 * - `api` is metered dollars, and `estimatedCostUsd` is the reserved worst case.
 * - `subscription` is unmetered quota. It is **counted, never costed**.
 * - `unknown` is a run whose spend cannot be established, which is a real state
 *   rather than a defensive one: a cell whose creation failed after the ledger
 *   reserved carries a charge the record cannot point at, and
 *   `bench/src/run/dossier.ts` says so in as many words.
 */
export type BillingKind = 'api' | 'subscription' | 'unknown';

/**
 * One stored run folded into a member.
 *
 * A **failed** run is carried rather than dropped. `bench/src/run/cell.ts`
 * keeps failed cells deliberately, so completion rate stays measurable, and a
 * combination scorer that merged only the successes would make an unreliable
 * backend look better by scoring only the cells it happened to finish. A failed
 * run contributes no text and no sources, and it still counts in the
 * denominator of the completion rate and in what was spent trying.
 */
export interface MemberRun {
  readonly runId: string;
  readonly provider: string;
  readonly model?: string | undefined;
  readonly outcome: 'ok' | 'failed';
  /**
   * The report as it was stored. Empty for a failed run.
   *
   * Text, never a path: see the file header. Whoever loads it owns resolving
   * `CellOk.reportPath` safely against the store root.
   */
  readonly markdown: string;
  /**
   * What the run reserved, which is the worst case of its band rather than a
   * quote, matching `CellOk.estimatedCostUsd` and how a panel actually
   * reserves. Zero for a `subscription` run, where the number is meaningless
   * rather than absent; see `BillingKind`.
   */
  readonly estimatedCostUsd: number;
  readonly billing: BillingKind;
}

/**
 * A member: a **named set of stored runs**, not a single run.
 *
 * This is what collapses the brief's backend, method, crawl-lane and repetition
 * axes into one concept. A backend is a member; a backend run five times is
 * *also* one member, whose material is the union of its five runs. It is also
 * what keeps the lattice affordable, and the arithmetic is not close: eight
 * backends at five repeats is forty runs and 2^40 subsets if a run is a member,
 * and eight members whatever the repeat count if a member is a set of runs.
 *
 * **Two things this deliberately does not do.**
 *
 * It does not let one lattice compare "this backend once" against "this backend
 * five times". Those are two different member definitions over the same stored
 * runs, so they are two evaluations compared afterwards, not two members inside
 * one. Putting both in one lattice would need overlapping members, which is
 * refused below.
 *
 * And it cannot, on its own, tell a *method* or a *crawl lane* apart. A stored
 * cell is keyed on task, provider and repetition only, so two variants
 * differing solely by lane or by tier collide on one key and the store keeps
 * the last. Members carrying such variants have to be labelled by whoever built
 * them, and the missing coordinate on the cell key is a recorded gap belonging
 * to the run harness. Stated here rather than discovered by somebody whose
 * "with browser" and "without browser" members turned out to be the same runs.
 */
export interface CombinationMember {
  /** Stable label, unique within one evaluation. Used as the subset key. */
  readonly id: string;
  readonly independence: MemberIndependence;
  readonly runs: readonly MemberRun[];
}

/**
 * The most members and the most explicitly-listed combinations one call accepts.
 *
 * Bounds rather than trust (CP §1): every array that a caller controls carries
 * an explicit maximum, and an unbounded combination list is also how the
 * exactness ceiling gets walked around by hand.
 */
export const MAX_MEMBERS = 64;
export const MAX_LISTED_COMBINATIONS = 4096;
export const MAX_RUNS_PER_MEMBER = 1000;

/**
 * No Zod here, deliberately.
 *
 * These values never cross a trust boundary. They are built in-process by the
 * caller out of `CellRecord`s the cell store already Zod-parsed on the way back
 * off disk, plus report text the store also owns. Re-validating a value that
 * has not left the process would be ceremony; the checks below are the ones
 * that catch a *caller* mistake, which is a different thing from an untrusted
 * input and is why they throw rather than returning a parse result.
 */
function assertShape(members: readonly CombinationMember[]): void {
  if (members.length > MAX_MEMBERS) {
    throw new TypeError(
      `${String(members.length)} members exceeds the cap of ${String(MAX_MEMBERS)}; a member list this long ` +
        'is a mistake rather than an experiment',
    );
  }
  const seen = new Set<string>();
  // Runs are identified across members, not only within one: a run that appears
  // in two members double-counts its evidence AND its cost in every subset
  // holding both, and a credit split over overlapping members is not the
  // Shapley value of anything.
  const runOwners = new Map<string, string>();
  for (const m of members) {
    if (m.id.trim() === '') {
      throw new TypeError('a combination member needs a non-empty id; the id is the subset key');
    }
    if (seen.has(m.id)) {
      throw new TypeError(
        `two combination members share the id "${m.id}". Ids are subset keys, so a duplicate silently ` +
          'collapses part of the lattice: the pair would be indistinguishable in every subset, in the ' +
          'frontier and in the credit split.',
      );
    }
    seen.add(m.id);
    if (m.runs.length > MAX_RUNS_PER_MEMBER) {
      throw new TypeError(
        `member "${m.id}" carries ${String(m.runs.length)} runs, over the cap of ${String(MAX_RUNS_PER_MEMBER)}`,
      );
    }
    for (const run of m.runs) {
      const owner = runOwners.get(run.runId);
      if (owner !== undefined) {
        throw new TypeError(
          `run "${run.runId}" appears in both member "${owner}" and member "${m.id}". Members must be ` +
            'disjoint: a shared run double-counts its evidence and its cost in every subset holding ' +
            'both, and a credit split over overlapping members is not a Shapley value of anything. To ' +
            'compare one repetition against five, run two evaluations and compare them, rather than ' +
            'putting overlapping members in one lattice.',
        );
      }
      runOwners.set(run.runId, m.id);
    }
  }
}

/**
 * Refuse a combination whose members are not independent, overlap, or collide.
 *
 * Throws rather than returning a verdict, and is called by `mergeCombination`
 * rather than left to the caller to remember. See
 * `PANEL_INDEPENDENCE_INVARIANT`.
 */
export function assertIndependentMembers(members: readonly CombinationMember[]): void {
  assertShape(members);
  const dependent = members.filter((m) => m.independence !== 'independent').map((m) => m.id);
  if (dependent.length > 0) {
    const error: CombinationIndependenceError = Object.assign(
      new Error(
        `Refusing to merge: ${String(dependent.length)} member(s) are marked as having seen another ` +
          `member's output (${dependent.join(', ')}). ${PANEL_INDEPENDENCE_INVARIANT}`,
      ),
      { name: 'CombinationIndependenceError' as const, dependentMemberIds: dependent },
    );
    throw error;
  }
}

/**
 * What a set of runs cost, split three ways and never blended.
 *
 * See `BillingKind` for why. A single number here would let a subscription
 * member sit at the cheap end of the frontier for free, and would let a run
 * that may have been charged but cannot be traced sit there at zero.
 */
export interface CostBreakdown {
  /** Metered dollars: the sum of reserved worst cases. The frontier's cost axis. */
  readonly apiUsd: number;
  /** Runs against a subscription quota. Counted, never costed. */
  readonly subscriptionRuns: number;
  /** Runs whose spend cannot be established. Counted, never guessed at. */
  readonly unknownSpendRuns: number;
}

export function costBreakdown(runs: readonly MemberRun[]): CostBreakdown {
  let apiUsd = 0;
  let subscriptionRuns = 0;
  let unknownSpendRuns = 0;
  for (const run of runs) {
    if (!Number.isFinite(run.estimatedCostUsd) || run.estimatedCostUsd < 0) {
      throw new TypeError(
        `run "${run.runId}" has a cost of ${String(run.estimatedCostUsd)}; ` +
          'a reserved worst case must be a non-negative finite number',
      );
    }
    switch (run.billing) {
      case 'api':
        apiUsd += run.estimatedCostUsd;
        break;
      case 'subscription':
        subscriptionRuns += 1;
        break;
      case 'unknown':
        unknownSpendRuns += 1;
        // Still added, because an unknown spend is more likely to be the
        // reserved amount than zero, and the count beside it says the figure is
        // not to be trusted on its own.
        apiUsd += run.estimatedCostUsd;
        break;
      default: {
        const exhaustive: never = run.billing;
        return exhaustive;
      }
    }
  }
  return { apiUsd, subscriptionRuns, unknownSpendRuns };
}

/**
 * What a member cost in metered dollars: the sum of its runs' worst cases.
 *
 * Worst cases summed, never averaged and never a typical figure, because a
 * combination's cost is what a panel would have to reserve before any member
 * starts. `src/research/runner.ts` reserves a panel's whole worst case in one
 * critical section for the same reason.
 */
export function memberCostUsd(member: CombinationMember): number {
  return costBreakdown(member.runs).apiUsd;
}

/**
 * How much of what was attempted actually finished, or `null` when nothing was.
 *
 * The 2026 prior art promotes completion rate to a **validity metric** rather
 * than a footnote, and this repo's own ledger is the argument: `local-codex`
 * was 0-for-3 and `openai` 0-for-2, and both would have silently vanished from
 * a naive average. A combination whose members half-fail is not the same
 * purchase as one whose members finish, at any score.
 *
 * **An empty denominator is `null`, not zero.** This returned `0` until
 * BENCH-15, so a member that never attempted anything and had nothing fail read
 * as "completed 0% of its attempted runs", which is the worst possible result
 * printed for the one state that is not a result at all. The rule is not
 * re-derived here: `bench/src/report/aggregate.ts` already keeps four distinct
 * refusal reasons precisely to separate "never ran" from "failed everything",
 * and `bench/src/stats/reliability.ts` follows it. This is the third
 * implementation agreeing with the first two rather than a fourth answer.
 *
 * A member whose every run failed still returns `0`, which was never the
 * disagreement and is correct on both readings.
 */
export function completionRate(runs: readonly MemberRun[]): number | null {
  if (runs.length === 0) return null;
  return runs.filter((r) => r.outcome === 'ok').length / runs.length;
}

/** Every run across a set of members, in member order then run order. */
export function memberRuns(members: readonly CombinationMember[]): readonly MemberRun[] {
  return members.flatMap((m) => m.runs);
}

/** The runs that produced a report. The only ones with text or sources. */
export function completedRuns(members: readonly CombinationMember[]): readonly MemberRun[] {
  return memberRuns(members).filter((r) => r.outcome === 'ok');
}
