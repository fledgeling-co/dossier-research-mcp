import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { decodeFilters, encodeFilters, perplexityProvider } from '../src/providers/perplexity.js';
import { extractCitedUrls } from '../src/research/report.js';
import { decodeXaiOptions, encodeXaiOptions } from '../src/providers/xai.js';
import { decodeOpenAiOptions, encodeOpenAiOptions } from '../src/providers/openai.js';
import { describeShaping, shapeRequest } from '../src/providers/options.js';

const withKeys = (env: Record<string, string>) =>
  new ProviderRegistry(loadConfig({ DOSSIER_STORE_DIR: '/tmp/x', ...env }), () => null);

describe('provider detection', () => {
  it('reports every backend, configured or not, so a gap is visible', () => {
    const r = withKeys({ GEMINI_API_KEY: 'g' });
    expect(r.list().map((p) => p.id)).toEqual(['gemini', 'perplexity', 'openai', 'xai', 'local']);
    expect(r.available().map((p) => p.id)).toEqual(['gemini']);
    // The "could be on" case names the variable that would enable it.
    expect(r.get('xai')?.detect().fix).toMatch(/XAI_API_KEY/);
  });

  it('keeps the local CLI backend out of automatic selection', () => {
    // It costs $0, so a cost tie-break would pick it every time — over a
    // subscription quota Dossier cannot meter, by running a third-party binary.
    // Visible everywhere, chosen nowhere, unless an operator asks for it.
    const r = withKeys({ GEMINI_API_KEY: 'g' });
    expect(r.list().map((p) => p.id)).toContain('local');
    expect(r.available().map((p) => p.id)).not.toContain('local');
    // Still reachable by name, which is the whole point of the exclusion.
    expect(r.get('local')).not.toBeNull();
    const opted = withKeys({ GEMINI_API_KEY: 'g', DOSSIER_PROVIDERS: 'gemini,local' });
    expect(opted.list().map((p) => p.id)).toContain('local');
  });

  it('never reports a key it cannot see as configured', () => {
    const r = withKeys({});
    expect(r.available()).toHaveLength(0);
    // Scoped to the key-based backends. `local` is detected from a binary on
    // PATH rather than a key, so asserting over it here would make this test
    // pass or fail depending on whether the developer has Claude Code
    // installed — and a machine-dependent assertion is worse than no assertion.
    for (const p of r.list().filter((x) => x.id !== 'local')) {
      expect(p.detect().state, p.id).toBe('not-configured');
    }
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
  const all = { GEMINI_API_KEY: 'g', PERPLEXITY_API_KEY: 'p', OPENAI_API_KEY: 'o', XAI_API_KEY: 'x' };
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
  const all = { GEMINI_API_KEY: 'g', PERPLEXITY_API_KEY: 'p', OPENAI_API_KEY: 'o', XAI_API_KEY: 'x' };

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
    expect(decodeXaiOptions(shapeRequest('xai', brief, { window: '7d' }).prompt).opts.fromDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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
