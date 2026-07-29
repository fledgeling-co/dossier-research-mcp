import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FAILING_STREAK,
  WINDOW,
  describeSearchHealth,
  healthOf,
  readSearchHealth,
  recordSearchOutcome,
} from '../src/local/search-health.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dossier-health-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('search health', () => {
  it('calls a backend failing only after a streak, not on one bad run', async () => {
    await recordSearchOutcome(dir, 'codex', 0);
    // One sourceless run is a question with no coverage as often as a broken
    // search. Warning here would train someone to ignore the warning.
    expect(healthOf(readSearchHealth(dir).get('codex'))).not.toBe('failing');

    await recordSearchOutcome(dir, 'codex', 0);
    expect(healthOf(readSearchHealth(dir).get('codex'))).toBe('failing');
  });

  it('clears as soon as the backend cites something again', async () => {
    for (let i = 0; i < FAILING_STREAK; i += 1) await recordSearchOutcome(dir, 'grok', 0);
    expect(healthOf(readSearchHealth(dir).get('grok'))).toBe('failing');

    await recordSearchOutcome(dir, 'grok', 12);
    expect(healthOf(readSearchHealth(dir).get('grok'))).toBe('healthy');
  });

  it('reports a backend nobody has run as unknown, never as healthy', () => {
    // The distinction is the whole value: a backend never exercised is not a
    // backend shown to work.
    expect(healthOf(undefined)).toBe('unknown');
    expect(healthOf([])).toBe('unknown');
  });

  it('keeps only the recent window', async () => {
    for (let i = 0; i < WINDOW + 4; i += 1) await recordSearchOutcome(dir, 'cursor', i);
    expect(readSearchHealth(dir).get('cursor')).toHaveLength(WINDOW);
  });

  it('keeps backends apart', async () => {
    for (let i = 0; i < FAILING_STREAK; i += 1) await recordSearchOutcome(dir, 'codex', 0);
    await recordSearchOutcome(dir, 'claude', 9);
    const r = readSearchHealth(dir);
    expect(healthOf(r.get('codex'))).toBe('failing');
    expect(healthOf(r.get('claude'))).toBe('healthy');
    expect(describeSearchHealth(r)).toHaveLength(1);
    expect(describeSearchHealth(r)[0]).toContain('codex');
  });

  it('returns nothing rather than throwing on a corrupt record', () => {
    // Diagnostics, not admission control: a bad file means no warning, never a
    // warning about everything.
    const bad = mkdtempSync(join(tmpdir(), 'dossier-health-bad-'));
    try {
      writeFileSync(join(bad, 'search-health.json'), '{not json');
      expect(readSearchHealth(bad).size).toBe(0);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });
});
