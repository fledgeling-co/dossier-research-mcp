import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import type { Config } from '../config.js';
import { GeminiRequestError, MissingCredentialsError } from './client.js';

/**
 * The Managed Agents surface — the *other* Gemini research technology.
 *
 * Where the Deep Research API gives you one opinionated, fully-managed research
 * loop per call, the Agents API gives you a **persisted, reusable agent**: an
 * id, a system instruction, a tool set, and a base environment (a real Linux
 * sandbox with Python and Node) that every interaction forks from. It is the
 * right surface when research is one step of a longer job that has to produce
 * files, run code over your data, or carry house methodology across many runs.
 *
 * Documented constraint, honestly surfaced rather than papered over: at preview
 * the only `base_agent` accepted is the Antigravity agent. You cannot currently
 * derive a custom agent from `deep-research-*`. So a custom agent here is a
 * *complement* to a Deep Research run, not a way to fork one — see
 * `docs/deep-research-api-vs-agent.md`.
 */

export const DEFAULT_BASE_AGENT = 'antigravity-preview-05-2026';

/** Agent ids Google reserves; creation fails on these prefixes. */
const RESERVED_PREFIXES = [
  'antigravity-', 'veo-', 'omni-', 'lyria-', 'imagen-', 'gemma-', 'gemini-',
  'google-', 'youtube-', 'android-', 'chrome-', 'pixel-', 'waze-', 'fitbit-',
  'nest-', 'kaggle-',
] as const;

export const AgentIdSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits and hyphens; start with alphanumeric.')
  .refine(
    (id) => !RESERVED_PREFIXES.some((p) => id.toLowerCase().startsWith(p)),
    { message: `Id starts with a prefix Google reserves (${RESERVED_PREFIXES.join(', ')}).` },
  );

export interface AgentSource {
  readonly type: 'inline' | 'repository';
  readonly target: string;
  /** Required for `inline`. */
  readonly content?: string;
  /** Required for `repository`. */
  readonly source?: string;
}

export interface CreateAgentArgs {
  readonly id: string;
  readonly description?: string;
  readonly systemInstruction?: string;
  readonly model?: string;
  readonly baseAgent?: string;
  readonly sources?: readonly AgentSource[];
  /** Domains the sandbox may reach; omit for the unrestricted default. */
  readonly networkAllowlist?: readonly { readonly domain: string }[];
}

export interface AgentSummary {
  readonly id: string;
  // `| undefined` is explicit because these come straight out of a Zod parse
  // under `exactOptionalPropertyTypes` — "absent" and "present as undefined"
  // are the same thing to a caller here.
  readonly description?: string | undefined;
}

export interface RunAgentArgs {
  readonly agentId: string;
  readonly input: string;
  /** `"remote"` for a fresh sandbox, or a prior `environmentId` to resume. */
  readonly environment?: string;
  readonly previousInteractionId?: string;
  readonly timeoutMs?: number;
}

export interface RunAgentResult {
  readonly interactionId: string;
  readonly environmentId: string;
  readonly outputText: string;
}

export interface AgentsClient {
  create(args: CreateAgentArgs): Promise<AgentSummary>;
  list(): Promise<AgentSummary[]>;
  get(id: string): Promise<AgentSummary | null>;
  remove(id: string): Promise<void>;
  run(args: RunAgentArgs): Promise<RunAgentResult>;
}

const AgentResponseSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
});

const ListAgentsSchema = z.object({
  agents: z.array(AgentResponseSchema).optional(),
});

const InteractionResultSchema = z.object({
  id: z.string().optional(),
  environment_id: z.string().optional(),
  output_text: z.string().optional(),
});

