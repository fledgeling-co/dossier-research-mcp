import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { CLI_IDS } from '../src/local/cli.js';
import { AmbiguousSpendError } from '../src/net/retry.js';
import { ProviderRegistry, routeAmong } from '../src/providers/registry.js';
import { isLoopProviderId, isLocalProviderId } from '../src/providers/types.js';
import type {
  Capabilities,
  CredentialStatus,
  ProviderId,
  ResearchProvider,
} from '../src/providers/types.js';
import { decodeFilters, encodeFilters, perplexityProvider } from '../src/providers/perplexity.js';
import { extractCitedUrls } from '../src/research/report.js';
import { decodeXaiOptions, encodeXaiOptions, xaiProvider } from '../src/providers/xai.js';
import { decodeOpenAiOptions, encodeOpenAiOptions, openAiProvider } from '../src/providers/openai.js';
import { describeShaping, shapeRequest } from '../src/providers/options.js';

const withKeys = (env: Record<string, string>) =>
  new ProviderRegistry(loadConfig({ DOSSIER_STORE_DIR: '/tmp/x', ...env }), () => null);

/** Backends detected from a key, as opposed to from a binary on PATH. */
// Both CLI families are excluded for one reason: they are detected from a
// binary on PATH, so an assertion over them passes or fails on what the
// developer happens to have installed.
const keyed = (ids: readonly ProviderId[]): ProviderId[] =>
  ids.filter((id) => !isLocalProviderId(id) && !isLoopProviderId(id));

