import type { TaskCategory } from '../tasks/schema.js';
import type {
  BenchAggregate,
  RepetitionFloor,
  ScorableVerdict,
} from '../report/aggregate.js';
import { eligibilityOf, type CandidateEligibility } from './frontier.js';

/**
 * BENCH-08's verdicts, carried into the lattice. The whole seam, and nothing
 * else.
 *
 * **This file must never import `node:fs`.** Same rule as every other file in
 * this directory, and `evaluate.test.ts` asserts it by reading the source.
 *
 * ## The instruction this file exists to follow
 *
 * `bench/src/report/comparison.ts` takes the aggregate's verdicts **wholesale**
 * rather than re-deriving them, and says why in a comment: deriving "is this
 * scorable" a second time let a backend the scorecard printed as invalid still
 * receive a comparison and a rank, which is two answers to whether the sample
 * supports a claim inside one report. A frontier is a stronger claim than a
 * rank, so the same failure here is worse.
 *
 * So this module computes **no floor**. It reads `ScorableVerdict` and
 * `RepetitionFloor` off an aggregate that already applied all four of them, in
 * the aggregate's own order, and maps them onto members. The one thing that
 * looks like a derivation, the scope verdict, is read off the corpus counts
 * exactly as `comparison.ts` reads its own scope gate, and its sentence is
 * lifted from a `CategoryGroup` rather than rewritten.
 *
 * ## Where the completion floor is, and where it is not
 *
 * `MIN_COMPLETION_SHARE` is the **fourth arm of `verdictFor`**, so it arrives
 * inside `ScorableVerdict` along with the other three and needs no separate
 * check. That is the whole point. `mergeCombination` computes a `completionRate`
 * of its own and `evaluate.ts` reports the worst one as a note; thresholding
 * that number as well would be a fifth floor, disagreeing with the four in
 * `aggregate.ts` the first time either moved. Nothing in `bench/src/combine/`
 * compares a completion rate against anything, and a test asserts it.
 */

/**
 * What one member of a lattice is allowed to contribute, in one scope.
 *
 * Both fields are BENCH-08's own types, not shapes restated here. Adding a
 * field to this interface should feel wrong: anything a frontier needs to know
 * about whether a sample supports a claim is already one of these two.
 */
export interface MemberEligibility {
  readonly verdict: ScorableVerdict;
  readonly repetitionFloor: RepetitionFloor;
}

/** The scope's own verdict, plus one entry per member id in the lattice. */
export interface CombinationEligibility {
  /**
   * Whether anything may be scored in this scope at all.
   *
   * For a task category this is `MIN_TASKS_PER_CATEGORY`, which is exactly the
   * floor `evaluateScopes` was running underneath: it evaluates per task
   * category, which is the scope that floor governs, and applied none of it.
   */
  readonly scope: ScorableVerdict;
  /** Keyed by member id. A member absent from here is refused, never defaulted. */
  readonly members: Readonly<Record<string, MemberEligibility>>;
}

/** Which stored runs a member draws on, so its verdict can be looked up. */
export interface MemberProviders {
  readonly id: string;
  /**
   * The provider ids whose cells this member is built from.
   *
   * Usually one. A member is a *named set of stored runs*, so a method or a
   * crawl lane may span several, and a member with none is a member that
   * contributed nothing to this scope.
   */
  readonly providers: readonly string[];
}

export type EligibilityScope =
  | { readonly kind: 'overall' }
  | { readonly kind: 'category'; readonly category: TaskCategory };

/**
 * Fold a combination's members down into one candidate's eligibility.
 *
 * **The worst member decides**, in both directions, and the direction is
 * forced rather than chosen: a combination is scored as the *union* of its
 * members, so a member whose own figure BENCH-08 withheld cannot be half of a
 * union that gets quoted. Averaging or majority-voting the verdicts would
 * produce a combination that may be scored out of members that may not.
 *
 * A member the caller did not describe is **not scorable**, with the member
 * named. Defaulting an unknown member to eligible is the same permissive
 * default the frontier's own missing-eligibility gate refuses, one level down.
 */
export function combinationEligibility(
  memberIds: readonly string[],
  eligibility: CombinationEligibility,
): CandidateEligibility {
  const blocked: string[] = [];
  const thin: string[] = [];
  for (const id of memberIds) {
    const found = eligibility.members[id];
    if (found === undefined) {
      blocked.push(
        `member "${id}" has no eligibility, so nothing is known about whether its sample supports a ` +
          'comparison; it is treated as not scorable rather than admitted on a default.',
      );
      continue;
    }
    if (!found.verdict.scorable) blocked.push(found.verdict.why);
    if (!found.repetitionFloor.met) thin.push(found.repetitionFloor.why);
  }
  return {
    scorable: blocked.length === 0,
    why: blocked.join(' '),
    repetitionsMet: thin.length === 0,
    repetitionsWhy: thin.join(' '),
  };
}

/** The same fold, expressed as the frontier's own helper, for a single member. */
export function memberCandidateEligibility(member: MemberEligibility): CandidateEligibility {
  return eligibilityOf(member.verdict, member.repetitionFloor);
}

