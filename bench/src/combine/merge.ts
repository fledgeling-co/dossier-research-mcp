import { extractCitedUrls } from '../../../src/research/report.js';
import { mergeEvidence, type MergedEvidence, type RunEvidence } from '../../../src/research/synthesise.js';
import { sourceIdentity } from './identity.js';
import {
  assertIndependentMembers,
  completedRuns,
  completionRate,
  costBreakdown,
  memberRuns,
  type CombinationMember,
  type CostBreakdown,
} from './member.js';

/**
 * Fold a set of members into one report-shaped object the scorers can grade
 * without knowing they are looking at a combination.
 *
 * **Nothing here is bought.** The reports arrive already paid for; see
 * `member.ts` for why that is sound and what would invalidate it.
 *
 * ## What is reused, and what is not
 *
 * The source registry is the product's own `mergeEvidence`, not a second copy.
 * That matters for a case which is easy to get wrong and which the product
 * already got right: when one provider contributes several runs, provenance has
 * to be per *run*, because keying on the provider name collapses several runs
 * into one label, every source then looks unique to that label, and the overlap
 * reads zero however much the runs actually shared. That is precisely the
 * repetition axis this slice exists to measure.
 *
 * **`mergeEvidence` is a source merge, not a report merge**, and it is worth
 * saying plainly because an earlier draft of this item's spec overstated it.
 * `MergedEvidence` carries no merged prose, so the combined markdown is built
 * here. Its `overlapRatio` is the share of union URLs cited by more than one
 * run, which is a different quantity from anything in `overlap.ts`: not
 * pairwise Jaccard, not domain Jaccard, not robustness. It rides along as part
 * of the product's own object and is never this slice's overlap measure.
 *
 * `describeOverlap` from the same module is deliberately **not** imported. It
 * carries a spoken direction, warning above one overlap level and approving
 * below another, which is right when telling an operator what their money
 * bought and forbidden here: the brief is explicit that overlap must not be
 * collapsed into "lower is better". See `overlap.ts`.
 *
 * Syndication is likewise **not** folded in here. Four domains carrying one
 * wire story are one source, and collapsing them needs page text this slice
 * does not take. It is also not composable from per-member counts: a caller who
 * wants the collapsed union count runs `scoreSourceQuality` over
 * `merged.citedUrls` and the pages for all of them, so that cross-member
 * near-duplicates are actually compared. Summing per-member collapsed counts
 * would miss exactly the syndication that spans members.
 */

/**
 * What a combination's score can and cannot mean.
 *
 * Carried on every merged object rather than written only in a doc, because the
 * number travels and the doc does not. The union is three different things
 * depending on what is being counted, and quoting one of them as though it were
 * a measurement is the failure this sentence exists to prevent.
 */
export const UNION_SEMANTICS =
  'A combination is scored as the union of its members: every source any member cited and every ' +
  'word any member wrote. That is faithful for anything counted from sources, because the union is ' +
  'exactly the evidence base a live panel would have had. It is the most generous reading for ' +
  'anything counted as recovered, because a real synthesis may drop a fact one member found, so a ' +
  'recall figure here is an upper bound. And it is the harshest reading for anything counted as a ' +
  'penalty, because one member asserting a false premise contaminates the union even when the others ' +
  'refused it. Read every combination score with the direction that applies to it.';

/**
 * The separator between two runs' reports in a merged combination.
 *
 * Visible and provenance-carrying rather than a bare blank line, so a scorer
 * that segments statements cannot silently run the end of one report into the
 * start of the next.
 */
const RUN_SEPARATOR = '\n\n---\n\n';

