import type { Config } from '../config.js';
import type { DeepResearchClient } from '../gemini/client.js';
import type { CostBand, DurationOptions } from '../gemini/cost.js';
import { describeProbeAge, readModelCache, type ProbedModel } from '../local/model-cache.js';
import type { ProfileSignal, QuestionProfile } from '../research/profile.js';
import { geminiProvider } from './gemini.js';
import { localProviders } from './local.js';
import { openAiProvider } from './openai.js';
import { perplexityProvider } from './perplexity.js';
import { xaiProvider } from './xai.js';
import {
  isLocalProviderId,
  LEGACY_LOCAL_ID,
  type LocalProviderId,
  type ProviderId,
  type ResearchProvider,
  type Shape,
} from './types.js';

/**
 * Does the operator's allow-list admit this backend?
 *
 * Exact ids match, and the legacy `local` is read as "every CLI". Someone who
 * set `DOSSIER_PROVIDERS=gemini,local` meant "the API plus my CLIs", and having
 * that silently resolve to no CLI at all after the per-CLI split would turn a
 * working configuration into a broken one on upgrade. `local-claude` still
 * names exactly one.
 */
function allows(enabled: readonly string[], id: ProviderId): boolean {
  if (enabled.includes(id)) return true;
  return isLocalProviderId(id) && enabled.includes(LEGACY_LOCAL_ID);
}

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
  /**
   * True when the operator named backends in `DOSSIER_PROVIDERS`.
   *
   * Panel assembly needs to know. An allow-list is an instruction, not a hint,
   * so a named backend joins whether or not the question profile would have
   * asked for it; naming one backend is how you get a panel of one.
   */
  private readonly allowListInForce: boolean;
  /**
   * Where the probed-model cache lives.
   *
   * Held rather than the whole config so the registry keeps depending on one
   * fact about the environment instead of all of them. Read on each panel
   * assembly rather than once in the constructor: a `research_doctor` probe
   * during the server's life should take effect on the next panel, not on the
   * next restart.
   */
  private readonly storeDir: string;

  constructor(config: Config, resolveGeminiClient: () => DeepResearchClient | null) {
    const built = [
      geminiProvider(config, resolveGeminiClient),
      perplexityProvider(config),
      openAiProvider(config),
      xaiProvider(config),
      // Every CLI, always built, whether or not it is installed. The API
      // backends exist without their keys and report themselves unconfigured,
      // and the CLIs behave the same way, so `list()` and `get()` do not depend
      // on what happens to be on the developer's PATH.
      ...localProviders(config),
    ];
    // An explicit allow-list is a deliberate operator choice and overrides
    // detection: a key present in the environment for some other tool should
    // not silently become a place Dossier can spend money.
    this.allowListInForce = config.enabledProviders.length > 0;
    this.all = this.allowListInForce ? built.filter((p) => allows(config.enabledProviders, p.id)) : built;
    this.storeDir = config.storeDir;
  }

  /**
   * The probed model behind each CLI backend, keyed by provider id.
   *
   * Empty on a machine that has never opted into the probe, which is the point:
   * the free lane keeps every member when nothing is known, and only dedupes on
   * an answer a CLI actually gave.
   */
  private probedModels(): ReadonlyMap<ProviderId, ProbedModel> {
    const byProvider = new Map<ProviderId, ProbedModel>();
    for (const [cli, entry] of readModelCache(this.storeDir)) byProvider.set(`local-${cli}`, entry);
    return byProvider;
  }

  list(): readonly ResearchProvider[] {
    return this.all;
  }

  get(id: ProviderId): ResearchProvider | null {
    const exact = this.all.find((p) => p.id === id);
    if (exact) return exact;
    // `local` is not a backend any more, but runs recorded before the per-CLI
    // split carry it, and `refresh`, `approvePlan` and `cancel` all resolve a
    // client from the id on the record. Resolving it to the leading local
    // backend keeps those runs readable and cancellable; the transcript
    // directory is shared, so it finds their output.
    if (id === LEGACY_LOCAL_ID) return this.all.find((p) => isLocalProviderId(p.id)) ?? null;
    return null;
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

  /**
   * Assemble a panel rather than pick a winner.
   *
   * `route()` still exists and still answers "which one backend", because the
   * explicit-provider path and every shaped tool needs exactly that. This is the
   * default path for an unqualified research request: every free backend that
   * can do the job, plus every paid backend the question actually calls for.
   */
  assemblePanel(need: PanelNeed): PanelDecision {
    const configured = this.available();
    if (configured.length === 0) {
      return {
        members: [],
        free: [],
        paid: [],
        total: ZERO_BAND,
        rejected: this.all.map((p) => ({ id: p.id, why: p.detect().detail })),
        notes: ['No provider credentials are configured, so there is no panel to assemble.'],
        crawl: null,
        profile: need.profile,
      };
    }
    return assemblePanelAmong(configured, {
      ...need,
      allowList: this.allowListInForce,
      cliModels: this.probedModels(),
    });
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
  const { eligible, rejected } = screenByCapability(configured, need);

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

export interface CapabilityScreen {
  readonly eligible: readonly ResearchProvider[];
  readonly rejected: readonly { id: ProviderId; why: string }[];
}

/**
 * Capability first, then usability. Nothing else.
 *
 * Shared by `routeAmong` and `assemblePanelAmong` so that the rule holds by
 * construction rather than by two implementations agreeing: a backend that
 * cannot enforce a date window does not join a date-bound panel merely because
 * it is free. Cost, billing preference and question profile are all downstream
 * of this function and none of them can put back what it removed.
 *
 * Two passes, in that order. The first is pure capability. The second is the
 * sign-in check, which is not a capability but a fact about the machine: a
 * subscription backend nobody has signed into is not a cheap option, it is a
 * broken one, and it costs $0 so it would win any cost sort outright. Both are
 * named in `rejected` so the fix is visible instead of mysterious.
 */
export function screenByCapability(
  configured: readonly ResearchProvider[],
  need: RoutingNeed,
): CapabilityScreen {
  const rejected: { id: ProviderId; why: string }[] = [];
  const capable = configured.filter((p) => {
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

  const eligible = capable.filter((p) => {
    if (p.capabilities.billedTo === 'subscription' && p.detect().signedIn !== true) {
      rejected.push({ id: p.id, why: 'installed but not signed in, so it cannot run' });
      return false;
    }
    return true;
  });

  return { eligible, rejected };
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

/* ------------------------------------------------------------------ panels */

/**
 * Which budget a member draws on, as a lane.
 *
 * Kept separate everywhere it is printed. The reader has to be able to see what
 * the money is buying over and above what the subscriptions already cover, and
 * a single merged list hides exactly that.
 */
export type PanelLane = 'free' | 'paid';

export interface PanelMember {
  readonly provider: ResearchProvider;
  readonly lane: PanelLane;
  /** Why this backend is on the panel, in one sentence. */
  readonly reason: string;
  readonly cost: CostBand;
}

/**
 * A crawl the panel would like and will not start.
 *
 * Detection of browser tooling exists in `src/local/browser.ts` and detection is
 * not permission. This is a recommendation printed for a human, nothing else:
 * Mode B stays opt-in behind `DOSSIER_BROWSER_PROVIDER`, and no code path here
 * enables it.
 */
export interface CrawlRecommendation {
  readonly why: string;
  readonly sites: readonly string[];
}

export interface PanelDecision {
  /** Free lane first, then paid, each ordered cheapest first. */
  readonly members: readonly PanelMember[];
  readonly free: readonly PanelMember[];
  readonly paid: readonly PanelMember[];
  /** The sum of every member's band. What the reservation will ask for. */
  readonly total: CostBand;
  readonly rejected: readonly { id: ProviderId; why: string }[];
  /** Anything the reader would be annoyed to discover afterwards. */
  readonly notes: readonly string[];
  readonly crawl: CrawlRecommendation | null;
  readonly profile: QuestionProfile;
}

export interface PanelNeed extends RoutingNeed {
  readonly profile: QuestionProfile;
  /**
   * True when `DOSSIER_PROVIDERS` named the candidate set.
   *
   * Naming a backend is an instruction, so the allow-list overrides the profile
   * in the inclusive direction: a named backend joins whether or not the
   * question calls for it. Without this, `DOSSIER_PROVIDERS=xai` on a question
   * with no social signal would assemble a panel of zero, which contradicts the
   * rule that naming one provider yields a panel of one.
   */
  readonly allowList?: boolean;
  /**
   * The model each CLI backend was probed as serving, keyed by provider id.
   *
   * Passed in rather than read here, for the same reason the provider set is:
   * the cache lives on disk under the store directory, and a membership
   * assertion that depended on what the developer happened to have probed would
   * pass on one machine and fail on the next.
   *
   * A missing entry means "never asked", never "different from the others".
   */
  readonly cliModels?: ReadonlyMap<ProviderId, ProbedModel>;
}

const ZERO_BAND: CostBand = { lowUsd: 0, highUsd: 0, midUsd: 0, basis: 'no members' };

/**
 * At or under this worst case, a backend is cheap enough that leaving it out
 * rarely saves anything worth having.
 *
 * Perplexity is the case this exists for: measured runs land near $0.29 and its
 * fast deep band tops out at $2, so on an ordinary deep question it joins by
 * default rather than waiting for a signal. At `max` tier its band doubles and
 * the default lapses, which is the intended behaviour: "cheap" is a fact about
 * the run, not about the vendor.
 */
export const PANEL_CHEAP_ENOUGH_USD = 2;

/** Above this many named sites, a domain filter is OpenAI's job rather than Perplexity's. */
const LARGE_DOMAIN_FILTER = 20;

/**
 * Assemble a panel over an already-configured set.
 *
 * Split from the registry for the same reason `routeAmong` is: the registry
 * builds providers from environment and PATH, so a test asserting which
 * backends joined would otherwise depend on what the developer has installed.
 */
export function assemblePanelAmong(
  configured: readonly ResearchProvider[],
  need: PanelNeed,
): PanelDecision {
  // Capability first, before billing and before the profile is even read.
  const { eligible, rejected: screened } = screenByCapability(configured, need);
  const rejected = [...screened];
  const notes: string[] = [];

  const costOf = (p: ResearchProvider): CostBand => p.estimate(need.estimateInput).cost;

  // Lane 1. Every capable, signed-in CLI joins. There is no cost argument
  // against including all of them, because the marginal cost of the second is
  // zero and they read different indexes.
  const free: PanelMember[] = eligible
    .filter((p) => p.capabilities.billedTo === 'subscription')
    .map((p) => ({
      provider: p,
      lane: 'free' as const,
      reason:
        `${p.label} is installed, signed in and can do this job. ` +
        'It spends CLI subscription quota rather than an API balance, and Dossier cannot meter that quota.',
      cost: costOf(p),
    }));

  // Lane 2. A paid backend joins when its key exists and the question profile
  // calls for what only that backend does. An allow-list overrides the profile
  // in the inclusive direction: naming a backend is an instruction.
  const paid: PanelMember[] = [];
  for (const p of eligible) {
    if (p.capabilities.billedTo === 'subscription') continue;
    const reason = need.allowList === true
      ? `${p.label} was named in DOSSIER_PROVIDERS, so it joins regardless of the question profile.`
      : paidJoinReason(p, need, costOf(p));
    if (reason === null) {
      rejected.push({ id: p.id, why: 'configured, but nothing in this question calls for it' });
      continue;
    }
    paid.push({ provider: p, lane: 'paid', reason, cost: costOf(p) });
  }

  // Cost orders the lane, and the order it was offered in breaks the tie. Every
  // CLI costs $0, so cost alone leaves the free lane in whatever order the sort
  // happens to produce; the registry builds the local backends strongest first,
  // and this is what makes that preference the printed order rather than a
  // property of `Array#sort` being stable.
  const offered = new Map(configured.map((p, i) => [p.id, i] as const));
  const at = (m: PanelMember): number => offered.get(m.provider.id) ?? Number.MAX_SAFE_INTEGER;
  const byCost = (a: PanelMember, b: PanelMember): number => a.cost.highUsd - b.cost.highUsd || at(a) - at(b);
  free.sort(byCost);
  paid.sort(byCost);

  // Two CLIs serving one model are one perspective. Done after the sort, so
  // "the survivor is the earlier one in the preference order" is a property of
  // the order already established rather than a second ranking.
  const deduped = dedupeFreeLaneByModel(free, need.cliModels);
  rejected.push(...deduped.dropped);
  notes.push(...deduped.notes);
  const freeFinal = deduped.kept;

  // "Never xAI alone" on a legal question, from the design and from xAI's own
  // documentation, which describes the product as suited to finding things
  // rather than concluding them. Refusing beats running: a legal answer from
  // the one backend the design says must not produce one unsupervised is worse
  // than no answer, and the operator can still force it by name.
  const legal = need.profile.signals.includes('legal');
  let paidFinal = paid;
  if (legal && need.allowList !== true && freeFinal.length === 0 && paid.length === 1 && paid[0]!.provider.id === 'xai') {
    rejected.push({
      id: 'xai',
      why: 'this question is legal or regulatory, and xAI must not be the only backend concluding on one',
    });
    notes.push(
      'xAI was the only backend the profile called for, and this is a legal or regulatory question. ' +
        'xAI is a finder rather than a concluder, so it is not run alone here. ' +
        'Configure Gemini, or name xAI in DOSSIER_PROVIDERS if you want it anyway.',
    );
    paidFinal = [];
  }

  const members = [...freeFinal, ...paidFinal];
  const total = sumBands(members.map((m) => m.cost));

  if (members.length === 0 && notes.length === 0) {
    notes.push('No configured provider can do this. See the rejections.');
  } else if (members.length === 1) {
    // A panel of one is a legitimate outcome and is said plainly. Dressing it
    // up as a panel would be the one thing the plan output must not do.
    notes.push(`A panel of one: ${members[0]!.provider.label} is the only backend that belongs on this question.`);
  }

  const crawl = recommendCrawl(need.profile);

  return { members, free: freeFinal, paid: paidFinal, total, rejected, notes, crawl, profile: need.profile };
}

interface FreeLaneDedupe {
  readonly kept: PanelMember[];
  readonly dropped: { id: ProviderId; why: string }[];
  readonly notes: string[];
}

/**
 * One seat per model on the free lane.
 *
 * The lane's entire justification is that different models drive different
 * searches and therefore read different parts of the web. That is what makes
 * four CLIs worth running instead of one. If two of them serve the *same*
 * model, they are not independent: the panel buys one perspective and reports
 * four, which is the corroboration trap living inside the lane built to prevent
 * it, and the automatic merge would then count the overlap it caused itself.
 *
 * On a default install the problem does not bite. Probed on this machine on
 * 27 July 2026, `cursor-agent` answers `Composer` and `grok` answers
 * `Grok 4.5`, so the CLIs really are distinct models. It bites when someone
 * points Cursor at Grok 4.5, which Cursor lets them do, and nothing about the
 * binary's name or version would ever reveal it.
 *
 * Three rules keep this from doing harm.
 *
 * **It only acts on a probed answer.** A machine that has never opted into
 * `research_doctor`'s `probeModels` has an empty cache, and an empty cache
 * keeps every member and says the lane may hold duplicates. Inferring a model
 * from a product name would drop a paid-for backend on the strength of a guess,
 * and the guess would be wrong on the default install described above.
 *
 * **The survivor is the earlier one in the preference order**, which the caller
 * has already applied to the lane. Cheapest-first is meaningless here because
 * every member costs $0, so the offered order is the whole ranking.
 *
 * **A capability is never inherited from the model.** This is the half that is
 * easy to get wrong later. If a user points Cursor at Grok 4.5, that Cursor
 * member still has no X access: live X search is xAI's own first-party tool
 * attached to their API, not something the weights carry around. Capability
 * declarations stay per-CLI in `src/providers/local.ts` and are read from the
 * provider, never derived from a probed model name. This function reads
 * `capabilities` for nothing and must keep reading it for nothing.
 */
function dedupeFreeLaneByModel(
  free: readonly PanelMember[],
  models: ReadonlyMap<ProviderId, ProbedModel> | undefined,
): FreeLaneDedupe {
  const kept: PanelMember[] = [];
  const dropped: { id: ProviderId; why: string }[] = [];
  const notes: string[] = [];
  const seen = new Map<string, { member: PanelMember; probe: ProbedModel }>();
  let unprobed = 0;

  for (const member of free) {
    const probe = models?.get(member.provider.id);
    if (!probe) {
      unprobed += 1;
      kept.push(member);
      continue;
    }
    const incumbent = seen.get(probe.normalised);
    if (!incumbent) {
      seen.set(probe.normalised, { member, probe });
      kept.push(member);
      continue;
    }
    // Both spellings, when they differ. The two CLIs named the same model two
    // ways, and printing only one of them reads as a claim about the other
    // backend that the other backend never made.
    const named =
      probe.model === incumbent.probe.model ? probe.model : `${probe.model} and ${incumbent.probe.model}`;
    // The older of the two readings, because the decision is only as current as
    // its weakest input.
    const oldest = Math.min(probe.probedAt, incumbent.probe.probedAt);
    dropped.push({
      id: member.provider.id,
      why:
        `serves the same model as ${incumbent.member.provider.label} (${named}), ` +
        `so seating both would buy one perspective and report two; oldest probe reading ${describeProbeAge(oldest)}`,
    });
  }

  if (dropped.length > 0) {
    notes.push(
      `${String(dropped.length)} CLI(s) left the free lane because another CLI already on it serves the same model. ` +
        'Two CLIs on one model read the same web, and counting that as two backends is the overlap this panel exists to avoid. ' +
        'Point them at different models, or name one with the `provider` argument to run it on its own.',
    );
  }
  if (free.length > 1 && unprobed > 0) {
    notes.push(
      `${String(unprobed)} of ${String(free.length)} CLIs on the free lane have no probed model, so the lane may hold the same model twice ` +
        'and its members may not be as independent as their count suggests. Nothing is dropped on a guess. ' +
        'Run `research_doctor` with `probeModels: true` to ask each signed-in CLI which model it serves; the answer is cached.',
    );
  }

  return { kept, dropped, notes };
}

/**
 * Why a paid backend belongs on this panel, or `null` if it does not.
 *
 * The table in `docs/plan/panel-routing.md` is the specification for this
 * function, one branch per row, most distinctive reason first.
 */
function paidJoinReason(p: ResearchProvider, need: PanelNeed, cost: CostBand): string | null {
  const has = (s: ProfileSignal): boolean => need.profile.signals.includes(s);
  const sites = need.profile.namedSites.length;
  const domains = Math.max(need.domains ?? 0, sites);

  switch (p.id) {
    case 'gemini': {
      if (has('breadth')) return `${p.label}: the question is broad or multi-part, which is what it covers best.`;
      if (has('legal')) {
        return `${p.label}: a legal or regulatory question wants the most comprehensive backend available.`;
      }
      if (need.shape === 'deep' || need.shape === undefined) {
        return `${p.label}: default yes for anything deep, as the most comprehensive backend available.`;
      }
      return null;
    }
    case 'perplexity': {
      if (has('time-bound')) {
        return `${p.label}: the question is time-bound, and it enforces a date window rather than asking for one.`;
      }
      if (has('enumeration')) {
        return `${p.label}: the question asks for an enumeration, which its wide mode cites row by row.`;
      }
      if (has('named-sites') && domains <= LARGE_DOMAIN_FILTER) {
        return `${p.label}: ${String(domains)} named site(s), inside its domain allow-list.`;
      }
      if (cost.highUsd <= PANEL_CHEAP_ENOUGH_USD) {
        return (
          `${p.label}: at a worst case of $${cost.highUsd.toFixed(2)} it is cheap enough that ` +
          'leaving it out rarely saves anything worth having.'
        );
      }
      return null;
    }
    case 'xai': {
      if (has('social')) {
        return `${p.label}: the question turns on what people are publicly saying, and nothing else reaches X.`;
      }
      return null;
    }
    case 'openai': {
      if (has('primary-literature')) {
        return `${p.label}: the question asks for primary literature.`;
      }
      if (domains > LARGE_DOMAIN_FILTER) {
        return `${p.label}: a domain filter of ${String(domains)} sites, above what the others accept.`;
      }
      return null;
    }
    default: {
      // Everything left is a CLI backend, billed to a subscription, and never
      // reaches here. The annotation is the exhaustiveness check the old `case
      // 'local'` was: a new id that is not a local one fails to assign, so
      // adding a paid backend is a compile error rather than a silent omission
      // from every panel.
      const cli: LocalProviderId | typeof LEGACY_LOCAL_ID = p.id;
      void cli;
      return null;
    }
  }
}

/** Sum of the members' bands. The worst case is what gets reserved. */
export function sumBands(bands: readonly CostBand[]): CostBand {
  if (bands.length === 0) return ZERO_BAND;
  const lowUsd = Number(bands.reduce((s, b) => s + b.lowUsd, 0).toFixed(2));
  const highUsd = Number(bands.reduce((s, b) => s + b.highUsd, 0).toFixed(2));
  const midUsd = Number(bands.reduce((s, b) => s + b.midUsd, 0).toFixed(2));
  return {
    lowUsd,
    highUsd,
    midUsd,
    basis: `sum of ${String(bands.length)} panel member(s); $${highUsd.toFixed(2)} is reserved before any member starts`,
  };
}

/**
 * Should a human point a browser at something?
 *
 * Returns a sentence, never an action. The panel may ask for a crawl lane and
 * must not enable one.
 */
function recommendCrawl(profile: QuestionProfile): CrawlRecommendation | null {
  if (profile.namedSites.length > 0) {
    return {
      why:
        'This question names specific pages. A search index reaches what it has crawled, ' +
        'so a named site is the case where browser tooling finds what the panel cannot.',
      sites: profile.namedSites,
    };
  }
  if (profile.needsSpecificPages) {
    return {
      why:
        'This question points at a document behind a login or a paywall, which no search index reaches. ' +
        'Browser tooling is the only route to it.',
      sites: [],
    };
  }
  return null;
}
