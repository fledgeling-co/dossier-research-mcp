import { z } from 'zod';
import type { Config } from '../config.js';
import type { CreateRunArgs, DeepResearchClient, FollowUpArgs } from '../gemini/client.js';
import type { CostBand, DurationOptions } from '../gemini/cost.js';
import { estimateDuration } from '../gemini/cost.js';
import type { InteractionSnapshot } from '../gemini/types.js';
import { attemptOnceThenSettle, retry, retryAfterMs } from '../net/retry.js';
import { compact } from './types.js';
import type {
  Capabilities,
  CredentialStatus,
  ProviderEstimate,
  ResearchProvider,
} from './types.js';

/**
 * Perplexity as a provider.
 *
 * The highest-value second backend, because it adds two things Gemini has none
 * of rather than doing the same thing slightly differently: **filters** (date
 * windows and domain allow-lists that are actually enforced rather than asked
 * for in a prompt) and **wide research**, which enumerates a set and cites
 * every member.
 *
 * Two endpoints, because Perplexity currently has two generations and each does
 * one of those jobs:
 *
 * - **deep** goes to the async Sonar endpoint with `sonar-deep-research`, which
 *   is the only place that model is exposed.
 * - **wide** goes to the newer Agent API with `preset: "wide-research"`, which
 *   is the only place that preset exists and the only one that writes results
 *   to a downloadable file.
 *
 * Deep research is not documented on the Agent API yet. When it lands, the deep
 * path should move and this comment should be the thing that gets deleted.
 */

const API = 'https://api.perplexity.ai';

/**
 * The deep path uses `sonar-deep-research` and nothing else.
 *
 * `sonar` and `sonar-pro` are search-and-summarise models: fast, cheap, and a
 * completely different product from a research run. Substituting one because it
 * is cheaper would silently turn a $2 investigation into a $0.02 web search
 * that still calls itself deep research, which is the kind of downgrade a user
 * would never detect from the output shape. `sonar-reasoning-pro` is likewise
 * reasoning without the exhaustive search loop.
 *
 * Tier changes how hard it searches, not which model does it.
 */
const DEEP_MODEL = 'sonar-deep-research';
/** Cheap follow-ups over a finished report; deliberately not the research model. */
const FOLLOWUP_MODEL = 'sonar-pro';

/** Extra request shaping Perplexity supports and Gemini does not. */
export interface PerplexityFilters {
  /** `hour` | `day` | `week` | `month` | `year`. */
  readonly recency?: string;
  /** Max 20. Prefix a domain with `-` to exclude it. */
  readonly domains?: readonly string[];
  /** `web` | `academic` | `sec`. */
  readonly searchMode?: string;
  /** Ask for the wide-research preset rather than a deep report. */
  readonly wide?: boolean;
}

/** Filters ride on the prompt because `CreateRunArgs` is provider-neutral. */
const FILTER_MARKER = '\n\n<!--dossier:perplexity ';

export function encodeFilters(prompt: string, filters: PerplexityFilters): string {
  if (Object.keys(filters).length === 0) return prompt;
  return `${prompt}${FILTER_MARKER}${JSON.stringify(filters)}-->`;
}

/**
 * The decoded options are a trust boundary, not our own data.
 *
 * The marker rides on the prompt, and a caller can send a pre-engineered brief
 * that ends in one. Casting the parsed JSON meant a brief ending
 * `<!--dossier:perplexity {"wide":true}-->` turned a deep purchase into a wide
 * one *after* the smaller band had been reserved. Parsed and bounded (CP §1),
 * and anything that fails to validate is dropped rather than partially trusted.
 */
const FiltersSchema = z
  .object({
    recency: z.enum(['hour', 'day', 'week', 'month', 'year']).optional(),
    domains: z.array(z.string().max(200)).max(20).optional(),
    searchMode: z.enum(['web', 'academic', 'sec']).optional(),
    wide: z.boolean().optional(),
  })
  .strict();

