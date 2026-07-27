import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { adapterFor, type CliAdapter } from '../src/local/cli.js';
import { localProvider, localProviders } from '../src/providers/local.js';

/** There is one backend per CLI now, so a test names the one it is exercising. */
const CLAUDE: CliAdapter = adapterFor('claude')!;

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

/**
 * A fake CLI that prints a report and exits with the code we choose.
 *
 * It answers `--version` as Claude Code, because the provider confirms identity
 * before it spawns anything. A fake that cannot identify itself is a separate
 * test, below.
 */
async function fakeCli(body: string): Promise<void> {
  const path = join(dir, 'claude');
  await writeFile(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.220 (Claude Code)"; exit 0; fi\n${body}\n`);
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
  // The fake bin dir first, then the real system paths: resolution still finds
  // our fake, and the fake's own shell can still find `sleep` and friends.
  process.env['PATH'] = `${dir}:/bin:/usr/bin`;
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
    const p = localProvider(config, CLAUDE);
    expect(p.detect().state).toBe('not-configured');
    expect(p.detect().fix).toMatch(/Claude Code/);
  });

  it('spawns nothing in hermetic mode', () => {
    const p = localProvider({ ...config, hermetic: true }, CLAUDE);
    expect(p.detect().state).toBe('not-configured');
    expect(p.detect().detail).toMatch(/hermetic/);
  });

  it('never claims ready from a binary on PATH alone', async () => {
    await fakeCli('echo hi');
    // Presence is not identity and is not a signed-in session; `research_doctor`
    // is where that gets checked, and it can say so per CLI.
    expect(localProvider(config, CLAUDE).detect().state).toBe('configured-unverified');
  });

  // CLI-17. Detection is per CLI. The whole point of the split is that one
  // missing tool costs you that tool and not the lane.
  it('reports each CLI on its own, so one absent tool does not take the others down', async () => {
    await fakeCli('echo hi');
    const built = localProviders(config);
    expect(built.map((p) => p.id)).toContain('local-claude');
    expect(built.map((p) => p.id)).toContain('local-codex');

    const claude = built.find((p) => p.id === 'local-claude')!;
    const codex = built.find((p) => p.id === 'local-codex')!;
    expect(claude.detect().state).toBe('configured-unverified');
    expect(codex.detect().state).toBe('not-configured');
    // Each names only itself, so the fix is actionable rather than a list of
    // every CLI in existence.
    expect(codex.detect().detail).toMatch(/codex/);
    expect(codex.detect().detail).not.toMatch(/claude/);
  });

  // CLI-18. The operator override narrows; it no longer chooses.
  it('restricts the lane to one CLI when DOSSIER_LOCAL_CLI names one', () => {
    expect(localProviders({ ...config, localCli: 'codex' }).map((p) => p.id)).toEqual(['local-codex']);
    // Unset is the new default: every CLI is offered, and detection decides.
    expect(localProviders(config).length).toBeGreaterThan(1);
  });

  it('offers the strongest CLI first, so the free lane leads with it', () => {
    expect(localProviders(config)[0]?.id).toBe('local-claude');
  });

  // CLI-21. Two CLIs answering one question must not write into one transcript.
  it('keeps two CLIs running at once in separate transcripts', async () => {
    await fakeCli('echo "answer from claude"');
    const codexBin = join(dir, 'codex');
    await writeFile(
      codexBin,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.9.0"; exit 0; fi\necho "answer from codex"\n',
    );
    await chmod(codexBin, 0o755);

    const brief = {
      prompt: 'same question, twice',
      tier: 'fast' as const,
      collaborativePlanning: false,
      thinkingSummaries: false,
      visualization: false,
      tools: [],
    };
    const claude = localProvider(config, CLAUDE).client();
    const codex = localProvider(config, adapterFor('codex')!).client();
    const [a, b] = await Promise.all([claude.createRun(brief), codex.createRun(brief)]);

    expect(a.interactionId).not.toBe(b.interactionId);
    // The CLI's name is in the id, so a transcript is attributable on disk
    // rather than only through the run record.
    expect(a.interactionId).toContain('claude');
    expect(b.interactionId).toContain('codex');
    expect((await settled(claude, a.interactionId)).markdown).toContain('answer from claude');
    expect((await settled(codex, b.interactionId)).markdown).toContain('answer from codex');
  });

  it('runs a brief and returns what the CLI wrote', async () => {
    await fakeCli('echo "# Report"; echo "The answer is 42."');
    const client = localProvider(config, CLAUDE).client();
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
    await fakeCli('echo "partial output"; exit 7');
    const client = localProvider(config, CLAUDE).client();
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
    await fakeCli('echo "durable output"');
    const first = localProvider(config, CLAUDE).client();
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
    const second = localProvider(config, CLAUDE).client();
    const done = await second.getRun(started.interactionId);
    expect(done.status).toBe('completed');
    expect(done.markdown).toContain('durable output');
  });

  it('does not let a brief reach a shell', async () => {
    // The injection case. If the prompt were interpolated into a shell command,
    // this would create the file; as an argv element it is just text.
    await fakeCli('echo "$@"');
    const canary = join(store, 'pwned.txt');
    const client = localProvider(config, CLAUDE).client();
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
    await fakeCli('echo hi');
    const client = localProvider(config, CLAUDE).client();
    expect(() => client.followUp({ question: 'why?', previousInteractionId: 'x', model: 'm' })).toThrow(
      /no follow-up turn/,
    );
  });

  it('refuses to spawn a binary it cannot identify', async () => {
    // The collision, and it is not hypothetical: installing the xAI CLI on this
    // machine replaced `~/.local/bin/agent`, which an hour earlier had been
    // Cursor's, with a symlink to xAI's binary. Detection is sync and can only
    // see that a name resolves; this is the last check before a brief is handed
    // to whatever that name happens to be today.
    const path = join(dir, 'claude');
    await writeFile(path, '#!/bin/sh\necho "some-other-vendor 1.0"\n');
    await chmod(path, 0o755);
    const client = localProvider(config, CLAUDE).client();
    await expect(
      client.createRun({
        prompt: 'q',
        tier: 'fast',
        collaborativePlanning: false,
        thinkingSummaries: false,
        visualization: false,
        tools: [],
      }),
    ).rejects.toThrow(/Refusing to run/);
  });

  it('costs nothing, and says what it does consume', () => {
    const estimate = localProvider(config, CLAUDE).estimate({ tier: 'fast' });
    expect(estimate.cost.highUsd).toBe(0);
    expect(estimate.cost.basis).toMatch(/subscription/);
  });
});