export function createAgentsClient(config: Config): AgentsClient {
  if (config.auth.mode === 'none') throw new MissingCredentialsError();

  const genai =
    config.auth.mode === 'vertex'
      ? new GoogleGenAI({
          vertexai: true,
          project: config.auth.project,
          location: config.auth.location,
        })
      : new GoogleGenAI({ apiKey: config.auth.apiKey });

  // Same single-boundary cast as the interactions client: the SDK's agent types
  // trail the preview wire format, and we validate the responses with Zod
  // regardless of what the declaration files claim.
  const agents = genai.agents as unknown as {
    create(params: Record<string, unknown>): Promise<unknown>;
    list(params?: Record<string, unknown> | null): Promise<unknown>;
    get(id: string): Promise<unknown>;
    delete(id: string): Promise<unknown>;
  };
  const interactions = genai.interactions as unknown as {
    create(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  };

  return {
    async create(args) {
      const id = AgentIdSchema.parse(args.id);
      const baseEnvironment: Record<string, unknown> = { type: 'remote' };
      if (args.sources && args.sources.length > 0) {
        baseEnvironment.sources = args.sources.map((s) => ({
          type: s.type,
          target: s.target,
          ...(s.content !== undefined ? { content: s.content } : {}),
          ...(s.source !== undefined ? { source: s.source } : {}),
        }));
      }
      if (args.networkAllowlist && args.networkAllowlist.length > 0) {
        baseEnvironment.network = {
          allowlist: args.networkAllowlist.map((a) => ({ domain: a.domain })),
        };
      }

      let raw: unknown;
      try {
        raw = await agents.create({
          id,
          base_agent: args.baseAgent ?? DEFAULT_BASE_AGENT,
          ...(args.model
            ? { agent_config: { type: 'antigravity', model: args.model } }
            : {}),
          ...(args.systemInstruction ? { system_instruction: args.systemInstruction } : {}),
          ...(args.description ? { description: args.description } : {}),
          base_environment: baseEnvironment,
        });
      } catch (e: unknown) {
        throw new GeminiRequestError('agents.create', e);
      }
      const parsed = AgentResponseSchema.safeParse(raw);
      return parsed.success ? parsed.data : { id };
    },

    async list() {
      let raw: unknown;
      try {
        raw = await agents.list();
      } catch (e: unknown) {
        throw new GeminiRequestError('agents.list', e);
      }
      const parsed = ListAgentsSchema.safeParse(raw);
      return parsed.success ? (parsed.data.agents ?? []) : [];
    },

    async get(id) {
      try {
        const raw = await agents.get(AgentIdSchema.parse(id));
        const parsed = AgentResponseSchema.safeParse(raw);
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },

    async remove(id) {
      try {
        await agents.delete(AgentIdSchema.parse(id));
      } catch (e: unknown) {
        throw new GeminiRequestError('agents.delete', e);
      }
    },

    async run(args) {
      let raw: unknown;
      try {
        raw = await interactions.create(
          {
            agent: args.agentId,
            input: args.input,
            environment: args.environment ?? 'remote',
            ...(args.previousInteractionId
              ? { previous_interaction_id: args.previousInteractionId }
              : {}),
          },
          { timeout: args.timeoutMs ?? 300_000 },
        );
      } catch (e: unknown) {
        throw new GeminiRequestError('interactions.create (agent)', e);
      }
      const parsed = InteractionResultSchema.safeParse(raw);
      const data = parsed.success ? parsed.data : {};
      return {
        interactionId: data.id ?? '',
        environmentId: data.environment_id ?? '',
        outputText: data.output_text ?? '',
      };
    },
  };
}

export function resolveAgentsClient(config: Config): AgentsClient | null {
  if (config.hermetic || config.auth.mode === 'none') return null;
  return createAgentsClient(config);
}

/**
 * The house research system instruction for a custom agent — the same source
 * discipline and epistemic bounding the prompt architect applies, expressed as
 * a persistent persona rather than a per-call prompt.
 */
export const RESEARCH_AGENT_INSTRUCTION = `You are a research analyst operating in a sandboxed environment.

Method:
- Prioritise primary and authoritative sources: official documentation, peer-reviewed literature, regulators, government databases, filed financials, raw datasets. Treat aggregator sites, SEO listicles and marketing blogs as promotional secondary material and corroborate anything taken from them.
- Attach a confidence qualifier (High / Medium / Low) to every non-trivial claim.
- Cite inline at the point of the claim, never in an end-of-document bibliography.
- When data is unavailable or contested, say so explicitly with <MISSING_DATA>, <INSUFFICIENT_EVIDENCE> or <CONFLICTING_EVIDENCE> rather than estimating. Never present a synthesised number as an empirical finding.
- Where you write files, put deliverables under /workspace and state the paths in your final answer.`;
