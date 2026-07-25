import { describe, expect, it } from 'vitest';
import { backendLimitations, loadConfig } from '../src/config.js';
import { toSnapshot } from '../src/gemini/types.js';
import { isPrivateAddress, safeFetch } from '../src/net/safe-fetch.js';
import { scoreCitations } from '../src/research/citations.js';
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

  it('degrades an unrecognised status to in_progress rather than throwing', () => {
    expect(toSnapshot('int_1', { status: 'something_new' }).status).toBe('in_progress');
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
