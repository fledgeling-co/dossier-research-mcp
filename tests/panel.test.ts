import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import type { CostBand } from '../src/gemini/cost.js';
import type { CreateRunArgs, DeepResearchClient } from '../src/gemini/client.js';
import type { InteractionSnapshot } from '../src/gemini/types.js';
import { normaliseModelName } from '../src/local/cli.js';
import type { ProbedModel } from '../src/local/model-cache.js';
import { assemblePanelAmong, ProviderRegistry, sumBands } from '../src/providers/registry.js';
import type {
  Capabilities,
  CredentialStatus,
  ProviderId,
  ResearchProvider,
} from '../src/providers/types.js';
import { profileQuestion, PROFILE_SIGNALS, type ProfileSignal } from '../src/research/profile.js';
import { BudgetExceededError, ConcurrencyExceededError, Runner } from '../src/research/runner.js';
import { panelContractId, renderPanel } from '../src/server.js';
import { Store } from '../src/store/store.js';

/* ----------------------------------------------------------- scripted set */

/**
 * Scripted providers, never the real registry.
 *
 * The CLI backend is detected from a binary on PATH and the API backends from
 * environment keys, so a membership assertion built from the environment would
 * pass on one machine and fail on the next. `assemblePanelAmong` takes the
 * candidate set as an argument for exactly this reason.
 */
const caps = (over: Partial<Capabilities>): Capabilities => ({
  shapes: ['deep'],
  background: true,
  planReview: false,
  followUp: false,
  dateFilter: 'none',
  domainFilter: 0,
  corpus: 'none',
  socialSources: [],
  structuredOutput: false,
  fileOutput: false,
  maxWallClockMinutes: 30,
  billedTo: 'api-balance',
  limitations: [],
  ...over,
});

const provider = (
  id: ProviderId,
  highUsd: number,
  capabilities: Capabilities,
  status: CredentialStatus,
): ResearchProvider => ({
  id,
  label: id.toUpperCase(),
  capabilities,
  detect: () => status,
  estimate: () => ({
    cost: { lowUsd: highUsd / 4, highUsd, midUsd: highUsd / 2, basis: 'scripted' },
    duration: {
      lowMinutes: 1,
      highMinutes: 2,
      factors: [],
      sources: [],
      awaitsApproval: false,
      cappedByApiLimit: false,
    },
  }),
  client: () => {
    throw new Error('not used');
  },
});

const signedIn: CredentialStatus = { state: 'configured-unverified', detail: 'on PATH, signed in', signedIn: true };
const apiKey: CredentialStatus = { state: 'configured-unverified', detail: 'key present' };

/**
 * Three signed-in CLIs, because that is the machine this was built for: a
 * Claude subscription, a Codex one and a Grok one, all paid for, all idle
 * before the free lane could hold more than one of them.
 */
const cli = provider('local-claude', 0, caps({ billedTo: 'subscription' }), signedIn);
const codexCli = provider('local-codex', 0, caps({ billedTo: 'subscription' }), signedIn);
const grokCli = provider('local-grok', 0, caps({ billedTo: 'subscription' }), signedIn);
const clis = [cli, codexCli, grokCli];
const gemini = provider('gemini', 7, caps({ planReview: true, corpus: 'file-search' }), apiKey);
const perplexity = provider(
  'perplexity',
  2,
  caps({ shapes: ['deep', 'wide', 'recent'], dateFilter: 'range', domainFilter: 20 }),
  apiKey,
);
const openai = provider('openai', 5, caps({ domainFilter: 100 }), apiKey);
const xai = provider('xai', 1, caps({ dateFilter: 'range', domainFilter: 5, socialSources: ['x'] }), apiKey);
const everyone = [gemini, perplexity, openai, xai, ...clis];

const input = { tier: 'fast' as const, tools: [] };
const panelFor = (question: string, over: Record<string, unknown> = {}, set = everyone) =>
  assemblePanelAmong(set, { estimateInput: input, profile: profileQuestion(question), ...over });
const ids = (set: readonly { provider: ResearchProvider }[]): ProviderId[] => set.map((m) => m.provider.id);

/* --------------------------------------------------- PANEL-08: the profile */

