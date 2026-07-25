/**
 * Task archetypes, ported from the bundled `deep-research-prompt-creator` skill.
 *
 * Each archetype is a self-contained override set applied to the base scaffold.
 * They are never merged: the skill's own anti-pattern list calls mixing two
 * archetypes in one prompt a decomposition trigger, because a run trying to
 * satisfy both competitive analysis and regulatory mapping satisfies neither.
 */

export const ARCHETYPE_NAMES = [
  'technical',
  'competitive',
  'regulatory',
  'academic',
  'forecasting',
] as const;
export type Archetype = (typeof ARCHETYPE_NAMES)[number];

export interface ArchetypeOverrides {
  /** One-line role suffix used in <role>. */
  readonly role: string;
  /** Human-facing description, surfaced by the capabilities resource. */
  readonly useWhen: string;
  readonly prioritise: readonly string[];
  readonly deprioritise: readonly string[];
  readonly depth: readonly string[];
  readonly lens: readonly string[];
  readonly output: readonly string[];
}

export const ARCHETYPE_OVERRIDES: Record<Archetype, ArchetypeOverrides> = {
  technical: {
    role: 'evaluating software stacks, infrastructure, APIs, or model architectures',
    useWhen: 'Software stacks, APIs, model architectures, hardware infrastructure, engineering paradigms.',
    prioritise: [
      'Official documentation, source repositories (including issues and PRs), vendor engineering blogs, peer-reviewed benchmarks, architecture whitepapers.',
    ],
    deprioritise: [
      'Vendor landing pages, "top 10 tools" listicles, influencer posts, and vendor-commissioned analyst reports (label these `[SECONDARY: promotional]`).',
    ],
    depth: [
      'Extract exact latency numbers, API schemas, rate limits, and documented architectural trade-offs verbatim where available.',
    ],
    lens: ['Build-vs-buy and operational trade-offs for the stated team size and constraints.'],
    output: [
      'Include a comparison table with columns such as Parameter Count / Context Window / Latency / Cost / License — technical reality lives in tables, prose buries it.',
    ],
  },
  competitive: {
    role: 'assessing competitive positioning, market sizing, or go-to-market strategy',
    useWhen: 'Go-to-market strategy, product positioning, competitive threat assessment, market sizing.',
    prioritise: [
      'Filed financials (10-K, 10-Q, 20-F, exchange filings), competitor pricing pages read in the context of customer-forum sentiment, and organic sentiment platforms (Reddit, Hacker News, industry forums, app-store and review-site ratings).',
    ],
    deprioritise: [
      'Vendor press releases as evidence of competitive advantage — sanitised corporate communications fail the criteria-match validator.',
    ],
    depth: [
      'Pain-point mining: query organic platforms for direct customer quotes, contrast them with the vendor’s official positioning, and name the gap explicitly.',
    ],
    lens: [
      'Identify at least two underserved gaps — capabilities customers explicitly want that no vendor in the set currently provides.',
    ],
    output: [
      'A competitor comparison table (offer / pricing / channel / sentiment) alongside the prose.',
    ],
  },
  regulatory: {
    role: 'mapping jurisdictional risk, policy, or compliance obligations for a legal team to act on',
    useWhen: 'Jurisdictional risk assessment, policy mapping, audit preparation, cross-border compliance.',
    prioritise: [
      'Primary legal texts (statutes, regulations, listing rules, enacted bills), official regulator publications, primary court decisions, and official enforcement releases.',
    ],
    deprioritise: [
      'Secondary legal commentary and law-firm marketing as primary evidence (label these `[SECONDARY: promotional]`).',
    ],
    depth: [
      'Categorise every finding strictly: `<ENACTED>` currently in force, `<PENDING>` introduced but not enacted, `<GUIDANCE>` non-binding, `<PROPOSED>` draft or consultation stage only.',
    ],
    lens: [
      'Identify jurisdictional conflicts where two regimes impose diverging requirements on the same entity.',
    ],
    output: [
      'End the report with `<REGULATORY_MAPPING_ONLY>This is a factual map, not legal advice. Confirm all enacted obligations with qualified counsel in each jurisdiction before acting.</REGULATORY_MAPPING_ONLY>`.',
    ],
  },
  academic: {
    role: 'synthesising scientific literature or reviewing methodology',
    useWhen: 'Post-graduate research, literature gap analysis, systematic methodology review.',
    prioritise: [
      'Peer-reviewed journals, conference proceedings from reputable venues, preprints clearly labelled as preprints, government research-agency publications, and systematic reviews.',
    ],
    deprioritise: [
      'Popular-science summaries and news coverage as primary evidence for scientific claims.',
    ],
    depth: [
      'For each cited study extract the experimental methodology, sample size, statistical significance (p-values, confidence intervals, effect sizes where reported), and stated limitations — do not summarise only the abstract.',
    ],
    lens: [
      'Explicitly distinguish points of scholarly consensus from points of active debate; do not equate preliminary preprints with peer-reviewed longitudinal data.',
    ],
    output: [
      'Include a Methodological Comparison table wherever more than three studies address the same question.',
    ],
  },
  forecasting: {
    role: 'forecasting trends for strategic planning or capital allocation',
    useWhen: 'Strategic planning, capital allocation, macroeconomic modelling, long-term resource allocation.',
    prioritise: [
      'Capital-expenditure patterns, demographic data, patent filings, regulatory catalysts, supply-chain and demand-side structural data, and primary datasets over commentary.',
    ],
    deprioritise: [
      'Linear extrapolations from the most recent twelve months presented as forecasts.',
    ],
    depth: [
      'Identify the underlying drivers rather than surface trends: capex patterns, demographic shifts, patent filings, regulatory catalysts, supply-chain constraints, demand-side changes.',
    ],
    lens: [
      'Resist linear extrapolation; identify precedents, reversals, and non-linear inflection points in the historical record.',
    ],
    output: [
      'Divergent scenarios are required — an Optimistic trajectory (named catalysts plus current evidence), a Conservative trajectory (named frictions plus current evidence), and Break conditions (observable events that would invalidate either).',
    ],
  },
};

