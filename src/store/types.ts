import { z } from 'zod';
import { RESEARCH_TIERS } from '../gemini/types.js';
import { ARCHETYPE_NAMES } from '../research/archetypes.js';
import { RUN_FAILURE_KINDS } from '../research/failure.js';
import { PROVIDER_IDS } from '../providers/types.js';

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
  /**
   * Which backend owns this run.
   *
   * Defaulted rather than required so every record written before the provider
   * layer existed still parses. A store predating this change is by definition
   * a Gemini store, and a migration that invalidated existing runs would lose
   * reports people paid for.
   *
   * The enum is `PROVIDER_IDS`, which still carries the bare `local` id. That
   * id is kept for two reasons, not one: every record written before the
   * per-CLI split carries it, and `importRun` and the local research loop still
   * write it today for runs that no CLI backend owns.
   */
  provider: z.enum(PROVIDER_IDS).default('gemini'),
  /**
   * The panel this run belongs to, when it was started as one member of one.
   *
   * A panel is several runs sharing this id rather than one record with
   * members. Each backend has its own interaction id, its own report, its own
   * lifecycle and its own ledger line, and one record cannot hold two of any of
   * those. Optional, so every record written before panels existed still parses
   * and every single-provider run stays exactly what it was.
   */
  panelId: z.string().max(64).optional(),
  /**
   * The exact model that produced the report, as the backend names it.
   *
   * Optional because runs recorded before this field existed have no way to
   * know, and inventing one would be worse than admitting it. A backend that
   * silently swaps model behind a tier is a thing that happens, and a report
   * you cannot attribute is a report you cannot reproduce.
   */
  model: z.string().max(120).optional(),
  /**
   * What artefact this run was asked for. Defaulted for the same reason as
   * `provider`: every record written before shapes existed is a deep run.
   */
  shape: z.enum(['deep', 'wide', 'recent', 'corpus']).default('deep'),
  /** The time window requested, when one was. Recorded for the audit trail. */
  window: z.string().max(10).optional(),
  /**
   * The wide spec, serialised.
   *
   * Held so the completion gate can run against the finished report: checking
   * that every requested column came back needs to know what was requested,
   * and that is not recoverable from the prompt an hour later.
   */
  wideSpec: z.string().max(20_000).optional(),
  /**
   * Which deliberate repetition of an identical request this run is.
   *
   * Set only by the benchmark harness, where `n = 5` of one task on one backend
   * must be five paid runs rather than one run counted five times. Absent on
   * every ordinary run, and absent on every record written before it existed.
   * The cap is the same order as a plausible `n`; a five-digit repetition index
   * is a loop, not a measurement.
   */
  repeat: z.number().int().min(1).max(1000).optional(),
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
  reasoningSteps: z.number().int().nonnegative().default(0),
  streamedChars: z.number().int().nonnegative().default(0),
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
  /**
   * Why it failed, when it failed.
   *
   * `failed` alone could not tell a broken adapter from a hard question, and
   * they need opposite responses. Optional so every record written before this
   * existed still parses; absent means "not classified", which renders as the
   * plain `failed` it always did rather than as a guess.
   */
  failureKind: z.enum(RUN_FAILURE_KINDS).optional(),
  /**
   * The HTTP status the provider returned, when it returned one.
   *
   * Held so a 429 can be labelled as a 429. The error text carries it too, but
   * only in prose, and prose is not something a caller can branch on.
   */
  failureStatus: z.number().int().min(100).max(599).optional(),
  /**
   * True once the budget commitment for this run has been released.
   *
   * On the record as well as in the ledger because it is the flag that makes
   * the release idempotent: a run whose commitment was already returned must
   * not return it twice if the record is re-saved.
   *
   * Optional rather than defaulted, so absent means "never released", which is
   * what every record written before this existed means. A default would make
   * the field required on the output type and force every construction site to
   * restate a fact none of them has an opinion about.
   */
  budgetReleased: z.boolean().optional(),
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
  /**
   * Whether this line commits money or gives it back.
   *
   * The ledger stays append-only: a request the provider provably refused is
   * compensated with a `release` line naming the same `runId`, never by editing
   * or deleting the reservation. The history of what happened is the point, and
   * "we reserved $9 and then learned nothing was created" is a truer record
   * than a reservation that quietly vanishes.
   *
   * The amount stays `nonnegative` rather than allowing a negative reservation,
   * deliberately. A negative amount would be the smaller diff and it would hand
   * anyone who can write to the ledger an unlimited budget: one hand-edited
   * line of `-1000000` and the ceiling is gone. Releases are a separate kind so
   * they can be bounded by what was actually reserved for that run.
   *
   * Optional, so every line written before this existed reads as a
   * reservation, which is what it was. `netCommittedUsd` treats an absent kind
   * as `reserve`, which is the direction that counts spend rather than hiding
   * it.
   */
  kind: z.enum(['reserve', 'release']).optional(),
  /** Why a release happened. Ignored on a reservation. */
  reason: z.string().max(300).optional(),
  label: z.string().max(200).optional(),
  /**
   * Which backend the money went to.
   *
   * Defaulted rather than required so every line written before per-provider
   * accounting existed still parses; a ledger that fails to load is a ledger
   * that reads as zero spend, which is the one failure this file cannot have.
   *
   * A free CLI member writes a line here at $0. The ledger is the record of
   * what ran, not only of what cost money, so three CLIs on one question are
   * three lines and the panel is legible afterwards.
   */
  provider: z.enum(PROVIDER_IDS).default('gemini'),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
