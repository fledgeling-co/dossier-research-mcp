import { describe, expect, it } from 'vitest';
import { backendLimitations, loadConfig } from '../src/config.js';
import { toSnapshot } from '../src/gemini/types.js';
import { estimateCost, estimateDuration, formatDuration } from '../src/gemini/cost.js';
import { isPrivateAddress, safeFetch } from '../src/net/safe-fetch.js';
import { classify, pollDelayMs, retry, retryAfterMs } from '../src/net/retry.js';
import { scoreCitations } from '../src/research/citations.js';
import { normaliseCitations } from '../src/research/report.js';
import { buildPrompt } from '../src/research/prompt.js';
import { fingerprint, fingerprintMatches } from '../src/research/contract.js';
import { assertStoreName, inferMimeType } from '../src/corpus/files.js';

describe('SSRF guards', () => {
  it('blocks loopback, private, link-local and CGNAT ranges', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.5.4',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata — the one that matters most
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  /**
   * The bypass an external review found in the shipped v0.2.1 guard.
   *
   * `new URL('http://[::ffff:127.0.0.1]/').hostname` is `::ffff:7f00:1`: the
   * WHATWG parser canonicalises the embedded IPv4 to hex. The old check looked
   * for a *dotted* `::ffff:a.b.c.d` with a regex, matched nothing, and returned
   * false. So loopback and the cloud metadata endpoint were both reachable
   * through a URL a model could put in a citation. Byte-level checks now.
   */
  it('blocks IPv6 forms that the URL parser canonicalises away from dotted-quad', () => {
    for (const address of [
      '::ffff:7f00:1', // == ::ffff:127.0.0.1 after canonicalisation
      '::ffff:a9fe:a9fe', // == ::ffff:169.254.169.254, the metadata endpoint
      '::7f00:1', // IPv4-compatible, deprecated but still routable text
      '64:ff9b::7f00:1', // NAT64 wrapping 127.0.0.1
      '2002:7f00:1::', // 6to4 wrapping 127.0.0.1
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('blocks the whole fe80::/10 link-local range, not just the fe80 prefix', () => {
    // The old check was startsWith('fe80'), but link-local is a /10: fe80
    // through febf. fe90::1 and febf::1 were both allowed through.
    for (const address of ['fe80::1', 'fe90::1', 'fea0::1', 'febf::1']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    // fec0::/10 is deprecated site-local, outside the link-local range, and a
    // public v6 address starting with 'fe' must still resolve normally.
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false);
  });

  it('fails closed on anything that is not a recognisable IP', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
    expect(isPrivateAddress('')).toBe(true);
  });

  it('rejects non-http schemes and malformed URLs before any request', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toThrow(/Scheme not allowed/);
    await expect(safeFetch('javascript:alert(1)')).rejects.toThrow(/Scheme not allowed/);
    await expect(safeFetch('not a url at all')).rejects.toThrow(/Malformed URL/);
  });

  it('rejects a literal private host without touching the network', async () => {
    await expect(safeFetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /Private address blocked/,
    );
  });

  it('tags the refusal reason so a redirect loop is not confused with a bad URL', async () => {
    // Distinguishing these is what stops a bot-deterring site (which 302s an
    // unrecognised UA back to itself) being reported as a fabricated citation.
    await expect(safeFetch('file:///etc/passwd')).rejects.toMatchObject({ reason: 'scheme' });
    await expect(safeFetch('http://10.0.0.1/')).rejects.toMatchObject({ reason: 'private' });
    await expect(safeFetch('nonsense')).rejects.toMatchObject({ reason: 'malformed' });
  });
});

describe('citation verdicts for a self-redirecting host', () => {
  it('reports a redirect loop as blocked, not invalid_url', () => {
    // `invalid_url` feeds the "suspect" badge, which reads as "these citations
    // are probably fabricated". A live report tripped this on four real
    // milvus.io URLs.
    const card = scoreCitations([
      ...Array.from({ length: 25 }, (_, i) => ({ url: `u${i}`, verdict: 'live' as const, checkedAt: 'now' })),
      ...Array.from({ length: 5 }, (_, i) => ({ url: `b${i}`, verdict: 'blocked' as const, checkedAt: 'now' })),
    ]);
    expect(card.badge).toBe('partial');
    expect(card.invalid).toBe(0);
  });
});

describe('corpus store names', () => {
  it('accepts the documented resource form', () => {
    expect(assertStoreName('fileSearchStores/my-store-123a456b')).toBe('fileSearchStores/my-store-123a456b');
  });

  it('rejects path traversal and arbitrary strings', () => {
    for (const bad of ['../secrets', 'fileSearchStores/../../x', 'my-store', 'fileSearchStores/']) {
      expect(() => assertStoreName(bad), bad).toThrow(/Invalid file search store name/);
    }
  });
});

describe('contract fingerprint', () => {
  const base = {
    prompt: 'Answer this decisively: who leads?',
    tier: 'fast' as const,
    tools: [{ type: 'google_search' as const }],
    collaborativePlanning: false,
  };

  it('ignores cosmetic differences', () => {
    expect(fingerprint(base)).toBe(
      fingerprint({ ...base, prompt: '  Answer   this decisively:  WHO leads? ' }),
    );
  });

  it('changes when tier, tools, or planning change — those are real differences', () => {
    expect(fingerprint({ ...base, tier: 'max' })).not.toBe(fingerprint(base));
    expect(fingerprint({ ...base, collaborativePlanning: true })).not.toBe(fingerprint(base));
    expect(
      fingerprint({
        ...base,
        tools: [{ type: 'file_search', fileSearchStoreNames: ['fileSearchStores/a'] }],
      }),
    ).not.toBe(fingerprint(base));
  });

  it('is order-insensitive across tools', () => {
    const a = fingerprint({ ...base, tools: [{ type: 'google_search' }, { type: 'url_context' }] });
    const b = fingerprint({ ...base, tools: [{ type: 'url_context' }, { type: 'google_search' }] });
    expect(a).toBe(b);
  });

  it('ignores MCP auth headers so a rotated token does not fork the dedupe key', () => {
    const withToken = (token: string) =>
      fingerprint({
        ...base,
        tools: [
          { type: 'mcp_server', name: 'x', url: 'https://x.test/mcp', headers: { Authorization: token } },
        ],
      });
    expect(withToken('Bearer old')).toBe(withToken('Bearer new'));
  });

  it('compares safely against differing lengths', () => {
    expect(fingerprintMatches('abc', 'abc')).toBe(true);
    expect(fingerprintMatches('abc', 'abcd')).toBe(false);
    expect(fingerprintMatches('abc', 'abd')).toBe(false);
  });
});

describe('interaction parsing (trust boundary)', () => {
  it('joins every model_output chunk — a report arrives split across steps', () => {
    // The exact shape a completed live run returns. A real 32k report came
    // back as two model_output steps; taking only the last one dropped the
    // title and the entire Executive Summary.
    const snap = toSnapshot('int_1', {
      status: 'completed',
      steps: [
        { type: 'user_input', content: [{ type: 'text', text: '<role>the prompt</role>' }] },
        { type: 'thought', content: [{ type: 'text', text: 'planning the search' }] },
        { type: 'model_output', content: [{ type: 'text', text: '# Title\n\n## Executive Summary\n\n- finding' }] },
        { type: 'model_output', content: [{ type: 'text', text: '\n\n#### Detail\n\nbody' }] },
      ],
    });
    expect(snap.markdown).toBe('# Title\n\n## Executive Summary\n\n- finding\n\n#### Detail\n\nbody');
    expect(snap.markdown).not.toContain('the prompt');
    expect(snap.markdown).not.toContain('planning the search');
    expect(snap.thoughts).toEqual(['planning the search']);
  });

  it('reads reasoning from summary[], not content[] — a thought step has no content', () => {
    // Exact live shape: `{ type: 'thought', signature, summary: [{text, type}] }`.
    const snap = toSnapshot('int_1', {
      status: 'completed',
      steps: [
        { type: 'thought', signature: '', summary: [
          { type: 'text', text: '***Generating research plan***' },
          { type: 'text', text: '**Mapping Candidate Frameworks**' },
        ] },
        { type: 'model_output', content: [{ type: 'text', text: '# Report' }] },
      ],
    });
    expect(snap.thoughts).toEqual(['***Generating research plan***', '**Mapping Candidate Frameworks**']);
    expect(snap.markdown).toBe('# Report');
  });

  it('falls back to other output text if model_output is ever renamed', () => {
    const snap = toSnapshot('int_1', {
      status: 'completed',
      steps: [
        { type: 'user_input', content: [{ type: 'text', text: 'prompt' }] },
        { type: 'final_answer', content: [{ type: 'text', text: '# Report' }] },
      ],
    });
    expect(snap.markdown).toBe('# Report');
  });

  it('separates thought steps from output', () => {
    const snap = toSnapshot('int_1', {
      status: 'in_progress',
      steps: [
        { type: 'thought_summary', content: [{ type: 'text', text: 'considering sources' }] },
        { type: 'model_output', content: [{ type: 'text', text: 'partial' }] },
      ],
    });
    expect(snap.thoughts).toEqual(['considering sources']);
    expect(snap.markdown).toBe('partial');
  });

  it('collects images', () => {
    const snap = toSnapshot('int_1', {
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'image', data: 'AAA', mime_type: 'image/png' }] }],
    });
    expect(snap.images).toEqual([{ data: 'AAA', mimeType: 'image/png' }]);
  });

  it('surfaces an unrecognised status as `unknown`, not as still-working', () => {
    // It used to degrade to `in_progress`, so a provider renaming a terminal
    // state produced a run that polled forever while the paid job was over.
    // `unknown` maps to `stalled`, which the watchdog and the caller both see.
    expect(toSnapshot('int_1', { status: 'something_new' }).status).toBe('unknown');
    expect(toSnapshot('int_1', {}).status).toBe('unknown');
    // Recognised statuses are untouched.
    expect(toSnapshot('int_1', { status: 'completed' }).status).toBe('completed');
  });

  it('fails loudly on an unparseable payload instead of pretending it succeeded', () => {
    const snap = toSnapshot('int_1', 'not an object');
    expect(snap.status).toBe('failed');
    expect(snap.error).toContain('Unparseable');
  });
});

