import { GoogleGenAI } from '@google/genai';
import type { Config } from '../config.js';
import { AGENT_BY_TIER, toSnapshot, type InteractionSnapshot, type ResearchTier } from './types.js';

/**
 * The Deep Research boundary.
 *
 * Everything the server does against Gemini goes through this interface, so the
 * whole runner/tool/report layer is testable with an injected fake and never
 * touches the network in the hermetic suite. The live adapter is the *only*
 * place that knows about `@google/genai`.
 */

/** A tool the researcher may use during the run. */
export type ResearchToolSpec =
  | { readonly type: 'google_search' }
  | { readonly type: 'url_context' }
  | { readonly type: 'code_execution' }
  | { readonly type: 'file_search'; readonly fileSearchStoreNames: readonly string[] }
  | {
      readonly type: 'mcp_server';
      readonly name: string;
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly allowedTools?: readonly string[];
    };

export interface CreateRunArgs {
  readonly prompt: string;
  readonly tier: ResearchTier;
  /** Human-in-the-loop planning: the first turn returns a plan to approve. */
  readonly collaborativePlanning: boolean;
  readonly thinkingSummaries: boolean;
  readonly visualization: boolean;
  readonly tools?: readonly ResearchToolSpec[];
  /** Continue from a prior interaction (plan refinement, follow-ups). */
  readonly previousInteractionId?: string;
  /** Extra multimodal inputs by URI (PDFs, images). */
  readonly attachments?: readonly {
    readonly kind: 'document' | 'image';
    readonly uri: string;
    readonly mimeType: string;
  }[];
}

export interface FollowUpArgs {
  readonly question: string;
  readonly previousInteractionId: string;
  readonly model: string;
}

export interface StreamOptions {
  /** Resume from this event id after a drop, rather than replaying the run. */
  readonly lastEventId?: string;
}

export interface DeepResearchClient {
  /**
   * Open the SSE stream for a run already in flight.
   *
   * Separate from `createRun` on purpose: the runner starts a run once and may
   * then attach, drop and re-attach the stream many times over the next hour,
   * so attaching has to be independent of starting.
   */
  streamRun?(interactionId: string, options?: StreamOptions): Promise<AsyncIterable<unknown>>;
  /** Kick a background run. Returns as soon as the interaction id exists. */
  createRun(args: CreateRunArgs): Promise<InteractionSnapshot>;
  /** Poll a run. */
  getRun(interactionId: string): Promise<InteractionSnapshot>;
  /** Best-effort cancel. Resolves even when the backend has already finished. */
  cancelRun(interactionId: string): Promise<void>;
  /** Cheap follow-up Q&A over a completed interaction (a plain model turn). */
  followUp(args: FollowUpArgs): Promise<string>;
}

/** Raised when the server is asked to spend money without credentials. */
export class MissingCredentialsError extends Error {
  readonly code = 'missing_credentials' as const;
  constructor() {
    super(
      'No Gemini credentials configured. Set GEMINI_API_KEY (AI Studio) or VERTEX_PROJECT (+ ADC) and restart the server.',
    );
    this.name = 'MissingCredentialsError';
  }
}

