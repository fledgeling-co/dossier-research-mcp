import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_ADAPTERS, probeCli, resolveOnPath, type CliAdapter } from '../src/local/cli.js';

/**
 * CLI detection.
 *
 * The load-bearing behaviour is refusal: two vendors ship a binary called
 * `agent` and two ship one called `grok`, so a probe that trusts the name on
 * PATH can hand a research brief to a completely different vendor's tool on a
 * completely different bill. Every test here is about identity.
 */

let dir: string;
let originalPath: string | undefined;

/** A fake executable that prints whatever we tell it to. */
async function fakeBin(name: string, prints: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\necho "${prints}"\n`);
  await chmod(path, 0o755);
  return path;
}

const adapter = (over: Partial<CliAdapter>): CliAdapter => ({
  id: 'claude',
  label: 'Test CLI',
  bin: 'faketool',
  versionArgs: ['--version'],
  identity: /test cli/i,
  pathHints: [],
  authPaths: [],
  headless: (p) => ['-p', p],
  billing: 'test',
  ...over,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dossier-cli-'));
  originalPath = process.env['PATH'];
  process.env['PATH'] = dir;
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = originalPath;
  await rm(dir, { recursive: true, force: true });
});

describe('resolving a binary', () => {
  it('finds an executable on PATH and ignores a non-executable file', async () => {
    await writeFile(join(dir, 'notexec'), 'x');
    await fakeBin('faketool', 'anything');
    expect(resolveOnPath('faketool')).toBe(join(dir, 'faketool'));
    expect(resolveOnPath('notexec')).toBeNull();
    expect(resolveOnPath('definitely-not-installed')).toBeNull();
  });
});

describe('identity confirmation', () => {
  it('accepts a binary whose version names the product', async () => {
    await fakeBin('faketool', 'Test CLI 1.2.3');
    const status = await probeCli(adapter({}));
    // No auth path declared, so it stops short of `ready` rather than guessing.
    expect(status.state).toBe('present-unauthed');
    expect(status.version).toContain('Test CLI');
  });

  it('refuses a binary of the right name that reports the wrong product', async () => {
    // The collision case, exactly: `grok` on PATH is not necessarily xAI's.
    await fakeBin('faketool', 'some-other-vendor 9.9.9');
    const status = await probeCli(adapter({}));
    expect(status.state).toBe('ambiguous');
    expect(status.detail).toMatch(/does not identify it/);
  });

  it('falls back to install path when the tool names nothing in its version', async () => {
    // Cursor's agent reports `2026.07.17-3e2a980` and nothing else, so version
    // matching cannot work and path provenance is the only signal left.
    await fakeBin('faketool', '2026.07.17-3e2a980');
    const bare = await probeCli(adapter({ identity: null }));
    expect(bare.state).toBe('ambiguous');
    const byPath = await probeCli(adapter({ identity: null, pathHints: ['dossier-cli-'] }));
    expect(byPath.state).toBe('present-unauthed');
    // And when it does reach ready, it says which signal identified it, since
    // "the path looked right" is weaker evidence than "it told us its name".
    const authPath = join(dir, 'auth.json');
    await writeFile(authPath, '{}');
    const ready = await probeCli(adapter({ identity: null, pathHints: ['dossier-cli-'], authPaths: [authPath] }));
    expect(ready.state).toBe('ready');
    expect(ready.detail).toMatch(/identified by install path rather than version string/);
  });

  it('reports a binary that will not answer --version as ambiguous, not ready', async () => {
    const path = join(dir, 'faketool');
    await writeFile(path, '#!/bin/sh\nexit 3\n');
    await chmod(path, 0o755);
    const status = await probeCli(adapter({}));
    expect(status.state).toBe('ambiguous');
  });

  it('reports an absent binary without running anything', async () => {
    const status = await probeCli(adapter({}));
    expect(status.state).toBe('absent');
    expect(status.path).toBeUndefined();
  });

  it('reaches ready only with identity AND a sign-in file', async () => {
    await fakeBin('faketool', 'Test CLI 1.2.3');
    const authPath = join(dir, 'auth.json');
    const unauthed = await probeCli(adapter({ authPaths: [authPath] }));
    expect(unauthed.state).toBe('present-unauthed');
    await writeFile(authPath, '{}');
    const authed = await probeCli(adapter({ authPaths: [authPath] }));
    expect(authed.state).toBe('ready');
  });
});

describe('the shipped adapters', () => {
  it('date and source every subscription claim', () => {
    // Gemini CLI's consumer tier vanished between two releases of its own
    // README. A coverage claim with no date is a claim that will silently rot.
    for (const a of CLI_ADAPTERS) {
      expect(a.billing, a.id).toMatch(/20\d\d|unconfirmed|NOT/i);
    }
  });

  it('warns about the Claude Code billing trap', () => {
    // ANTHROPIC_API_KEY outranks the subscription in -p mode with no prompt,
    // which silently converts a free run into a metered one.
    const claude = CLI_ADAPTERS.find((a) => a.id === 'claude');
    expect(claude?.caution).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('does not present Gemini CLI as a subscription path', () => {
    const gemini = CLI_ADAPTERS.find((a) => a.id === 'gemini');
    expect(gemini?.billing).toMatch(/API key only/i);
    expect(gemini?.billing).toMatch(/withdrawn/i);
  });

  it('passes the brief as an argv element, never through a shell', () => {
    // A research question containing a backtick must be a question, not a
    // command substitution.
    for (const a of CLI_ADAPTERS) {
      const argv = a.headless('what is `rm -rf /` in shell?');
      expect(argv, a.id).toContain('what is `rm -rf /` in shell?');
    }
  });
});

describe('path provenance is directory provenance', () => {
  it('does not accept a binary because its own filename matches the hint', async () => {
    // `pathHints: ['claude']` matched against the full path is satisfied by the
    // binary being called `claude`, which is the one fact already known. So a
    // hostile `claude` on PATH printing anything at all would have been
    // "identified by install path". Hints are matched against the directory.
    await fakeBin('faketool', 'not a real product');
    const byOwnName = await probeCli(adapter({ identity: null, pathHints: ['faketool'] }));
    expect(byOwnName.state).toBe('ambiguous');
  });

  it('accepts a binary living in the vendor’s own directory', async () => {
    await fakeBin('faketool', 'not a real product');
    // The temp directory stands in for `~/.grok/` or `~/.codex/`.
    const byDir = await probeCli(adapter({ identity: null, pathHints: ['dossier-cli-'] }));
    expect(byDir.state).toBe('present-unauthed');
  });
});