export function decodeFilters(prompt: string): { prompt: string; filters: PerplexityFilters } {
  const at = prompt.lastIndexOf(FILTER_MARKER);
  if (at === -1) return { prompt, filters: {} };
  const raw = prompt.slice(at + FILTER_MARKER.length).replace(/-->\s*$/, '');
  try {
    const parsed = FiltersSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return { prompt, filters: {} };
    // Strip the explicit `undefined`s Zod emits for absent optionals;
    // `exactOptionalPropertyTypes` treats those as different from absent.
    return { prompt: prompt.slice(0, at), filters: compact(parsed.data) };
  } catch {
    return { prompt, filters: {} };
  }
}

/**
 * Perplexity bills tokens *plus* per-search *plus* citation and reasoning
 * tokens, and reasoning routinely dominates: their own worked example is $0.816
 * of which $0.582 was reasoning. A flat "tokens" estimate would understate the
 * common case, so the band is built from the parts.
 */
export function perplexityCost(input: DurationOptions): CostBand {
  // Anchored on Perplexity's own worked `sonar-deep-research` example: 21
  // searches, 194k reasoning tokens, 19k citation tokens, $0.816 total, of
  // which $0.582 was reasoning. A `max` run roughly doubles the search loop.
  //
  // Tier and shape are independent. An earlier version treated `tier: 'max'`
  // as "wide", which is wrong twice over: a max deep-research run is still a
  // report, and a wide run is a different product whose cost scales with how
  // many rows you asked for rather than with the tier.
  const wide = input.shape === 'wide';
  const base = wide
    ? { low: 1.0, high: 6.0 }
    : input.tier === 'max'
      ? { low: 1.2, high: 4.0 }
      : { low: 0.5, high: 2.0 };
  const corpora = (input.tools ?? []).filter((t) => t === 'file_search').length;
  const extra = corpora * 0.5;
  return {
    lowUsd: Number((base.low + extra).toFixed(2)),
    highUsd: Number((base.high + extra).toFixed(2)),
    midUsd: Number(((base.low + base.high) / 2 + extra).toFixed(2)),
    basis: wide
      ? 'wide-research preset: one search loop per item, every row cited; scales with the number of items requested'
      : `sonar-deep-research (${input.tier}): $2/M in, $8/M out, plus $2/M citation, $3/M reasoning and $5/1k searches. ` +
        'Reasoning usually dominates. Actual per-request cost comes back from the API and is recorded against this estimate.',
  };
}

/**
 * Which endpoint a run belongs to, carried in the handle itself.
 *
 * This lived in a process-local `Map`, which meant a server restart forgot it:
 * a wide run's id was then polled against the Sonar endpoint, which knows
 * nothing about it, and could not be cancelled. Runs here are durable by
 * design and outlive the process, so anything needed to poll one has to be in
 * the record rather than in memory.
 */
const WIDE_PREFIX = 'wide:';

function encodeHandle(kind: 'deep' | 'wide', id: string): string {
  return kind === 'wide' ? `${WIDE_PREFIX}${id}` : id;
}

function decodeHandle(handle: string): { kind: 'deep' | 'wide'; id: string } {
  return handle.startsWith(WIDE_PREFIX)
    ? { kind: 'wide', id: handle.slice(WIDE_PREFIX.length) }
    : { kind: 'deep', id: handle };
}