describe('the question profile', () => {
  // One question per signal that must fire, and one that must not. A keyword
  // classifier that fires on everything is the same as no classifier, and it
  // would put every paid backend on every panel.
  const carriers: Record<ProfileSignal, string> = {
    enumeration: 'List every vendor shipping an MCP server for research.',
    'time-bound': 'What shipped in the last 3 months on this?',
    social: 'What are people saying on Reddit about this launch?',
    'primary-literature': 'What do the randomised trials say about this drug?',
    'named-sites': 'What does the pricing page on anthropic.com say?',
    legal: 'What are our GDPR obligations here?',
    breadth: 'Give me a comprehensive overview of this.',
  };
  // Deliberately flat and short: no keywords, one clause, under the word count.
  const inert = 'Who leads this market?';

  for (const signal of PROFILE_SIGNALS) {
    it(`fires ${signal} on a question that carries it and not on one that does not`, () => {
      expect(profileQuestion(carriers[signal]).signals).toContain(signal);
      expect(profileQuestion(inert).signals).not.toContain(signal);
    });
  }

  it('is additive: a question that is both time-bound and legal carries both', () => {
    const p = profileQuestion('What GDPR enforcement actions have landed since 2024?');
    expect(p.signals).toContain('legal');
    expect(p.signals).toContain('time-bound');
  });

  it('reads the archetype rather than duplicating it, so a classifier hit still counts', () => {
    // Nothing here matches the legal keyword list; the regulatory archetype is
    // what carries the signal. Built on top of `selectArchetype`, not beside it.
    const p = profileQuestion('What policy changes affect a UK issuer IPO timetable?');
    expect(p.archetype).toBe('regulatory');
    expect(p.signals).toContain('legal');
  });

  it('does not mistake a file name or a library for a named site', () => {
    const p = profileQuestion('Why does vitest.config.ts break node.js 20 here, e.g. on CI?');
    expect(p.namedSites).toEqual([]);
    expect(p.signals).not.toContain('named-sites');
  });

  it('treats several sub-questions as breadth even when nothing announces it', () => {
    expect(profileQuestion('Who leads? What do they charge?').signals).toContain('breadth');
  });
});

/* -------------------------------------------------------- lanes and gating */