describe('the supervisor bounds what the CLI can do', () => {
  it('truncates a runaway CLI and says so, rather than filling the store', async () => {
    // A chatty CLI could otherwise write until the disk gave out, and a silent
    // truncation reads as "that was the whole report".
    // Comfortably past the 8 MB cap: 300k lines of 100 bytes is ~30 MB.
    const line = 'a'.repeat(99);
    await fakeCli(`i=0; while [ $i -lt 300000 ]; do echo "${line}"; i=$((i+1)); done`);
    const client = localProvider({ ...config, storeDir: store }, CLAUDE).client();
    const started = await client.createRun({
      prompt: 'q',
      tier: 'fast',
      collaborativePlanning: false,
      thinkingSummaries: false,
      visualization: false,
      tools: [],
    });
    const done = await settled(client, started.interactionId, 30_000);
    expect(done.markdown.length).toBeLessThan(12 * 1024 * 1024);
    expect(done.markdown).toContain('output truncated');
  }, 60_000);

  it('refuses to record a cancellation it could not confirm', async () => {
    // Writing the sidecar straight after SIGTERM declared a run finished while
    // it was still running and still consuming quota.
    await fakeCli('trap "" TERM; sleep 30');
    const client = localProvider({ ...config, storeDir: store }, CLAUDE).client();
    const started = await client.createRun({
      prompt: 'q',
      tier: 'fast',
      collaborativePlanning: false,
      thinkingSummaries: false,
      visualization: false,
      tools: [],
    });
    await new Promise((r) => setTimeout(r, 300));
    // The contract: cancel returns only once the process is actually gone, and
    // the terminal state is recorded after that rather than on the strength of
    // having sent a signal.
    await client.cancelRun(started.interactionId);
    const after = await client.getRun(started.interactionId);
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/cancelled/);
  }, 30_000);
});
