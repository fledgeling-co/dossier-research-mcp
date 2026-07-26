import type { Config } from '../config.js';
import type { DeepResearchClient } from '../gemini/client.js';
import type { DurationOptions } from '../gemini/cost.js';
import { geminiProvider } from './gemini.js';
import { localProvider } from './local.js';
import { openAiProvider } from './openai.js';
import { perplexityProvider } from './perplexity.js';
import { xaiProvider } from './xai.js';
import type { ProviderId, ResearchProvider, Shape } from './types.js';

/**
 * Which backends exist, which are usable, and which one should run this job.
 *
 * Detection is pure and offline: a provider's key presence is checked, never
 * its liveness, because a slow or failing backend must not delay the server
 * coming up. `research_doctor --verify` is the explicit opt-in that promotes
 * `configured-unverified` to `ready`.
 */
export class ProviderRegistry {
  private readonly all: readonly ResearchProvider[];

  constructor(
    private readonly config: Config,
    resolveGeminiClient: () => DeepResearchClient | null,
  ) {
    const built = [
      geminiProvider(config, resolveGeminiClient),
      perplexityProvider(config),
      openAiProvider(config),
      xaiProvider(config),
      localProvider(config),
    ];
    // An explicit allow-list is a deliberate operator choice and overrides
    // detection: a key present in the environment for some other tool should
    // not silently become a place Dossier can spend money.
    this.all =
      config.enabledProviders.length > 0
        ? built.filter((p) => config.enabledProviders.includes(p.id))
        : built;
  }

  list(): readonly ResearchProvider[] {
    return this.all;
  }

  get(id: ProviderId): ResearchProvider | null {
    return this.all.find((p) => p.id === id) ?? null;
  }

  /**
   * Providers eligible for automatic selection.
   *
   * `local` is excluded unless an operator names it in `DOSSIER_PROVIDERS`,
   * even when its CLI is sitting right there on PATH. It costs $0, so any
   * cost tie-break would pick it every time, and that is the wrong default for
   * reasons unrelated to quality: it spends a subscription quota rather than an
   * API balance, and it executes a third-party binary on this machine. Both are
   * choices somebody should make rather than discover. It stays fully visible
   * in `research_doctor` and fully usable by name.
   */
  available(): readonly ResearchProvider[] {
    return this.all.filter(
      (p) =>
        p.detect().state !== 'not-configured' &&
        (p.id !== 'local' || this.config.enabledProviders.includes('local')),
    );
  }

  /**
   * Choose a backend, capability first.
   *
   * Order is deliberate and not negotiable by price: a hard requirement (a date
   * window, an editable plan, X) eliminates providers outright, because no
   * amount of cheapness makes an incapable backend correct. Cost breaks ties
   * among the survivors.
   *
   * Returns the reasoning too. A router that silently picks is a router nobody
   * can second-guess, and this one is picking how to spend money.
   */
  route(need: RoutingNeed): RoutingDecision {
    const configured = this.available();
    if (configured.length === 0) {
      return {
        provider: null,
        reason: 'No provider credentials are configured.',
        runnerUp: null,
        rejected: this.all.map((p) => ({ id: p.id, why: p.detect().detail })),
      };
    }

    const rejected: { id: ProviderId; why: string }[] = [];
    const eligible = configured.filter((p) => {
      const c = p.capabilities;
      if (need.shape && !c.shapes.includes(need.shape)) {
        rejected.push({ id: p.id, why: `cannot do ${need.shape} research` });
        return false;
      }
      if (need.planReview && !c.planReview) {
        rejected.push({ id: p.id, why: 'has no editable plan before spending' });
        return false;
      }
      if (need.dateWindow && c.dateFilter === 'none') {
        rejected.push({ id: p.id, why: 'cannot enforce a date window (prompt-only)' });
        return false;
      }
      if (need.domains && need.domains > c.domainFilter) {
        rejected.push({
          id: p.id,
          why: c.domainFilter === 0 ? 'has no domain filter' : `caps domain filters at ${c.domainFilter}`,
        });
        return false;
      }
      if (need.corpus && c.corpus === 'none') {
        rejected.push({ id: p.id, why: 'cannot ground on a private corpus' });
        return false;
      }
      if (need.social && !need.social.every((s) => c.socialSources.includes(s))) {
        rejected.push({ id: p.id, why: `cannot search ${need.social.join('/')}` });
        return false;
      }
      return true;
    });

    if (eligible.length === 0) {
      return {
        provider: null,
        reason: 'No configured provider can do this. See the rejections.',
        runnerUp: null,
        rejected,
      };
    }

    const estimateFor = (p: ResearchProvider): number => p.estimate(need.estimateInput).cost.highUsd;
    const ranked = [...eligible].sort((a, b) => estimateFor(a) - estimateFor(b));

    // Cost, on the reserved worst case, once capability has already decided
    // who is eligible.
    //
    // This used to hand every deep run to Gemini regardless of price, on the
    // grounds that its editable plan is worth more than the difference. That
    // reasoning is sound and belongs in the *capability* filter, where asking
    // for a plan review already forces Gemini and nothing else qualifies. As a
    // blanket preference it did something else: it made three configured
    // backends unreachable without naming them, so four runs in a row went to
    // the most expensive eligible provider and the operator's other keys never
    // ran. The documented tie-break order is capability, then cost, then dated
    // accuracy as weak evidence, then diversity.
    const preferred = ranked[0]!;
    const runnerUp = ranked.find((p) => p.id !== preferred.id) ?? null;

    return {
      provider: preferred,
      reason: describeChoice(preferred, need, eligible.length),
      runnerUp,
      rejected,
    };
  }
}

export interface RoutingNeed {
  readonly shape?: Shape;
  readonly planReview?: boolean;
  readonly dateWindow?: boolean;
  readonly domains?: number;
  readonly corpus?: boolean;
  readonly social?: readonly string[];
  readonly estimateInput: DurationOptions;
}

export interface RoutingDecision {
  readonly provider: ResearchProvider | null;
  readonly reason: string;
  readonly runnerUp: ResearchProvider | null;
  readonly rejected: readonly { id: ProviderId; why: string }[];
}

/**
 * Why this backend, most specific reason first.
 *
 * "The only configured provider that can do this" is true but unhelpful: it
 * says a choice was forced without saying by what. The requirement that forced
 * it is the useful sentence, so the specific reasons are checked before the
 * generic fallback.
 */
function describeChoice(p: ResearchProvider, need: RoutingNeed, eligible: number): string {
  if (need.social?.length) return `${p.label} is the only backend that reaches ${need.social.join('/')}.`;
  if (need.planReview) return `${p.label} is the only backend offering an editable plan before spending.`;
  if (need.shape === 'wide') return `${p.label} has a native wide-research mode that cites every row.`;
  if (need.dateWindow) return `${p.label} can enforce the date window rather than only asking for it.`;
  if (need.domains) return `${p.label} accepts a domain filter of ${String(need.domains)}; the others cap lower.`;
  if (need.corpus) return `${p.label} is the only backend that can ground on a private corpus.`;
  if (eligible === 1) return `${p.label} is the only configured provider that can do this.`;
  return `${p.label}: cheapest configured backend meeting the requirements, of ${String(eligible)} eligible.`;
}
