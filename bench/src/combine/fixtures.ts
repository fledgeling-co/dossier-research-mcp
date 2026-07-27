import type { CombinationMember, MemberRun } from './member.js';

/**
 * Shared fixtures for the combination tests.
 *
 * Kept in one file because several acceptance rows turn on the *same* three
 * members seen from different angles: the eccentric member must simultaneously
 * have the most unique sources, the lowest overlap, the highest missed-central
 * count and the lowest score-based contribution, and building that member four
 * times in four files is how three of those four quietly stop being the same
 * member.
 */

let counter = 0;
const nextRunId = (): string => {
  counter += 1;
  return `dr_fixture${String(counter).padStart(4, '0')}`;
};

/** A report citing exactly these URLs, in markdown link form. */
export function reportCiting(title: string, urls: readonly string[]): string {
  const body = urls.map((u, i) => `- Finding ${String(i + 1)}: [source](${u})`).join('\n');
  return `# ${title}\n\n${body}\n`;
}

export function run(
  provider: string,
  urls: readonly string[],
  costUsd = 1,
  markdown?: string,
): MemberRun {
  return {
    runId: nextRunId(),
    provider,
    markdown: markdown ?? reportCiting(provider, urls),
    estimatedCostUsd: costUsd,
  };
}

export function member(
  id: string,
  urls: readonly string[],
  costUsd = 1,
): CombinationMember {
  return { id, independence: 'independent', runs: [run(id, urls, costUsd)] };
}

/**
 * Three members where one is eccentric rather than broad.
 *
 * `core-a` and `core-b` both find the two central sources plus one of their
 * own. `obscure` finds neither central source and five sources nobody else
 * found. It therefore has, by construction: the most unique sources, the lowest
 * pairwise overlap (zero with both others), and the highest missed-central
 * count. Whether it is also the most *valuable* member is the question the
 * brief says a metric must get right, and the score function in the tests says
 * it is not.
 */
export function eccentricTrio(): {
  members: readonly CombinationMember[];
  centralUrls: readonly string[];
} {
  const central = ['https://example.org/central-one', 'https://example.org/central-two'];
  return {
    members: [
      member('core-a', [...central, 'https://a.example.com/own']),
      member('core-b', [...central, 'https://b.example.com/own']),
      member('obscure', [
        'https://obscure1.example.net/x',
        'https://obscure2.example.net/x',
        'https://obscure3.example.net/x',
        'https://obscure4.example.net/x',
        'https://obscure5.example.net/x',
      ]),
    ],
    centralUrls: central,
  };
}

/**
 * A scorer that only credits the sources a competent answer cannot avoid.
 *
 * This is what makes the eccentric member score zero: it found five pages and
 * none of them is one of the two the question actually rests on. Deliberately
 * blunt, because the point being tested is the *shape* of the metric, not the
 * sophistication of any real scorer.
 */
export function goldSourceScorer(goldUrls: readonly string[]): (merged: { citedUrls: readonly string[] }) => number {
  const gold = new Set(goldUrls);
  return (merged) => {
    let hit = 0;
    for (const url of merged.citedUrls) if (gold.has(url)) hit += 1;
    return gold.size === 0 ? 0 : hit / gold.size;
  };
}