describe('citation scorecard', () => {
  const at = '2026-07-25T00:00:00.000Z';
  it('flags a report as suspect when too many citations do not resolve', () => {
    const card = scoreCitations([
      { url: 'a', verdict: 'live', checkedAt: at },
      { url: 'b', verdict: 'not_found', checkedAt: at },
      { url: 'c', verdict: 'invalid_url', checkedAt: at },
      { url: 'd', verdict: 'live', checkedAt: at },
    ]);
    expect(card.badge).toBe('suspect');
  });

  it('marks a clean report verified', () => {
    const card = scoreCitations(
      Array.from({ length: 10 }, (_, i) => ({ url: `u${i}`, verdict: 'live' as const, checkedAt: at })),
    );
    expect(card.badge).toBe('verified');
    expect(card.liveRate).toBe(1);
  });

  it('does not count a paywall as a fabrication', () => {
    const card = scoreCitations([
      ...Array.from({ length: 8 }, (_, i) => ({ url: `u${i}`, verdict: 'live' as const, checkedAt: at })),
      { url: 'p1', verdict: 'blocked', checkedAt: at },
      { url: 'p2', verdict: 'blocked', checkedAt: at },
    ]);
    expect(card.badge).toBe('partial');
  });
});

describe('config', () => {
  it('prefers Vertex when a project is set, even alongside an API key', () => {
    const config = loadConfig({ GEMINI_API_KEY: 'k', VERTEX_PROJECT: 'p' });
    expect(config.auth.mode).toBe('vertex');
  });

  it('treats an empty string as unset (a present-but-empty .env key)', () => {
    const config = loadConfig({ GEMINI_API_KEY: '', DOSSIER_BUDGET_USD: '' });
    expect(config.auth.mode).toBe('none');
    expect(config.budgetUsd).toBe(100);
  });

  it('rejects an out-of-range numeric rather than silently clamping', () => {
    expect(() => loadConfig({ DOSSIER_BUDGET_USD: '-5' })).toThrow(/Invalid environment/);
  });

  it('parses the HTTP token list', () => {
    expect(loadConfig({ DOSSIER_HTTP_TOKENS: 'a, b ,,c' }).httpTokens).toEqual(['a', 'b', 'c']);
  });
});

