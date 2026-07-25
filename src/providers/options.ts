import type { Window } from '../research/shapes.js';
import { windowEnforcement, windowToFromDate, windowToRecency } from '../research/shapes.js';
import { encodeOpenAiOptions } from './openai.js';
import { encodeFilters } from './perplexity.js';
import type { ProviderId, Shape } from './types.js';
import { encodeXaiOptions } from './xai.js';

/**
 * One neutral request shape, four provider dialects.
 *
 * Every backend takes a date window and a domain list; no two take them the
 * same way, and two of them cannot enforce a date window at all. The caller
 * should not have to know that, and more importantly the *report* must not
 * pretend the difference away.
 *
 * So this returns the encoded prompt **and** the split between what the backend
 * will enforce and what is merely asked for in prose. "Restricted to the last
 * 12 months" means something different on Perplexity than on Gemini, and
 * presenting them identically is the lie of omission this layer exists to
 * prevent.
 */

export interface RequestShaping {
  readonly window?: Window;
  /** Bare domains; prefix with `-` to exclude. Trimmed to each backend's cap. */
  readonly domains?: readonly string[];
  readonly searchMode?: 'web' | 'academic' | 'sec';
  readonly shape?: Shape;
  /** OpenAI only: the primary lever on both cost and quality. */
  readonly maxToolCalls?: number;
  /** xAI only: search X as well as the web. */
  readonly searchX?: boolean;
}

export interface ShapedRequest {
  /** The prompt as the provider's client expects it, options encoded. */
  readonly prompt: string;
  /** Constraints the backend applies itself. */
  readonly enforced: readonly string[];
  /** Constraints that exist only as prose in the prompt. */
  readonly requested: readonly string[];
  /** Anything silently trimmed, so the caller is not surprised later. */
  readonly dropped: readonly string[];
}

/** Domain caps, per provider. Exceeding them is an API error, not a warning. */
const DOMAIN_CAP: Record<ProviderId, number> = {
  gemini: 0,
  perplexity: 20,
  openai: 100,
  xai: 5,
  local: 0,
};

/**
 * The prose fallback.
 *
 * Inserted into the prompt for constraints the backend cannot enforce. It is
 * genuinely weaker than a filter and is labelled `requested` everywhere it
 * surfaces, but it is not nothing: a research agent told to restrict itself to
 * a period mostly does.
 */
export function constraintBlock(parts: readonly string[]): string {
  return `<search_constraints>\n${parts.map((p) => `- ${p}`).join('\n')}\n</search_constraints>`;
}

export function shapeRequest(
  provider: ProviderId,
  prompt: string,
  shaping: RequestShaping,
): ShapedRequest {
  const enforced: string[] = [];
  const requested: string[] = [];
  const dropped: string[] = [];
  const window = shaping.window;
  const domains = shaping.domains ?? [];
  const cap = DOMAIN_CAP[provider];

  const acceptedDomains = domains.slice(0, cap);
  if (domains.length > acceptedDomains.length) {
    dropped.push(
      cap === 0
        ? `${String(domains.length)} domain filter(s): ${provider} has no domain filter, so they were put in the prompt instead`
        : `${String(domains.length - cap)} domain(s) past ${provider}'s cap of ${String(cap)}`,
    );
  }
  if (acceptedDomains.length > 0) {
    enforced.push(`domain filter (${acceptedDomains.length} of ${String(domains.length)})`);
  }
  // Domains the backend will not filter on still belong in the prompt. Dropping
  // them entirely would silently widen a search the caller deliberately narrowed.
  const unfiltered = domains.slice(acceptedDomains.length);
  if (unfiltered.length > 0) {
    requested.push(`prefer these sources: ${unfiltered.join(', ')}`);
  }

  switch (provider) {
    case 'perplexity': {
      const recency = window ? windowToRecency(window) : undefined;
      if (window && window !== 'all') {
        // The bucket is applied either way; it is only *enforcement* when it
        // matches the window exactly. A 90-day window filtered at one year is
        // a pre-filter plus a request, and reporting it as enforced would
        // overstate what the backend actually guarantees.
        if (recency) enforced.push(`recency filter: ${recency}`);
        if (windowEnforcement('recency-bucket', window) === 'requested') {
          requested.push(`only use sources published within the last ${window}`);
        }
      }
      const withProse = withConstraints(prompt, requested);
      return {
        prompt: encodeFilters(withProse, {
          ...(recency ? { recency } : {}),
          ...(acceptedDomains.length > 0 ? { domains: acceptedDomains } : {}),
          ...(shaping.searchMode ? { searchMode: shaping.searchMode } : {}),
          ...(shaping.shape === 'wide' ? { wide: true } : {}),
        }),
        enforced,
        requested,
        dropped,
      };
    }

    case 'xai': {
      const fromDate = window ? windowToFromDate(window) : undefined;
      if (fromDate) enforced.push(`date window (${window ?? ''} as a from-date of ${fromDate})`);
      else if (window && window !== 'all') requested.push(`only use sources published within the last ${window}`);
      const withProse = withConstraints(prompt, requested);
      return {
        prompt: encodeXaiOptions(withProse, {
          ...(fromDate ? { fromDate } : {}),
          ...(acceptedDomains.length > 0 ? { domains: acceptedDomains } : {}),
          ...(shaping.searchX ? { searchX: true } : {}),
        }),
        enforced,
        requested,
        dropped,
      };
    }

    case 'openai': {
      // No date filter of any kind on the Responses API web search, so a window
      // here is always prose. Saying so is the entire value of this split.
      if (window && window !== 'all') {
        requested.push(`only use sources published within the last ${window}`);
      }
      const withProse = withConstraints(prompt, requested);
      return {
        prompt: encodeOpenAiOptions(withProse, {
          ...(acceptedDomains.length > 0 ? { domains: acceptedDomains } : {}),
          ...(shaping.maxToolCalls ? { maxToolCalls: shaping.maxToolCalls } : {}),
        }),
        enforced,
        requested,
        dropped,
      };
    }

    default: {
      // Gemini and the local loop: everything is prose.
      if (window && window !== 'all') {
        requested.push(`only use sources published within the last ${window}`);
      }
      return { prompt: withConstraints(prompt, requested), enforced, requested, dropped };
    }
  }
}

/**
 * Insert the prose constraints **before** the final `<core_directive>`.
 *
 * Appending after it is the bug that shipped once: the closing directive
 * re-anchors the model after an hour of search and only works because it is
 * last, so anything after it can be ignored entirely. A run with corpus
 * grounding appended that way returned a 12,660-token report citing none of it.
 */
export function withConstraints(prompt: string, parts: readonly string[]): string {
  if (parts.length === 0) return prompt;
  const insert = `${constraintBlock(parts)}\n\n`;
  const anchor = prompt.lastIndexOf('<core_directive>');
  return anchor > 0 ? prompt.slice(0, anchor) + insert + prompt.slice(anchor) : `${insert}${prompt}`;
}

/** One line for a tool response: what the backend will actually do. */
export function describeShaping(s: ShapedRequest): string[] {
  const lines: string[] = [];
  if (s.enforced.length > 0) lines.push(`**Enforced by the backend**: ${s.enforced.join('; ')}`);
  if (s.requested.length > 0) {
    lines.push(
      `**Asked for in the prompt only** (not enforced, so check the dates yourself): ${s.requested.join('; ')}`,
    );
  }
  if (s.dropped.length > 0) lines.push(`**Trimmed**: ${s.dropped.join('; ')}`);
  return lines;
}