describe('panel assembly', () => {
  it('PANEL-01: screens capability before billing and before the profile', () => {
    // The CLIs are free, signed in and would otherwise anchor the free lane.
    // None can enforce a date window, so all three are off a date-bound panel.
    const panel = panelFor('What shipped in the last 3 months?', { dateWindow: true });
    expect(panel.free).toHaveLength(0);
    expect(panel.rejected.find((r) => r.id === 'local-claude')?.why).toMatch(/date window/);
    expect(panel.rejected.find((r) => r.id === 'local-grok')?.why).toMatch(/date window/);
    expect(ids(panel.members)).toContain('perplexity');
  });

  it('PANEL-02: runs on the free lane alone with no API key configured at all', () => {
    const panel = panelFor('Who leads this market?', {}, [cli]);
    expect(ids(panel.free)).toEqual(['local-claude']);
    expect(panel.paid).toHaveLength(0);
    expect(panel.total.highUsd).toBe(0);
    // Never the word "free" about the money: a quota is being spent that
    // Dossier cannot meter, and saying free would be a claim about a bill.
    expect(panel.free[0]?.reason).toMatch(/cannot meter/i);
  });

  // PANEL-21. The whole reason the ids were split. Three subscriptions paid for
  // used to produce one answer, because a single `local` provider picked a
  // winner by preference order and the other two sat idle on every run.
  it('PANEL-21: seats every signed-in CLI, strongest first', () => {
    const panel = panelFor('Who leads this market?', {}, clis);
    expect(ids(panel.free)).toEqual(['local-claude', 'local-codex', 'local-grok']);
    expect(panel.total.highUsd).toBe(0);
    // Order is the offered order at equal cost, not whatever the sort happened
    // to do, so the strongest CLI leads and reads first in the rendering.
    expect(ids(panelFor('Who leads this market?', {}, [grokCli, cli, codexCli]).free)).toEqual([
      'local-grok',
      'local-claude',
      'local-codex',
    ]);
  });

  it('PANEL-21: a CLI that is installed but not signed in loses its own seat only', () => {
    const notSignedIn = provider('local-codex', 0, caps({ billedTo: 'subscription' }), {
      state: 'configured-unverified',
      detail: 'on PATH, no session file',
    });
    const panel = panelFor('Who leads this market?', {}, [cli, notSignedIn, grokCli]);
    expect(ids(panel.free)).toEqual(['local-claude', 'local-grok']);
    expect(panel.rejected.find((r) => r.id === 'local-codex')?.why).toMatch(/sign/i);
  });

  it('PANEL-03: a paid backend joins only when the question calls for it', () => {
    // xAI is the cheapest configured backend and stays off a question with no
    // social signal. Cost is not what gets a backend onto a panel.
    const quiet = panelFor('Who leads this market?');
    expect(ids(quiet.paid)).not.toContain('xai');
    expect(quiet.rejected.find((r) => r.id === 'xai')?.why).toMatch(/nothing in this question calls for it/);

    const social = panelFor('What are people saying on Reddit about this launch?');
    expect(ids(social.paid)).toContain('xai');
    expect(social.paid.find((m) => m.provider.id === 'xai')?.reason).toMatch(/publicly saying/);
  });

  it('PANEL-04: additive signals bring in the backend each one implies', () => {
    const panel = panelFor(
      'What GDPR enforcement actions have landed since 2024, and what do the papers say about them?',
    );
    // legal and breadth → Gemini; time-bound → Perplexity; primary literature → OpenAI.
    expect(ids(panel.paid)).toEqual(expect.arrayContaining(['gemini', 'perplexity', 'openai']));
  });

  it('PANEL-05: says a panel of one is a panel of one', () => {
    const panel = panelFor('Who leads this market?', {}, [cli]);
    expect(panel.members).toHaveLength(1);
    expect(panel.notes.join(' ')).toMatch(/A panel of one/);
    expect(panel.notes.join(' ')).not.toMatch(/fallback|degraded/i);
  });

  it('PANEL-06: an allow-list joins a backend the profile would have left out', () => {
    // `DOSSIER_PROVIDERS=xai` on a question with no social signal must still
    // produce a panel of one, not a panel of zero.
    const panel = panelFor('Who leads this market?', { allowList: true }, [xai]);
    expect(ids(panel.members)).toEqual(['xai']);
    expect(panel.paid[0]?.reason).toMatch(/named in DOSSIER_PROVIDERS/);
  });

  it('PANEL-06: an allow-list also excludes, because the registry never builds the rest', () => {
    const r = new ProviderRegistry(
      loadConfig({ DOSSIER_STORE_DIR: '/tmp/x', PERPLEXITY_API_KEY: 'p', DOSSIER_PROVIDERS: 'perplexity' }),
      () => null,
    );
    expect(r.list().map((p) => p.id)).toEqual(['perplexity']);
  });

  it('PANEL-07: never lets xAI conclude a legal question on its own', () => {
    // Social gets xAI onto the panel; legal is what it must not conclude alone.
    // With nothing else configured the panel is empty rather than xAI-only.
    const q = 'What are people saying about our GDPR obligations for this data?';
    const panel = panelFor(q, {}, [xai]);
    expect(panel.members).toHaveLength(0);
    expect(panel.rejected.find((r) => r.id === 'xai')?.why).toMatch(/must not be the only backend/);
    expect(panel.notes.join(' ')).toMatch(/finder rather than a concluder/);

    // And a legal question with no social signal never reached xAI anyway.
    const quiet = panelFor('What are our GDPR obligations for this data?', {}, [xai]);
    expect(quiet.members).toHaveLength(0);
  });

  it('PANEL-07: and still runs it alongside another backend, or when named', () => {
    const q = 'What are people saying about our GDPR obligations for this data?';
    expect(ids(panelFor(q).members)).toContain('xai');
    // An explicit allow-list is an instruction, and an instruction outranks a
    // guard whose whole job is to second-guess an automatic choice.
    expect(ids(panelFor(q, { allowList: true }, [xai]).members)).toEqual(['xai']);
  });

  it('PANEL-09: recommends a crawl and cannot start one', () => {
    const panel = panelFor('What does the pricing page on anthropic.com say?');
    expect(panel.crawl?.sites).toContain('anthropic.com');
    expect(panel.crawl?.why).toMatch(/search index/i);
    // The recommendation is a sentence for a human. Nothing on the decision
    // enables browser tooling, and no member is a browser.
    expect(Object.keys(panel)).not.toContain('browser');
    expect(ids(panel.members).every((id) => id !== ('browser' as ProviderId))).toBe(true);
  });

  it('PANEL-10: the total is the sum of the members, at the top of every band', () => {
    const panel = panelFor('Give me a comprehensive overview of this.');
    expect(panel.total.highUsd).toBe(
      Number(panel.members.reduce((s, m) => s + m.cost.highUsd, 0).toFixed(2)),
    );
    expect(panel.total.basis).toMatch(/reserved before any member starts/);
  });

  it('sums bands to the top of the range and says so', () => {
    const bands: CostBand[] = [
      { lowUsd: 1, highUsd: 3, midUsd: 2, basis: 'a' },
      { lowUsd: 0.5, highUsd: 2, midUsd: 1.25, basis: 'b' },
    ];
    expect(sumBands(bands).highUsd).toBe(5);
    expect(sumBands([]).highUsd).toBe(0);
  });

  it('names every backend it left out and why', () => {
    const panel = panelFor('Who leads this market?');
    for (const r of panel.rejected) expect(r.why.length).toBeGreaterThan(0);
    // Every configured backend is either a member or a rejection. A backend
    // that vanishes silently is the one an operator will never think to ask about.
    const accounted = new Set([...ids(panel.members), ...panel.rejected.map((r) => r.id)]);
    for (const p of everyone) expect(accounted.has(p.id), p.id).toBe(true);
  });

  it('PANEL-17: prints the lanes separately, with a cost each and a total', () => {
    // The acceptance test can only ever see the empty panel, because hermetic
    // mode reports every backend not-configured. The populated rendering is
    // asserted here instead, off a scripted panel.
    const text = renderPanel(
      panelFor('What are people saying about our comprehensive GDPR obligations since 2024?'),
    ).join('\n');

    expect(text).toMatch(/\*\*Panel\*\*: \d+ backends? \(\d+ free, \d+ paid\)/);
    expect(text).toMatch(/\*Free lane\*/);
    expect(text).toMatch(/\*Paid lane\*/);
    // A cost against every member, not just a total at the bottom.
    for (const m of panelFor('What are people saying about our comprehensive GDPR obligations since 2024?').members) {
      expect(text).toContain(m.provider.label);
    }
    expect(text).toMatch(/\*\*Total worst case\*\*: \$\d+\.\d\d/);
    expect(text).toMatch(/An estimate band, never a quote/);
    expect(text).toMatch(/\*\*Question profile\*\*/);
    expect(text).toMatch(/\*\*Not on the panel\*\*/);
  });

  /* --------------------------------------- PANEL-25..27: one seat per model */

  /**
   * A probed-model cache, as `research_doctor --probeModels` would have left it.
   *
   * Scripted rather than read from disk for the same reason the providers are:
   * a dedupe assertion that depended on what the developer happened to have
   * probed would pass on one machine and fail on the next.
   */
  const probedAs = (entries: Record<string, string>, probedAt = Date.now()): ReadonlyMap<ProviderId, ProbedModel> =>
    new Map(
      Object.entries(entries).map(([id, model]) => [
        id as ProviderId,
        { model, probedAt, normalised: normaliseModelName(model) },
      ]),
    );

  const cursorCli = provider('local-cursor', 0, caps({ billedTo: 'subscription' }), signedIn);

  it('PANEL-25: two CLIs on one model take one seat, and the survivor is the earlier in preference order', () => {
    // The owner's case exactly: Cursor lets you point it at Grok 4.5, and a
    // lane holding Cursor-as-Grok beside Grok buys one perspective and reports
    // two. Spelled differently on each side on purpose; a dedupe that only
    // caught an exact string would miss the real answers.
    const panel = panelFor(
      'Who leads this market?',
      { cliModels: probedAs({ 'local-grok': 'Grok 4.5', 'local-cursor': 'grok-4.5' }) },
      [cli, grokCli, cursorCli],
    );

    expect(ids(panel.free)).toEqual(['local-claude', 'local-grok']);
    const why = panel.rejected.find((r) => r.id === 'local-cursor')?.why ?? '';
    expect(why).toMatch(/same model/);
    // Both spellings are named, and so is how old the reading is: a model
    // identity is a fact about a setting the user can change at any time.
    expect(why).toMatch(/grok-4\.5/);
    expect(why).toMatch(/Grok 4\.5/);
    expect(why).toMatch(/oldest probe reading/);
    expect(panel.notes.join(' ')).toMatch(/same model/);
  });

  it('PANEL-25: the survivor is the order, not the id', () => {
    const reversed = panelFor(
      'Who leads this market?',
      { cliModels: probedAs({ 'local-grok': 'Grok 4.5', 'local-cursor': 'Grok 4.5' }) },
      [cursorCli, grokCli],
    );
    expect(ids(reversed.free)).toEqual(['local-cursor']);
    expect(reversed.rejected.find((r) => r.id === 'local-grok')?.why).toMatch(/same model/);
  });

  it('PANEL-25: two CLIs probed as different models both keep their seats', () => {
    // The default install, measured 27 July 2026: cursor-agent reports Composer
    // and grok reports Grok 4.5. The dedupe must not bite here.
    const panel = panelFor(
      'Who leads this market?',
      { cliModels: probedAs({ 'local-cursor': 'Composer', 'local-grok': 'Grok 4.5' }) },
      [cursorCli, grokCli],
    );
    expect(ids(panel.free)).toEqual(['local-cursor', 'local-grok']);
    expect(panel.notes.join(' ')).not.toMatch(/same model/);
  });

  it('PANEL-26: an unprobed machine keeps every CLI and says the lane may hold duplicates', () => {
    // No cache at all. Guessing from the product name is what would drop a
    // paid-for backend, and on the default install the guess would be wrong.
    const panel = panelFor('Who leads this market?', {}, clis);
    expect(ids(panel.free)).toEqual(['local-claude', 'local-codex', 'local-grok']);
    expect(panel.rejected.map((r) => r.id)).not.toContain('local-grok');

    const note = panel.notes.join(' ');
    expect(note).toMatch(/may hold the same model twice/);
    expect(note).toMatch(/probeModels/);
    expect(note).toMatch(/research_doctor/);
  });

  it('PANEL-26: a partly probed lane still warns about the members nobody asked', () => {
    const panel = panelFor('Who leads this market?', { cliModels: probedAs({ 'local-claude': 'Claude Opus 4.6' }) }, clis);
    expect(panel.free).toHaveLength(3);
    expect(panel.notes.join(' ')).toMatch(/2 of 3 CLIs on the free lane have no probed model/);
  });

  it('PANEL-26: a single-CLI lane is not warned about, because it cannot duplicate anything', () => {
    expect(panelFor('Who leads this market?', {}, [cli]).notes.join(' ')).not.toMatch(/may hold the same model/);
  });

  it('PANEL-27: a capability is never inherited from a probed model', () => {
    // Point Cursor at Grok 4.5 and it is still not xAI. Live X search is a
    // first-party tool attached to xAI's API, not something the weights carry,
    // so the CLI stays off a social panel and xAI is still the only way there.
    const panel = panelFor(
      'What are people saying on X about this launch?',
      { social: ['x'], cliModels: probedAs({ 'local-cursor': 'Grok 4.5' }) },
      [cursorCli, xai],
    );
    expect(ids(panel.free)).toEqual([]);
    expect(panel.rejected.find((r) => r.id === 'local-cursor')?.why).toMatch(/cannot search x/);
    expect(ids(panel.members)).toEqual(['xai']);
  });

  it('PANEL-18: the contract token binds the whole membership, order-independently', () => {
    expect(panelContractId(['perplexity', 'gemini'])).toBe(panelContractId(['gemini', 'perplexity']));
    expect(panelContractId(['gemini'])).not.toBe(panelContractId(['gemini', 'perplexity']));
    expect(panelContractId(['gemini'])).not.toBe('gemini');
  });
});

