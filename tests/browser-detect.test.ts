import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BROWSER_TOOLS,
  DETECTION_IS_NOT_PERMISSION,
  probeAllBrowserTools,
  probeBrowserTool,
  renderBrowserTools,
  type BinaryBrowserTool,
  type PackageBrowserTool,
} from '../src/local/browser.js';

/**
 * Browser tooling detection.
 *
 * Two things are load-bearing and neither is "does it find the tool". The first
 * is refusal: an unidentified binary must be reported rather than believed, the
 * same rule `local-cli.test.ts` enforces for coding CLIs. The second is that
 * detecting a *package* must not become installing one, and must not become
 * reading the client config where other servers keep their API keys.
 */

let dir: string;
let originalPath: string | undefined;

async function fakeBin(at: string, name: string, prints: string): Promise<string> {
  const path = join(at, name);
  await writeFile(path, `#!/bin/sh\necho "${prints}"\n`);
  await chmod(path, 0o755);
  return path;
}

const binary = (over: Partial<BinaryBrowserTool>): BinaryBrowserTool => ({
  id: 'playwright-cli',
  label: 'Test Driver',
  kind: 'binary',
  bin: 'fakedriver',
  versionArgs: ['--version'],
  identity: /test driver/i,
  pathHints: [],
  probeRationale: 'test',
  reachesExistingSession: 'test',
  install: 'test',
  ...over,
});

const pkg = (over: Partial<PackageBrowserTool>): PackageBrowserTool => ({
  id: 'chrome-devtools-mcp',
  label: 'Test Server',
  kind: 'package',
  packageName: 'test-mcp',
  probeRationale: 'test',
  reachesExistingSession: 'test',
  install: 'test',
  ...over,
});

/** The module's own source, for the assertions that are about what it never does. */
const source = await readFile(new URL('../src/local/browser.ts', import.meta.url), 'utf8');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dossier-browser-'));
  originalPath = process.env['PATH'];
  process.env['PATH'] = dir;
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = originalPath;
  await rm(dir, { recursive: true, force: true });
});

// BROWSER-01
describe('identifying a browser binary', () => {
  it('accepts a binary whose version names the product', async () => {
    await fakeBin(dir, 'fakedriver', 'Test Driver 1.55.0');
    const s = await probeBrowserTool(binary({}));
    expect(s.state).toBe('present');
    expect(s.version).toContain('Test Driver');
  });

  it('refuses a binary of the right name that names a different product', async () => {
    await fakeBin(dir, 'fakedriver', 'some-other-vendor 9.9.9');
    const s = await probeBrowserTool(binary({}));
    expect(s.state).toBe('ambiguous');
    expect(s.detail).toMatch(/does not identify it/);
  });

  it('falls back to install-path provenance, and says that is what identified it', async () => {
    // Playwright prints a bare `Version 1.55.0` that names no product, which is
    // exactly the Cursor problem in cli.ts. npm's namespace is the only
    // provenance left: nobody but the package owner can be in
    // `node_modules/playwright/`.
    const nested = join(dir, 'node_modules', 'playwright');
    await mkdir(nested, { recursive: true });
    await fakeBin(nested, 'fakedriver', 'Version 1.55.0');
    process.env['PATH'] = nested;

    const bare = await probeBrowserTool(binary({ identity: null }));
    expect(bare.state).toBe('ambiguous');

    const byPath = await probeBrowserTool(
      binary({ identity: null, pathHints: ['node_modules/playwright'] }),
    );
    expect(byPath.state).toBe('present');
    expect(byPath.detail).toMatch(/identified by install path rather than version string/);
  });

  it('does not treat a lookalike package name as the vendor', async () => {
    // npm lets anyone publish `playwright-helper`, so a substring hint would
    // hand a stranger's package the Playwright authors' provenance.
    const nested = join(dir, 'node_modules', 'playwright-helper');
    await mkdir(nested, { recursive: true });
    await fakeBin(nested, 'fakedriver', 'Version 1.55.0');
    process.env['PATH'] = nested;
    const s = await probeBrowserTool(
      binary({ identity: null, pathHints: ['node_modules/playwright'] }),
    );
    expect(s.state).toBe('ambiguous');
  });

  it('does not accept a binary because its own filename matches the hint', async () => {
    // A hint matched against the whole path is satisfied by the binary being
    // *named* that, which is the one fact already known and proves nothing.
    await fakeBin(dir, 'fakedriver', 'nothing identifying');
    const s = await probeBrowserTool(binary({ identity: null, pathHints: ['fakedriver'] }));
    expect(s.state).toBe('ambiguous');
  });

  it('reports a binary that will not answer --version as ambiguous, not present', async () => {
    const path = join(dir, 'fakedriver');
    await writeFile(path, '#!/bin/sh\nexit 3\n');
    await chmod(path, 0o755);
    const s = await probeBrowserTool(binary({}));
    expect(s.state).toBe('ambiguous');
    expect(s.detail).toMatch(/nothing further was run/);
  });

  it('reports an absent binary without running anything', async () => {
    const s = await probeBrowserTool(binary({}));
    expect(s.state).toBe('absent');
    expect(s.path).toBeUndefined();
  });
});

