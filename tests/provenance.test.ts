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
