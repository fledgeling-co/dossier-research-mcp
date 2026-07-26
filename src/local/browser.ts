import { execFile } from 'node:child_process';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { resolveOnPath } from './cli.js';

const run = promisify(execFile);

/**
 * Browser tooling on this machine, detected and never driven.
 *
 * `docs/providers/browser-sessions.md` owns this area and its three hard rules
 * bind everything here. Dossier has no browser of its own. Dossier will never
 * type a password. Mode B automation stays opt-in behind
 * `DOSSIER_BROWSER_PROVIDER`. **Detection is not permission.** Nothing in this
 * file starts a browser, attaches to one, or moves a run any closer to being
 * automated. It answers "what is installed" so `research_doctor` and the setup
 * wizard can stop guessing, and it stops there.
 *
 * ## Why there are two kinds of probe
 *
 * The four tools are not four instances of one thing, and probing them
 * identically would be wrong in a way that costs something real.
 *
 * A **binary** on `PATH` gets the full `cli.ts` discipline: resolve the
 * absolute path, `realpath` through the symlink, ask `--version`, confirm
 * identity by version string or by install-path provenance, and report
 * `ambiguous` rather than guessing. The name on `PATH` is never trusted, for
 * the same reason it is never trusted for a coding CLI.
 *
 * A **package** that a client launches through `npx` is a different kind of
 * object and must not be probed as if it were a binary. Two reasons, both hard:
 *
 * 1. **`npx` is not a probe, it is an installer.** `npx chrome-devtools-mcp
 *    --version` on a machine that does not have the package **downloads it from
 *    the registry and executes it**. A detector that fetches and runs
 *    third-party code in order to find out whether that code is present has
 *    answered its own question by making it true, and has run something the
 *    user never asked for. So `npx` is never invoked here. Presence is
 *    established by looking for the package directory where npm would have put
 *    it, and that directory is never opened.
 *
 * 2. **Registration lives in the client's config, which is not ours to read.**
 *    Whether an MCP server is actually wired into Claude Code, Cursor or VS
 *    Code is recorded in that client's own configuration file, alongside every
 *    *other* server's `env` block. Those blocks routinely hold API keys.
 *    Reading someone's client config to answer a cosmetic question would mean
 *    reading their other tools' credentials, so registration is reported
 *    `unknown`, permanently and by design, and the user is asked to check their
 *    client.
 *
 * ## What is deliberately not detected
 *
 * **Whether you are signed into anything.** The coding CLIs keep a sign-in file
 * of their own, so `cli.ts` can check that one exists without opening it. A
 * browser driver has no such file: the session that matters belongs to
 * *Chrome*, and finding it would mean going into a browser profile directory
 * and its cookie store. That is a credential store, and Dossier does not look
 * in it. Nothing in this module reads a file at all; it lists directories and
 * asks one binary for its version. Whether a driver can reach an existing login
 * is therefore carried as a documented property of the driver, sourced from
 * `browser-sessions.md`, rather than as a probe result.
 */

export const BROWSER_TOOL_IDS = [
  'playwright-cli',
  'browser-use',
  'chrome-devtools-mcp',
  'playwright-mcp',
] as const;
export type BrowserToolId = (typeof BROWSER_TOOL_IDS)[number];

/**
 * How a tool can legitimately be found.
 *
 * Carried on every status so a reader can never mistake a package on disk for a
 * runnable executable. The two answers mean genuinely different things: a
 * confirmed binary was executed once, with `--version`; a present package was
 * only ever seen to exist.
 */
export type BrowserProbeKind = 'binary' | 'package';

/**
 * The one sentence every reported tool carries.
 *
 * Kept as a constant rather than written into each renderer because the gap
 * between "Dossier can see this" and "Dossier may use this" is the single thing
 * a reader of a detection report is most likely to close wrongly.
 */
export const DETECTION_IS_NOT_PERMISSION =
  'Detection is not permission. Dossier drives none of these. Mode B automation stays opt-in behind DOSSIER_BROWSER_PROVIDER, and Dossier will never type a password.';

interface BrowserToolBase {
  readonly id: BrowserToolId;
  readonly label: string;
  /** Why this probe and not another. Stated per tool, on purpose. */
  readonly probeRationale: string;
  /**
   * Whether this driver can reach a page behind an existing browser login.
   *
   * A documented claim from `docs/providers/browser-sessions.md`, not a probe
   * result. It is the property that decides whether a driver is any use for
   * spending a subscription, and it cannot be detected without reading a
   * browser profile.
   */
  readonly reachesExistingSession: string;
  readonly install: string;
  readonly caution?: string;
}

