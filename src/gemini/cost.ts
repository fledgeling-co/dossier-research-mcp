import type { ResearchTier } from './types.js';

/**
 * Cost estimation for a Deep Research task.
 *
 * Google publishes per-task *ranges* rather than a formula, because billing is
 * the underlying model tokens plus whatever tools the agentic loop consumed.
 * We therefore estimate a band, never a precise figure, and the ledger charges
 * the band's midpoint on start and reconciles nothing afterwards — the number
 * is a spend *guardrail*, not an invoice. Callers are told this explicitly so
 * nobody reconciles our figure against a Google bill.
 *
 * Source: Gemini API "Deep Research" docs, preview pricing estimates.
 */
export interface CostBand {
  readonly lowUsd: number;
  readonly highUsd: number;
  readonly midUsd: number;
  readonly basis: string;
}

const BANDS: Record<ResearchTier, { low: number; high: number; basis: string }> = {
  fast: {
    low: 1,
    high: 3,
    basis: '~80 searches, ~250k input tokens (50-70% cached), ~60k output',
  },
  max: {
    low: 3,
    high: 7,
    basis: 'up to ~160 searches, ~900k input tokens, ~80k output',
  },
};

export function estimateCost(tier: ResearchTier): CostBand {
  const b = BANDS[tier];
  return {
    lowUsd: b.low,
    highUsd: b.high,
    midUsd: (b.low + b.high) / 2,
    basis: b.basis,
  };
}

/** Typical wall-clock band, in minutes. The API caps a task at 60 minutes. */
export function estimateDuration(tier: ResearchTier): { lowMinutes: number; highMinutes: number } {
  return tier === 'max' ? { lowMinutes: 10, highMinutes: 60 } : { lowMinutes: 4, highMinutes: 20 };
}

/**
 * A managed-agent run.
 *
 * Google prices these on tokens rather than per task, and documents a single
 * interaction as "typically 100k to 3M tokens". At Flash rates that spans
 * roughly $0.05 to $1.50, so this reserves the top of the range. It is a
 * coarser estimate than the Deep Research bands, which is exactly why it
 * reserves the high end: an ungated path is worse than an over-cautious one,
 * and `agent_run` previously had no ceiling of any kind.
 */
export const AGENT_RUN_BAND: CostBand = {
  lowUsd: 0.05,
  highUsd: 1.5,
  midUsd: 0.5,
  basis: 'token-metered; Google documents 100k-3M tokens for a single interaction',
};

export function formatCostBand(band: CostBand): string {
  return `$${band.lowUsd.toFixed(2)}-$${band.highUsd.toFixed(2)}`;
}
