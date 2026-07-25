import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { localProvider } from '../src/providers/local.js';

/**
 * The subprocess backend, driven against a real spawned process.
 *
 * Mocking the spawn would test nothing that matters here: the whole design
 * question is whether a detached child's outcome survives being observed by a
 * *different* process later, which is what durability across a server restart
 * actually means.
 */

let dir: string;
let store: string;
let originalPath: string | undefined;
let config: Config;

/** A fake CLI that prints a report and exits with the code we choose. */
async function fakeCli(body: string): Promise<void> {
  const path = join(dir, 'claude');
  await writeFile(path, body);
  await chmod(path, 0o755);
}

/**
 * Poll to a terminal state rather than sleeping a fixed time.
 *
 * A fixed sleep is a race with a real subprocess: 400ms passed locally and
 * failed under a loaded test runner, which is exactly the kind of flake that
 * gets a genuine failure dismissed later.
 */
async function settled(
  client: { getRun: (id: string) => Promise<{ status: string; markdown: string; error?: string }> },
  id: string,
  timeoutMs = 8_000,
): Promise<{ status: string; markdown: string; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await client.getRun(id);
    if (snapshot.status !== 'in_progress' || Date.now() > deadline) return snapshot;
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dossier-localbin-'));
  store = await mkdtemp(join(tmpdir(), 'dossier-localstore-'));
  originalPath = process.env['PATH'];
  process.env['PATH'] = dir;
  config = { ...loadConfig({ DOSSIER_STORE_DIR: store }), storeDir: store, hermetic: false };
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = originalPath;
  await rm(dir, { recursive: true, force: true });
  await rm(store, { recursive: true, force: true });
});

describe('the local CLI backend', () => {
  it('reports nothing configured when no CLI is installed', () => {
    const p = localProvider(config);
    expect(p.detect().state).toBe('not-configured');
    expect(p.detect().fix).toMatch(/claude|codex/);
  });

  it('spawns nothing in hermetic mode', () => {
    const p = localProvider({ ...config, hermetic: true });
    expect(p.detect().state).toBe('not-configured');
    expect(p.detect().detail).toMatch(/hermetic/);
  });

  it('never claims ready from a binary on PATH alone', async () => {
    await fakeCli('#!/bin/sh\necho hi\n');
    // Presence is not identity and is not a signed-in session; `research_doctor`
    // is where that gets checked, and it can say so per CLI.
    expect(localProvider(config).detect().state).toBe('configured-unverified');
  });

  it('runs a brief and returns what the CLI wrote', async () => {
    await fakeCli('#!/bin/sh\necho "# Report"\necho "The answer is 42."\n');
    const client = localProvider(config).client();
    const started = await client.createRun({
      prompt: 'what is the answer?',
      tier: 'fast',
      collaborativePlanning: false,
      thinkingSummaries: false,
      visualization: false,
      tools: [],
    });
    expect(started.status).toBe('in_progress');
    const done = await settled(client, started.interactionId);
    expect(done.status).toBe('completed');
    expect(done.markdown).toContain('The answer is 42.');
  });

  it('reports a non-zero exit as a failure, with the code', async () => {
    await fakeCli('#!/bin/sh\necho "partial output"\nexit 7\n');
    const client = localProvider(config).client();
    const started = await client.createRun({
      prompt: 'q',
      tier: 'fast',
      collaborativePlanning: false,
      thinkingSummaries: false,
      visualization: false,
      tools: [],
    });
    const done = await settled(client, started.interactionId);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/exited with code 7/);
    // The partial output is still there: a failed run that produced something
    // is more useful than an empty one.
    expect(done.markdown).toContain('partial output');
  });

  it('survives the observing process being a different one', async () => {
    await fakeCli('#!/bin/sh\necho "durable output"\n');
    const first = localProvider(config).client();
    const started = await first.createRun({
      prompt: 'q',
      tier: 'fast',
      collaborativePlanning: false,
      thinkingSummaries: false,
      visualization: false,
      tools: [],
    });
    await settled(first, started.interactionId);
    // A brand-new provider instance, exactly as a restarted server would build.
    const second = localProvider(config).client();
    const done = await second.getRun(started.interactionId);
    expect(done.status).toBe('completed');
    expect(done.markdown).toContain('durable output');
  });

  it('does not let a brief reach a shell', async () => {
    // The injection case. If the prompt were interpolated into a shell command,
    // this would create the file; as an argv element it is just text.
    await fakeCli('#!/bin/sh\necho "$@"\n');
    const canary = join(store, 'pwned.txt');
    const client = localProvider(config).client();
    const started = await client.createRun({
      prompt: `q"; touch ${canary}; echo "`,
      tier: 'fast',
      collaborativePlanning: false,
      thinkingSummaries: false,
      visualization: false,
      tools: [],
    });
    const done = await settled(client, started.interactionId);
    expect(done.markdown).toContain('touch');
    await expect(rm(canary)).rejects.toThrow(); // never created
  });

  it('refuses a follow-up rather than silently buying a second run', async () => {
    await fakeCli('#!/bin/sh\necho hi\n');
    const client = localProvider(config).client();
    expect(() => client.followUp({ question: 'why?', previousInteractionId: 'x', model: 'm' })).toThrow(
      /no follow-up turn/,
    );
  });

  it('costs nothing, and says what it does consume', () => {
    const estimate = localProvider(config).estimate({ tier: 'fast' });
    expect(estimate.cost.highUsd).toBe(0);
    expect(estimate.cost.basis).toMatch(/subscription/);
  });
});
