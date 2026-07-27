/**
 * What the benchmark reports, one entry per number.
 *
 * **This file must never import `node:fs`.** Same rule as `bench/src/score/`
 * and `bench/src/run/cell.ts`, and the same reason: rendering has to be pure
 * over stored bytes, or the property `docs/plan/benchmark.md` bought by
 * separating the run from the scoring is gone. A metric added here in three
 * months applies to research already paid for only if nothing in this path
 * needs a network.
 *
 * The registry exists to enforce one rule mechanically rather than by
 * convention: **accuracy and volume are never the same number.** The prior art
 * (`docs/deep-research/benchmark-prior-art.md`) is explicit that citation count
 * and citation correctness are close to orthogonal in current systems, that
 * human preference tracks the former, and that "any harness you build must
 * report accuracy and volume as separate axes, never a blended score". A
 * `direction` of `none` is what makes that hold: `rank.ts` refuses to order a
 * metric that has one, so "citations per statement" cannot become a leaderboard
 * by anybody's later convenience.
 *
 * There is deliberately no overall quality score. Not an omission.
 */

/**
 * Every metric this slice can report.
 *
 * A tuple so the union, the descriptor record and every exhaustive switch
 * derive from one source, exactly as `TASK_CATEGORIES` does.
 */
export const METRIC_IDS = [
  'accuracy',
  'relevance',
  'calibration-brier',
  'refusal',
  'dissent-recall',
  'conflict-acknowledgement',
  'false-balance',
  'recency-fresh-share',
  'citation-accuracy',
  'citation-thoroughness',
  'source-necessity',
  'resolvability',
  'citation-sources',
  'citations-per-statement',
  'independent-domains',
  'independent-domains-collapsed',
  'report-chars',
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

/**
 * `quality` is a rate or a score and may be ordered. `volume` is a count and
 * may not: it describes how much a backend did, never how well. `validity`
 * describes whether the measurement itself is trustworthy, and ordering
 * backends by it would be ranking them on their own instrumentation.
 */
export type MetricFamily = 'quality' | 'volume' | 'validity';

/** `none` is not a label. It is the gate `rank.ts` reads. */
export type MetricDirection = 'higher' | 'lower' | 'none';

export type MetricUnit = 'share' | 'score' | 'count' | 'ratio' | 'chars';

export interface MetricDescriptor {
  readonly id: MetricId;
  readonly label: string;
  readonly family: MetricFamily;
  readonly direction: MetricDirection;
  readonly unit: MetricUnit;
  /**
   * What this number cannot mean.
   *
   * Carried on the descriptor rather than left to a doc, because the caveat and
   * the number have to travel together. Every table that prints a metric prints
   * this under it.
   */
  readonly caveat: string;
}

const DESCRIPTORS: readonly MetricDescriptor[] = [
  {
    id: 'accuracy',
    label: 'Accuracy',
    family: 'quality',
    direction: 'higher',
    unit: 'share',
    caveat:
      'the share of the task\'s recorded answers the report actually stated. It says nothing about anything the task did not record.',
  },
  {
    id: 'relevance',
    label: 'Relevance',
    family: 'quality',
    direction: 'higher',
    unit: 'score',
    caveat:
      'required-term coverage minus a drift penalty. Crude on purpose: it separates an answer about the right subject from one that is not, and accuracy decides whether it is correct.',
  },
  {
    id: 'calibration-brier',
    label: 'Calibration (Brier)',
    family: 'quality',
    direction: 'lower',
    unit: 'score',
    caveat:
      'lower is better. It pairs a stated confidence with whether the fact was recovered, so a backend that states no confidence is unmeasurable rather than perfect.',
  },
  {
    id: 'refusal',
    label: 'Refusal correctness',
    family: 'quality',
    direction: 'higher',
    unit: 'score',
    caveat:
      'only the two families where the correct answer is not an answer. Every other task is not applicable and leaves the denominator.',
  },
  {
    id: 'dissent-recall',
    label: 'Dissent recall',
    family: 'quality',
    direction: 'higher',
    unit: 'share',
    caveat:
      'whether the report reached a dissenting source recorded at authoring time, by URL or by its distinguishing term. It cannot see a dissenting source the gold set never knew about.',
  },
  {
    id: 'conflict-acknowledgement',
    label: 'Conflict acknowledgement',
    family: 'quality',
    direction: 'higher',
    unit: 'share',
    caveat:
      'whether both recorded figures appear, or the disagreement is flagged. Reporting one number as settled when two exist is the failure being measured.',
  },
  {
    id: 'false-balance',
    label: 'False-balance guard',
    family: 'quality',
    direction: 'higher',
    unit: 'share',
    caveat:
      'the counterweight to dissent recall. Without it the suite would reward hedging on everything.',
  },
  {
    id: 'recency-fresh-share',
    label: 'Recency (fresh share)',
    family: 'quality',
    direction: 'higher',
    unit: 'share',
    caveat:
      'needs a publication date per source, which nothing in the stored results records. Reported unavailable rather than approximated from a fetch time, which would grade every source fresh.',
  },
  {
    id: 'citation-accuracy',
    label: 'Citation accuracy',
    family: 'quality',
    direction: 'higher',
    unit: 'share',
    caveat:
      'of the citations whose support could be decided, the share where the cited page contained what the statement asserted. Token containment, not entailment, and never claim verification.',
  },
  {
    id: 'citation-thoroughness',
    label: 'Citation thoroughness',
    family: 'quality',
    direction: 'higher',
    unit: 'share',
    caveat:
      'of the supported pairs, the share that were actually cited. It is the other half of accuracy and moves in the opposite direction when a backend under-cites.',
  },
  {
    id: 'source-necessity',
    label: 'Source necessity',
    family: 'quality',
    direction: 'higher',
    unit: 'share',
    caveat:
      'a minimum vertex cover of the support graph, which is tie-dependent: a different minimum cover of the same size exists. Read it beside the uniquely-cited count.',
  },
  {
    id: 'resolvability',
    label: 'Resolvability',
    family: 'quality',
    direction: 'higher',
    unit: 'share',
    caveat:
      'the share of checked citations whose URL resolved. A blocked or unreachable page leaves the denominator rather than counting as dead.',
  },
  {
    id: 'citation-sources',
    label: 'Sources cited',
    family: 'volume',
    direction: 'none',
    unit: 'count',
    caveat:
      'a count, never a quality. A backend citing a hundred sources at eighty percent and one citing ten at eighty percent are different products, which is why this is never folded into citation accuracy.',
  },
  {
    id: 'citations-per-statement',
    label: 'Citations per statement',
    family: 'volume',
    direction: 'none',
    unit: 'ratio',
    caveat:
      'density, not diligence. Over-citing raises it and lowers thoroughness at the same time.',
  },
  {
    id: 'independent-domains',
    label: 'Independent domains',
    family: 'volume',
    direction: 'none',
    unit: 'count',
    caveat:
      'registrable domains after canonicalisation. Agreement between backends is not corroboration, and neither is a second URL on the same domain.',
  },
  {
    id: 'independent-domains-collapsed',
    label: 'Independent domains, syndication collapsed',
    family: 'volume',
    direction: 'none',
    unit: 'count',
    caveat:
      'the same count after near-duplicate page text is collapsed. Four domains carrying one wire story are one source wearing four hats, and domain counting alone cannot see it.',
  },
  {
    id: 'report-chars',
    label: 'Report length',
    family: 'volume',
    direction: 'none',
    unit: 'chars',
    caveat:
      'length is not depth. Recorded because a long confident report is the worst possible outcome in the obscure-entity category, so it is context for refusal rather than a score.',
  },
];

const BY_ID: ReadonlyMap<MetricId, MetricDescriptor> = new Map(DESCRIPTORS.map((d) => [d.id, d]));

/**
 * The descriptor for a metric.
 *
 * Throws on an unknown id rather than returning `undefined`. A caller that
 * silently skipped a metric it could not describe would print a table with a
 * column missing and no indication that it was.
 */
export function metricDescriptor(id: MetricId): MetricDescriptor {
  const found = BY_ID.get(id);
  if (!found) throw new TypeError(`no descriptor for metric "${id}"`);
  return found;
}

/** Every descriptor, in registry order. */
export function allMetrics(): readonly MetricDescriptor[] {
  return DESCRIPTORS;
}

/** Every metric of one family, in registry order. */
export function metricsOfFamily(family: MetricFamily): readonly MetricDescriptor[] {
  return DESCRIPTORS.filter((d) => d.family === family);
}

/**
 * May this metric be ordered?
 *
 * The single gate. `rank.ts` calls it and nothing else decides.
 */
export function isRankable(id: MetricId): boolean {
  return metricDescriptor(id).direction !== 'none';
}

/**
 * Which of two values is better, given the metric's direction.
 *
 * Returns a comparator suitable for `sort`, best first. Throws for an
 * unrankable metric rather than defaulting to descending, because a silent
 * default is exactly how a count becomes a leaderboard.
 */
export function betterFirst(id: MetricId): (a: number, b: number) => number {
  const { direction } = metricDescriptor(id);
  switch (direction) {
    case 'higher':
      return (a, b) => b - a;
    case 'lower':
      return (a, b) => a - b;
    case 'none':
      throw new TypeError(
        `metric "${id}" has no direction and must never be ordered; it is a ${metricDescriptor(id).family} figure`,
      );
    default: {
      const exhaustive: never = direction;
      return exhaustive;
    }
  }
}
