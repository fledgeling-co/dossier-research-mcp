import { z } from 'zod';
import type { Config } from '../config.js';
import type { CreateRunArgs, DeepResearchClient, FollowUpArgs } from '../gemini/client.js';
import type { CostBand, DurationOptions } from '../gemini/cost.js';
import { estimateDuration } from '../gemini/cost.js';
import type { InteractionSnapshot, ResearchTier } from '../gemini/types.js';
import { attemptOnceThenSettle, retry, retryAfterMs } from '../net/retry.js';
import { compact } from './types.js';
import type {
  Capabilities,
  CredentialStatus,
  ProviderEstimate,
  ResearchProvider,
} from './types.js';

/**
 * OpenAI as a provider.
 *
 * Deliberately **not** the deep-research models. `o3-deep-research` reached end
 * of access on 23 July 2026 and is gone from the model list; `o4-mini-deep-research`
 * was *also* announced as retiring and is still listed as of 25 July 2026
 * (verified against a live `/v1/models` call). Either way OpenAI's own
 * deep-research guide still documents both, which is the reminder that a
 * capability matrix keyed on a provider name rather than a provider *and model*
 * goes stale within months.
 *
 * The replacement is `gpt-5.6-sol` with the same tools and the same background
 * mode, and it lifts two constraints the retired models had: structured outputs
 * and function calling both work now, and web search takes a domain filter of
 * up to 100 entries, which is five times Perplexity's.
 */

const API = 'https://api.openai.com/v1';

/** `reasoning.effort`. `xhigh` is OpenAI's own recommendation for deep research. */
const RESEARCH_EFFORT = { fast: 'high', max: 'xhigh' } as const;
const MODEL = { fast: 'gpt-5.6-terra', max: 'gpt-5.6-sol' } as const;

/** The model this backend will actually use for a tier, for the run record. */
export function modelFor(tier: keyof typeof MODEL): string {
  return MODEL[tier];
}

export interface OpenAiOptions {
  /** Up to 100 domains; prefix with `-` to block rather than allow. */
  readonly domains?: readonly string[];
  /**
   * The primary lever on both cost *and* quality. OpenAI's API docs call it the
   * main way to constrain cost; their launch data shows pass rate rising with
   * it across the whole plotted range. Capping is a trade, not a saving.
   */
  readonly maxToolCalls?: number;
}

const MARKER = '\n\n<!--dossier:openai ';

export function encodeOpenAiOptions(prompt: string, opts: OpenAiOptions): string {
  return Object.keys(opts).length === 0 ? prompt : `${prompt}${MARKER}${JSON.stringify(opts)}-->`;
}

/** Bounded, because the marker rides on caller-supplied prompt text (CP §1). */
const OpenAiOptionsSchema = z
  .object({
    domains: z.array(z.string().max(200)).max(100).optional(),
    // Capped: an injected `maxToolCalls` is a direct lever on the bill.
    maxToolCalls: z.number().int().min(1).max(500).optional(),
  })
  .strict();

export function decodeOpenAiOptions(prompt: string): { prompt: string; opts: OpenAiOptions } {
  const at = prompt.lastIndexOf(MARKER);
  if (at === -1) return { prompt, opts: {} };
  try {
    const parsed = OpenAiOptionsSchema.safeParse(JSON.parse(prompt.slice(at + MARKER.length).replace(/-->\s*$/, '')));
    if (!parsed.success) return { prompt, opts: {} };
    // Strip the explicit `undefined`s Zod emits for absent optionals;
    // `exactOptionalPropertyTypes` treats those as different from absent.
    return { prompt: prompt.slice(0, at), opts: compact(parsed.data) };
  } catch {
    return { prompt, opts: {} };
  }
}

export function openAiCost(input: DurationOptions): CostBand {
  // gpt-5.6-sol is $5/$30 per 1M under the 272k threshold; a research run is
  // input-heavy with a large reasoning component. Bands, not arithmetic.
  const sol = input.tier === 'max';
  const low = sol ? 1.5 : 0.6;
  const high = sol ? 9 : 3.5;
  return {
    lowUsd: low,
    highUsd: high,
    midUsd: Number(((low + high) / 2).toFixed(2)),
    basis: `${sol ? 'gpt-5.6-sol' : 'gpt-5.6-terra'} with web search, reasoning-heavy; a max_tool_calls ceiling is always sent, so the tool half of the bill is genuinely bounded`,
  };
}