/* ------------------------------------------------------ starting the panel */

function scriptedClient(
  states: InteractionSnapshot[],
  onCreate?: () => void,
): DeepResearchClient & { created: CreateRunArgs[] } {
  const calls = new Map<string, number>();
  const created: CreateRunArgs[] = [];
  let seq = 0;
  return {
    created,
    async createRun(args) {
      onCreate?.();
      created.push(args);
      const id = `int_${(seq += 1)}`;
      calls.set(id, 0);
      return { interactionId: id, status: 'in_progress', markdown: '', thoughts: [], images: [] };
    },
    async getRun(interactionId) {
      const i = calls.get(interactionId) ?? 0;
      calls.set(interactionId, i + 1);
      const state = states[Math.min(i, states.length - 1)];
      return { ...(state as InteractionSnapshot), interactionId };
    },
    async cancelRun() {
      /* no-op */
    },
    async followUp() {
      return 'follow-up answer';
    },
  };
}

const snapshot = (over: Partial<InteractionSnapshot>): InteractionSnapshot => ({
  interactionId: 'int_1',
  status: 'in_progress',
  markdown: '',
  thoughts: [],
  images: [],
  ...over,
});

const PANEL_ARGS = {
  question: 'Who leads the market?',
  prompt: '<core_directive>Answer this decisively: who leads the market?</core_directive>',
  archetype: 'competitive' as const,
  tier: 'fast' as const,
  tools: [{ type: 'google_search' as const }],
  collaborativePlanning: false,
  thinkingSummaries: true,
  visualization: true,
  preEngineered: false,
};