describe('corpus mime inference', () => {
  it('maps the documentation types the SDK cannot infer', () => {
    expect(inferMimeType('/docs/README.md')).toBe('text/markdown');
    expect(inferMimeType('/docs/spec.MARKDOWN')).toBe('text/markdown');
    expect(inferMimeType('/x/report.pdf')).toBe('application/pdf');
    expect(inferMimeType('/x/data.csv')).toBe('text/csv');
  });

  it('falls back to text/plain rather than letting the SDK throw', () => {
    // The live SDK throws "Can not determine mimeType" on an unknown extension,
    // which failed every .md upload before this fallback existed.
    expect(inferMimeType('/x/NOTES')).toBe('text/plain');
    expect(inferMimeType('/x/file.weird')).toBe('text/plain');
  });
});

describe('user_input echo (observed live-API behaviour)', () => {
  it('never treats the echoed prompt as the report', () => {
    // Mid-flight, the live API returns exactly this: the submitted prompt
    // echoed back as a `user_input` step, and nothing else yet.
    const snap = toSnapshot('int_1', {
      status: 'in_progress',
      steps: [{ type: 'user_input', content: [{ type: 'text', text: '<core_directive>my prompt</core_directive>' }] }],
    });
    expect(snap.markdown).toBe('');
  });

  it('picks the model output even when the echo is present', () => {
    const snap = toSnapshot('int_1', {
      status: 'completed',
      steps: [
        { type: 'user_input', content: [{ type: 'text', text: 'my prompt' }] },
        { type: 'model_output', content: [{ type: 'text', text: '# The report' }] },
      ],
    });
    expect(snap.markdown).toBe('# The report');
  });
});