/**
 * The scope's verdict, read the way `comparison.ts` reads its scope gate.
 *
 * For a category, the answer is a property of the corpus rather than of any
 * backend, so every `CategoryGroup` in an under-sampled category carries the
 * *same* `under-sampled-corpus` verdict with the same provider-independent
 * sentence. Lifting that sentence is what makes a withheld frontier print the
 * report's own words rather than a paraphrase that drifts from them.
 *
 * A category the corpus holds no tasks of at all produces no groups, so there
 * is no sentence to lift. That case is worded here because BENCH-08 has no
 * verdict for it: it never crosses a provider with a category nobody authored.
 */
function scopeVerdict(agg: BenchAggregate, scope: EligibilityScope): ScorableVerdict {
  if (scope.kind === 'category') {
    for (const group of agg.categoryGroups) {
      if (group.category !== scope.category) continue;
      if (!group.verdict.scorable && group.verdict.reason === 'under-sampled-corpus') {
        return group.verdict;
      }
      // A group exists and the corpus floor did not fire, so the scope is fine
      // and whatever withheld this backend is the backend's own business.
      return { scorable: true };
    }
    return {
      scorable: false,
      reason: 'under-sampled-corpus',
      why:
        `the corpus holds no ${scope.category} task at all, so there is nothing to score in this ` +
        'category and no combination of backends can change that. The fix is authoring tasks.',
    };
  }
  if (agg.backends.some((b) => b.verdict.scorable)) return { scorable: true };
  return {
    scorable: false,
    reason: 'under-sampled-corpus',
    why:
      'no backend may be scored overall, so there is no scope for a frontier to be stated in. ' +
      agg.backends.map((b) => (b.verdict.scorable ? '' : b.verdict.why)).join(' ').trim(),
  };
}

function memberVerdict(
  agg: BenchAggregate,
  scope: EligibilityScope,
  member: MemberProviders,
): MemberEligibility {
  if (member.providers.length === 0) {
    return {
      verdict: {
        scorable: false,
        reason: 'nothing-completed',
        why: `member "${member.id}" draws on no stored run in this scope, so there is nothing to score.`,
      },
      repetitionFloor: {
        met: false,
        minRepetitions: 0,
        floor: 0,
        why: `member "${member.id}" draws on no stored run in this scope, so there are no repetitions to judge`,
      },
    };
  }

  const verdicts: ScorableVerdict[] = [];
  const floors: RepetitionFloor[] = [];
  for (const provider of member.providers) {
    if (scope.kind === 'category') {
      const category = scope.category;
      const group = agg.categoryGroups.find(
        (g) => g.provider === provider && g.category === category,
      );
      if (group === undefined) {
        verdicts.push(unknownProvider(member.id, provider));
        floors.push(unknownProviderFloor(provider));
        continue;
      }
      verdicts.push(group.verdict);
      floors.push(group.repetitionFloor);
      continue;
    }
    const backend = agg.backends.find((b) => b.provider === provider);
    if (backend === undefined) {
      verdicts.push(unknownProvider(member.id, provider));
      floors.push(unknownProviderFloor(provider));
      continue;
    }
    verdicts.push(backend.verdict);
    floors.push(backend.repetitionFloor);
  }

  // The worst provider decides, for the same reason the worst member decides a
  // combination: a member is the union of its runs, so a provider whose figure
  // was withheld cannot be part of a member that gets quoted.
  const refused = verdicts.find((v) => !v.scorable);
  // The weakest repetition count, matching how `aggregate.ts` takes its own
  // floor over the weakest task rather than the average: one thin coordinate is
  // enough to make the figure partly an ordering of noise.
  const weakest = floors.reduce((lowest, f) =>
    f.minRepetitions < lowest.minRepetitions ? f : lowest,
  );
  return { verdict: refused ?? { scorable: true }, repetitionFloor: weakest };
}

function unknownProvider(memberId: string, provider: string): ScorableVerdict {
  return {
    scorable: false,
    reason: 'nothing-completed',
    why:
      `member "${memberId}" names provider "${provider}", which the aggregate has no figure for in this ` +
      'scope. An unknown provider is treated as not scorable rather than admitted, because a frontier ' +
      'calls what it leaves off dominated.',
  };
}

function unknownProviderFloor(provider: string): RepetitionFloor {
  return {
    met: false,
    minRepetitions: 0,
    floor: 0,
    why: `provider "${provider}" has no aggregate figure in this scope, so there are no repetitions to judge`,
  };
}

/**
 * Everything a lattice needs to know about what its sample supports, taken
 * from an aggregate that already worked it out.
 *
 * This is the only function in `bench/src/combine/` that has ever seen a
 * `BenchAggregate`, and keeping it that way is deliberate: the lattice takes
 * verdicts, not reports, so the merge and the frontier stay testable without
 * building a corpus, and the single place the two slices meet is this file.
 */
export function eligibilityFromAggregate(
  agg: BenchAggregate,
  scope: EligibilityScope,
  members: readonly MemberProviders[],
): CombinationEligibility {
  const byId: Record<string, MemberEligibility> = {};
  for (const member of members) {
    byId[member.id] = memberVerdict(agg, scope, member);
  }
  return { scope: scopeVerdict(agg, scope), members: byId };
}
