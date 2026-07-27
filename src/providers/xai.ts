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
 * xAI as a provider.
 *
 * One reason to have it, and it is decisive: **nothing else can search X.** If
 * a question turns on what people are publicly saying right now, no budget on
 * another backend substitutes.
 *
 * The awkward part is persistence. xAI has no background job in the sense
 * Gemini, Perplexity and OpenAI do; it has *deferred completions*, which return
 * a request id you can retrieve for 24 hours. That covers a dropped connection
 * and does not cover an hour-long investigation, so the capability record says
 * `background: true` with the ceiling set honestly at 24h rather than claiming
 * parity.
 */

const API = 'https://api.x.ai/v1';
const MODEL = { fast: 'grok-4.3', max: 'grok-4.5' } as const;

/** The model this backend will actually use for a tier, for the run record. */
export function modelFor(tier: keyof typeof MODEL): string {
  return MODEL[tier];
}

export interface XaiOptions {
  /** Search X as well as the web. */
  readonly searchX?: boolean;
  /** ISO dates, inclusive at both ends. */
  readonly fromDate?: string;
  readonly toDate?: string;
  /** Max 20, and mutually exclusive with `excludeHandles`. */
  readonly allowHandles?: readonly string[];
  readonly excludeHandles?: readonly string[];
  /** Max 5 on web search. */
  readonly domains?: readonly string[];
}

const MARKER = '\n\n<!--dossier:xai ';

export function encodeXaiOptions(prompt: string, opts: XaiOptions): string {
  return Object.keys(opts).length === 0 ? prompt : `${prompt}${MARKER}${JSON.stringify(opts)}-->`;
}

/** Bounded, because the marker rides on caller-supplied prompt text (CP §1). */
const XaiOptionsSchema = z
  .object({
    searchX: z.boolean().optional(),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    allowHandles: z.array(z.string().max(80)).max(20).optional(),
    excludeHandles: z.array(z.string().max(80)).max(20).optional(),
    domains: z.array(z.string().max(200)).max(5).optional(),
  })
  .strict();

export function decodeXaiOptions(prompt: string): { prompt: string; opts: XaiOptions } {
  const at = prompt.lastIndexOf(MARKER);
  if (at === -1) return { prompt, opts: {} };
  try {
    const parsed = XaiOptionsSchema.safeParse(JSON.parse(prompt.slice(at + MARKER.length).replace(/-->\s*$/, '')));
    if (!parsed.success) return { prompt, opts: {} };
    // Strip the explicit `undefined`s Zod emits for absent optionals;
    // `exactOptionalPropertyTypes` treats those as different from absent.
    return { prompt: prompt.slice(0, at), opts: compact(parsed.data) };
  } catch {
    return { prompt, opts: {} };
  }
}

export function xaiCost(input: DurationOptions): CostBand {
  // grok-4.5 is $2/$6 per 1M under the 200k threshold, plus $5 per 1,000
  // server-side tool calls. The model chooses its own search count (13 in xAI's
  // own worked example), so the tool component is the uncertain half.
  const big = input.tier === 'max';
  const low = big ? 0.3 : 0.15;
  const high = big ? 2.5 : 1.2;
  return {
    lowUsd: low,
    highUsd: high,
    midUsd: Number(((low + high) / 2).toFixed(2)),
    basis:
      `${big ? 'grok-4.5' : 'grok-4.3'} tokens plus $5/1k server-side tool calls; ` +
      'a max_tool_calls ceiling is sent, so the search component is bounded rather than open-ended',
  };
}