describe('backend limitations', () => {
  it('reports nothing for an API key, which is the full-capability backend', () => {
    expect(backendLimitations(loadConfig({ GEMINI_API_KEY: 'k' }))).toEqual([]);
  });

  it('names every Vertex gap, not just File Search', () => {
    // The docs used to claim File Search was the only Vertex trade-off. It is
    // not: the Interactions API on Vertex serves agents and media models, not
    // the standard Gemini models a follow-up or a summary needs.
    const limits = backendLimitations(loadConfig({ VERTEX_PROJECT: 'p' }));
    expect(limits.length).toBeGreaterThan(1);
    expect(limits.join(' ')).toContain('Corpus grounding is unavailable');
    expect(limits.join(' ')).toContain('research_followup is unavailable');
    expect(limits.join(' ')).toContain('not been verified against a live Vertex project');
  });
});

describe('retry and backoff', () => {
  it('classifies failures conservatively: unknown is fatal, 429 is rate-limited', () => {
    expect(classify({ status: 429 })).toBe('rate-limited');
    expect(classify({ status: 503 })).toBe('retryable');
    expect(classify({ status: 400 })).toBe('fatal');
    expect(classify({ status: 401 })).toBe('fatal');
    expect(classify({ code: 'ECONNRESET' })).toBe('retryable');
    // ENOTFOUND is a real answer from DNS, not a transient fault.
    expect(classify({ code: 'ENOTFOUND' })).toBe('fatal');
    expect(classify(new Error('who knows'))).toBe('fatal');
  });

  it('honours Retry-After over its own guess, in seconds and as a date', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(retryAfterMs({ headers: { 'retry-after': '30' } }, now)).toBe(30_000);
    expect(
      retryAfterMs({ headers: { 'retry-after': new Date(now + 45_000).toUTCString() } }, now),
    ).toBe(45_000);
    expect(retryAfterMs({ headers: {} }, now)).toBeUndefined();
  });

  it('stops immediately on a fatal failure rather than burning attempts', async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls += 1;
          throw Object.assign(new Error('bad request'), { status: 400 });
        },
        { sleep: async () => undefined },
      ),
    ).rejects.toThrow('bad request');
    expect(calls).toBe(1);
  });

  it('retries transient failures and returns the eventual success', async () => {
    let calls = 0;
    const result = await retry(
      async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('boom'), { status: 503 });
        return 'ok';
      },
      { sleep: async () => undefined, random: () => 0.5 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('widens the poll interval as failures accumulate, then snaps back', () => {
    const base = 20_000;
    expect(pollDelayMs(base, 0)).toBe(base);
    const one = pollDelayMs(base, 1, { random: () => 1 });
    const three = pollDelayMs(base, 3, { random: () => 1 });
    expect(one).toBeGreaterThan(base);
    expect(three).toBeGreaterThan(one);
    // Capped, so an outage degrades to occasional probing rather than silence.
    expect(pollDelayMs(base, 50, { random: () => 1, maxMs: 600_000 })).toBeLessThanOrEqual(600_000);
    // Recovery is immediate, not gradual.
    expect(pollDelayMs(base, 0)).toBe(base);
  });
});