/** Raised when Gemini rejects or fails a request. Carries no secret material. */
export class GeminiRequestError extends Error {
  readonly code = 'gemini_request_failed' as const;
  constructor(operation: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Gemini ${operation} failed: ${detail.slice(0, 500)}`);
    this.name = 'GeminiRequestError';
    if (cause instanceof Error) this.cause = cause;
  }
}

function buildInput(args: CreateRunArgs): unknown {
  if (!args.attachments || args.attachments.length === 0) return args.prompt;
  return [
    { type: 'text', text: args.prompt },
    ...args.attachments.map((a) => ({
      type: a.kind,
      uri: a.uri,
      mime_type: a.mimeType,
    })),
  ];
}

function buildTools(tools: readonly ResearchToolSpec[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => {
    switch (t.type) {
      case 'google_search':
      case 'url_context':
      case 'code_execution':
        return { type: t.type };
      case 'file_search':
        return { type: 'file_search', file_search_store_names: [...t.fileSearchStoreNames] };
      case 'mcp_server':
        return {
          type: 'mcp_server',
          name: t.name,
          url: t.url,
          ...(t.headers ? { headers: { ...t.headers } } : {}),
          ...(t.allowedTools ? { allowed_tools: [...t.allowedTools] } : {}),
        };
      default: {
        const _exhaustive: never = t;
        return _exhaustive;
      }
    }
  });
}

/**
 * Live adapter over the Interactions API.
 *
 * `background: true` and `store: true` are non-negotiable for Deep Research —
 * the API rejects a foreground run, and without `store` the interaction cannot
 * be polled or continued. They are set here rather than exposed as options so a
 * caller cannot construct an unusable request.
 */
export function createLiveClient(config: Config): DeepResearchClient {
  if (config.auth.mode === 'none') throw new MissingCredentialsError();

  const genai =
    config.auth.mode === 'vertex'
      ? new GoogleGenAI({
          vertexai: true,
          project: config.auth.project,
          location: config.auth.location,
        })
      : new GoogleGenAI({ apiKey: config.auth.apiKey });

  // The SDK's agent-interaction param union is narrower than the documented
  // wire shape (its AgentTool union omits file_search, and agent ids are typed
  // as a closed enum that trails the preview releases). We build the documented
  // body and hand it over at this single boundary rather than fighting the
  // types at every call site.
  const interactions = genai.interactions as unknown as {
    create(params: Record<string, unknown>): Promise<unknown>;
    get(id: string, params?: Record<string, unknown> | null): Promise<unknown>;
    cancel(id: string): Promise<unknown>;
  };

  function idOf(raw: unknown, fallback: string): string {
    if (raw && typeof raw === 'object' && 'id' in raw) {
      const id = (raw as { id?: unknown }).id;
      if (typeof id === 'string' && id) return id;
    }
    return fallback;
  }

  return {
    async createRun(args) {
      const tools = buildTools(args.tools);
      const body: Record<string, unknown> = {
        agent: AGENT_BY_TIER[args.tier],
        input: buildInput(args),
        background: true,
        store: true,
        agent_config: {
          type: 'deep-research',
          collaborative_planning: args.collaborativePlanning,
          thinking_summaries: args.thinkingSummaries ? 'auto' : 'none',
          visualization: args.visualization ? 'auto' : 'off',
        },
        ...(tools ? { tools } : {}),
        ...(args.previousInteractionId
          ? { previous_interaction_id: args.previousInteractionId }
          : {}),
      };
      let raw: unknown;
      try {
        raw = await interactions.create(body);
      } catch (e: unknown) {
        throw new GeminiRequestError('interactions.create', e);
      }
      return toSnapshot(idOf(raw, ''), raw);
    },

    async getRun(interactionId) {
      let raw: unknown;
      try {
        raw = await interactions.get(interactionId);
      } catch (e: unknown) {
        throw new GeminiRequestError('interactions.get', e);
      }
      return toSnapshot(interactionId, raw);
    },

    async streamRun(interactionId, options) {
      try {
        const raw = await interactions.get(interactionId, {
          stream: true,
          ...(options?.lastEventId ? { last_event_id: options.lastEventId } : {}),
        });
        return raw as AsyncIterable<unknown>;
      } catch (e: unknown) {
        throw new GeminiRequestError('interactions.get (stream)', e);
      }
    },

    async cancelRun(interactionId) {
      try {
        await interactions.cancel(interactionId);
      } catch (e: unknown) {
        // A run that already finished (or was never created) is not an error
        // worth failing the caller's cancel over — the desired end state holds.
        const message = e instanceof Error ? e.message : String(e);
        if (/not.?found|already|completed|invalid/i.test(message)) return;
        throw new GeminiRequestError('interactions.cancel', e);
      }
    },

    async followUp(args) {
      if (config.auth.mode === 'vertex') {
        // The Interactions API on Vertex serves agents and specialised media
        // models; a follow-up turn passes a standard Gemini model, which it
        // will not route. Fail with the reason rather than a routing error.
        throw new Error(
          'Follow-up turns need a standard Gemini model, which the Interactions API does not serve on Vertex. Use GEMINI_API_KEY, or read the report directly with research_read.',
        );
      }
      let raw: unknown;
      try {
        raw = await interactions.create({
          model: args.model,
          input: args.question,
          previous_interaction_id: args.previousInteractionId,
        });
      } catch (e: unknown) {
        throw new GeminiRequestError('interactions.create (follow-up)', e);
      }
      const snapshot = toSnapshot(idOf(raw, args.previousInteractionId), raw);
      return snapshot.markdown;
    },
  };
}

/**
 * Resolve the client for the running server. Hermetic mode never constructs a
 * live client, so a stray key in the environment cannot make the test suite
 * spend money.
 */
export function resolveClient(config: Config): DeepResearchClient | null {
  if (config.hermetic || config.auth.mode === 'none') return null;
  return createLiveClient(config);
}