export function openAiProvider(config: Config): ResearchProvider {
  const capabilities: Capabilities = {
    shapes: ['deep', 'corpus'],
    background: true,
    planReview: false,
    followUp: true,
    dateFilter: 'none',
    domainFilter: 100,
    // Advertised `vector-store` while the create body carried only web
    // search, so routing sent corpus work to a backend that ignored it. It is
    // a real OpenAI capability and an unimplemented one here; saying `none`
    // until the wiring exists is the difference between a gap and a lie.
    corpus: 'none',
    socialSources: [],
    structuredOutput: true,
    fileOutput: true,
    maxWallClockMinutes: 45,
    billedTo: 'api-balance',
    limitations: [
      'No editable plan before spending. The ChatGPT product has one; the API does not.',
      'Never asks clarifying questions: it expects a fully-formed prompt and will not ask for context.',
      'No date filter; recency goes in the prompt and is not enforced.',
      'Private-corpus grounding is NOT wired up here yet, though the API supports vector stores. Use Gemini for corpus work.',
    ],
  };

  const key = config.openaiApiKey;
  /**
   * The paid POST, attempted exactly once.
   *
   * Deliberately NOT `request`: that retries four times, and a create that
   * timed out after OpenAI accepted it would then buy up to four jobs while
   * Dossier reserved for one and tracked only the last id.
   */
  const createOnce = async (path: string, init: RequestInit): Promise<Record<string, unknown>> =>
    attemptOnceThenSettle(async () => {
      if (!key) throw new Error('OPENAI_API_KEY is not set.');
      const res = await fetch(`${API}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw Object.assign(new Error(`OpenAI ${res.status}: ${body.slice(0, 400)}`), {
          status: res.status,
          headers: res.headers,
        });
      }
      return (await res.json()) as Record<string, unknown>;
    }, {
      provider: 'OpenAI',
      // The 429 that cost the owner $18 twice. OpenAI usually sends no
      // `Retry-After` and puts the wait in the message ("try again in 1.236s"),
      // which `nextRetryDelayMs` reads.
      rateLimit: {
        onRetry: ({ attempt, delayMs }) =>
          process.stderr.write(
            `[dossier] openai rate-limited on create (attempt ${String(attempt)}); waiting ${String(delayMs)}ms. Nothing was created, so this retry cannot buy a second report.\n`,
          ),
      },
    });

  const kinds = new Map<string, 'response'>();

  const request = async (path: string, init: RequestInit): Promise<Record<string, unknown>> => {
    if (!key) throw new Error('OPENAI_API_KEY is not set.');
    return retry(
      async () => {
        const res = await fetch(`${API}${path}`, {
          ...init,
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw Object.assign(new Error(`OpenAI ${res.status}: ${body.slice(0, 400)}`), {
            status: res.status,
            headers: res.headers,
          });
        }
        return (await res.json()) as Record<string, unknown>;
      },
      {
        attempts: 4,
        onRetry: ({ delayMs, kind, error }) =>
          process.stderr.write(
            `[dossier] openai ${kind}; retrying in ${String(delayMs)}ms${retryAfterMs(error) ? ' (Retry-After)' : ''}\n`,
          ),
      },
    );
  };

  const client: DeepResearchClient = {
    async createRun(args: CreateRunArgs): Promise<InteractionSnapshot> {
      const { prompt, opts } = decodeOpenAiOptions(args.prompt);
      const webSearch: Record<string, unknown> = { type: 'web_search' };
      if (opts.domains?.length) {
        const allow = opts.domains.filter((d) => !d.startsWith('-')).slice(0, 100);
        const block = opts.domains.filter((d) => d.startsWith('-')).map((d) => d.slice(1)).slice(0, 100);
        if (allow.length) webSearch['filters'] = { allowed_domains: allow };
        if (block.length) webSearch['filters'] = { ...(webSearch['filters'] as object), blocked_domains: block };
      }

      const raw = await createOnce('/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: MODEL[args.tier],
          input: prompt,
          background: true,
          store: true,
          reasoning: { effort: RESEARCH_EFFORT[args.tier], ...(args.tier === 'max' ? { mode: 'pro' } : {}) },
          tools: [webSearch],
          // Always send a ceiling, not only when the caller named one. The
          // estimate says this run is "bounded by max_tool_calls" and ordinary
          // starts never set one, so the bound was rhetorical and the reserved
          // band could be exceeded by a model that felt thorough. The default
          // is generous enough not to shape the research and finite enough to
          // make the sentence true.
          max_tool_calls: opts.maxToolCalls ?? (args.tier === 'max' ? 200 : 80),
        }),
      });
      const id = typeof raw['id'] === 'string' ? raw['id'] : '';
      kinds.set(id, 'response');
      return { interactionId: id, status: 'in_progress', markdown: '', thoughts: [], images: [] };
    },

    async getRun(interactionId: string): Promise<InteractionSnapshot> {
      const raw = await request(`/responses/${encodeURIComponent(interactionId)}`, { method: 'GET' });
      // Lower-cased defensively. Perplexity's async endpoint returns `COMPLETED`
      // against its own lower-case documentation, and a case-sensitive check
      // there meant finished runs polled forever and paid-for reports were
      // never stored. OpenAI returns lower case today; this costs nothing and
      // removes the whole class.
      const rawStatus = raw['status'];
      const status = (typeof rawStatus === 'string' ? rawStatus : 'in_progress').toLowerCase();
      const done = ['completed', 'failed', 'cancelled', 'incomplete'].includes(status);
      return {
        interactionId,
        status: !done ? 'in_progress' : status === 'completed' ? 'completed' : 'failed',
        markdown: appendAnnotationSources(extractText(raw), raw),
        thoughts: [],
        images: [],
        ...(status === 'failed' || status === 'incomplete'
          ? { error: String((raw['error'] as { message?: string })?.message ?? status) }
          : {}),
      };
    },

    async cancelRun(interactionId: string): Promise<void> {
      await request(`/responses/${encodeURIComponent(interactionId)}/cancel`, { method: 'POST' });
    },

    async followUp(args: FollowUpArgs): Promise<string> {
      const raw = await request('/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.6-luna',
          input: args.question,
          previous_response_id: args.previousInteractionId,
        }),
      });
      return extractText(raw);
    },
  };

  return {
    id: 'openai',
    label: 'OpenAI gpt-5.6 (Responses API)',
    capabilities,
    detect(): CredentialStatus {
      if (config.hermetic) return { state: 'not-configured', detail: 'hermetic mode: no network calls are permitted' };
      if (!key) {
        return {
          state: 'not-configured',
          detail: 'no OpenAI credentials',
          fix: 'Set OPENAI_API_KEY from https://platform.openai.com (a ChatGPT subscription does not include API credits)',
        };
      }
      return { state: 'configured-unverified', detail: 'OPENAI_API_KEY is set' };
    },
    estimate(input: DurationOptions): ProviderEstimate {
      return { cost: openAiCost(input), duration: estimateDuration(input) };
    },
    modelFor(tier: ResearchTier): string {
      return modelFor(tier);
    },
    client(): DeepResearchClient {
      if (!key) throw new Error('OPENAI_API_KEY is not set.');
      return client;
    },
  };
}

/** Responses API: text lives in `output_text` blocks inside `output` items. */
function extractText(raw: Record<string, unknown>): string {
  const direct = raw['output_text'];
  if (typeof direct === 'string') return direct;
  const out = raw['output'];
  if (!Array.isArray(out)) return '';
  const parts: string[] = [];
  for (const item of out as { type?: string; content?: { type?: string; text?: string }[] }[]) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const c of item.content) if (c.type === 'output_text' && c.text) parts.push(c.text);
  }
  return parts.join('');
}

/**
 * Responses-API citations live in annotations, not in the text.
 *
 * A completed run returns `output[].content[].annotations` as `url_citation`
 * entries, and the extractor kept only `text`. Everything downstream reads the
 * markdown, so a correctly cited report was stored with zero sources:
 * `research_verify_citations` had nothing to dereference and
 * `research_evidence` profiled an empty registry. Same failure Perplexity had
 * for a different reason, so the same fix: render them into the report.
 */
export function appendAnnotationSources(markdown: string, raw: Record<string, unknown>): string {
  const out = raw['output'];
  if (!Array.isArray(out)) return markdown;
  const seen = new Map<string, string>();
  for (const item of out as { content?: { annotations?: unknown }[] }[]) {
    for (const content of item.content ?? []) {
      const annotations = content.annotations;
      if (!Array.isArray(annotations)) continue;
      for (const a of annotations as { type?: unknown; url?: unknown; title?: unknown }[]) {
        if (a.type !== 'url_citation' || typeof a.url !== 'string') continue;
        // A numeric marker title ("1") is a footnote label, not a source name.
        // Trimmed: a page's full <title> can run to hundreds of characters,
        // and a source list is meant to be scannable.
        const raw = typeof a.title === 'string' ? a.title.trim() : '';
        const title = raw && !/^\d+$/.test(raw) ? (raw.length > 100 ? `${raw.slice(0, 97)}...` : raw) : '';
        if (!seen.has(a.url)) seen.set(a.url, title);
      }
    }
  }
  if (seen.size === 0) return markdown;
  if (/^##+\s*sources\b/im.test(markdown)) return markdown;
  const lines = [...seen].map(([url, title]) => `- [${(title || url).replace(/[[\]]/g, '')}](${url})`);
  return `${markdown.trimEnd()}\n\n## Sources\n\n${lines.join('\n')}\n`;
}