describe('duration estimates reflect the run, not just the tier', () => {
  it('widens when a corpus, an MCP server or attachments are involved', () => {
    const plain = estimateDuration({ tier: 'fast', tools: ['google_search'] });
    const corpus = estimateDuration({ tier: 'fast', tools: ['google_search', 'file_search'] });
    const external = estimateDuration({ tier: 'fast', tools: ['google_search', 'mcp_server'] });
    const files = estimateDuration({ tier: 'fast', tools: ['google_search'], attachments: 3 });

    expect(corpus.highMinutes).toBeGreaterThan(plain.highMinutes);
    expect(external.highMinutes).toBeGreaterThan(plain.highMinutes);
    expect(files.highMinutes).toBeGreaterThan(plain.highMinutes);
  });

  it('names the sources it will consult, so the caller can sanity-check them', () => {
    const d = estimateDuration({
      tier: 'max',
      tools: ['google_search', 'file_search', 'url_context'],
      attachments: 1,
    });
    expect(d.sources.join(' ')).toContain('Google Search');
    expect(d.sources.join(' ')).toContain('private corpus');
    expect(d.sources.join(' ')).toContain('attached file');
    // And explains itself rather than emitting a bare range.
    expect(d.factors.length).toBeGreaterThan(1);
  });

  it('flags that a plan-review run waits on a human before it spends', () => {
    const d = estimateDuration({ tier: 'fast', collaborativePlanning: true });
    expect(d.awaitsApproval).toBe(true);
    expect(formatDuration(d)).toContain('after you approve the plan');
    expect(formatDuration(estimateDuration('fast'))).toContain('background');
  });

  it('never promises longer than the API will actually run a task', () => {
    const everything = estimateDuration({
      tier: 'max',
      tools: ['google_search', 'url_context', 'file_search', 'code_execution', 'mcp_server', 'mcp_server'],
      attachments: 6,
    });
    expect(everything.highMinutes).toBeLessThanOrEqual(60);
    expect(everything.cappedByApiLimit).toBe(true);
    expect(everything.factors.join(' ')).toContain('60-minute task limit');
  });

  it('still accepts a bare tier, so old callers keep working', () => {
    expect(estimateDuration('max').highMinutes).toBe(60);
    expect(estimateDuration('fast').lowMinutes).toBe(4);
  });
});