export interface BinaryBrowserTool extends BrowserToolBase {
  readonly kind: 'binary';
  readonly bin: string;
  readonly versionArgs: readonly string[];
  /** What `--version` must contain to prove identity. `null` means it proves nothing. */
  readonly identity: RegExp | null;
  /**
   * Path segments identifying the vendor, matched against the directory the
   * binary resolves into and never against the whole path. See
   * `matchesPathHint` for why the match is segment-bounded rather than a
   * substring.
   */
  readonly pathHints: readonly string[];
}

export interface PackageBrowserTool extends BrowserToolBase {
  readonly kind: 'package';
  /** The npm package name, as it appears as a directory under a `node_modules` root. */
  readonly packageName: string;
}

export type BrowserToolAdapter = BinaryBrowserTool | PackageBrowserTool;

export const BROWSER_TOOLS: readonly BrowserToolAdapter[] = [
  {
    id: 'playwright-cli',
    label: 'Playwright CLI',
    kind: 'binary',
    bin: 'playwright',
    versionArgs: ['--version'],
    // Prints `Version 1.55.0`: a bare number naming no product, which is the
    // same problem Cursor's agent has in `cli.ts`. The regex is kept anyway
    // because some builds do print the name, and a match is stronger evidence
    // than provenance; when it does not match, identity falls to the path.
    identity: /playwright/i,
    // npm's registry namespace is real provenance: only the owner of the
    // `playwright` package can occupy `node_modules/playwright`. Matched
    // against the resolved directory, so a binary merely *named* `playwright`
    // does not satisfy it.
    pathHints: ['node_modules/playwright', 'node_modules/playwright-core'],
    probeRationale:
      'a real executable that answers --version offline and cheaply, so the full cli.ts discipline applies: resolve, realpath, ask, confirm, or report ambiguous',
    reachesExistingSession:
      'Only through the Playwright browser extension. A plain `playwright` launch gets a fresh profile, which your logins are not in and which Google actively blocks sign-in from.',
    install: 'npm i -g playwright',
  },
  {
    id: 'browser-use',
    label: 'browser-use',
    kind: 'binary',
    bin: 'browser-use',
    versionArgs: ['--version'],
    identity: /browser.?use/i,
    // Deliberately short, and it will usually miss. A pip or uv console script
    // resolves into a plain `bin/` directory that names no vendor, so identity
    // has to come from the version string and an unidentifiable one is reported
    // ambiguous. `~/.local/bin` is NOT a hint: anything at all can be installed
    // there, so treating it as provenance would identify any binary that
    // happened to take the name, which is the whole failure this guards.
    pathHints: ['browser-use', 'browser_use'],
    probeRationale:
      'a console script on PATH, so it is a binary, but given a longer timeout than the coding CLIs because a Python entry point pays import cost before it can answer; a timeout reports ambiguous rather than running anything further',
    reachesExistingSession:
      'No. It drives its own profile, so your existing logins are absent unless you persist state into it yourself.',
    install: 'pip install browser-use',
    caution:
      'Drives a browser autonomously by design. Dossier does not invoke it; this is inventory, not activation.',
  },
  {
    id: 'chrome-devtools-mcp',
    label: 'Chrome DevTools MCP',
    kind: 'package',
    packageName: 'chrome-devtools-mcp',
    probeRationale:
      'an MCP server a client launches through npx, not a binary anyone runs, so presence on disk is the only safe question: `npx chrome-devtools-mcp --version` would DOWNLOAD and EXECUTE the package on a machine that does not have it, which is installation dressed as detection',
    reachesExistingSession:
      'Yes with --autoConnect on Chrome 144+, which you approve once at chrome://inspect. Its default mode uses a fresh profile and cannot.',
    install:
      'claude mcp add chrome-devtools --scope user -- npx chrome-devtools-mcp@latest --autoConnect',
  },
  {
    id: 'playwright-mcp',
    label: 'Playwright MCP',
    kind: 'package',
    packageName: '@playwright/mcp',
    probeRationale:
      'the same shape as chrome-devtools-mcp, a package a client launches through npx, so presence on disk only and for the same reason; the scoped name means the probe looks for `@playwright/mcp` as a nested directory rather than a single one',
    reachesExistingSession:
      'Yes with --extension, where you install the Playwright browser extension and pick which tab it may use.',
    install: 'claude mcp add playwright --scope user -- npx @playwright/mcp@latest --extension',
  },
];