export function perplexityProvider(config: Config): ResearchProvider {
  const capabilities: Capabilities = {
    shapes: ['deep', 'wide', 'recent'],
    background: true,
    planReview: false,
    followUp: true,
    dateFilter: 'recency-bucket',
    domainFilter: 20,
    corpus: 'none',
    socialSources: [],
    structuredOutput: false,
    fileOutput: true,
    maxWallClockMinutes: 30,
    limitations: [
      'No editable plan before spending; only Gemini offers that.',
      'No private-corpus grounding.',
      'Format compliance is weak: it scored zero on a benchmark table task by returning prose. Use wide research when the shape matters.',
      'Verbose. It averaged 5,253 words per task on one benchmark while scoring below tools that wrote a tenth as much.',
    ],
  };

  const key = config.perplexityApiKey;

  const request = async (path: string, init: RequestInit): Promise<unknown> => {
    if (!key) throw new Error('PERPLEXITY_API_KEY is not set.');
    return retry(
      async () => {
        const res = await fetch(`${API}${path}`, {
          ...init,
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
            ...(init.headers ?? {}),
          },
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          // Attach the status and headers so `classify` and `retryAfterMs` can
          // see them; without this a 429 is indistinguishable from a 400 and
          // gets retried or abandoned wrongly.
          throw Object.assign(new Error(`Perplexity ${res.status}: ${body.slice(0, 400)}`), {
            status: res.status,
            headers: res.headers,
          });
        }
        return await res.json();
      },
      {
        attempts: 4,
        onRetry: ({ delayMs, kind, error }) => {
          const after = retryAfterMs(error);
          process.stderr.write(
            `[dossier] perplexity ${kind}; retrying in ${String(delayMs)}ms${after ? ' (Retry-After)' : ''}\n`,
          );
        },
      },
    );
  };

  /**
   * The paid POST, attempted exactly once.
   *
   * Deliberately NOT `request`: that retries four times, and a create that
   * timed out after Perplexity accepted it would then buy up to four jobs while
   * Dossier reserved for one and tracked only the last id.
   */
  const createOnce = async (path: string, init: RequestInit): Promise<unknown> =>
    attemptOnceThenSettle(async () => {
      if (!key) throw new Error('PERPLEXITY_API_KEY is not set.');
      const res = await fetch(`${API}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw Object.assign(new Error(`Perplexity ${res.status}: ${body.slice(0, 400)}`), {
          status: res.status,
          headers: res.headers,
        });
      }
      return await res.json();
    }, { provider: 'Perplexity' });

  const client: DeepResearchClient = {
    async createRun(args: CreateRunArgs): Promise<InteractionSnapshot> {
      const { prompt, filters } = decodeFilters(args.prompt);

      if (filters.wide) {
        // Wide research: background job that writes results to a sandbox file.
        const body = {
          preset: 'wide-research',
          background: true,
          input: prompt,
        };
        const res = (await createOnce('/v1/agent', { method: 'POST', body: JSON.stringify(body) })) as {
          id?: string;
        };
        return {
          interactionId: encodeHandle('wide', res.id ?? ''),
          status: 'in_progress',
          markdown: '',
          thoughts: [],
          images: [],
        };
      }

      // Deep research via the async Sonar endpoint.
      const search: Record<string, unknown> = {};
      if (filters.recency) search['search_recency_filter'] = filters.recency;
      if (filters.domains?.length) search['search_domain_filter'] = filters.domains.slice(0, 20);
      if (filters.searchMode) search['search_mode'] = filters.searchMode;

      const res = (await createOnce('/async/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          request: {
            model: DEEP_MODEL,
            messages: [{ role: 'user', content: prompt }],
            // Tier maps to search depth, which for this model is reasoning
            // effort. Without it both tiers would buy the same run at
            // different advertised prices.
            reasoning_effort: args.tier === 'max' ? 'high' : 'medium',
            ...search,
          },
        }),
      })) as { id?: string; request_id?: string };
      return {
        interactionId: encodeHandle('deep', res.id ?? res.request_id ?? ''),
        status: 'in_progress',
        markdown: '',
        thoughts: [],
        images: [],
      };
    },

    async getRun(interactionId: string): Promise<InteractionSnapshot> {
      const { kind, id } = decodeHandle(interactionId);
      const path =
        kind === 'wide'
          ? `/v1/agent/${encodeURIComponent(id)}`
          : `/async/chat/completions/${encodeURIComponent(id)}`;
      const raw = (await request(path, { method: 'GET' })) as Record<string, unknown>;

      // Narrow before stringifying: `raw['status']` is `unknown`, and a
      // non-string would otherwise become the literal '[object Object]' and
      // never match any terminal state, leaving the run polling forever.
      //
      // Lower-cased for the same reason, and this one was not hypothetical: the
      // async Sonar endpoint returns **`COMPLETED`** in upper case, against the
      // lower-case values the docs list. A case-sensitive comparison meant a
      // finished run was never recognised as finished, so it polled until the
      // stall watchdog gave up and the paid-for report was never stored. Found
      // by running a real job, and invisible to every hermetic test.
      const rawStatus = raw['status'];
      const status = (typeof rawStatus === 'string' ? rawStatus : 'in_progress').toLowerCase();
      const terminal = ['completed', 'failed', 'cancelled', 'incomplete'].includes(status);
      const markdown = appendSources(extractMarkdown(raw), raw);
      // A wide run that finished with no inline text has written its matrix to
      // a sandbox file. Saying so beats handing back an empty report that looks
      // like the model produced nothing.
      const fileOnly = kind === 'wide' && terminal && !markdown.trim() && describeResultFile(raw);
      if (fileOnly) {
        return {
          interactionId,
          status: 'failed',
          markdown: '',
          thoughts: [],
          images: [],
          error:
            `The wide run finished and wrote its result to a file (${fileOnly}) rather than returning it inline. ` +
            'Dossier cannot download that yet, so the matrix is in your Perplexity console rather than here. ' +
            'This path has never been exercised against a live Agent API run.',
        };
      }

      const cost = extractCost(raw);
      return {
        interactionId,
        status: !terminal ? 'in_progress' : status === 'completed' ? 'completed' : 'failed',
        markdown,
        ...(cost !== undefined ? { actualCostUsd: cost } : {}),
        thoughts: [],
        images: [],
        ...(status === 'failed' || status === 'incomplete'
          ? { error: String((raw['error'] as { message?: string })?.message ?? status) }
          : {}),
      };
    },

    async cancelRun(interactionId: string): Promise<void> {
      const { kind, id } = decodeHandle(interactionId);
      // Only the Agent API documents cancellation. An async Sonar job has no
      // cancel endpoint, so saying so beats pretending it stopped.
      if (kind !== 'wide') {
        throw new Error(
          'Perplexity does not expose cancellation for async Sonar jobs. The run will finish and bill; ' +
            'Dossier has stopped tracking it.',
        );
      }
      await request(`/v1/agent/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    },

    async followUp(args: FollowUpArgs): Promise<string> {
      const raw = (await request('/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: FOLLOWUP_MODEL,
          messages: [{ role: 'user', content: args.question }],
        }),
      })) as { choices?: { message?: { content?: string } }[] };
      return raw.choices?.[0]?.message?.content ?? '';
    },
  };

  return {
    id: 'perplexity',
    label: 'Perplexity Sonar Deep Research',
    capabilities,

    detect(): CredentialStatus {
      if (config.hermetic) {
        return { state: 'not-configured', detail: 'hermetic mode: no network calls are permitted' };
      }
      if (!key) {
        return {
          state: 'not-configured',
          detail: 'no Perplexity credentials',
          fix: 'Set PERPLEXITY_API_KEY from https://console.perplexity.ai (a Pro subscription does not include API access)',
        };
      }
      return { state: 'configured-unverified', detail: 'PERPLEXITY_API_KEY is set' };
    },

    estimate(input: DurationOptions): ProviderEstimate {
      const duration = estimateDuration(input);
      return {
        cost: perplexityCost(input),
        // Measurably quicker than Gemini: 2-5 minutes for a moderate task
        // against Gemini's 4-20. Halving the band reflects that rather than
        // reusing Google's published figures for a different product.
        duration: {
          ...duration,
          lowMinutes: Math.max(2, Math.round(duration.lowMinutes / 2)),
          highMinutes: Math.max(5, Math.round(duration.highMinutes / 2)),
        },
      };
    },

    client(): DeepResearchClient {
      if (!key) throw new Error('PERPLEXITY_API_KEY is not set.');
      return client;
    },
  };
}