export function xaiProvider(config: Config): ResearchProvider {
  const capabilities: Capabilities = {
    shapes: ['deep', 'recent'],
    // Not background, whatever the request says. `/v1/responses` accepts
    // `deferred: true` with a 200 and then returns a COMPLETED result in the
    // same call: verified live on 25 July 2026. The work happens inside the
    // HTTP request, so a run longer than the client timeout is lost rather
    // than parked, and advertising durability here would be a promise the
    // transport cannot keep.
    background: false,
    planReview: false,
    followUp: true,
    dateFilter: 'range',
    domainFilter: 5,
    // Same as OpenAI: xAI collections are real and unwired here, and the
    // create body carries only web and X search.
    corpus: 'none',
    // The whole reason this provider exists.
    socialSources: ['x'],
    structuredOutput: true,
    fileOutput: false,
    maxWallClockMinutes: 20,
    billedTo: 'api-balance',
    limitations: [
      'No editable plan before spending.',
      'The run happens INSIDE the create call: `deferred` is accepted and ignored, so a long investigation can outlive the HTTP timeout. Suits fast, broad questions rather than hour-long ones.',
      'Domain filtering caps at 5, against Perplexity 20 and OpenAI 100.',
      'Private-corpus grounding is NOT wired up here yet, though xAI has collections. Use Gemini for corpus work.',
      'Fast and broad rather than careful: roughly 10x faster than a deep-research API and 3x the pages, which suits finding things more than concluding them.',
      'allowHandles and excludeHandles are mutually exclusive; setting both is an error, not a merge.',
    ],
  };

  const key = config.xaiApiKey;

  const request = async (path: string, init: RequestInit): Promise<Record<string, unknown>> => {
    if (!key) throw new Error('XAI_API_KEY is not set.');
    return retry(
      async () => {
        const res = await fetch(`${API}${path}`, {
          ...init,
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw Object.assign(new Error(`xAI ${res.status}: ${body.slice(0, 400)}`), {
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
            `[dossier] xai ${kind}; retrying in ${String(delayMs)}ms${retryAfterMs(error) ? ' (Retry-After)' : ''}\n`,
          ),
      },
    );
  };

  /**
   * The paid POST, attempted exactly once.
   *
   * Deliberately NOT `request`: that retries four times, and a create that
   * timed out after xAI accepted it would then buy up to four jobs while
   * Dossier reserved for one and tracked only the last id.
   */
  const createOnce = async (path: string, init: RequestInit): Promise<Record<string, unknown>> =>
    attemptOnceThenSettle(async () => {
      if (!key) throw new Error('XAI_API_KEY is not set.');
      const res = await fetch(`${API}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
        // Longer than the usual POST deadline because this request performs
        // the whole run. Sixty seconds cut off a real investigation mid-flight
        // and reported it as an unknown-outcome charge, which it then was.
        signal: AbortSignal.timeout(15 * 60_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw Object.assign(new Error(`xAI ${res.status}: ${body.slice(0, 400)}`), {
          status: res.status,
          headers: res.headers,
        });
      }
      return (await res.json()) as Record<string, unknown>;
    }, {
      provider: 'xAI',
      rateLimit: {
        onRetry: ({ attempt, delayMs }) =>
          process.stderr.write(
            `[dossier] xai rate-limited on create (attempt ${String(attempt)}); waiting ${String(delayMs)}ms. Nothing was created, so this retry cannot buy a second report.\n`,
          ),
      },
    });

  const buildTools = (opts: XaiOptions): Record<string, unknown>[] => {
    const web: Record<string, unknown> = { type: 'web_search' };
    if (opts.domains?.length) web['allowed_domains'] = opts.domains.slice(0, 5);
    const tools: Record<string, unknown>[] = [web];
    if (opts.searchX) {
      const x: Record<string, unknown> = { type: 'x_search' };
      if (opts.fromDate) x['from_date'] = opts.fromDate;
      if (opts.toDate) x['to_date'] = opts.toDate;
      // Mutually exclusive upstream: sending both is a 400, so prefer the
      // allow-list and drop the other rather than letting the API reject.
      if (opts.allowHandles?.length) x['allowed_x_handles'] = opts.allowHandles.slice(0, 20);
      else if (opts.excludeHandles?.length) x['excluded_x_handles'] = opts.excludeHandles.slice(0, 20);
      tools.push(x);
    }
    return tools;
  };

  const client: DeepResearchClient = {
    async createRun(args: CreateRunArgs): Promise<InteractionSnapshot> {
      const { prompt, opts } = decodeXaiOptions(args.prompt);
      const raw = await createOnce('/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: MODEL[args.tier],
          input: prompt,
          store: true,
          deferred: true, // accepted and ignored; see the capability note above
          tools: buildTools(opts),
          // The model picks its own search count, and searches are the loose
          // half of the bill. A ceiling keeps the reserved band meaningful.
          max_tool_calls: args.tier === 'max' ? 60 : 25,
        }),
      });
      const id = typeof raw['id'] === 'string' ? raw['id'] : typeof raw['request_id'] === 'string' ? raw['request_id'] : '';
      // The response is usually the finished run, so return it as such rather
      // than reporting `in_progress` and polling for something already done.
      // Claiming a run is in flight when its result is in hand costs a poll
      // cycle and, worse, describes the system incorrectly.
      const status = (typeof raw['status'] === 'string' ? raw['status'] : '').toLowerCase();
      if (status === 'completed') {
        return {
          interactionId: id,
          status: 'completed',
          markdown: appendAnnotationSources(extractText(raw), raw),
          thoughts: [],
          images: [],
        };
      }
      return { interactionId: id, status: 'in_progress', markdown: '', thoughts: [], images: [] };
    },

    async getRun(interactionId: string): Promise<InteractionSnapshot> {
      const raw = await request(`/responses/${encodeURIComponent(interactionId)}`, { method: 'GET' });
      // Lower-cased for the reason recorded in the Perplexity adapter: an API
      // that documents lower-case status values and returns upper-case ones
      // leaves a finished run polling forever.
      const rawStatus = raw['status'];
      const status = (typeof rawStatus === 'string' ? rawStatus : 'in_progress').toLowerCase();
      const done = ['completed', 'failed', 'cancelled'].includes(status);
      return {
        interactionId,
        status: !done ? 'in_progress' : status === 'completed' ? 'completed' : 'failed',
        markdown: appendAnnotationSources(extractText(raw), raw),
        thoughts: [],
        images: [],
        ...(status === 'failed' ? { error: 'the xAI run failed' } : {}),
      };
    },

    async cancelRun(): Promise<void> {
      // xAI documents no cancellation for deferred completions. Claiming a stop
      // we cannot perform is worse than saying so: the run finishes and bills.
      throw new Error(
        'xAI does not expose cancellation for deferred completions. The run will finish and bill; Dossier has stopped tracking it.',
      );
    },

    async followUp(args: FollowUpArgs): Promise<string> {
      const raw = await request('/responses', {
        method: 'POST',
        body: JSON.stringify({ model: 'grok-4.3', input: args.question }),
      });
      return extractText(raw);
    },
  };

  return {
    id: 'xai',
    label: 'xAI Grok (web + X search)',
    capabilities,
    detect(): CredentialStatus {
      if (config.hermetic) return { state: 'not-configured', detail: 'hermetic mode: no network calls are permitted' };
      if (!key) {
        return {
          state: 'not-configured',
          detail: 'no xAI credentials',
          fix: 'Set XAI_API_KEY from https://console.x.ai (X Premium+ and SuperGrok do not include API credits)',
        };
      }
      return { state: 'configured-unverified', detail: 'XAI_API_KEY is set' };
    },
    estimate(input: DurationOptions): ProviderEstimate {
      const d = estimateDuration(input);
      // Measurably the fastest of the four: roughly 10x a deep-research API on
      // a breadth task. Reflect that rather than reusing Google's bands.
      return {
        cost: xaiCost(input),
        duration: { ...d, lowMinutes: 1, highMinutes: Math.max(4, Math.round(d.highMinutes / 4)) },
      };
    },
    modelFor(tier: ResearchTier): string {
      return modelFor(tier);
    },
    client(): DeepResearchClient {
      if (!key) throw new Error('XAI_API_KEY is not set.');
      return client;
    },
  };
}

function extractText(raw: Record<string, unknown>): string {
  const direct = raw['output_text'];
  if (typeof direct === 'string') return direct;
  const out = raw['output'];
  if (!Array.isArray(out)) return '';
  const parts: string[] = [];
  for (const item of out as { type?: string; content?: { type?: string; text?: string }[] }[]) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const c of item.content) if (c.text) parts.push(c.text);
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
