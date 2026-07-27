import {
  exactnessRefusal,
  marginalContributions,
  MAX_EXACT_MEMBERS,
  type MarginalResult,
} from './marginal.js';
import { mergeCombination, type MergedCombination } from './merge.js';
import { assertIndependentMembers, type CombinationMember } from './member.js';
import {
  overlapCurve,
  sourceOverlapProfile,
  type OverlapBin,
  type OverlapProfile,
} from './overlap.js';
import { paretoFrontier, type FrontierCandidate, type FrontierResult } from './frontier.js';

/**
 * Evaluate every combination of a set of members, and say which are worth their
 * price.
 *
 * **Nothing here is bought and nothing here is fetched.** The whole point of
 * separating the run from the scoring in `docs/plan/benchmark.md` is that a
 * combination never has to be run: every cell is stored raw by
 * `bench/src/run/store.ts`, so all 2^N subsets are evaluated by merging reports
 * that already exist. The N runs were paid for once; the lattice is free.
 *
 * ## Why the score is injected rather than computed here
 *
 * The brief asks for "every score from BENCH-03 through BENCH-07, unchanged".
 * Three of those cannot be reached from stored cells alone, and pretending
 * otherwise would mean fabricating their inputs:
 *
 * - accuracy and relevance need the task's gold set,
 * - source quality needs fetched page text, which nothing yet stores
 *   (`docs/bench/source-quality.md` calls itself producer-less for exactly this),
 * - citation integrity needs the evidence snapshot `bench/src/citations/` writes.
 *
 * So `scoreCombination` is injected, exactly as `planBatch` takes
 * `estimateCellUsd` and `scoreCitationIntegrity` takes a `SupportOracle`. The
 * caller owns which scorers run and what they are handed; this module owns the
 * merge, the overlap, the credit split and the frontier. That seam neither
 * fabricates a missing input nor silently drops the measures that need one.
 *
 * Pure and synchronous over whatever the injected scorer is.
 */

export interface EvaluateInput {
  readonly members: readonly CombinationMember[];
  /**
   * What one merged combination is worth. Higher is better.
   *
   * Called once per combination and its result is reused for the frontier and
   * for the credit split, so it is never called `2^n` times twice.
   */
  readonly scoreCombination: (merged: MergedCombination) => number;
  /**
   * An explicit list of combinations, each named by member ids.
   *
   * The escape hatch above the member ceiling: each listed combination is still
   * scored **exactly**, and the credit split is simply not reported rather than
   * approximated from a partial lattice. Omit it to enumerate every non-empty
   * subset.
   */
  readonly combinations?: readonly (readonly string[])[];
  /** Overridable for tests. Never raise it without reading `MAX_EXACT_MEMBERS`. */
  readonly maxExactMembers?: number;
}

export interface CombinationEvaluation {
  /** Sorted member ids joined by `+`. Stable across runs, and the frontier key. */
  readonly id: string;
  readonly memberIds: readonly string[];
  readonly merged: MergedCombination;
  readonly score: number;
  readonly costUsd: number;
  readonly overlap: OverlapProfile;
}

export interface CombinationReport {
  readonly combinations: readonly CombinationEvaluation[];
  readonly frontier: FrontierResult;
  /**
   * The exact credit split, or a refusal naming the count.
   *
   * `undefined` when an explicit combination list was supplied: a credit split
   * computed over a shortlist is not the Shapley value of anything, and
   * reporting one would be the approximation this slice refuses, wearing a
   * different hat.
   */
  readonly marginal: MarginalResult | undefined;
  /** Score distribution by overlap band, ascending. Not an ordering on quality. */
  readonly overlapCurve: readonly OverlapBin[];
  readonly notes: readonly string[];
  /** True when every non-empty subset was evaluated rather than a shortlist. */
  readonly exhaustive: boolean;
}

/** Sorted, joined member ids. The stable identity of a combination. */
export function combinationId(memberIds: readonly string[]): string {
  return [...memberIds].sort().join('+');
}

/**
 * Every non-empty subset, in ascending size then input order.
 *
 * The empty combination is excluded from the report because it is not a
 * purchase anyone can make. It is still evaluated inside the credit split,
 * where `v({})` is the baseline every marginal is measured against.
 */
