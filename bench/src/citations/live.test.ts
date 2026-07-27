import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { citationBatch } from './live.js';
import { fetchPage } from './fetch.js';
import { collectCitationEvidence } from './collect.js';
import { scoreCitationIntegrity } from '../score/citations.js';
import type { RegistryResponse } from './registries.js';

/**
 * The seams the out-of-family critic found reviewed-by-reading but never
 * exercised: the real SSRF boundary, the composed persisted round-trip, and a
 * transport that throws rather than resolving.
 *
 * The SSRF test is hermetic despite driving the real fetcher, because a private
 * address is refused before a socket is opened. That is the property being
 * asserted, so the test and the guarantee are the same thing.
 */

function dirs(): { cacheDir: string; evidenceDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'bench-cite-live-'));
  return { cacheDir: join(root, 'cache'), evidenceDir: join(root, 'evidence') };
}

describe('the real fetch adapter and the SSRF boundary', () => {
  it('refuses a link-local address without opening a socket', async () => {
    const result = await fetchPage('http://169.254.169.254/latest/meta-data/');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Private address blocked/);
  });

  it('refuses loopback and a private range too', async () => {
    for (const url of ['http://127.0.0.1/x', 'http://10.0.0.1/x', 'http://192.168.1.1/x']) {
      const result = await fetchPage(url);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Private address blocked/);
    }
  });

  it('refuses a scheme that is not http or https', async () => {
    const result = await fetchPage('file:///etc/passwd');
    expect(result.error).toMatch(/Scheme not allowed/);
  });

  it('carries the refusal through collection as invalid_url, not unreachable', async () => {
    const evidence = await collectCitationEvidence('A claim [x](http://169.254.169.254/meta).', {
      registryTransport: () => Promise.resolve({ status: 0, body: '', error: 'not asked' }),
      fetchPage: (url) => fetchPage(url),
    });
    expect(evidence.pages[0]?.verdict).toBe('invalid_url');
  });
});

describe('a transport that throws (the fail-closed rule)', () => {
  const report = 'Adoption reached 28.6% [a](https://example.com/a), see 10.1038/nature12373.';

  it('still returns a complete snapshot when the registry transport rejects', async () => {
    const evidence = await collectCitationEvidence(report, {
      registryTransport: () => Promise.reject(new Error('socket hang up')),
      fetchPage: () => Promise.reject(new Error('socket hang up')),
    });
    expect(evidence.pages).toHaveLength(1);
    expect(evidence.registry).toHaveLength(1);
    expect(evidence.registry[0]?.status).toBe('unchecked');
    expect(evidence.pages[0]?.verdict).toBe('unreachable');
  });

  it('never turns a thrown request into an absent reference', async () => {
    const evidence = await collectCitationEvidence(report, {
      registryTransport: () => Promise.reject(new Error('ECONNRESET')),
      fetchPage: () => Promise.resolve({ url: 'x', status: 0, ok: false, body: '', contentType: '', truncated: false }),
    });
    expect(evidence.registry.every((r) => r.status !== 'absent')).toBe(true);
  });
});

describe('the composed round trip', () => {
  const report =
    'Adoption reached 28.6% in 2024 [a](https://example.com/a). See 10.1038/nature12373 for the method.';

  it('collects, writes, reads and scores through one public surface', async () => {
    const batch = citationBatch(dirs());
    // The live adapters really run; every address is refused before a socket,
    // so the whole path is exercised and the suite stays hermetic.
    await batch.collect('task-a/gemini/1', 'A claim [x](http://127.0.0.1/private).');
    const result = batch.score('task-a/gemini/1', 'A claim [x](http://127.0.0.1/private).');
    expect(result.status).toBe('scored');
    if (result.status !== 'scored') return;
    expect(result.resolvability.invalid).toBe(1);
    expect(result.citationAccuracy).toBeNull();
  });

  it('refuses to score a report against another report’s evidence', async () => {
    const batch = citationBatch(dirs());
    await batch.collect('cell', 'The first report [a](http://127.0.0.1/one).');
    const result = batch.score('cell', 'A completely different report [b](http://127.0.0.1/two).');
    // Reported as a pipeline gap, never as a result about the backend.
    expect(result.status).toBe('unmeasurable');
    if (result.status !== 'unmeasurable') return;
    expect(result.reason).toBe('no-evidence');
  });

  it('reports no evidence when nothing was ever collected for that cell', () => {
    const batch = citationBatch(dirs());
    const result = batch.score('never-collected', report);
    expect(result.status).toBe('unmeasurable');
  });
});

describe('truncation, carried from collection into the score (INTEG-41)', () => {
  it('counts a truncated miss as unchecked rather than as a wrong citation', async () => {
    const report = 'Adoption reached 28.6% in 2024 [a](https://example.com/a).';
    const evidence = await collectCitationEvidence(report, {
      registryTransport: (): Promise<RegistryResponse> =>
        Promise.resolve({ status: 0, body: '', error: 'not asked' }),
      fetchPage: () =>
        Promise.resolve({
          url: 'https://example.com/a',
          status: 200,
          ok: true,
          body: '<html><body><p>a page whose figures sit past the cap</p></body></html>',
          contentType: '',
          truncated: true,
        }),
    });
    const result = scoreCitationIntegrity(report, evidence);
    expect(result.status).toBe('scored');
    if (result.status !== 'scored') return;
    expect(result.citationsUnchecked).toBe(1);
    expect(result.citationAccuracy).toBeNull();
  });
});
