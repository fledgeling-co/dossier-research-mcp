import { z } from 'zod';
import { RESEARCH_TIERS } from '../gemini/types.js';
import { ARCHETYPE_NAMES } from '../research/archetypes.js';

/**
 * Persisted shapes. These are read back from disk on every server start, so
 * they are a trust boundary exactly like a network payload (CP §1) — a
 * hand-edited or partially-written record must be rejected, not cast.
 */

export const RUN_STATES = [
  'planning', // collaborative planning turn returned a plan; awaiting approval
  'running',
  'completed',
  'failed',
  'cancelled',
  'stalled', // no progress within the watchdog window; still recoverable
] as const;
export type RunState = (typeof RUN_STATES)[number];

/** Terminal states never re-enter the poller. */
export const TERMINAL_STATES: readonly RunState[] = ['completed', 'failed', 'cancelled'];

export const CitationVerdictSchema = z.object({
  url: z.string().max(4000),
  verdict: z.enum(['live', 'not_found', 'unreachable', 'blocked', 'unverified', 'invalid_url']),
  httpStatus: z.number().int().optional(),
  checkedAt: z.string(),
  note: z.string().max(500).optional(),
});
export type CitationVerdict = z.infer<typeof CitationVerdictSchema>;

export const RunRecordSchema = z.object({
  /** Stable local handle. Callers only ever see this, never the interaction id. */
  id: z.string().min(1).max(64),
  interactionId: z.string().max(200).default(''),
  state: z.enum(RUN_STATES),
  tier: z.enum(RESEARCH_TIERS),
  archetype: z.enum(ARCHETYPE_NAMES),

  /** The caller's original question, verbatim. */
  question: z.string().max(20_000),
  /** The prompt actually sent (engineered, or the caller's own scaffold). */
  prompt: z.string().max(200_000),
  /** True when the caller supplied an already-engineered prompt. */
  promptWasPreEngineered: z.boolean().default(false),

  /** Dedupe key: hash of (prompt, tier, tools, corpus). */
  fingerprint: z.string().max(128),

  createdAt: z.string(),
  updatedAt: z.string(),
  /** Last time the run reported forward progress — drives stall detection. */
  lastProgressAt: z.string(),
  completedAt: z.string().optional(),

  estimatedCostUsd: z.number().nonnegative().default(0),
  label: z.string().max(200).optional(),
  tags: z.array(z.string().max(60)).max(20).default([]),

  /** Collaborative planning: the plan Gemini proposed, awaiting approval. */
  plan: z.string().max(100_000).optional(),
  planApproved: z.boolean().default(false),

  title: z.string().max(300).optional(),
  summary: z.string().max(5000).optional(),
  /** Path (relative to the store dir) of the report markdown, when completed. */
  reportPath: z.string().max(500).optional(),
  reportChars: z.number().int().nonnegative().default(0),
  sourceCount: z.number().int().nonnegative().default(0),
  imageCount: z.number().int().nonnegative().default(0),

  citations: z.array(CitationVerdictSchema).max(2000).optional(),
  citationsCheckedAt: z.string().optional(),

  /** Live progress from the SSE stream. Zero when only polling was used. */
  searches: z.number().int().nonnegative().default(0),
  urlsFetched: z.number().int().nonnegative().default(0),
  corpusQueries: z.number().int().nonnegative().default(0),
  codeRuns: z.number().int().nonnegative().default(0),
  /** SSE resume token, so a dropped stream picks up where it left off. */
  lastEventId: z.string().max(300).optional(),
  /** True once the stream has been abandoned and polling took over. */
  streamAbandoned: z.boolean().default(false),

  toolsUsed: z.array(z.string().max(80)).max(20).default([]),
  corpusStores: z.array(z.string().max(300)).max(20).default([]),

  error: z.string().max(4000).optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const JournalEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  at: z.string(),
  kind: z.enum(['created', 'plan', 'progress', 'thought', 'completed', 'failed', 'cancelled', 'stalled', 'note']),
  message: z.string().max(20_000),
});
export type JournalEvent = z.infer<typeof JournalEventSchema>;

export const LedgerEntrySchema = z.object({
  at: z.string(),
  runId: z.string().max(64),
  tier: z.enum(RESEARCH_TIERS),
  estimatedCostUsd: z.number().nonnegative(),
  label: z.string().max(200).optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