function enumerateSubsets(memberIds: readonly string[]): (readonly string[])[] {
  const out: string[][] = [];
  const total = 2 ** memberIds.length;
  for (let mask = 1; mask < total; mask += 1) {
    const ids: string[] = [];
    for (let i = 0; i < memberIds.length; i += 1) {
      if ((mask & (1 << i)) !== 0) ids.push(memberIds[i]!);
    }
    out.push(ids);
  }
  out.sort((a, b) => a.length - b.length || combinationId(a).localeCompare(combinationId(b)));
  return out;
}

export function evaluateCombinations(input: EvaluateInput): CombinationReport {
  const { members, scoreCombination } = input;
  const ceiling = input.maxExactMembers ?? MAX_EXACT_MEMBERS;

  // Refused up front, before any work, and for the whole evaluation rather than
  // per combination: a member that saw another member's output invalidates
  // every subset it appears in, and half a lattice is not a partial answer.
  assertIndependentMembers(members);

  const byId = new Map(members.map((m) => [m.id, m]));
  const allIds = members.map((m) => m.id);
  const notes: string[] = [];

  let requested: (readonly string[])[];
  let exhaustive: boolean;
  if (input.combinations === undefined) {
    if (members.length > ceiling) {
      // The same wording the credit split uses. One limit, one sentence.
      throw Object.assign(new Error(exactnessRefusal(members.length, ceiling)), {
        name: 'ExactnessRefusedError' as const,
        memberCount: members.length,
        ceiling,
      });
    }
    requested = enumerateSubsets(allIds);
    exhaustive = true;
  } else {
    requested = input.combinations.map((ids) => [...ids]);
    exhaustive = false;
    notes.push(
      `An explicit list of ${String(requested.length)} combination(s) was evaluated rather than the full ` +
        'lattice. Each is scored exactly. The per-member credit split is not reported, because a ' +
        'Shapley value over a shortlist is not the Shapley value of anything.',
    );
  }

  const seenIds = new Set<string>();
  const evaluations: CombinationEvaluation[] = [];
  for (const ids of requested) {
    if (ids.length === 0) {
      throw new TypeError('an empty combination is not a purchase; remove it from the list');
    }
    const id = combinationId(ids);
    if (seenIds.has(id)) {
      throw new TypeError(
        `the combination "${id}" was requested twice. Member ids are a set, so "a+b" and "b+a" are one ` +
          'combination and evaluating it twice would double its weight in the curve.',
      );
    }
    seenIds.add(id);
    const chosen = ids.map((memberId) => {
      const member = byId.get(memberId);
      if (!member) {
        throw new TypeError(`combination "${id}" names member "${memberId}", which is not in the member set`);
      }
      return member;
    });
    const merged = mergeCombination(chosen);
    const score = scoreCombination(merged);
    if (!Number.isFinite(score)) {
      throw new TypeError(
        `scoreCombination returned ${String(score)} for combination "${id}"; a score must be a finite number`,
      );
    }
    evaluations.push({
      id,
      memberIds: [...ids],
      merged,
      score,
      costUsd: merged.costUsd,
      overlap: sourceOverlapProfile(chosen),
    });
  }

  const candidates: FrontierCandidate[] = evaluations.map((e) => ({
    id: e.id,
    score: e.score,
    costUsd: e.costUsd,
    robustness: e.overlap.robustness.worstCaseSurvivingShare,
  }));
  const frontier = paretoFrontier(candidates);

  let marginal: MarginalResult | undefined;
  if (exhaustive) {
    // Every subset's score is already computed. The value function is a lookup,
    // never a re-merge, which is what keeps the credit split free rather than
    // doubling the work of the whole evaluation.
    const scores = new Map(evaluations.map((e) => [e.id, e.score]));
    marginal = marginalContributions(
      allIds,
      // The empty coalition is worth zero: nothing bought, nothing found. Every
      // marginal is measured against that baseline.
      (ids) => (ids.length === 0 ? 0 : (scores.get(combinationId(ids)) ?? 0)),
      ceiling,
    );
  }

  notes.push(
    'A combination is scored as the union of its members and never has to be run: every cell was stored ' +
      'raw, so this whole lattice was evaluated with zero network calls and zero spend.',
    "Cost is the sum of the members' reserved worst cases, matching how a panel actually reserves. A " +
      'cheaper realistic average would flatter a member that occasionally costs much more.',
  );
  if (exhaustive) {
    notes.push(
      `The per-member credit split is exact over all ${String(2 ** members.length)} coalitions, computed ` +
        'over the score rather than over the source count. Over a source count, a member finding pages ' +
        'nobody else found would be the most valuable member whatever those pages are worth, which is ' +
        'eccentricity rather than value; breadth is reported separately as overlap.centrality.uniqueUrls.',
    );
  }

  return {
    combinations: evaluations,
    frontier,
    marginal,
    overlapCurve: overlapCurve(
      evaluations.map((e) => ({
        id: e.id,
        meanUrlJaccard: e.overlap.meanUrlJaccard,
        score: e.score,
      })),
    ),
    notes,
    exhaustive,
  };
}