describe('cost estimates track what the run actually attaches', () => {
  it('leaves the documented bands intact for a default run', () => {
    // google_search / url_context / code_execution are on for every run and are
    // already inside Google's published band. If attaching nothing changed the
    // headline figure, every doc quoting "$1-3" would be wrong.
    const fast = estimateCost({ tier: 'fast', tools: ['google_search', 'url_context', 'code_execution'] });
    expect(fast.lowUsd).toBe(1);
    expect(fast.highUsd).toBe(3);
    expect(estimateCost('max').highUsd).toBe(7);
  });

  it('widens for corpora, external servers and attachments', () => {
    const base = estimateCost('fast').highUsd;
    expect(estimateCost({ tier: 'fast', tools: ['file_search'] }).highUsd).toBeGreaterThan(base);
    expect(estimateCost({ tier: 'fast', tools: ['mcp_server'] }).highUsd).toBeGreaterThan(base);
    expect(estimateCost({ tier: 'fast', attachments: 4 }).highUsd).toBeGreaterThan(base);
  });

  it('explains the increment rather than silently inflating the number', () => {
    const b = estimateCost({ tier: 'fast', tools: ['file_search', 'mcp_server'], attachments: 2 });
    expect(b.basis).toContain('corpus store');
    expect(b.basis).toContain('MCP server');
    expect(b.basis).toContain('attached file');
  });

  it('scales with the number of corpora and servers, not just their presence', () => {
    const one = estimateCost({ tier: 'fast', tools: ['file_search'] }).highUsd;
    const two = estimateCost({ tier: 'fast', tools: ['file_search', 'file_search'] }).highUsd;
    expect(two).toBeGreaterThan(one);
  });
});

describe('hardening found by external review', () => {
  it('renders non-http citation schemes inert instead of clickable', () => {
    // `javascript:` and `data:` as markdown links hand the client a payload,
    // and safeFetch refuses them, so they used to vanish from verification too.
    const out = normaliseCitations(
      '<cite url="javascript:alert(1)">click</cite> and <cite url="file:///etc/passwd"/> and ' +
        '<cite url="https://example.com/a">real</cite>',
    );
    expect(out).not.toContain('](javascript:');
    expect(out).not.toContain('](file:');
    expect(out).toContain('not linked');
    expect(out).toContain('[real](https://example.com/a)');
  });

  it('warns, without rewriting, when a brief has content after its directive', () => {
    // The directive only re-anchors if it is last. We cannot fix someone's
    // engineered brief without breaking the verbatim promise, so we say so.
    const drifted =
      '<role>x</role>\n<core_directive>Answer decisively.</core_directive>\n\nPS: also mention pricing.';
    const built = buildPrompt({ question: drifted });
    expect(built.preEngineered).toBe(true);
    expect(built.prompt).toBe(drifted); // untouched
    expect(built.warnings?.[0]).toMatch(/after the final <\/core_directive>/);
  });

  it('does not warn about a correctly anchored brief', () => {
    const fine = '<role>x</role>\n\n<core_directive>Answer decisively.</core_directive>';
    const built = buildPrompt({ question: fine });
    expect(built.preEngineered).toBe(true);
    expect(built.prompt).toBe(fine);
    expect(built.warnings).toBeUndefined();
  });

  it('merges nothing when a self-closing cite precedes a paired one', () => {
    // The paired pattern used to span from a self-closing tag to the next
    // `</cite>`, silently eating the prose and the citation in between.
    const out = normaliseCitations(
      '<cite url="https://a.test/1"/> middle prose <cite url="https://b.test/2">B</cite>',
    );
    expect(out).toContain('middle prose');
    expect(out).toContain('[B](https://b.test/2)');
  });
});
