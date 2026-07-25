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

/**
 * A single utility-model call: a title, a summary, a follow-up answer, a claim
 * extraction.
 *
 * These are small next to a research run, which is exactly why they were
 * originally left outside the ledger. That was wrong: `research_followup` and
 * `research_claims` both invoke a billed model, and automatic titling fires on
 * every completed run. Unreserved billed calls mean the "hard" daily ceiling
 * was never the whole spend. Cheap is not free, and a loop of cheap is not
 * cheap.
 *
 * Reserving the top of a generous band keeps the gate conservative without
 * making a $0.01 title look like a $1.50 agent run.
 */
export const UTILITY_CALL_BAND: CostBand = {
  lowUsd: 0.002,
  highUsd: 0.08,
  midUsd: 0.02,
  basis: 'one utility-model call over a report-sized context',
};

/**
 * What this particular run will cost, not what runs cost in general.
 *
 * The tier sets the base band; everything attached to the run adds tokens on
 * top of it, and those tokens are the bill. A corpus search pulls retrieved
 * passages into context, `url_context` pulls whole fetched pages in,
 * attachments pull documents in, and an MCP server pulls back whatever it feels
 * like. Charging all of that to a flat tier band understates a heavily-equipped
 * run, and the understatement lands in the one place it must not: the spend
 * gate reserves from this number.
 *
 * Increments are judgement calibrated on Google's published token figures, not
 * measurements. The band stays deliberately wide and is labelled an estimate
 * everywhere it surfaces.
 */
export function estimateCost(input: CostInput): CostBand {
  const opts: DurationOptions = typeof input === 'string' ? { tier: input } : input;
  const b = BANDS[opts.tier];
  const tools = opts.tools ?? [];
  const attachments = opts.attachments ?? 0;
  const count = (type: string): number => tools.filter((x: string) => x === type).length;

  let low = b.low;
  let high = b.high;
  const extras: string[] = [];
  const add = (l: number, h: number, why: string): void => {
    low += l;
    high += h;
    extras.push(why);
  };

  // `google_search`, `url_context` and `code_execution` are on for every run,
  // so Google's published band already accounts for them. Charging extra for
  // them would inflate the headline figure for the default case and make the
  // documented $1-3 / $3-7 wrong. Only things you deliberately attach add cost.
  const corpora = count('file_search');
  if (corpora > 0) add(0.3 * corpora, 1.2 * corpora, `retrieved passages from ${corpora} corpus store${corpora === 1 ? '' : 's'}`);
  const mcp = count('mcp_server');
  if (mcp > 0) add(0.2 * mcp, 1.0 * mcp, `content returned by ${mcp} external MCP server${mcp === 1 ? '' : 's'}`);
  if (attachments > 0) {
    add(0.1 * attachments, Math.min(0.5 * attachments, 3), `${attachments} attached file${attachments === 1 ? '' : 's'} read into context`);
  }

  // Deliberately NOT including the automatic title and summary here. Those
  // reserve separately via `reserveUtilitySpend` at the moment they run;
  // folding them in as well would reserve the same few cents twice and make
  // every documented band end in .08.

  const basis = extras.length > 0 ? `${b.basis}; plus ${extras.join(', ')}` : b.basis;
  return {
    lowUsd: Number(low.toFixed(2)),
    highUsd: Number(high.toFixed(2)),
    midUsd: Number(((low + high) / 2).toFixed(2)),
    basis,
  };
}

/** A bare tier still works, so existing callers do not have to change. */
export type CostInput = ResearchTier | DurationOptions;

export interface DurationOptions {
  readonly tier: ResearchTier;
  /** deep | wide | recent | corpus. Affects cost independently of tier. */
  readonly shape?: string;
  /** Tool `type` strings, exactly as passed to the API. */
  readonly tools?: readonly string[];
  readonly attachments?: number;
  readonly collaborativePlanning?: boolean;
}

/** A bare tier still works, so existing callers do not have to change. */
export type DurationInput = ResearchTier | DurationOptions;

export interface DurationEstimate {
  readonly lowMinutes: number;
  readonly highMinutes: number;
  /** Why the band is what it is, in the order the run will incur them. */
  readonly factors: readonly string[];
  /** Sources this run will actually consult, for the caller to sanity-check. */
  readonly sources: readonly string[];
  /** True when the run pauses for a human before it spends the research budget. */
  readonly awaitsApproval: boolean;
  /** True when the factors summed past the provider's hard task limit. */
  readonly cappedByApiLimit: boolean;
}

/** Google caps one Deep Research task at 60 minutes. */
const API_TASK_CAP_MINUTES = 60;

