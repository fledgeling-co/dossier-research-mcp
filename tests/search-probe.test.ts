import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSearchAnswer } from '../src/local/cli.js';
import {
  PROBE_TRUSTED_MS,
  probeIsFresh,
  probedUnableToSearch,
  readSearchProbes,
  writeSearchProbes,
  type ProbeRecord,
} from '../src/local/search-health.js';

describe('reading a CLI’s answer to the search probe', () => {
  it('takes the URL out of a compliant reply', () => {
    expect(parseSearchAnswer('SEARCH_OK=https://example.com/news/story-1')).toEqual({
      ok: true,
      url: 'https://example.com/news/story-1',
    });
  });

  it('reads an explicit refusal, which is the answer that matters', () => {
    const r = parseSearchAnswer('SEARCH_FAILED=web search tool is not available');
    expect(r).toEqual({ ok: false, reason: 'web search tool is not available' });
  });

  it('prefers the URL when a CLI narrates a failed first attempt then succeeds', () => {
    // CLIs narrate. A transcript mentioning a retry is a success, and reading
    // the refusal first would report a working search as broken.
    const r = parseSearchAnswer('SEARCH_FAILED=first tool call timed out\nretrying\nSEARCH_OK=https://example.com/a/b');
    expect(r).toEqual({ ok: true, url: 'https://example.com/a/b' });
  });

  it('returns nothing when the CLI ignored the form', () => {
    expect(parseSearchAnswer('I found an interesting article about cats.')).toBeUndefined();
  });

  it('strips trailing punctuation a model wraps a URL in', () => {
    const r = parseSearchAnswer('SEARCH_OK=https://example.com/a).');
    expect(r).toEqual({ ok: true, url: 'https://example.com/a' });
  });
});

describe('probe cache', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dossier-probe-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const rec = (state: ProbeRecord['state'], at = Date.now()): ProbeRecord => ({ state, at });

  it('round-trips and reports who cannot search', async () => {
    await writeSearchProbes(
      dir,
      new Map([
        ['codex', rec('working')],
        ['grok', rec('no_search')],
        ['cursor', rec('unverified')],
      ]),
    );
    expect(readSearchProbes(dir).size).toBe(3);
    expect([...probedUnableToSearch(readSearchProbes(dir))].sort()).toEqual(['cursor', 'grok']);
  });

  it('never counts a CLI that was not asked, nor a probe that itself failed', async () => {
    // `refused` means absent or signed out, which the doctor reports on its own
    // terms; `failed` is evidence about the probe, not about the search.
    await writeSearchProbes(dir, new Map([['a', rec('refused')], ['b', rec('failed')]]));
    expect(probedUnableToSearch(readSearchProbes(dir))).toEqual([]);
  });

  it('stops believing a stale probe', async () => {
    const old = Date.now() - PROBE_TRUSTED_MS - 1;
    await writeSearchProbes(dir, new Map([['codex', rec('no_search', old)]]));
    expect(probeIsFresh(readSearchProbes(dir).get('codex')!)).toBe(false);
    // A day-old "cannot search" is a claim about yesterday, and must not keep
    // flagging a backend somebody has since signed back in to.
    expect(probedUnableToSearch(readSearchProbes(dir))).toEqual([]);
  });
});