/**
 * Keyword scoring for automatic archetype selection. Ties and no-match default
 * to `competitive`: it is the broadest override set, and the failure mode of
 * guessing it wrongly (extra sentiment mining) is milder than guessing
 * `regulatory` wrongly (a legal-advice disclaimer on a technical report).
 */
const ARCHETYPE_KEYWORDS: Record<Archetype, RegExp> = {
  technical:
    /\b(api|apis|architecture|stack|framework|latency|benchmark|throughput|infrastructure|sdk|database|runtime|open[- ]?source|repo|library|protocol|kubernetes|compiler)\b/gi,
  competitive:
    /\b(competit\w+|market|pricing|packaging|positioning|go[- ]?to[- ]?market|gtm|rival|landscape|customer sentiment|market siz\w+|share|vendor|churn|segment)\b/gi,
  regulatory:
    /\b(regulat\w+|compliance|disclosure|jurisdiction\w*|statute|listing rule|enforcement|legal obligation|policy|licens\w+|sanction\w*|privacy law|gdpr)\b/gi,
  academic:
    /\b(peer[- ]?reviewed|literature|methodolog\w+|study|studies|clinical|p[- ]?value|sample size|systematic review|preprint|journal|meta[- ]analysis|cohort)\b/gi,
  forecasting:
    /\b(forecast\w*|trend\w*|outlook|projection|scenario|five[- ]?year|5[- ]?year|long[- ]?term|macro\w*|demand outlook|capex|adoption curve|by 20\d\d)\b/gi,
};

export function selectArchetype(text: string): Archetype {
  let best: Archetype = 'competitive';
  let bestScore = 0;
  for (const name of ARCHETYPE_NAMES) {
    const matches = text.match(ARCHETYPE_KEYWORDS[name]);
    const score = matches ? matches.length : 0;
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return best;
}