export interface MergedCombination {
  /** The member ids in this combination, in the order they were supplied. */
  readonly memberIds: readonly string[];
  /** The product's own merged evidence base, provenance per run. */
  readonly evidence: MergedEvidence;
  /**
   * Every cited URL, folded to one identity per document and deduplicated, in
   * first-cited order. This is the list to hand a source scorer.
   *
   * Folded with `sourceIdentity`, which collapses `http` onto `https` on top of
   * the product's canonicalisation. See `identity.ts` for why that fold belongs
   * here and not in the product.
   */
  readonly citedUrls: readonly string[];
  /**
   * The members' completed reports as one document.
   *
   * **With exactly one completed run this is that run's markdown, byte for
   * byte.** No header, no separator, no wrapper. That is what makes a
   * combination of one score identically to the member on its own, which is the
   * property that lets a combination's score be compared with an individual's
   * at all. A wrapper would move every character offset a scorer reports and
   * would change any measure that counts paragraphs.
   *
   * Note what the identity is *over*: a **member**, not a run. A member of five
   * runs is five reports, and its singleton combination is those five merged,
   * which is the member evaluated alone and is not equal to any one of its
   * runs. That is the only reading under which the property is even statable
   * once a member is a set.
   */
  readonly markdown: string;
  /**
   * Metered dollars only: the sum of the members' reserved worst cases.
   * Never an average. See `cost` for the two figures this one cannot carry.
   */
  readonly costUsd: number;
  /** The three-way split. A subscription run is counted here, never costed. */
  readonly cost: CostBreakdown;
  /** Runs attempted, including the ones that failed. */
  readonly runCount: number;
  /** Runs that produced a report. */
  readonly completedRunCount: number;
  /**
   * Completed over attempted.
   *
   * A validity metric, not a footnote: a combination whose members half-fail is
   * not the same purchase as one whose members finish, at any score.
   */
  readonly completionRate: number;
  /** See `UNION_SEMANTICS`. Rides on the value so it cannot be left behind. */
  readonly semantics: string;
}

/**
 * Merge members into one report-shaped object.
 *
 * Refuses outright if any member is marked as having seen another's output, if
 * two members share an id, or if a run appears in two members.
 */
export function mergeCombination(members: readonly CombinationMember[]): MergedCombination {
  assertIndependentMembers(members);

  const attempted = memberRuns(members);
  const completed = completedRuns(members);

  // Only completed runs carry evidence. A failed run has no report and no
  // sources, and it is still in the denominator below.
  const runs: RunEvidence[] = completed.map((run) => ({
    runId: run.runId,
    provider: run.provider,
    ...(run.model !== undefined ? { model: run.model } : {}),
    markdown: run.markdown,
  }));

  const evidence = mergeEvidence(runs);

  // `evidence.sources` is canonical and deduplicated but not scheme-folded, so
  // the fold is applied here and the list re-deduplicated. First-cited order is
  // preserved, matching `buildRegistry`.
  const citedUrls: string[] = [];
  const seen = new Set<string>();
  for (const source of evidence.sources) {
    const identity = sourceIdentity(source.url);
    if (seen.has(identity)) continue;
    seen.add(identity);
    citedUrls.push(identity);
  }

  const markdown =
    runs.length === 1
      ? // The identity case, stated as a branch rather than as a join that
        // happens to produce the same string. A join with an empty separator
        // would be equivalent today and would stop being equivalent the moment
        // anyone added a header.
        (runs[0]?.markdown ?? '')
      : runs.map((r) => r.markdown).join(RUN_SEPARATOR);

  const cost = costBreakdown(attempted);

  return {
    memberIds: members.map((m) => m.id),
    evidence,
    citedUrls,
    markdown,
    costUsd: cost.apiUsd,
    cost,
    runCount: attempted.length,
    completedRunCount: completed.length,
    completionRate: completionRate(attempted),
    semantics: UNION_SEMANTICS,
  };
}

/**
 * The source identities one member found, on its own.
 *
 * The unit `overlap.ts` compares. Extracted here rather than there so the whole
 * slice reads a report's citations through exactly one path, and so a member's
 * set is identical whether it is reached through a merge or through an overlap
 * calculation. Failed runs contribute nothing, because they produced nothing.
 */
export function memberUrlSet(member: CombinationMember): ReadonlySet<string> {
  const out = new Set<string>();
  for (const run of member.runs) {
    if (run.outcome !== 'ok') continue;
    for (const raw of extractCitedUrls(run.markdown)) out.add(sourceIdentity(raw));
  }
  return out;
}