/**
 * Perplexity returns its sources OUT OF BAND, in `citations` and
 * `search_results`, and puts none of them in the report text.
 *
 * A real 45,000-character report came back with **zero** URLs in its markdown
 * and sixteen in a sibling array. Everything downstream reads the markdown:
 * `extractCitedUrls` found nothing, so the run recorded zero sources,
 * `research_verify_citations` had nothing to dereference and
 * `research_evidence` profiled an empty registry. A cited report looked
 * uncited, which is the worst direction for that error to point.
 *
 * So the sources are appended as a Sources section in the format the rest of
 * the codebase already reads. `search_results` is preferred because it carries
 * titles and dates; the bare `citations` array is the fallback.
 */
function appendSources(markdown: string, raw: Record<string, unknown>): string {
  const response = (raw['response'] ?? raw) as Record<string, unknown>;
  const results = response['search_results'];
  const bare = response['citations'];

  const lines: string[] = [];
  if (Array.isArray(results)) {
    for (const item of results as { title?: unknown; url?: unknown; date?: unknown }[]) {
      if (typeof item.url !== 'string') continue;
      const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : item.url;
      const date = typeof item.date === 'string' && item.date ? ` (${item.date})` : '';
      lines.push(`- [${title.replace(/[[\]]/g, '')}](${item.url})${date}`);
    }
  }
  if (lines.length === 0 && Array.isArray(bare)) {
    for (const url of bare as unknown[]) {
      if (typeof url === 'string') lines.push(`- ${url}`);
    }
  }
  if (lines.length === 0) return markdown;
  // Only add the section when the report did not already carry its sources.
  if (/^##+\s*sources\b/im.test(markdown)) return markdown;
  return `${markdown.trimEnd()}\n\n## Sources\n\n${lines.join('\n')}\n`;
}

/** Pull report text out of either endpoint's response shape. */
function extractMarkdown(raw: Record<string, unknown>): string {
  // Agent API: a heterogeneous `output` array of typed items.
  const output = raw['output'];
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output as { type?: string; content?: unknown; text?: string }[]) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content as { text?: string }[]) if (c.text) parts.push(c.text);
      } else if (typeof item.text === 'string') {
        parts.push(item.text);
      }
    }
    if (parts.length > 0) return parts.join('');
  }
  // Sonar: chat-completions shape. Strip the `<think>` block it prefixes.
  const choices = raw['response'] ?? raw['choices'];
  const list = (Array.isArray(choices) ? choices : (choices as { choices?: unknown })?.choices) as
    | { message?: { content?: string } }[]
    | undefined;
  const content = list?.[0]?.message?.content;
  if (typeof content === 'string') return content.replace(/^[\s\S]*?<\/think>\s*/i, '');
  return '';
}

/** Perplexity reports real spend per request; record it beside our estimate. */
function extractCost(raw: Record<string, unknown>): number | undefined {
  const usage = (raw['usage'] ?? (raw['response'] as { usage?: unknown })?.usage) as
    | { cost?: { total_cost?: number } }
    | undefined;
  const total = usage?.cost?.total_cost;
  return typeof total === 'number' ? total : undefined;
}

/** Name the result file a wide run wrote, when it wrote one instead of text. */
function describeResultFile(raw: Record<string, unknown>): string | null {
  const response = (raw['response'] ?? raw) as Record<string, unknown>;
  for (const key of ['share_file', 'output_file', 'result_file', 'file']) {
    const value = response[key] ?? raw[key];
    if (typeof value === 'string' && value) return value;
    if (value && typeof value === 'object') {
      const named = (value as { name?: unknown; id?: unknown }).name ?? (value as { id?: unknown }).id;
      if (typeof named === 'string' && named) return named;
    }
  }
  return null;
}
