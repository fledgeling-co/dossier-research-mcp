import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLI_ADAPTERS,
  normaliseModelName,
  parseModelAnswer,
  probeCli,
  probeCliModel,
  resolveOnPath,
  type CliAdapter,
} from '../src/local/cli.js';
import { describeProbeAge, readModelCache, writeModelCache } from '../src/local/model-cache.js';

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

/* ------------------------------------------------------- model identity ---- */

/**
 * Asking a CLI which model it serves.
 *
 * Nothing here runs a real CLI or spends anything: the fake binary answers
 * `--version` and a `-p` prompt differently, which is exactly the shape the
 * probe drives. The load-bearing behaviour is refusal again, for the same
 * reason as identity: a one-line question handed to an unidentified binary is
 * still a prompt handed to a vendor nobody chose.
 */
async function fakeCli(name: string, version: string, answer: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; else echo "${answer}"; fi\n`,
  );
  await chmod(path, 0o755);
  return path;
}

/** An adapter that will reach `ready`: identity from the version, auth from a file. */
async function readyAdapter(over: Partial<CliAdapter> = {}): Promise<CliAdapter> {
  const authPath = join(dir, 'auth.json');
  await writeFile(authPath, '{}');
  return adapter({ authPaths: [authPath], ...over });
}

describe('CLI-23: the model probe refuses anything it has not identified', () => {
  it('does not prompt a binary whose identity is unconfirmed', async () => {
    await fakeCli('faketool', 'some-other-vendor 9.9.9', 'MODEL=Composer');
    const probe = await probeCliModel(await readyAdapter());
    expect(probe.state).toBe('refused');
    expect(probe.model).toBeUndefined();
    expect(probe.detail).toMatch(/could not be identified/);
  });

  it('does not prompt a CLI nobody has signed into', async () => {
    await fakeCli('faketool', 'Test CLI 1.2.3', 'MODEL=Composer');
    const probe = await probeCliModel(adapter({ authPaths: [join(dir, 'missing.json')] }));
    expect(probe.state).toBe('refused');
    expect(probe.detail).toMatch(/not signed in/);
  });

  it('does not prompt a CLI that is not installed', async () => {
    const probe = await probeCliModel(await readyAdapter());
    expect(probe.state).toBe('refused');
    expect(probe.detail).toMatch(/not installed/);
  });

  it('asks an identified, signed-in CLI and reports what it answered', async () => {
    await fakeCli('faketool', 'Test CLI 1.2.3', 'MODEL=Composer');
    const probe = await probeCliModel(await readyAdapter());
    expect(probe.state).toBe('probed');
    expect(probe.model).toBe('Composer');
  });

  it('reports a CLI that answers in some other shape as unreadable, and caches nothing', async () => {
    await fakeCli('faketool', 'Test CLI 1.2.3', 'I am an AI assistant and cannot say');
    const probe = await probeCliModel(await readyAdapter());
    expect(probe.state).toBe('unreadable');
    expect(probe.model).toBeUndefined();
  });
});

describe('CLI-24: reading the answer', () => {
  it('finds MODEL= inside a noisy reply and strips the decoration', () => {
    expect(parseModelAnswer('thinking...\nMODEL=Grok 4.5\n')).toBe('Grok 4.5');
    expect(parseModelAnswer('`MODEL=Composer`')).toBe('Composer');
    expect(parseModelAnswer('**MODEL=Composer**')).toBe('Composer');
    expect(parseModelAnswer('model = claude-opus-4.6')).toBe('claude-opus-4.6');
  });

  it('keeps a trailing dot that is part of the version', () => {
    // Trimming it would rename Grok 4.5 to Grok 4, which is a different model
    // and would compare unequal to every other spelling of the same one.
    expect(parseModelAnswer('MODEL=Grok 4.5')).toBe('Grok 4.5');
  });

  it('refuses the prompt echoed back, rather than caching the placeholder', () => {
    // Two CLIs that both echoed would look like one model and one of them
    // would silently lose its seat on the panel.
    expect(parseModelAnswer('MODEL=<the name of the model writing this reply>')).toBeNull();
    expect(parseModelAnswer('no answer here')).toBeNull();
    expect(parseModelAnswer('MODEL=   ')).toBeNull();
  });

  it('compares models by shape, not by punctuation', () => {
    expect(normaliseModelName('Grok 4.5')).toBe(normaliseModelName('grok-4.5'));
    expect(normaliseModelName('Grok_4.5')).toBe('grok 4.5');
    // And keeps two genuinely different models apart, including the version.
    expect(normaliseModelName('Grok 4.5')).not.toBe(normaliseModelName('Grok 4'));
    expect(normaliseModelName('Composer')).not.toBe(normaliseModelName('Grok 4.5'));
  });
});

describe('CLI-25: the probed-model cache', () => {
  it('round-trips a reading with its timestamp', async () => {
    await writeModelCache(dir, new Map([['cursor', 'Composer']]), 1_700_000_000_000);
    const cache = readModelCache(dir);
    expect(cache.get('cursor')?.model).toBe('Composer');
    expect(cache.get('cursor')?.probedAt).toBe(1_700_000_000_000);
    // Derived on read, so an edited file cannot make the comparison key
    // disagree with the model name printed beside it.
    expect(cache.get('cursor')?.normalised).toBe('composer');
  });

  it('merges rather than replacing, so probing one CLI does not un-probe the rest', async () => {
    await writeModelCache(dir, new Map([['cursor', 'Composer']]), 1_700_000_000_000);
    await writeModelCache(dir, new Map([['grok', 'Grok 4.5']]), 1_700_000_001_000);
    const cache = readModelCache(dir);
    expect(cache.get('cursor')?.model).toBe('Composer');
    expect(cache.get('grok')?.model).toBe('Grok 4.5');
  });

  it('reads a corrupt or absent file back as never-probed rather than throwing', async () => {
    expect(readModelCache(join(dir, 'nothing-here')).size).toBe(0);
    await writeFile(join(dir, 'cli-models.json'), '{ not json');
    expect(readModelCache(dir).size).toBe(0);
    // An unknown envelope is not half-believed either. Losing the cache costs a
    // warning; trusting a malformed one could drop a backend someone pays for.
    await writeFile(join(dir, 'cli-models.json'), JSON.stringify({ version: 9, entries: {} }));
    expect(readModelCache(dir).size).toBe(0);
  });

  it('skips a malformed entry and keeps the rest of the file', async () => {
    await writeFile(
      join(dir, 'cli-models.json'),
      JSON.stringify({
        version: 1,
        entries: {
          cursor: { model: 'Composer', probedAt: 1_700_000_000_000 },
          grok: { model: '', probedAt: 1_700_000_000_000 },
          codex: { model: 'GPT-5.6' },
          'not-a-cli': { model: 'x', probedAt: 1 },
        },
      }),
    );
    const cache = readModelCache(dir);
    expect([...cache.keys()]).toEqual(['cursor']);
  });

  it('never writes an empty probe, so a failed run leaves the last answer alone', async () => {
    await writeModelCache(dir, new Map([['cursor', 'Composer']]), 1_700_000_000_000);
    await writeModelCache(dir, new Map());
    expect(readModelCache(dir).get('cursor')?.model).toBe('Composer');
  });

  it('reports the age of a reading in words', () => {
    const now = 1_700_000_000_000;
    expect(describeProbeAge(now, now)).toBe('just now');
    expect(describeProbeAge(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(describeProbeAge(now - 3 * 3_600_000, now)).toBe('3 hours ago');
    expect(describeProbeAge(now - 2 * 86_400_000, now)).toBe('2 days ago');
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