/**
 * How long this particular run will take, not how long runs take in general.
 *
 * The tier sets the base band (Google's published figures: roughly 80 searches
 * against roughly 160). Everything attached to the run extends it, and the
 * caller deserves to see which thing costs which minutes rather than a single
 * opaque range. An MCP server is the biggest unknown, because its latency is
 * somebody else's problem entirely.
 *
 * These increments are judgement, not measurement, and the returned band is
 * deliberately wide. A wide honest band beats a narrow invented one: the whole
 * point is telling someone whether to wait or go and do something else.
 */
export function estimateDuration(input: DurationInput): DurationEstimate {
  const opts: DurationOptions = typeof input === 'string' ? { tier: input } : input;
  const tier = opts.tier;
  const tools = opts.tools ?? [];
  const attachments = opts.attachments ?? 0;

  const base =
    tier === 'max' ? { low: 10, high: 60 } : { low: 4, high: 20 };
  const factors: string[] = [
    tier === 'max'
      ? 'up to ~160 searches (max tier)'
      : '~80 searches (fast tier)',
  ];
  const sources: string[] = [];

  let low = base.low;
  let high = base.high;
  const add = (l: number, h: number, why: string) => {
    low += l;
    high += h;
    factors.push(why);
  };

  const count = (type: string): number => tools.filter((t: string) => t === type).length;

  if (count('google_search') > 0) sources.push('Google Search (the open web)');
  if (count('url_context') > 0) {
    sources.push('specific URLs you named');
    add(1, 4, 'fetching and reading the URLs you supplied');
  }
  const corpora = count('file_search');
  if (corpora > 0) {
    sources.push(`${corpora} private corpus store${corpora === 1 ? '' : 's'}`);
    add(2, 8, 'searching your private corpus alongside the web');
  }
  if (count('code_execution') > 0) {
    add(1, 5, 'running code to check its own figures');
  }
  const mcp = count('mcp_server');
  if (mcp > 0) {
    sources.push(`${mcp} external MCP server${mcp === 1 ? '' : 's'}`);
    // Somebody else's latency, retries and rate limits. Widest increment here.
    add(2, 10 * mcp, `calling ${mcp} external MCP server${mcp === 1 ? '' : 's'} (their latency, not ours)`);
  }
  if (attachments > 0) {
    sources.push(`${attachments} attached file${attachments === 1 ? '' : 's'}`);
    add(1, Math.min(3 * attachments, 12), `reading ${attachments} attached file${attachments === 1 ? '' : 's'}`);
  }
  if (sources.length === 0) sources.push('Google Search (the open web)');

  // The API caps a single task at 60 minutes, so an additive estimate must not
  // promise more than the provider will ever deliver. When the factors add up
  // past the cap, say that the run is more likely to be truncated than slow:
  // that is the actionable version of the same information.
  const capped = high > API_TASK_CAP_MINUTES;
  if (capped) {
    high = API_TASK_CAP_MINUTES;
    factors.push(`capped at the API's ${API_TASK_CAP_MINUTES}-minute task limit, so expect breadth to be trimmed rather than the clock to run over`);
  }

  return {
    lowMinutes: Math.min(low, API_TASK_CAP_MINUTES),
    highMinutes: high,
    factors,
    sources,
    awaitsApproval: opts.collaborativePlanning === true,
    cappedByApiLimit: capped,
  };
}



/** One line a caller can show verbatim. */
export function formatDuration(d: DurationEstimate): string {
  const band = `${d.lowMinutes}-${d.highMinutes} minutes`;
  return d.awaitsApproval
    ? `${band} of research, starting after you approve the plan`
    : `${band}, running in the background`;
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

/**
 * `agent_run` executes a **user-defined** agent, so its model and token volume
 * are not ours to predict: the band above is a Flash-rate guess and a run on a
 * Pro-class model can exceed it several times over.
 *
 * Rather than pretend to an estimate, cap the exposure. A caller who wants a
 * larger single agent run raises this deliberately, which is the same shape as
 * every other spend control here: refuse early rather than reconcile late.
 *
 * **What this is not:** a limit Google enforces. It is the amount reserved
 * against the local ledger before the call, so it refuses a run that would
 * cross the ceiling and does nothing to stop an admitted run costing more than
 * the reservation. Calling it "hard" without that sentence overstated it: no
 * token, tool or dollar limit reaches the provider, because `agent_run`
 * executes a user-defined agent whose model and volume are not ours to bound.
 */
export const AGENT_RUN_HARD_CAP_USD = 5;

export function formatCostBand(band: CostBand): string {
  return `$${band.lowUsd.toFixed(2)}-$${band.highUsd.toFixed(2)}`;
}