/** One named slice of the corpus, usually a task category. */
export interface CombinationScope {
  readonly name: string;
  readonly members: readonly CombinationMember[];
}

export interface ScopedCombinationReport {
  /** One report per scope, in the order the scopes were supplied. */
  readonly byScope: readonly { readonly scope: string; readonly report: CombinationReport }[];
  /**
   * One report over every scope's runs folded into the same member ids.
   *
   * Reported **beside** the per-scope frontiers and never instead of them. The
   * best combination for a time-bound question is not the best for primary
   * literature, and a single global winner would hide exactly the routing
   * decision this benchmark exists to inform.
   */
  readonly overall: CombinationReport;
}

/**
 * Run the whole evaluation per category as well as over everything.
 *
 * Members are matched across scopes by id, and a member absent from a scope
 * simply contributes nothing there rather than being dropped from the lattice:
 * a backend that failed every cell in one category is a real result about that
 * category, and removing it would change which combinations exist per scope and
 * make the frontiers incomparable.
 */
export function evaluateScopes(
  scopes: readonly CombinationScope[],
  scoreCombination: (merged: MergedCombination, scope: string) => number,
  options: { readonly maxExactMembers?: number } = {},
): ScopedCombinationReport {
  if (scopes.length === 0) {
    throw new TypeError('evaluateScopes needs at least one scope');
  }
  const names = new Set<string>();
  for (const s of scopes) {
    if (names.has(s.name)) throw new TypeError(`two scopes share the name "${s.name}"`);
    names.add(s.name);
  }

  // The union of member ids across scopes, so every scope evaluates the same
  // lattice and the frontiers can be read side by side.
  const template = new Map<string, CombinationMember>();
  for (const scope of scopes) {
    for (const m of scope.members) {
      const existing = template.get(m.id);
      if (existing && existing.independence !== m.independence) {
        throw new TypeError(
          `member "${m.id}" is marked ${existing.independence} in one scope and ${m.independence} in ` +
            'another. Independence is a property of how the research was produced, not of the scope.',
        );
      }
      if (!existing) template.set(m.id, { id: m.id, independence: m.independence, runs: [] });
    }
  }
  const allIds = [...template.keys()];

  const fill = (members: readonly CombinationMember[]): CombinationMember[] => {
    const byId = new Map(members.map((m) => [m.id, m]));
    return allIds.map((id) => byId.get(id) ?? template.get(id)!);
  };

  const byScope = scopes.map((scope) => ({
    scope: scope.name,
    report: evaluateCombinations({
      members: fill(scope.members),
      scoreCombination: (merged) => scoreCombination(merged, scope.name),
      ...(options.maxExactMembers !== undefined ? { maxExactMembers: options.maxExactMembers } : {}),
    }),
  }));

  const overallMembers: CombinationMember[] = allIds.map((id) => ({
    id,
    independence: template.get(id)!.independence,
    runs: scopes.flatMap((s) => s.members.find((m) => m.id === id)?.runs ?? []),
  }));

  return {
    byScope,
    overall: evaluateCombinations({
      members: overallMembers,
      scoreCombination: (merged) => scoreCombination(merged, 'overall'),
      ...(options.maxExactMembers !== undefined ? { maxExactMembers: options.maxExactMembers } : {}),
    }),
  };
}
