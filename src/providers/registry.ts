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

  constructor(config: Config, resolveGeminiClient: () => DeepResearchClient | null) {
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
   * Every configured backend, including the local CLI. `local` used to be
   * excluded here unless an operator named it in `DOSSIER_PROVIDERS`; see
   * `route()` for why that changed and what replaced it.
   */
  available(): readonly ResearchProvider[] {
    return this.all.filter((p) => p.detect().state !== 'not-configured');
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
    return routeAmong(configured, need);
  }
}

/**
 * The routing algorithm itself, over an already-configured set.
 *
 * Split out from `ProviderRegistry` because the registry builds its own
 * providers from environment and PATH, which makes the *decision* impossible to
 * test without depending on what the developer happens to have installed. The
 * local CLI backend is detected from a binary on PATH, so an assertion about
 * whether it is preferred could otherwise pass on one machine and fail on the
 * next. This takes the providers as an argument instead.
 */
export function routeAmong(configured: readonly ResearchProvider[], need: RoutingNeed): RoutingDecision {
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
    // A subscription backend nobody has signed into is not a cheap option, it
    // is a broken one, and it costs $0 so it would win the cost sort below
    // outright. Eliminated here rather than merely left unpreferred, and named
    // in `rejected` so the fix is visible instead of mysterious.
    if (c.billedTo === 'subscription' && p.detect().signedIn !== true) {
      rejected.push({ id: p.id, why: 'installed but not signed in, so it cannot run' });
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

  // A subscription the user already pays for beats a metered API balance.
  //
  // This one is an owner decision, not an inference from the numbers, and it
  // reverses the previous rule. Before 0.5.1 the CLI backend was excluded
  // from automatic selection altogether: it costs $0, so any cost tie-break
  // picks it every time, and it draws on a quota Dossier cannot see or meter
  // while running a third-party binary on the machine. Those facts have not
  // changed. What changed is the judgement about which default serves the
  // person paying: billing an API when a capable CLI is installed and signed
  // in spends real money to avoid spending an allowance already bought.
  //
  // Three things keep it honest.
  //
  // Capability is still first and is untouched by this. A CLI cannot enforce
  // a date window, reach X, filter domains or offer an editable plan, and the
  // filter above has already eliminated it from every such job. Preference
  // only ever chooses between backends that can all do the work.
  //
  // Sign-in is required. `detect()` reports it from the existence of a
  // session file, never from opening one. Preferring a CLI nobody has signed
  // into would trade a working paid run for a failing free one.
  //
  // The reason says so. `describeChoice` states that a subscription quota is
  // being spent and that Dossier cannot meter it, because "free" is the one
  // word this must never imply.
  //
  // `DOSSIER_PROVIDERS` overrides in both directions: naming the CLI forces
  // it, and omitting it from a non-empty list removes it from the registry
  // entirely.
  const subscription = ranked.find(
    (p) => p.capabilities.billedTo === 'subscription' && p.detect().signedIn === true,
  );

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
  // ran. The documented tie-break order is capability, then billing, then
  // cost, then dated accuracy as weak evidence, then diversity.
  const preferred = subscription ?? ranked[0]!;
  // The runner-up is the cheapest *paid* backend when a subscription won, so
  // the named fallback is the one that would actually run if the CLI turned
  // out to be unusable at spawn, rather than a second subscription entry.
  const runnerUp = ranked.find((p) => p.id !== preferred.id) ?? null;

  return {
    provider: preferred,
    reason: describeChoice(preferred, need, eligible.length),
    runnerUp,
    rejected,
  };
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
  // Billing is checked after the hard requirements and before cost, mirroring
  // the order `route()` applies. The wording avoids "free" on purpose: no API
  // is charged, but a quota is consumed and nothing here can measure how much.
  if (p.capabilities.billedTo === 'subscription') {
    return (
      `${p.label}: preferred because it is installed and signed in, and can do this job. ` +
      'This spends your CLI subscription quota rather than an API balance, and Dossier cannot meter that quota. ' +
      `Set DOSSIER_PROVIDERS to route to a paid backend instead, of ${String(eligible)} eligible.`
    );
  }
  if (need.planReview) return `${p.label} is the only backend offering an editable plan before spending.`;
  if (need.shape === 'wide') return `${p.label} has a native wide-research mode that cites every row.`;
  if (need.dateWindow) return `${p.label} can enforce the date window rather than only asking for it.`;
  if (need.domains) return `${p.label} accepts a domain filter of ${String(need.domains)}; the others cap lower.`;
  if (need.corpus) return `${p.label} is the only backend that can ground on a private corpus.`;
  if (eligible === 1) return `${p.label} is the only configured provider that can do this.`;
  return `${p.label}: cheapest configured backend meeting the requirements, of ${String(eligible)} eligible.`;
}