describe('provider detection', () => {
  it('reports every backend, configured or not, so a gap is visible', () => {
    const r = withKeys({ GEMINI_API_KEY: 'g' });
    expect(keyed(r.list().map((p) => p.id))).toEqual(['gemini', 'perplexity', 'openai', 'xai']);
    // The CLI backends are filtered out of the availability assertion because
    // they are detected from a binary on PATH, so including them would make
    // this pass or fail depending on what the developer has installed.
    expect(keyed(r.available().map((p) => p.id))).toEqual(['gemini']);
    // The "could be on" case names the variable that would enable it.
    expect(r.get('xai')?.detect().fix).toMatch(/XAI_API_KEY/);
  });

  // CLI-16. One backend per CLI, derived from the adapter table rather than
  // written out again, so adding a CLI adds a backend and no list falls behind.
  it('gives every CLI in the adapter table its own backend', () => {
    const r = withKeys({ GEMINI_API_KEY: 'g' });
    const ids = r.list().map((p) => p.id);
    for (const cli of CLI_IDS) expect(ids, cli).toContain(`local-${cli}`);
    expect(ids.filter((id) => isLocalProviderId(id))).toHaveLength(CLI_IDS.length);
    // Strongest first, so the free lane leads with it.
    expect(ids.find((id) => isLocalProviderId(id))).toBe('local-claude');
  });

  // CLI-20, the registry half. Runs recorded before the split carry `local`, and
  // refresh, approve and cancel all resolve a client from the id on the record,
  // so the id has to keep resolving even though nothing answers to it any more.
  // The store half, that such a record still parses, is in `runner.test.ts`.
  it('still resolves the legacy `local` id to a working backend', () => {
    const r = withKeys({ GEMINI_API_KEY: 'g' });
    expect(r.list().map((p) => p.id)).not.toContain('local');
    expect(r.get('local')?.id).toBe('local-claude');
  });

  it('never reports a key it cannot see as configured', () => {
    const r = withKeys({});
    expect(keyed(r.available().map((p) => p.id))).toHaveLength(0);
    // Scoped to the key-based backends. A CLI is detected from a binary on
    // PATH rather than a key, so asserting over one here would make this test
    // pass or fail depending on whether the developer has Claude Code
    // installed, and a machine-dependent assertion is worse than no assertion.
    for (const p of r.list().filter((x) => !isLocalProviderId(x.id) && !isLoopProviderId(x.id))) {
      expect(p.detect().state, p.id).toBe('not-configured');
    }
  });

  it('pairs every CLI with a loop backend, so the method can be measured against it', () => {
    // The pairing is what makes the comparison worth anything: `loop-claude`
    // and `local-claude` are one binary, one subscription and one web search,
    // differing only in whether Dossier's own method sits in between. A CLI
    // with no loop twin is a backend whose method contribution cannot be
    // measured at all, so this is derived from the adapter table rather than
    // written out, exactly as CLI-16 above is.
    const ids = withKeys({ GEMINI_API_KEY: 'g' }).list().map((p) => p.id);
    for (const cli of CLI_IDS) expect(ids, cli).toContain(`loop-${cli}`);
    expect(ids.filter((id) => isLoopProviderId(id))).toHaveLength(CLI_IDS.length);
  });

  it('reports the loop backend as costing nothing, like the CLI it drives', () => {
    // It spawns the CLI several times rather than once, so the temptation is to
    // price it higher. There is no API charge either way: what it spends more of
    // is subscription quota, which Dossier cannot see or meter, and inventing a
    // dollar figure for it would put a number on the ledger that no invoice
    // will ever match.
    const r = withKeys({});
    const est = r.get('loop-claude')?.estimate({ tier: 'fast' });
    expect(est?.cost.highUsd).toBe(0);
    expect(est?.cost.basis).toMatch(/subscription/);
  });

  it('honours an explicit allow-list over mere key presence', () => {
    // A key in the environment for some other tool must not silently become a
    // place Dossier can spend money.
    const r = withKeys({ GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o', DOSSIER_PROVIDERS: 'gemini' });
    expect(r.available().map((p) => p.id)).toEqual(['gemini']);
  });

  it('reports nothing as configured in hermetic mode', () => {
    const r = withKeys({ GEMINI_API_KEY: 'g', PERPLEXITY_API_KEY: 'p', DOSSIER_HERMETIC: '1' });
    expect(r.available()).toHaveLength(0);
  });
});

describe('routing is capability-first, not price-first', () => {
  // The allow-list pins the set to the four API backends. Without it a signed-in
  // CLI on the developer's PATH joins the routing pool and these assertions
  // become machine-dependent; the CLI preference has its own suite below.
  const all = {
    GEMINI_API_KEY: 'g',
    PERPLEXITY_API_KEY: 'p',
    OPENAI_API_KEY: 'o',
    XAI_API_KEY: 'x',
    DOSSIER_PROVIDERS: 'gemini,perplexity,openai,xai',
  };
  const input = { tier: 'fast' as const, tools: ['google_search'] };

  it('eliminates backends that cannot do the job before comparing cost', () => {
    // xAI is the cheapest of the four, and irrelevant if you need a plan.
    const d = withKeys(all).route({ planReview: true, estimateInput: input });
    expect(d.provider?.id).toBe('gemini');
    expect(d.rejected.map((r) => r.id)).toContain('xai');
    expect(d.rejected.find((r) => r.id === 'xai')?.why).toMatch(/editable plan/);
  });

  it('routes X questions to the only backend that reaches X', () => {
    const d = withKeys(all).route({ social: ['x'], estimateInput: input });
    expect(d.provider?.id).toBe('xai');
    expect(d.reason).toMatch(/only backend that reaches x/i);
  });

  it('routes a date window away from backends that can only ask for one', () => {
    const d = withKeys(all).route({ dateWindow: true, estimateInput: input });
    expect(['perplexity', 'xai']).toContain(d.provider?.id);
    expect(d.rejected.find((r) => r.id === 'gemini')?.why).toMatch(/date window/);
  });

  it('picks by domain-filter capacity when the allow-list is large', () => {
    const d = withKeys(all).route({ domains: 60, estimateInput: input });
    // Perplexity caps at 20 and xAI at 5; only OpenAI takes 60.
    expect(d.provider?.id).toBe('openai');
    expect(d.rejected.find((r) => r.id === 'perplexity')?.why).toMatch(/caps domain filters at 20/);
  });

  it('routes wide research to the backend with a native wide mode', () => {
    const d = withKeys(all).route({ shape: 'wide', estimateInput: input });
    expect(d.provider?.id).toBe('perplexity');
  });

  it('says so plainly when nothing configured can do the job', () => {
    const d = withKeys({ GEMINI_API_KEY: 'g' }).route({ social: ['x'], estimateInput: input });
    expect(d.provider).toBeNull();
    expect(d.reason).toMatch(/No configured provider can do this/);
  });

  it('always names a runner-up and the reasoning, so the choice is checkable', () => {
    const d = withKeys(all).route({ shape: 'deep', estimateInput: input });
    expect(d.provider).not.toBeNull();
    expect(d.runnerUp).not.toBeNull();
    expect(d.reason.length).toBeGreaterThan(20);
  });
});

describe('provider options survive the provider-neutral prompt field', () => {
  it('round-trips Perplexity filters without disturbing the prompt', () => {
    const encoded = encodeFilters('the brief', { recency: 'month', domains: ['a.com'], wide: true });
    const { prompt, filters } = decodeFilters(encoded);
    expect(prompt).toBe('the brief');
    expect(filters.recency).toBe('month');
    expect(filters.wide).toBe(true);
  });

  it('round-trips xAI and OpenAI options', () => {
    const x = decodeXaiOptions(encodeXaiOptions('q', { searchX: true, fromDate: '2026-01-01' }));
    expect(x.prompt).toBe('q');
    expect(x.opts.searchX).toBe(true);
    const o = decodeOpenAiOptions(encodeOpenAiOptions('q', { maxToolCalls: 40 }));
    expect(o.opts.maxToolCalls).toBe(40);
  });

  it('leaves a prompt with no options completely untouched', () => {
    expect(encodeFilters('plain', {})).toBe('plain');
    expect(decodeFilters('plain').prompt).toBe('plain');
  });

  it('does not corrupt the prompt when the marker payload is damaged', () => {
    const broken = 'the brief\n\n<!--dossier:perplexity {not json-->';
    expect(decodeFilters(broken).prompt).toBe(broken);
    expect(decodeFilters(broken).filters).toEqual({});
  });
});

describe('capability records are honest about the trade-offs', () => {
  // The allow-list pins the set to the four API backends. Without it a signed-in
  // CLI on the developer's PATH joins the routing pool and these assertions
  // become machine-dependent; the CLI preference has its own suite below.
  const all = {
    GEMINI_API_KEY: 'g',
    PERPLEXITY_API_KEY: 'p',
    OPENAI_API_KEY: 'o',
    XAI_API_KEY: 'x',
    DOSSIER_PROVIDERS: 'gemini,perplexity,openai,xai',
  };

  it('names limitations on every backend, including the default one', () => {
    for (const p of withKeys(all).list()) {
      expect(p.capabilities.limitations.length, p.id).toBeGreaterThan(0);
    }
  });

  it('records that only Gemini has plan review and only xAI has X', () => {
    const r = withKeys(all);
    const planReview = r.list().filter((p) => p.capabilities.planReview).map((p) => p.id);
    const social = r.list().filter((p) => p.capabilities.socialSources.includes('x')).map((p) => p.id);
    expect(planReview).toEqual(['gemini']);
    expect(social).toEqual(['xai']);
  });

  it('does not repeat the retired deep-research models structured-output limit', () => {
    // `o3-deep-research` could not be schema-forced; `gpt-5.6-sol` can. A
    // matrix keyed on the provider name rather than the model went stale.
    expect(withKeys(all).get('openai')?.capabilities.structuredOutput).toBe(true);
  });
});

describe('request shaping tells the truth about what is enforced', () => {
  const brief = '<role>x</role>\n\n<core_directive>Answer this decisively: what?</core_directive>';

  it('reports a Gemini window as requested, never as enforced', () => {
    // The distinction the whole layer exists for. Gemini has no date filter, so
    // a window there is a sentence in a prompt and must be labelled one.
    const s = shapeRequest('gemini', brief, { window: '30d' });
    expect(s.enforced).toEqual([]);
    expect(s.requested.join(' ')).toMatch(/within the last 30d/);
    expect(s.prompt).toContain('<search_constraints>');
  });

  it('keeps the prose constraint BEFORE the closing directive', () => {
    // Appending after the final `<core_directive>` shipped once and made the
    // instruction invisible to the model. The re-anchor only works when last.
    const s = shapeRequest('gemini', brief, { window: '7d' });
    const constraints = s.prompt.indexOf('<search_constraints>');
    const anchor = s.prompt.lastIndexOf('<core_directive>');
    expect(constraints).toBeGreaterThan(-1);
    expect(constraints).toBeLessThan(anchor);
  });

  it('calls a bucket that merely contains the window a request, not enforcement', () => {
    // 90 days has no Perplexity bucket. Filtering at a year is a pre-filter
    // plus a hope; calling it enforced would overstate the guarantee.
    const s = shapeRequest('perplexity', brief, { window: '90d' });
    expect(s.enforced.join(' ')).toContain('year');
    expect(s.requested.join(' ')).toMatch(/within the last 90d/);
    // An exact bucket IS enforcement and carries no prose fallback.
    const exact = shapeRequest('perplexity', brief, { window: '30d' });
    expect(exact.enforced.join(' ')).toContain('month');
    expect(exact.requested).toEqual([]);
  });

  it('trims domains to each backend’s cap and puts the remainder in the prompt', () => {
    // Sending 20 domains to xAI is an API error, and silently dropping them
    // would widen a search the caller deliberately narrowed.
    const domains = Array.from({ length: 8 }, (_, i) => `site${String(i)}.com`);
    const s = shapeRequest('xai', brief, { domains });
    expect(s.enforced.join(' ')).toContain('5 of 8');
    expect(s.dropped.join(' ')).toMatch(/3 domain\(s\) past xai's cap of 5/);
    expect(s.requested.join(' ')).toContain('site5.com');
  });

  it('encodes each backend’s own dialect', () => {
    expect(decodeFilters(shapeRequest('perplexity', brief, { shape: 'wide' }).prompt).filters.wide).toBe(true);
    // The from-date rides on `x_search`, so it is only sent when X is searched.
    expect(
      decodeXaiOptions(shapeRequest('xai', brief, { window: '7d', searchX: true }).prompt).opts.fromDate,
    ).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(decodeOpenAiOptions(shapeRequest('openai', brief, { maxToolCalls: 40 }).prompt).opts.maxToolCalls).toBe(40);
  });

  it('describes the split in words a caller can act on', () => {
    const lines = describeShaping(shapeRequest('openai', brief, { window: '1y', domains: ['a.com'] }));
    expect(lines.join('\n')).toMatch(/Enforced by the backend/);
    expect(lines.join('\n')).toMatch(/prompt only/);
  });
});

describe('the Perplexity response shape, as the live API actually returns it', () => {
  /** Trimmed from a real completed async Sonar job, 25 July 2026. */
  const liveShape = {
    id: '9565d5cf-e7ad-481e-9152-31ab5e428053',
    // Upper case, against the lower-case values the docs list.
    status: 'COMPLETED',
    response: {
      choices: [{ message: { role: 'assistant', content: '# A report\n\nProse with no links in it at all.' } }],
      citations: ['https://github.com/qdrant/qdrant/releases', 'https://qdrant.tech/documentation/'],
      search_results: [
        { title: 'Releases · qdrant/qdrant', url: 'https://github.com/qdrant/qdrant/releases', date: '2026-07-17' },
        { title: 'Qdrant docs', url: 'https://qdrant.tech/documentation/', date: null },
      ],
      usage: { cost: { total_cost: 0.29103 } },
    },
  };

  it('recognises an upper-case terminal status', async () => {
    // The bug this locks down: a case-sensitive comparison meant a finished run
    // was never seen as finished, so it polled until the stall watchdog gave up
    // and the report somebody had already paid for was never stored.
    const client = perplexityProvider(
      loadConfig({ DOSSIER_STORE_DIR: '/tmp/x', PERPLEXITY_API_KEY: 'k' }),
    ).client();
    const snapshot = await parseWith(client, liveShape);
    expect(snapshot.status).toBe('completed');
  });

  it('brings the out-of-band citations into the report text', async () => {
    // Perplexity puts every source in a sibling array and none in the markdown.
    // Everything downstream reads the markdown, so a cited report looked
    // uncited: zero sources recorded, nothing to verify, an empty profile.
    const client = perplexityProvider(
      loadConfig({ DOSSIER_STORE_DIR: '/tmp/x', PERPLEXITY_API_KEY: 'k' }),
    ).client();
    const snapshot = await parseWith(client, liveShape);
    expect(snapshot.markdown).toContain('## Sources');
    expect(extractCitedUrls(snapshot.markdown)).toEqual([
      'https://github.com/qdrant/qdrant/releases',
      'https://qdrant.tech/documentation/',
    ]);
    // The title and date ride along, because a bare URL list is harder to read.
    expect(snapshot.markdown).toContain('[Releases · qdrant/qdrant]');
    expect(snapshot.markdown).toContain('(2026-07-17)');
  });
});

/** Drive `getRun`'s parse against a fixed payload, without a network. */
async function parseWith(
  client: { getRun: (id: string) => Promise<{ status: string; markdown: string }> },
  payload: unknown,
): Promise<{ status: string; markdown: string }> {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    return await client.getRun('9565d5cf-e7ad-481e-9152-31ab5e428053');
  } finally {
    globalThis.fetch = original;
  }
}

describe('no adapter trusts the case of a status string', () => {
  // Perplexity documents lower case and returns `COMPLETED`. Once one API does
  // that, assuming any of them will not is a choice rather than an oversight,
  // and the failure is silent: a finished run polls until the watchdog gives up
  // and the paid-for report is never stored.
  const config = loadConfig({
    DOSSIER_STORE_DIR: '/tmp/x',
    PERPLEXITY_API_KEY: 'k',
    OPENAI_API_KEY: 'k',
    XAI_API_KEY: 'k',
  });

  it.each([
    ['perplexity', perplexityProvider(config).client(), { status: 'COMPLETED', response: { choices: [{ message: { content: 'done' } }] } }],
    ['openai', openAiProvider(config).client(), { status: 'Completed', output_text: 'done' }],
    ['xai', xaiProvider(config).client(), { status: 'COMPLETED', output_text: 'done' }],
  ])('%s treats a shouted terminal status as terminal', async (_name, client, payload) => {
    const snapshot = await parseWith(client, payload);
    expect(snapshot.status).toBe('completed');
  });
});

describe('a paid create is attempted exactly once', () => {
  /**
   * The guarantee this product exists to make. A create that times out after
   * the provider accepted it has already bought a report; retrying buys a
   * second one, while Dossier reserves for one and tracks only the last id.
   * One is a support question, the other is a refund request.
   */
  const config = loadConfig({
    DOSSIER_STORE_DIR: '/tmp/x',
    PERPLEXITY_API_KEY: 'k',
    OPENAI_API_KEY: 'k',
    XAI_API_KEY: 'k',
  });

  const createArgs = {
    prompt: 'q',
    tier: 'fast' as const,
    collaborativePlanning: false,
    thinkingSummaries: false,
    visualization: false,
    tools: [],
  };

  /** Count how many times the wire was hit, and fail every attempt. */
  async function attempts(client: { createRun: (a: typeof createArgs) => Promise<unknown> }, failWith: () => Response | never) {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return failWith();
    };
    try {
      await client.createRun(createArgs).catch((e: unknown) => e);
      return calls;
    } finally {
      globalThis.fetch = original;
    }
  }

  const clients = () => [
    ['perplexity', perplexityProvider(config).client()] as const,
    ['openai', openAiProvider(config).client()] as const,
    ['xai', xaiProvider(config).client()] as const,
  ];

  it('does not retry a timeout, because the job may already exist', async () => {
    for (const [name, client] of clients()) {
      const calls = await attempts(client, () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      });
      expect(calls, `${name} retried a paid create`).toBe(1);
    }
  });

  it('does not retry a 5xx either', async () => {
    for (const [name, client] of clients()) {
      const calls = await attempts(client, () => new Response('upstream boom', { status: 503 }));
      expect(calls, `${name} retried a paid create on 5xx`).toBe(1);
    }
  });

  it('reports an unknown outcome as ambiguous spend, not as a plain failure', async () => {
    const client = perplexityProvider(config).client();
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('socket hang up');
    };
    try {
      const error = await client.createRun(createArgs).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AmbiguousSpendError);
      expect(String(error)).toMatch(/unknown whether a job was created/);
      expect(String(error)).toMatch(/NOT been retried/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('passes a 4xx straight through, since nothing was created', async () => {
    const client = perplexityProvider(config).client();
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response('bad request', { status: 400 });
    };
    try {
      const error = await client.createRun(createArgs).catch((e: unknown) => e);
      expect(calls).toBe(1);
      // The provider's own message, not an ambiguity warning: a rejected
      // request is a request the caller can fix.
      expect(error).not.toBeInstanceOf(AmbiguousSpendError);
      expect(String(error)).toMatch(/400/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('still retries READS, which are free and worth recovering', async () => {
    const client = perplexityProvider(config).client();
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return calls < 3
        ? new Response('flaky', { status: 503 })
        : new Response(JSON.stringify({ status: 'COMPLETED', response: { choices: [{ message: { content: 'ok' } }] } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
    };
    try {
      const snapshot = await client.getRun('some-id');
      expect(calls).toBeGreaterThan(1);
      expect(snapshot.status).toBe('completed');
    } finally {
      globalThis.fetch = original;
    }
  }, 30_000);
});

describe('decoded provider options are a trust boundary', () => {
  // The marker rides on the prompt, and a caller can send a pre-engineered
  // brief that ends in one. Casting the parsed JSON meant a brief ending
  // `<!--dossier:perplexity {"wide":true}-->` upgraded a deep purchase to a
  // wide one AFTER the smaller band had been reserved.
  it('refuses an injected wide flag smuggled through the prompt', () => {
    const injected = 'A perfectly normal brief.\n\n<!--dossier:perplexity {"wide":true,"recency":"day"}-->';
    // Decoding a marker Dossier itself wrote is fine; the point is that the
    // values are bounded, so anything outside the schema is dropped whole.
    const legit = decodeFilters(encodeFilters('brief', { wide: true, recency: 'day' }));
    expect(legit.filters.wide).toBe(true);
    // An unknown key fails the strict schema and the whole thing is discarded.
    const hostile = decodeFilters(`${injected.slice(0, injected.lastIndexOf('<!--'))}\n\n<!--dossier:perplexity {"wide":true,"evil":1}-->`);
    expect(hostile.filters).toEqual({});
  });

  it('caps an injected maxToolCalls rather than passing it to the bill', () => {
    const absurd = decodeOpenAiOptions('brief\n\n<!--dossier:openai {"maxToolCalls":999999}-->');
    expect(absurd.opts.maxToolCalls).toBeUndefined();
    const sane = decodeOpenAiOptions(encodeOpenAiOptions('brief', { maxToolCalls: 40 }));
    expect(sane.opts.maxToolCalls).toBe(40);
  });

  it('refuses a malformed xAI date rather than sending it', () => {
    const bad = decodeXaiOptions('brief\n\n<!--dossier:xai {"fromDate":"last tuesday"}-->');
    expect(bad.opts.fromDate).toBeUndefined();
    const good = decodeXaiOptions(encodeXaiOptions('brief', { fromDate: '2026-01-01' }));
    expect(good.opts.fromDate).toBe('2026-01-01');
  });
})

describe('enforcement is claimed only where the request carries it', () => {
  const brief = '<core_directive>Answer this decisively: what?</core_directive>';

  it('does not claim a date filter xAI applies only to X', () => {
    // `from_date` attaches to `x_search`, not to web search, so a window on a
    // web-only run is prose like anywhere else. Calling it enforced was true
    // for half the request and misleading for the half most runs use.
    const webOnly = shapeRequest('xai', brief, { window: '30d' });
    expect(webOnly.enforced.join(' ')).not.toMatch(/date window/);
    expect(webOnly.requested.join(' ')).toMatch(/within the last 30d/);

    const withX = shapeRequest('xai', brief, { window: '30d', searchX: true });
    expect(withX.enforced.join(' ')).toMatch(/date window on X search/);
    // And it still says the web half is unfiltered, rather than implying both.
    expect(withX.requested.join(' ')).toMatch(/covers X only/);
  });

  it('does not claim Sonar filters on a Perplexity wide run', () => {
    // Wide goes to the Agent API, whose body carries the preset and the prompt
    // and none of the Sonar search filters.
    const wide = shapeRequest('perplexity', brief, { window: '30d', domains: ['a.com'], shape: 'wide' });
    expect(wide.enforced).toEqual([]);
    expect(wide.requested.join(' ')).toMatch(/within the last 30d/);
    expect(wide.requested.join(' ')).toMatch(/a\.com/);

    // The deep path still enforces what it really sends.
    const deep = shapeRequest('perplexity', brief, { window: '30d', domains: ['a.com'] });
    expect(deep.enforced.join(' ')).toMatch(/recency filter: month/);
    expect(deep.enforced.join(' ')).toMatch(/domain filter/);
  });
});

describe('a Perplexity handle survives a restart', () => {
  const config = loadConfig({ DOSSIER_STORE_DIR: '/tmp/x', PERPLEXITY_API_KEY: 'k' });

  it('routes a wide handle to the Agent endpoint from a fresh process', async () => {
    // The endpoint kind lived in a process-local Map, so a restart forgot it:
    // a wide run's id was then polled against the Sonar endpoint, which knows
    // nothing about it, and could not be cancelled. Runs here outlive the
    // process by design, so the handle has to carry what polling needs.
    const created = perplexityProvider(config).client();
    const started = await withFetch(
      async () =>
        created.createRun({
          prompt: encodeFilters('build a matrix', { wide: true }),
          tier: 'fast',
          collaborativePlanning: false,
          thinkingSummaries: false,
          visualization: false,
          tools: [],
        }),
      () => new Response(JSON.stringify({ id: 'agent-123' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(started.interactionId).toBe('wide:agent-123');

    // A brand-new provider instance, exactly as a restarted server would build.
    const restarted = perplexityProvider(config).client();
    const paths: string[] = [];
    await withFetch(
      async () => restarted.getRun(started.interactionId),
      (url) => {
        paths.push(String(url));
        return new Response(JSON.stringify({ status: 'COMPLETED', output: [{ type: 'message', content: [{ text: 'done' }] }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );
    expect(paths[0]).toContain('/v1/agent/agent-123');
    expect(paths[0]).not.toContain('/async/chat/completions');
  });
});

/** Run `fn` with `fetch` replaced by `respond`, which sees the URL. */
async function withFetch<T>(fn: () => Promise<T>, respond: (url: unknown) => Response): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = async (url: unknown) => respond(url);
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

describe('routing follows the documented tie-break order', () => {
  // docs/plan/multi-provider-research.md:245-248 — capability, then cost, then
  // dated accuracy as weak evidence, then diversity. Gemini used to win every
  // deep run outright, which made three configured backends unreachable without
  // naming them: four consecutive real runs all went to the dearest provider.
  it('sends an ordinary deep run to the cheapest capable backend, not Gemini', () => {
    const registry = withKeys({
      GEMINI_API_KEY: 'g',
      PERPLEXITY_API_KEY: 'p',
      XAI_API_KEY: 'x',
      DOSSIER_PROVIDERS: 'gemini,perplexity,xai',
    });
    const decision = registry.route({ shape: 'deep', estimateInput: { tier: 'fast', tools: [] } });
    expect(decision.provider?.id).not.toBe('gemini');
    expect(decision.reason).toMatch(/cheapest configured backend/);
    expect(decision.runnerUp).not.toBeNull();
  });

  it('still forces Gemini when the question needs an editable plan', () => {
    // Capability outranks cost. This is the case the old preference was really
    // for, and it was already handled by the eligibility filter.
    const registry = withKeys({ GEMINI_API_KEY: 'g', PERPLEXITY_API_KEY: 'p', XAI_API_KEY: 'x' });
    const decision = registry.route({ planReview: true, estimateInput: { tier: 'fast', tools: [] } });
    expect(decision.provider?.id).toBe('gemini');
    expect(decision.reason).toMatch(/only backend offering an editable plan/);
  });

  it('still forces xAI when the question needs X', () => {
    const registry = withKeys({ GEMINI_API_KEY: 'g', PERPLEXITY_API_KEY: 'p', XAI_API_KEY: 'x' });
    const decision = registry.route({ social: ['x'], estimateInput: { tier: 'fast', tools: [] } });
    expect(decision.provider?.id).toBe('xai');
  });

  it('names why each rejected backend could not run', () => {
    const registry = withKeys({ GEMINI_API_KEY: 'g', PERPLEXITY_API_KEY: 'p', XAI_API_KEY: 'x' });
    const decision = registry.route({ planReview: true, estimateInput: { tier: 'fast', tools: [] } });
    expect(decision.rejected.length).toBeGreaterThan(0);
    for (const r of decision.rejected) expect(r.why).toMatch(/no editable plan/);
  });
});

describe('a subscription already paid for beats a metered API balance', () => {
  // Scripted providers, not the real registry: the CLI backend is detected from
  // a binary on PATH, so building one from the environment would make these
  // assertions pass or fail depending on whether the developer has Claude Code
  // installed. `routeAmong` takes the set as an argument for exactly this.
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
      cost: { lowUsd: 0, highUsd, midUsd: highUsd / 2, basis: 'scripted' },
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
  const notSignedIn: CredentialStatus = { state: 'configured-unverified', detail: 'on PATH, no sign-in', signedIn: false };
  const apiKey: CredentialStatus = { state: 'configured-unverified', detail: 'key present' };

  const cli = (status: CredentialStatus): ResearchProvider =>
    provider('local', 0, caps({ billedTo: 'subscription' }), status);
  // Deliberately given every capability the CLI lacks, so any test where the
  // API backend wins is won on capability rather than on it being the only one
  // left standing.
  const paid = provider(
    'perplexity',
    4,
    caps({ shapes: ['deep', 'wide', 'recent'], dateFilter: 'range', domainFilter: 20, socialSources: ['x'] }),
    apiKey,
  );
  const input = { tier: 'fast' as const, tools: [] };

  it('prefers an installed, signed-in CLI over a paid backend for a job it can do', () => {
    const d = routeAmong([paid, cli(signedIn)], { shape: 'deep', estimateInput: input });
    expect(d.provider?.id).toBe('local');
    // The fallback that would really run is named, not a second free entry.
    expect(d.runnerUp?.id).toBe('perplexity');
  });

  it('does not prefer a CLI on PATH that nobody has signed into', () => {
    // A free run that fails is worse than a paid run that works, and the
    // sign-in check is the only thing standing between the two.
    const d = routeAmong([paid, cli(notSignedIn)], { shape: 'deep', estimateInput: input });
    expect(d.provider?.id).toBe('perplexity');
  });

  it('treats an unstated sign-in as not signed in, never as a pass', () => {
    const unstated: CredentialStatus = { state: 'configured-unverified', detail: 'on PATH' };
    const d = routeAmong([paid, cli(unstated)], { shape: 'deep', estimateInput: input });
    expect(d.provider?.id).toBe('perplexity');
  });

  it('lets capability outrank the preference on a date window, X, and a plan', () => {
    const withPlan = provider('gemini', 9, caps({ planReview: true }), apiKey);
    for (const need of [
      { dateWindow: true, estimateInput: input },
      { social: ['x'], estimateInput: input },
      { shape: 'recent' as const, estimateInput: input },
      { domains: 10, estimateInput: input },
    ]) {
      const d = routeAmong([paid, cli(signedIn)], need);
      expect(d.provider?.id, JSON.stringify(need)).toBe('perplexity');
    }
    const d = routeAmong([withPlan, cli(signedIn)], { planReview: true, estimateInput: input });
    expect(d.provider?.id).toBe('gemini');
  });

  it('says a subscription quota is being spent, and never says free', () => {
    const d = routeAmong([paid, cli(signedIn)], { shape: 'deep', estimateInput: input });
    expect(d.reason).toMatch(/subscription quota/i);
    expect(d.reason).toMatch(/rather than an API balance/i);
    expect(d.reason).toMatch(/cannot meter/i);
    expect(d.reason).not.toMatch(/\bfree\b/i);
  });

  it('is overridden in both directions by the operator allow-list', () => {
    // Omitting the CLIs from a non-empty DOSSIER_PROVIDERS keeps them out of the
    // registry entirely, so routing never sees them.
    const onlyApi = withKeys({ PERPLEXITY_API_KEY: 'p', DOSSIER_PROVIDERS: 'perplexity' });
    expect(onlyApi.list().filter((p) => isLocalProviderId(p.id))).toHaveLength(0);
    const onlyCli = withKeys({ PERPLEXITY_API_KEY: 'p', DOSSIER_PROVIDERS: 'local' });
    expect(keyed(onlyCli.list().map((p) => p.id))).toHaveLength(0);
  });

  // CLI-19. `local` was the only way to name a CLI before the split and is what
  // every wizard-written config already carries, so it has to keep meaning "the
  // CLIs" rather than quietly meaning none of them after an upgrade.
  it('accepts both the umbrella `local` id and an individual CLI id', () => {
    const umbrella = withKeys({ DOSSIER_PROVIDERS: 'local' });
    expect(new Set(umbrella.list().map((p) => p.id))).toEqual(new Set(CLI_IDS.map((id) => `local-${id}`)));
    const one = withKeys({ DOSSIER_PROVIDERS: 'local-codex' });
    expect(one.list().map((p) => p.id)).toEqual(['local-codex']);
    // And they compose, so an operator can widen a narrow list without knowing
    // which form the other half was written in.
    const both = withKeys({ PERPLEXITY_API_KEY: 'p', DOSSIER_PROVIDERS: 'perplexity,local-grok' });
    expect(both.list().map((p) => p.id)).toEqual(['perplexity', 'local-grok']);
  });
});