describe('starting a panel', () => {
  let dir: string;
  let store: Store;
  let config: Config;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'drmcp-panel-'));
    store = new Store(dir);
    await store.init();
    config = { ...loadConfig({ DOSSIER_HERMETIC: '1' }), storeDir: dir };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A flat $2 band per member, so the arithmetic in each assertion is visible. */
  const flat = (): CostBand => ({ lowUsd: 1, highUsd: 2, midUsd: 1.5, basis: 'scripted' });

  it('PANEL-13: one run per member, bound by a shared panel id', async () => {
    const runner = new Runner(store, config, () => scriptedClient([snapshot({})]), undefined, flat);
    const result = await runner.startPanel({ ...PANEL_ARGS, members: ['gemini', 'perplexity', 'openai'] });

    expect(result.started).toHaveLength(3);
    expect(new Set(result.started.map((s) => s.run.id)).size).toBe(3);
    expect(result.started.map((s) => s.run.provider).sort()).toEqual(['gemini', 'openai', 'perplexity']);
    for (const s of result.started) expect(s.run.panelId).toBe(result.panelId);

    // Every per-run tool still works, because a member is an ordinary run.
    const one = await store.getRun(result.started[0]!.run.id);
    expect(one?.state).toBe('running');
    expect(await runner.panelMembers(result.panelId)).toHaveLength(3);
  });

  it('PANEL-10: reserves the sum before any member starts', async () => {
    const runner = new Runner(store, config, () => scriptedClient([snapshot({})]), undefined, flat);
    const result = await runner.startPanel({ ...PANEL_ARGS, members: ['gemini', 'perplexity', 'openai'] });

    expect(result.reservedUsd).toBe(6);
    expect((await runner.budget()).committedUsd).toBe(6);
    // Per member, at the top of the band. The midpoint would let the expensive
    // tail of a five-member panel walk straight through the ceiling.
    for (const s of result.started) expect(s.run.estimatedCostUsd).toBe(2);
  });

  it('PANEL-11: refuses an unaffordable panel whole, before anything starts', async () => {
    // Three members at $2 against a $5 ceiling. Two would fit, which is the
    // point: reserving member by member would start two and then stop.
    const tight = { ...config, budgetUsd: 5 };
    let creates = 0;
    const runner = new Runner(
      store,
      tight,
      () => scriptedClient([snapshot({})], () => (creates += 1)),
      undefined,
      flat,
    );
    await expect(
      runner.startPanel({ ...PANEL_ARGS, members: ['gemini', 'perplexity', 'openai'] }),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    expect(creates).toBe(0);
    expect((await runner.budget()).committedUsd).toBe(0);
    expect(await store.listRuns()).toHaveLength(0);
    await expect(
      runner.startPanel({ ...PANEL_ARGS, members: ['gemini', 'perplexity', 'openai'] }),
    ).rejects.toThrow(/reserves \$6\.00 in full before any member starts/);
  });

  it('PANEL-11: and still starts a panel that fits exactly', async () => {
    const runner = new Runner(store, { ...config, budgetUsd: 6 }, () => scriptedClient([snapshot({})]), undefined, flat);
    const result = await runner.startPanel({ ...PANEL_ARGS, members: ['gemini', 'perplexity', 'openai'] });
    expect(result.started).toHaveLength(3);
  });

  it('PANEL-12: refuses a panel wider than the concurrency cap, whole', async () => {
    let creates = 0;
    const runner = new Runner(
      store,
      { ...config, maxConcurrent: 2 },
      () => scriptedClient([snapshot({})], () => (creates += 1)),
      undefined,
      flat,
    );
    await expect(
      runner.startPanel({ ...PANEL_ARGS, members: ['gemini', 'perplexity', 'openai'] }),
    ).rejects.toBeInstanceOf(ConcurrencyExceededError);
    expect(creates).toBe(0);
    expect(await store.listRuns()).toHaveLength(0);
  });

  /** What a CLI member costs: nothing metered, and a band all the same. */
  const free = (): CostBand => ({ lowUsd: 0, highUsd: 0, midUsd: 0, basis: 'subscription' });
  const CLI_PANEL = ['local-claude', 'local-codex', 'local-grok'] as const;

  // PANEL-22. The fingerprint carries the provider, so three CLIs answering one
  // question are three purchases and not one deduped onto the other two. Worth
  // asserting rather than assuming: the same brief, shaped the same way, hashes
  // identically apart from that one field, and this is exactly the collapse that
  // once made `research_compare` diff a report against itself.
  it('PANEL-22: three CLIs on one question are three runs, three fingerprints, three ledger lines', async () => {
    const client = scriptedClient([snapshot({})]);
    const runner = new Runner(store, config, () => client, undefined, free);
    const result = await runner.startPanel({ ...PANEL_ARGS, members: [...CLI_PANEL] });

    expect(result.started).toHaveLength(3);
    expect(result.started.some((s) => s.deduped)).toBe(false);
    expect(new Set(result.started.map((s) => s.run.fingerprint)).size).toBe(3);
    expect(client.created).toHaveLength(3);

    // Three lines at $0. The ledger is the record of what ran, not only of what
    // cost money, so a free member that wrote nothing would be a panel with a
    // hole in its history.
    const ledger = await store.readLedger();
    expect(ledger).toHaveLength(3);
    expect(ledger.map((e) => e.provider).sort()).toEqual([...CLI_PANEL].sort());
    for (const e of ledger) expect(e.estimatedCostUsd).toBe(0);
    expect(result.reservedUsd).toBe(0);
    expect((await runner.budget()).committedUsd).toBe(0);
  });

  // PANEL-23. A free lane wide enough on its own to exceed the cap is now the
  // common shape, not an edge case, so the whole-panel refusal has to hold when
  // nothing on the panel costs anything. The budget gate cannot catch this one:
  // at $0 there is nothing to refuse on price.
  it('PANEL-23: refuses a free panel wider than the concurrency cap, whole', async () => {
    let creates = 0;
    const runner = new Runner(
      store,
      { ...config, maxConcurrent: 2 },
      () => scriptedClient([snapshot({})], () => (creates += 1)),
      undefined,
      free,
    );
    await expect(runner.startPanel({ ...PANEL_ARGS, members: [...CLI_PANEL] })).rejects.toBeInstanceOf(
      ConcurrencyExceededError,
    );
    expect(creates).toBe(0);
    expect(await store.listRuns()).toHaveLength(0);
    // Nothing reserved either, so a refused panel does not eat the ceiling.
    expect((await runner.budget()).committedUsd).toBe(0);
    await expect(runner.startPanel({ ...PANEL_ARGS, members: [...CLI_PANEL] })).rejects.toThrow(
      /A panel of 3 needs 3 slots at once/,
    );
  });

  // PANEL-24. The ordinary panel on the machine this was built for. It has to
  // fit under the *shipped* default rather than a number a test picked, so this
  // deliberately does not override `maxConcurrent`.
  it('PANEL-24: admits three free members plus two paid ones on the shipped default', async () => {
    const shipped = loadConfig({ DOSSIER_HERMETIC: '1' });
    expect(shipped.maxConcurrent, 'the shipped cap has to clear the ordinary panel').toBeGreaterThanOrEqual(5);

    const runner = new Runner(
      store,
      { ...shipped, storeDir: dir, budgetUsd: 100 },
      () => scriptedClient([snapshot({})]),
      undefined,
      (p) => (p.startsWith('local-') ? free() : flat()),
    );
    const result = await runner.startPanel({
      ...PANEL_ARGS,
      members: [...CLI_PANEL, 'gemini', 'perplexity'],
    });

    expect(result.started).toHaveLength(5);
    expect(result.failed).toHaveLength(0);
    // Only the paid half reserves anything, and it reserves at the top of its band.
    expect(result.reservedUsd).toBe(4);
  });

  it('PANEL-14: a member that refuses at create time does not strand the rest', async () => {
    const runner = new Runner(
      store,
      config,
      (id) =>
        id === 'openai'
          ? {
              ...scriptedClient([snapshot({})]),
              async createRun() {
                throw new Error('openai said no');
              },
            }
          : scriptedClient([snapshot({})]),
      undefined,
      flat,
    );
    const result = await runner.startPanel({ ...PANEL_ARGS, members: ['gemini', 'perplexity', 'openai'] });

    expect(result.failed.map((f) => f.provider)).toEqual(['openai']);
    expect(result.failed[0]?.error).toMatch(/openai said no/);
    expect(result.started.filter((s) => s.run.state === 'running')).toHaveLength(2);
    const failedRun = (await store.listRuns()).find((r) => r.provider === 'openai');
    expect(failedRun?.state).toBe('failed');
  });

  it('PANEL-15: an identical existing run is reused, and the rest still start', async () => {
    const client = scriptedClient([snapshot({})]);
    const runner = new Runner(store, config, () => client, undefined, flat);
    const solo = await runner.start({ ...PANEL_ARGS, provider: 'gemini' });

    const result = await runner.startPanel({ ...PANEL_ARGS, members: ['gemini', 'perplexity'] });
    const reused = result.started.find((s) => s.deduped);
    expect(reused?.run.id).toBe(solo.run.id);
    expect(result.reservedUsd).toBe(2); // one new member, not two
    expect(client.created).toHaveLength(2); // the solo run, plus one new member
  });

  it('PANEL-19: an explicit provider still starts one run with no panel id', async () => {
    const runner = new Runner(store, config, () => scriptedClient([snapshot({})]), undefined, flat);
    const { run } = await runner.start({ ...PANEL_ARGS, provider: 'perplexity' });
    expect(run.panelId).toBeUndefined();
    expect(await store.listRuns()).toHaveLength(1);
  });

  it('never buys the same backend twice in one panel', async () => {
    const runner = new Runner(store, config, () => scriptedClient([snapshot({})]), undefined, flat);
    // Two identical members would compute one fingerprint twice and neither
    // copy would find the other, so both would be paid for.
    const result = await runner.startPanel({ ...PANEL_ARGS, members: ['gemini', 'gemini'] });
    expect(result.started).toHaveLength(1);
    expect(result.reservedUsd).toBe(2);
  });

  it('refuses an empty panel rather than starting nothing quietly', async () => {
    const runner = new Runner(store, config, () => scriptedClient([snapshot({})]), undefined, flat);
    await expect(runner.startPanel({ ...PANEL_ARGS, members: [] })).rejects.toThrow(/at least one member/);
  });

  it('refuses to start a panel it cannot start in full', async () => {
    const runner = new Runner(
      store,
      config,
      (id) => (id === 'openai' ? null : scriptedClient([snapshot({})])),
      undefined,
      flat,
    );
    await expect(
      runner.startPanel({ ...PANEL_ARGS, members: ['gemini', 'openai'] }),
    ).rejects.toThrow(/cannot be started in full/);
    expect(await store.listRuns()).toHaveLength(0);
  });

  it('PANEL-16: merges the panel automatically once every member is terminal', async () => {
    const report = (host: string): string =>
      `# Findings\n\nThe market leader is Acme ([source](https://${host}/report)).\n`;
    const runner = new Runner(
      store,
      config,
      (id) =>
        scriptedClient([
          snapshot({
            status: 'completed',
            markdown: report(id === 'gemini' ? 'alpha.example' : 'beta.example'),
          }),
        ]),
      undefined,
      flat,
    );
    const result = await runner.startPanel({ ...PANEL_ARGS, members: ['gemini', 'perplexity'] });
    await runner.tick();

    for (const s of result.started) {
      const journal = await store.readJournal(s.run.id);
      const merge = journal.filter((e) => e.message.startsWith('Panel merge:'));
      // Written once per member, and once only: a restart mid-panel must not
      // append a second copy.
      expect(merge, s.run.provider).toHaveLength(1);
      expect(merge[0]?.message).toMatch(/independent/i);
    }
    await runner.tick();
    const again = await store.readJournal(result.started[0]!.run.id);
    expect(again.filter((e) => e.message.startsWith('Panel merge:'))).toHaveLength(1);
  });

  it('PANEL-16: counts support in domains, so two members reading one site is one source', async () => {
    const same = '# Findings\n\nAcme leads ([source](https://one.example/a)).\n';
    const runner = new Runner(store, config, () => scriptedClient([snapshot({ status: 'completed', markdown: same })]), undefined, flat);
    const result = await runner.startPanel({ ...PANEL_ARGS, members: ['gemini', 'perplexity'] });
    await runner.tick();

    const journal = await store.readJournal(result.started[0]!.run.id);
    const merge = journal.find((e) => e.message.startsWith('Panel merge:'));
    expect(merge?.message).toMatch(/1 independent domain/);
    // Two backends agreeing off one page is the corroboration trap, and the
    // operator is told at the moment the panel finishes rather than never.
    expect(merge?.message).toMatch(/overlap|WARNING/i);
  });
});
