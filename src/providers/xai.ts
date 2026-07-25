import type { Config } from '../config.js';
import type { CreateRunArgs, DeepResearchClient, FollowUpArgs } from '../gemini/client.js';
import type { CostBand, DurationOptions } from '../gemini/cost.js';
import { estimateDuration } from '../gemini/cost.js';
import type { InteractionSnapshot } from '../gemini/types.js';
import { retry, retryAfterMs } from '../net/retry.js';
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

export function decodeXaiOptions(prompt: string): { prompt: string; opts: XaiOptions } {
  const at = prompt.lastIndexOf(MARKER);
  if (at === -1) return { prompt, opts: {} };
  try {
    return {
      prompt: prompt.slice(0, at),
      opts: JSON.parse(prompt.slice(at + MARKER.length).replace(/-->\s*$/, '')) as XaiOptions,
    };
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
      'the model picks its own search count, so the tool component is the loose half',
  };
}

export function xaiProvider(config: Config): ResearchProvider {
  const capabilities: Capabilities = {
    shapes: ['deep', 'recent'],
    background: true,
    planReview: false,
    followUp: true,
    dateFilter: 'range',
    domainFilter: 5,
    corpus: 'collections',
    // The whole reason this provider exists.
    socialSources: ['x'],
    structuredOutput: true,
    fileOutput: false,
    maxWallClockMinutes: 20,
    limitations: [
      'No editable plan before spending.',
      'Deferred completions are retrievable for 24 hours, which is not the same as a true background job.',
      'Domain filtering caps at 5, against Perplexity 20 and OpenAI 100.',
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
      const raw = await request('/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: MODEL[args.tier],
          input: prompt,
          store: true,
          deferred: true, // retrievable for 24h; xAI's nearest thing to background
          tools: buildTools(opts),
        }),
      });
      const id = typeof raw['id'] === 'string' ? raw['id'] : typeof raw['request_id'] === 'string' ? raw['request_id'] : '';
      return { interactionId: id, status: 'in_progress', markdown: '', thoughts: [], images: [] };
    },

    async getRun(interactionId: string): Promise<InteractionSnapshot> {
      const raw = await request(`/responses/${encodeURIComponent(interactionId)}`, { method: 'GET' });
      const status = typeof raw['status'] === 'string' ? raw['status'] : 'in_progress';
      const done = ['completed', 'failed', 'cancelled'].includes(status);
      return {
        interactionId,
        status: !done ? 'in_progress' : status === 'completed' ? 'completed' : 'failed',
        markdown: extractText(raw),
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
