import { describe, expect, it } from 'vitest';
import { looksRateLimited, rateLimitFacts } from '../src/research/failure.js';

/**
 * The exact message that killed six runs in this repo's own ledger, at $9 each.
 *
 * Kept verbatim because every field in it changed a conclusion: the account was
 * at 99.3% of its budget, the request that tipped it over was small, and the
 * wait was under three seconds. Read together they say the problem is
 * concurrency rather than any single run being too large — which is the
 * opposite of what "the research failed" suggested.
 */
const REAL =
  'Rate limit reached for gpt-5.6-sol in organization org-oNHiZa0QJDLagNfGa2HjWod8 on tokens ' +
  'per min (TPM): Limit 1000000, Used 993157, Requested 53211. Please try again in 2.782s. ' +
  'Visit https://platform.openai.com/account/rate-limits to learn more.';

describe('a rate limit reported in the response body', () => {
  it('is detected, where an HTTP-status check cannot see it', () => {
    // The call returned 200. `isRateLimited` asks whether the status was 429
    // and is right to; this is a different shape and needs its own answer.
    expect(looksRateLimited(REAL)).toBe(true);
  });

  it('does not fire on ordinary research prose', () => {
    expect(looksRateLimited('The research run failed with no reported reason.')).toBe(false);
    expect(looksRateLimited('No sources were found for the stated time window.')).toBe(false);
  });

  it('recovers the numbers that turn a failure into a diagnosis', () => {
    expect(rateLimitFacts(REAL)).toEqual({
      limit: 1_000_000,
      used: 993_157,
      requested: 53_211,
      retryAfterSeconds: 2.782,
    });
  });

  it('reports a missing field as missing rather than guessing', () => {
    // Providers word these differently. A zero here would read as "the account
    // has no limit", which is the most dangerous possible wrong answer.
    expect(rateLimitFacts('Rate limit reached. Try again later.')).toEqual({});
  });

  it('handles the thousands separators providers actually emit', () => {
    expect(rateLimitFacts('TPM: Limit 1,000,000, Used 999,999').limit).toBe(1_000_000);
  });
});

describe('the per-backend concurrency cap', () => {
  it('defaults to 1 for OpenAI and to unlimited elsewhere', async () => {
    const { loadConfig } = await import('../src/config.js');
    const c = loadConfig({ DOSSIER_STORE_DIR: '/tmp/x' });
    expect(c.providerConcurrency['openai']).toBe(1);
    for (const p of ['gemini', 'perplexity', 'xai']) {
      expect(c.providerConcurrency[p], p).toBe(0);
    }
  });

  it('lets an explicit 0 disable it, which the first version did not', () => {
    // The default was applied by remapping 0 to 1 at the read site, so the
    // documented "0 disables the cap" was false for the only backend that
    // capped by default. The default belongs in the schema; the read site now
    // passes the value through.
    return import('../src/config.js').then(({ loadConfig }) => {
      const c = loadConfig({ DOSSIER_STORE_DIR: '/tmp/x', DOSSIER_CONCURRENCY_OPENAI: '0' });
      expect(c.providerConcurrency['openai']).toBe(0);
    });
  });
});