// BROWSER-02
describe('an MCP server package is found, never fetched', () => {
  it('finds a package by directory existence', async () => {
    const root = join(dir, 'roots');
    await mkdir(join(root, 'test-mcp'), { recursive: true });
    const s = await probeBrowserTool(pkg({}), { packageRoots: [root] });
    expect(s.state).toBe('present');
    expect(s.path).toBe(join(root, 'test-mcp'));
  });

  it('resolves a scoped name as a nested directory', async () => {
    const root = join(dir, 'roots');
    await mkdir(join(root, '@scope', 'thing'), { recursive: true });
    const s = await probeBrowserTool(pkg({ packageName: '@scope/thing' }), {
      packageRoots: [root],
    });
    expect(s.state).toBe('present');
  });

  it('never invokes npx, because npx would download and execute the package', async () => {
    // The whole point of probing a package differently from a binary. If anyone
    // ever "improves" this to ask `npx chrome-devtools-mcp --version`, this
    // fake on PATH gets run and leaves the marker behind.
    const marker = join(dir, 'npx-was-invoked');
    await fakeBin(dir, 'npx', 'x');
    await writeFile(join(dir, 'npx'), `#!/bin/sh\ntouch "${marker}"\n`);
    await chmod(join(dir, 'npx'), 0o755);
    await writeFile(join(dir, 'npm'), `#!/bin/sh\ntouch "${marker}"\n`);
    await chmod(join(dir, 'npm'), 0o755);

    const all = await probeAllBrowserTools({ packageRoots: [] });
    expect(all.filter((s) => s.kind === 'package').every((s) => s.state === 'absent')).toBe(true);
    await expect(access(marker)).rejects.toThrow();
  });
});

// BROWSER-03
describe('client registration is never read', () => {
  it('reports registration unknown whether the package is there or not', async () => {
    const root = join(dir, 'roots');
    await mkdir(join(root, 'test-mcp'), { recursive: true });
    const present = await probeBrowserTool(pkg({}), { packageRoots: [root] });
    const absent = await probeBrowserTool(pkg({}), { packageRoots: [] });
    expect(present.registration).toBe('unknown');
    expect(absent.registration).toBe('unknown');
    expect(present.detail).toMatch(/API keys/);
  });

  it('names no client config file anywhere in the module', () => {
    // Registration lives next to other servers' env blocks, which hold their
    // API keys. A cosmetic question is not worth reading those.
    for (const config of ['.claude.json', 'claude_desktop_config', 'mcp.json', 'settings.json']) {
      expect(source, config).not.toContain(config);
    }
  });

  it('does not attach registration to a binary, which has none', async () => {
    await fakeBin(dir, 'fakedriver', 'Test Driver 1.0');
    const s = await probeBrowserTool(binary({}));
    expect(s.registration).toBeUndefined();
  });
});

// BROWSER-04
describe('detection is not permission', () => {
  it('carries the opt-in gate on every status, in every state', async () => {
    const all = await probeAllBrowserTools({ packageRoots: [] });
    expect(all).toHaveLength(BROWSER_TOOLS.length);
    for (const s of all) {
      expect(s.permission, s.id).toContain('DOSSIER_BROWSER_PROVIDER');
      expect(s.permission, s.id).toMatch(/never type a password/);
    }
  });

  it('states it once, prominently, in the rendered section', async () => {
    const rendered = renderBrowserTools(await probeAllBrowserTools({ packageRoots: [] }));
    expect(rendered).toContain(DETECTION_IS_NOT_PERMISSION);
    expect(rendered).toMatch(/has no browser of its own/);
  });
});

// BROWSER-05
describe('no probe goes near a credential store', () => {
  it('opens no file: the module lists directories and asks one binary its version', () => {
    // cli.ts checks a sign-in file by existence and never opens it. A browser
    // driver has no such file, because the session belongs to Chrome, so the
    // equivalent here would mean walking a browser profile and its cookie
    // store. There is therefore no read at all.
    for (const read of [/\breadFile\b/, /\breadFileSync\b/, /createReadStream/, /\bopenSync\b/]) {
      expect(source, String(read)).not.toMatch(read);
    }
  });

  it('names no browser profile or cookie store', () => {
    for (const p of ['Cookies', 'Login Data', 'Default/Preferences', 'Local State']) {
      expect(source, p).not.toContain(p);
    }
  });

  it('reports no sign-in state, because it cannot honestly know one', async () => {
    const all = await probeAllBrowserTools({ packageRoots: [] });
    for (const s of all) {
      expect(s, s.id).not.toHaveProperty('signedIn');
      // What it says instead is a documented property of the driver, and every
      // one of them says something.
      expect(s.reachesExistingSession.length, s.id).toBeGreaterThan(0);
    }
  });
});

// BROWSER-06
describe('a package is never described as an executable', () => {
  it('carries the probe kind on every status and prints it', async () => {
    const all = await probeAllBrowserTools({ packageRoots: [] });
    const rendered = renderBrowserTools(all);
    for (const s of all) {
      expect(['binary', 'package'], s.id).toContain(s.kind);
      expect(rendered).toContain(`Probe: ${s.kind}, because ${s.probeRationale}`);
    }
    expect(rendered).toContain('Probe: package');
    expect(rendered).toContain('Probe: binary');
  });

  it('gives every shipped tool its own stated reason for the probe it gets', () => {
    const reasons = new Set(BROWSER_TOOLS.map((t) => t.probeRationale));
    expect(reasons.size).toBe(BROWSER_TOOLS.length);
    for (const t of BROWSER_TOOLS) expect(t.probeRationale.length, t.id).toBeGreaterThan(40);
  });
});
