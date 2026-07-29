import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { RunRecordSchema } from '../src/store/types.js';

/**
 * Provenance for a run a panel member started.
 *
 * The mechanism relies on one fact about MCP: a stdio server is a CHILD of the
 * client that launched it. So when Dossier spawns a CLI with a marker in its
 * environment, and that CLI launches Dossier to call `research_start`, the
 * second Dossier inherits the marker. That is the whole chain, and each link is
 * asserted here because the failure is silent — a run charged to the user and
 * counted as an independent voice when it is neither.
 */

describe('DOSSIER_SPAWNED_BY', () => {
  it('is absent for an ordinary launch, so no existing run changes meaning', () => {
    const config = loadConfig({ DOSSIER_STORE_DIR: '/tmp/x' });
    expect(config.spawnedBy).toBe('');
  });

  it('is read from the environment a parent Dossier set', () => {
    const config = loadConfig({
      DOSSIER_STORE_DIR: '/tmp/x',
      DOSSIER_SPAWNED_BY: 'loc_claude_abc001',
    });
    expect(config.spawnedBy).toBe('loc_claude_abc001');
  });

  it('refuses to start rather than truncating an implausible value', () => {
    // It arrives through the environment and reaches a stored record, so it is
    // bounded rather than trusted. Refusing beats truncating: this variable is
    // set by Dossier itself, so an over-long one means either a defect upstream
    // or someone editing the environment, and a silently shortened provenance
    // marker points at a run that does not exist.
    expect(() =>
      loadConfig({
        DOSSIER_STORE_DIR: '/tmp/x',
        DOSSIER_SPAWNED_BY: 'x'.repeat(5000),
      }),
    ).toThrow(/DOSSIER_SPAWNED_BY/);
  });
});

describe('RunRecord.spawnedBy', () => {
  const base = {
    id: 'dr_1',
    createdAt: '2026-07-28T00:00:00Z',
    updatedAt: '2026-07-28T00:00:00Z',
    state: 'completed',
    question: 'q',
    prompt: 'p',
    archetype: 'technical',
    tier: 'fast',
    estimatedCostUsd: 1,
    fingerprint: 'fp',
    lastProgressAt: '2026-07-28T00:00:00Z',
  };

  it('parses a record without it, so nothing written before this is invalidated', () => {
    const parsed = RunRecordSchema.parse(base);
    expect(parsed.spawnedBy).toBeUndefined();
  });

  it('carries the spawning interaction id, which resolves back to a run', () => {
    // Named for what it holds. The provider mints the interaction id before any
    // run record exists, so this cannot be a run id, and calling it one would
    // send a reader looking for a record that was never written under that key.
    const parsed = RunRecordSchema.parse({ ...base, spawnedBy: 'loc_claude_abc001' });
    expect(parsed.spawnedBy).toBe('loc_claude_abc001');
  });
});

describe('dedupe never returns a run that produced nothing', () => {
  it('skips a completed run with no sources, so a retry can actually retry', async () => {
    // Reported from use: a retry after a failure deduped straight onto the
    // 0-source run it was retrying, so the retry could never succeed. The
    // `failed` guard does not catch it: the usual cause is a backend whose web
    // search broke and then wrote a fluent account of why it could not
    // research, which lands as `completed`.
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Store } = await import('../src/store/store.js');

    const root = await mkdtemp(join(tmpdir(), 'dedupe-'));
    const store = new Store(root);
    await store.init();

    const now = new Date().toISOString();
    const base = {
      createdAt: now, updatedAt: now, lastProgressAt: now,
      question: 'q', prompt: 'p', archetype: 'technical' as const, tier: 'fast' as const,
      estimatedCostUsd: 1, fingerprint: 'fp-shared',
    };

    await store.saveRun({ ...base, id: 'dr_barren', state: 'completed', reportChars: 9140, sourceCount: 0 } as never);
    expect(await store.findByFingerprint('fp-shared', 60)).toBeNull();

    // And a real one on the same fingerprint is still returned, or dedupe would
    // have stopped working rather than become correct.
    await store.saveRun({ ...base, id: 'dr_real', state: 'completed', reportChars: 400, sourceCount: 7 } as never);
    expect((await store.findByFingerprint('fp-shared', 60))?.id).toBe('dr_real');
  });

  it('still dedupes onto an in-flight run, which has no sources yet', async () => {
    // The guard is on TERMINAL runs only. An in-flight run legitimately has no
    // sources, and deduping onto it is the entire point of dedupe.
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Store } = await import('../src/store/store.js');
    const root = await mkdtemp(join(tmpdir(), 'dedupe2-'));
    const store = new Store(root);
    await store.init();
    const now = new Date().toISOString();
    await store.saveRun({
      id: 'dr_running', createdAt: now, updatedAt: now, lastProgressAt: now,
      state: 'running', question: 'q', prompt: 'p', archetype: 'technical',
      tier: 'fast', estimatedCostUsd: 1, fingerprint: 'fp-live', reportChars: 0, sourceCount: 0,
    } as never);
    expect((await store.findByFingerprint('fp-live', 60))?.id).toBe('dr_running');
  });
});
