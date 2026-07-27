import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DiskRegistryCache,
  MemoryRegistryCache,
  RateLimiter,
  SingleFlight,
  cacheKey,
} from './cache.js';
import type { RegistryAnswer } from './evidence.js';

/**
 * Remembering an answer, spacing the requests, and collapsing the duplicates.
 *
 * The rule that gets its own tests in three places is that an `unchecked`
 * answer is never remembered. It is the first rule of the slice at the storage
 * layer: caching a moment when a server was busy would freeze it into a
 * permanent verdict about somebody's citation, inherited by every later report
 * without one of them making a request that could correct it.
 */

function answer(over: Partial<RegistryAnswer> = {}): RegistryAnswer {
  return {
    kind: 'doi',
    id: '10.1038/nature12373',
    status: 'present',
    detail: 'Crossref holds a record for this DOI',
    checkedAt: '2026-07-27T00:00:00.000Z',
    ...over,
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bench-cite-cache-'));
}

describe('keys', () => {
  it('namespaces by registry kind, so two kinds cannot collide', () => {
    expect(cacheKey('doi', 'x')).not.toBe(cacheKey('arxiv', 'x'));
    expect(cacheKey('doi', 'x').startsWith('doi/')).toBe(true);
  });

  it('hashes the identifier, so its own slashes cannot escape the directory', () => {
    expect(cacheKey('doi', '10.1000/../../etc/passwd')).not.toContain('..');
    expect(cacheKey('doi', '10.1000/a/b/c').split('/')).toHaveLength(2);
  });
});

describe('the on-disk cache (INTEG-06, INTEG-08)', () => {
  it('round-trips an answer', () => {
    const cache = new DiskRegistryCache(tempDir());
    cache.set(answer());
    expect(cache.get('doi', '10.1038/nature12373')).toMatchObject({ status: 'present' });
  });

  it('never writes an unchecked answer', () => {
    const dir = tempDir();
    const cache = new DiskRegistryCache(dir);
    cache.set(answer({ status: 'unchecked', detail: 'the registry answered 429' }));
    expect(cache.get('doi', '10.1038/nature12373')).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('writes atomically, leaving no temporary file behind', () => {
    const dir = tempDir();
    new DiskRegistryCache(dir).set(answer());
    expect(readdirSync(join(dir, 'doi')).every((f) => f.endsWith('.json'))).toBe(true);
  });

  it('discards a corrupt entry rather than trusting it', () => {
    const dir = tempDir();
    const cache = new DiskRegistryCache(dir);
    cache.set(answer());
    const file = join(dir, cacheKey('doi', '10.1038/nature12373'));
    writeFileSync(file, 'not json at all', 'utf8');
    expect(cache.get('doi', '10.1038/nature12373')).toBeUndefined();
  });

  it('discards an entry whose recorded identity disagrees with what was asked', () => {
    const dir = tempDir();
    const cache = new DiskRegistryCache(dir);
    cache.set(answer());
    const file = join(dir, cacheKey('doi', '10.1038/nature12373'));
    const stored = JSON.parse(readFileSync(file, 'utf8')) as RegistryAnswer;
    writeFileSync(file, JSON.stringify({ ...stored, id: '10.9999/other' }), 'utf8');
    // A hand-edited or colliding file must not be able to assert that somebody
    // else's citation was fabricated.
    expect(cache.get('doi', '10.1038/nature12373')).toBeUndefined();
  });

  it('discards an entry that fails the schema', () => {
    const dir = tempDir();
    const cache = new DiskRegistryCache(dir);
    cache.set(answer());
    const file = join(dir, cacheKey('doi', '10.1038/nature12373'));
    writeFileSync(file, JSON.stringify({ kind: 'doi', id: '10.1038/nature12373' }), 'utf8');
    expect(cache.get('doi', '10.1038/nature12373')).toBeUndefined();
  });

  it('returns undefined for an answer it has never seen', () => {
    expect(new DiskRegistryCache(tempDir()).get('cve', 'CVE-2021-44228')).toBeUndefined();
  });
});

describe('the in-memory cache', () => {
  it('applies the same unchecked rule', () => {
    const cache = new MemoryRegistryCache();
    cache.set(answer({ status: 'unchecked' }));
    expect(cache.get('doi', '10.1038/nature12373')).toBeUndefined();
    cache.set(answer({ status: 'absent' }));
    expect(cache.get('doi', '10.1038/nature12373')).toMatchObject({ status: 'absent' });
  });
});

describe('the rate limiter (INTEG-09)', () => {
  it('holds the gap between two calls to one registry, across concurrent callers', async () => {
    const slept: number[] = [];
    let clock = 0;
    const limiter = new RateLimiter({
      gaps: { crossref: 200 },
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      now: () => clock,
    });

    const order: string[] = [];
    await Promise.all([
      limiter.schedule('crossref', async () => {
        order.push('a');
      }),
      limiter.schedule('crossref', async () => {
        order.push('b');
      }),
      limiter.schedule('crossref', async () => {
        order.push('c');
      }),
    ]);

    expect(order).toEqual(['a', 'b', 'c']);
    // The first goes immediately; the next two each wait the full gap, because
    // no time passed between them other than the waiting itself.
    expect(slept).toEqual([200, 200]);
  });

  it('does not make one registry wait behind another', async () => {
    const slept: number[] = [];
    let clock = 0;
    const limiter = new RateLimiter({
      gaps: { crossref: 200, nvd: 6000 },
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
    await Promise.all([
      limiter.schedule('crossref', async () => undefined),
      limiter.schedule('nvd', async () => undefined),
    ]);
    expect(slept).toEqual([]);
  });
});

describe('single flight (INTEG-07)', () => {
  it('collapses concurrent callers asking the same question onto one call', async () => {
    const flight = new SingleFlight();
    let calls = 0;
    const work = async (): Promise<RegistryAnswer> => {
      calls += 1;
      await Promise.resolve();
      return answer();
    };
    const [a, b, c] = await Promise.all([
      flight.run('k', work),
      flight.run('k', work),
      flight.run('k', work),
    ]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('lets a later caller start a fresh call once the first has settled', async () => {
    const flight = new SingleFlight();
    let calls = 0;
    const work = async (): Promise<RegistryAnswer> => {
      calls += 1;
      return answer();
    };
    await flight.run('k', work);
    await flight.run('k', work);
    expect(calls).toBe(2);
  });

  it('does not wedge the key when the work throws', async () => {
    const flight = new SingleFlight();
    await expect(
      flight.run('k', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    await expect(flight.run('k', () => Promise.resolve(answer()))).resolves.toMatchObject({
      status: 'present',
    });
  });
});