export type BrowserToolState = 'absent' | 'ambiguous' | 'present';

export interface BrowserToolStatus {
  readonly id: BrowserToolId;
  readonly label: string;
  readonly kind: BrowserProbeKind;
  readonly state: BrowserToolState;
  readonly detail: string;
  readonly path?: string;
  readonly version?: string;
  /**
   * Whether a client has this MCP server wired up.
   *
   * Always `'unknown'`, and only present on `package` tools. Registration is
   * recorded in the client's own config file next to other servers' API keys,
   * so Dossier does not look. An honest unknown beats a guess dressed as a
   * fact.
   */
  readonly registration?: 'unknown';
  readonly reachesExistingSession: string;
  readonly probeRationale: string;
  readonly permission: string;
  readonly install: string;
  readonly caution?: string;
}

export interface BrowserProbeOptions {
  /** Hard cap on the one `--version` call a binary probe makes. */
  readonly timeoutMs?: number;
  /**
   * Where to look for packages. Replaces the machine's real npm roots entirely.
   *
   * Present so a test can be deterministic. Detection that consults the
   * developer's own global `node_modules` passes or fails depending on what
   * that developer happens to have installed, which is the same defect the
   * provider registry tests had.
   */
  readonly packageRoots?: readonly string[];
}

/**
 * Probe one browser tool. Local, offline, and it reads no file.
 *
 * A binary is executed exactly once, with `--version`, no shell and a hard
 * timeout. A package is never executed at all.
 */
export async function probeBrowserTool(
  tool: BrowserToolAdapter,
  opts: BrowserProbeOptions = {},
): Promise<BrowserToolStatus> {
  const base: Omit<BrowserToolStatus, 'state' | 'detail'> = {
    id: tool.id,
    label: tool.label,
    kind: tool.kind,
    reachesExistingSession: tool.reachesExistingSession,
    probeRationale: tool.probeRationale,
    permission: DETECTION_IS_NOT_PERMISSION,
    install: tool.install,
    ...(tool.caution === undefined ? {} : { caution: tool.caution }),
  };

  if (tool.kind === 'package') {
    const roots = opts.packageRoots ?? (await packageRoots());
    const found = await findPackageDir(tool.packageName, roots);
    return found === null
      ? {
          ...base,
          state: 'absent',
          registration: 'unknown',
          detail: `\`${tool.packageName}\` is not in any npm root or npx cache on this machine`,
        }
      : {
          ...base,
          state: 'present',
          path: found,
          registration: 'unknown',
          detail:
            `\`${tool.packageName}\` is present on disk. Whether it is registered with your MCP client is not checked: ` +
            "that lives in the client's own config alongside other servers' API keys, so Dossier does not read it. Ask your client.",
        };
  }

  const found = resolveOnPath(tool.bin);
  if (found === null) {
    return { ...base, state: 'absent', detail: `\`${tool.bin}\` is not on PATH` };
  }
  const real = await realpath(found).catch(() => found);

  let version: string;
  try {
    const { stdout, stderr } = await run(real, [...tool.versionArgs], {
      timeout: opts.timeoutMs ?? 6_000,
    });
    version = `${stdout} ${stderr}`.trim().split('\n')[0]?.trim() ?? '';
  } catch {
    return {
      ...base,
      state: 'ambiguous',
      path: real,
      detail:
        'the binary resolved but did not answer --version in time, so its identity is unconfirmed and nothing further was run',
    };
  }

  const identified = tool.identity ? tool.identity.test(version) : false;
  const byPath = tool.pathHints.some((hint) => matchesPathHint(dirname(real), hint));
  if (!identified && !byPath) {
    return {
      ...base,
      state: 'ambiguous',
      path: real,
      version,
      detail:
        `\`${tool.bin}\` resolves to ${real} but reports "${version}", which does not identify it as ${tool.label}. ` +
        'It is reported rather than assumed, and Dossier drives nothing either way.',
    };
  }

  return {
    ...base,
    state: 'present',
    path: real,
    version,
    detail: `installed (${version})${identified ? '' : ', identified by install path rather than version string'}`,
  };
}

