import { canonicaliseUrl } from '../../../src/research/corroborate.js';
import { extractCitedUrls } from '../../../src/research/report.js';
import { mergeEvidence, type MergedEvidence, type RunEvidence } from '../../../src/research/synthesise.js';
import {
  assertIndependentMembers,
  memberCostUsd,
  type CombinationMember,
} from './member.js';

/**
 * Fold a set of members into one report-shaped object the scorers can grade
 * without knowing they are looking at a combination.
 *
 * **Nothing here is bought.** The reports arrive already paid for; see
 * `member.ts` for why that is sound and what would invalidate it.
 *
 * The merge itself is the product's own `mergeEvidence`, not a second copy of
 * it. That matters for a case which is easy to get wrong and which the product
 * already got right: when one provider contributes several runs, provenance has
 * to be per *run*, because keying on the provider name collapses five runs into
 * one label, every source then looks unique to that label, and the overlap
 * reads zero however much the runs actually shared. That is precisely the
 * repetition axis this slice exists to measure, so a second merge here would
 * have broken it on day one.
 *
 * `describeOverlap` from the same module is deliberately **not** imported. It
 * carries a spoken direction, warning above one overlap level and approving
 * below another, which is right when telling an operator what their money
 * bought and forbidden here: the brief is explicit that overlap must not be
 * collapsed into "lower is better". See `overlap.ts`.
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
   * Every cited URL, canonicalised and deduplicated, in first-cited order.
   * This is the list to hand a source scorer; it is the same shape
   * `buildRegistry` produces for a single report.
   */
  readonly citedUrls: readonly string[];
  /**
   * The members' reports as one document.
   *
   * **With exactly one run this is that run's markdown, byte for byte.** No
   * header, no separator, no wrapper. That is what makes a combination of one
   * score identically to the member on its own, which is the property that lets
   * a combination's score be compared with an individual's at all. A wrapper
   * would move every character offset a scorer reports and would change any
   * measure that counts paragraphs.
   */
  readonly markdown: string;
  /** Sum of the members' reserved worst cases. Never an average. */
  readonly costUsd: number;
  readonly runCount: number;
  /** See `UNION_SEMANTICS`. Rides on the value so it cannot be left behind. */
  readonly semantics: string;
}

/**
 * Merge members into one report-shaped object.
 *
 * Refuses outright if any member is marked as having seen another's output.
 */
export function mergeCombination(members: readonly CombinationMember[]): MergedCombination {
  assertIndependentMembers(members);

  const runs: RunEvidence[] = [];
  for (const member of members) {
    for (const run of member.runs) {
      runs.push({
        runId: run.runId,
        provider: run.provider,
        ...(run.model !== undefined ? { model: run.model } : {}),
        markdown: run.markdown,
      });
    }
  }

  const evidence = mergeEvidence(runs);

  // Deduplicated by canonical URL and kept in first-cited order, matching
  // `buildRegistry`. `evidence.sources` is already canonical and deduplicated,
  // so this is a projection rather than a second extraction; the fallback below
  // exists only for the empty case, where there is nothing to project.
  const citedUrls = evidence.sources.map((s) => s.url);

  const markdown =
    runs.length === 1
      ? // The identity case, stated as a branch rather than as a join that
        // happens to produce the same string. A join with an empty separator
        // would be equivalent today and would stop being equivalent the moment
        // anyone added a header.
        (runs[0]?.markdown ?? '')
      : runs.map((r) => r.markdown).join(RUN_SEPARATOR);

  return {
    memberIds: members.map((m) => m.id),
    evidence,
    citedUrls,
    markdown,
    costUsd: members.reduce((sum, m) => sum + memberCostUsd(m), 0),
    runCount: runs.length,
    semantics: UNION_SEMANTICS,
  };
}

/**
 * The canonical URL set one member found, on its own.
 *
 * The unit `overlap.ts` compares. Extracted here rather than there so the whole
 * slice reads a report's citations through exactly one path, and so a member's
 * set is identical whether it is reached through a merge or through an overlap
 * calculation.
 */
export function memberUrlSet(member: CombinationMember): ReadonlySet<string> {
  const out = new Set<string>();
  for (const run of member.runs) {
    for (const raw of extractCitedUrls(run.markdown)) out.add(canonicaliseUrl(raw));
  }
  return out;
}
