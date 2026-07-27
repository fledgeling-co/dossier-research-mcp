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
 * anything is testable without a filesystem, a network or a wallet.
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

/** One stored run folded into a member. */
export interface MemberRun {
  readonly runId: string;
  readonly provider: string;
  readonly model?: string | undefined;
  /** The report as it was stored. Referenced from the cell record, read by the caller. */
  readonly markdown: string;
  /**
   * What the run reserved, which is the worst case of its band rather than a
   * quote, matching `CellOk.estimatedCostUsd` and how the panel actually
   * reserves. A cheaper realistic average would flatter a member that
   * occasionally costs much more.
   */
  readonly estimatedCostUsd: number;
}

/**
 * A member: a **named set of stored runs**, not a single run.
 *
 * This is what collapses all four of the brief's axes into one concept. A
 * backend is a member; a backend run five times is *also* one member, whose
 * material is the union of its five runs; a method and a crawl lane are members
 * in the same way. It is also what keeps the lattice affordable, and the
 * arithmetic is not close: eight backends at five repeats is forty runs and
 * 2^40 subsets if a run is a member, and eight members whatever the repeat
 * count if a member is a set of runs.
 */
export interface CombinationMember {
  /** Stable label, unique within one evaluation. Used as the subset key. */
  readonly id: string;
  readonly independence: MemberIndependence;
  readonly runs: readonly MemberRun[];
}

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
function assertDistinctIds(members: readonly CombinationMember[]): void {
  const seen = new Set<string>();
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
  }
}

/**
 * Refuse a combination whose members are not independent.
 *
 * Throws rather than returning a verdict, and is called by `mergeCombination`
 * rather than left to the caller to remember. See
 * `PANEL_INDEPENDENCE_INVARIANT`.
 */
export function assertIndependentMembers(members: readonly CombinationMember[]): void {
  assertDistinctIds(members);
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
 * What a member costs: the sum of its runs' worst cases.
 *
 * Worst cases summed, never averaged and never a typical figure, because a
 * combination's cost is what the panel would have to reserve before any member
 * starts. `src/research/runner.ts` reserves a panel's whole worst case in one
 * critical section for the same reason.
 */
export function memberCostUsd(member: CombinationMember): number {
  let total = 0;
  for (const run of member.runs) {
    if (!Number.isFinite(run.estimatedCostUsd) || run.estimatedCostUsd < 0) {
      throw new TypeError(
        `member "${member.id}" run "${run.runId}" has a cost of ${String(run.estimatedCostUsd)}; ` +
          'a reserved worst case must be a non-negative finite number',
      );
    }
    total += run.estimatedCostUsd;
  }
  return total;
}

/** Every run across a set of members, in member order then run order. */
export function memberRuns(members: readonly CombinationMember[]): readonly MemberRun[] {
  return members.flatMap((m) => m.runs);
}