/**
 * Does a resolved directory sit at, or inside, a vendor's own directory.
 *
 * Segment-bounded rather than a plain substring, which is stricter than the
 * equivalent check in `cli.ts` and deliberately so. The hints here are npm
 * package paths, and npm lets **anyone** publish `playwright-anything`; a
 * substring hint of `node_modules/playwright` would therefore treat a stranger's
 * `node_modules/playwright-helper` as provenance from the Playwright authors,
 * which is the exact confusion this whole mechanism exists to prevent. The
 * boundary also fixes the other direction: a hint written with a trailing slash
 * matched nothing at all, because the directory the binary resolves into is the
 * package directory itself and has no trailing slash.
 */
function matchesPathHint(dir: string, hint: string): boolean {
  const needle = hint.replace(/^\/+|\/+$/g, '');
  return dir === needle || dir.endsWith(`/${needle}`) || dir.includes(`/${needle}/`);
}

/** Probe every known browser tool at once. Bounded, so a hung binary cannot wedge it. */
export async function probeAllBrowserTools(
  opts: BrowserProbeOptions = {},
): Promise<BrowserToolStatus[]> {
  const roots = opts.packageRoots ?? (await packageRoots());
  return Promise.all(
    BROWSER_TOOLS.map((t) =>
      probeBrowserTool(t, {
        ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
        packageRoots: roots,
      }),
    ),
  );
}

const STATE_ICON: Record<BrowserToolState, string> = {
  present: '✅ PRESENT',
  ambiguous: '❓ AMBIGUOUS',
  absent: '⚪ NOT INSTALLED',
};

/**
 * Render the doctor's browser section.
 *
 * Lives here rather than in `server.ts` so the wording that keeps detection
 * separate from permission can be asserted by a unit test rather than only by
 * an acceptance one.
 */
export function renderBrowserTools(statuses: readonly BrowserToolStatus[]): string {
  const lines: string[] = [
    '## Browser tooling on this machine',
    '',
    'Dossier has no browser of its own and starts none. This is an inventory, so you know which of the',
    'documented drivers you already have; nothing here changes what runs.',
    '',
    `> ${DETECTION_IS_NOT_PERMISSION}`,
    '',
  ];
  for (const s of statuses) {
    lines.push(`### ${STATE_ICON[s.state]} · ${s.label}`);
    lines.push(`- ${s.detail}`);
    if (s.path) lines.push(`- Path: \`${s.path}\``);
    lines.push(`- Probe: ${s.kind}, because ${s.probeRationale}`);
    if (s.registration) lines.push(`- Registered with your MCP client: ${s.registration}`);
    lines.push(`- Reaches an existing login: ${s.reachesExistingSession}`);
    if (s.state !== 'present') lines.push(`- Install: \`${s.install}\``);
    if (s.caution) lines.push(`- ⚠ ${s.caution}`);
    lines.push('');
  }
  lines.push(
    'Which drivers reach a logged-in tab and why a fresh automated profile cannot: `docs/providers/browser-sessions.md`.',
  );
  return lines.join('\n');
}

/**
 * The npm roots a globally installed package could be under, plus the npx cache.
 *
 * Derived statically rather than by shelling out to `npm root -g`, which is
 * slow and which on a misconfigured machine prints a path that does not exist
 * anyway. Missing roots simply never match.
 */
async function packageRoots(): Promise<string[]> {
  const roots = [
    // The standard layout for any Node install: the binary is at
    // `<prefix>/bin/node`, global packages at `<prefix>/lib/node_modules`.
    resolve(dirname(process.execPath), '..', 'lib', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
    join(homedir(), '.npm-global', 'lib', 'node_modules'),
  ];
  const prefix = process.env['npm_config_prefix'];
  if (prefix) roots.push(join(prefix, 'lib', 'node_modules'));

  // npm's `_npx` cache is where `npx pkg@latest` actually leaves a package, so
  // it is the likeliest place for an MCP server a client launches that way. It
  // is a directory of hashed names, so it needs one listing. That listing is
  // bounded: an unbounded walk of somebody's home directory is not a probe.
  const npx = join(homedir(), '.npm', '_npx');
  const entries = await readdir(npx).catch((): string[] => []);
  for (const entry of entries.slice(0, 200)) roots.push(join(npx, entry, 'node_modules'));
  return roots;
}

/**
 * Find a package directory, by existence alone.
 *
 * Never opens a file and never runs anything. `join` handles the scoped case:
 * `@playwright/mcp` becomes a nested path under the root.
 */
async function findPackageDir(pkg: string, roots: readonly string[]): Promise<string | null> {
  for (const root of roots) {
    const candidate = join(root, pkg);
    const isDir = await stat(candidate)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (isDir) return candidate;
  }
  return null;
}
