import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Coding CLIs as research backends.
 *
 * This is not the consolation tier. On the April 2026 agent bench, Claude Code
 * driving plain web search with no MCP tools scored **97.0% at $1.54** and was
 * the fastest tool tested, against 75.8% at $10.92 for a premium deep-research
 * API on the same questions. Where hosted deep research genuinely wins is
 * breadth of sources per run and long uninterrupted investigation; on "find
 * these five facts and cite them" the local loop is simply better and happens
 * to cost nothing extra.
 *
 * ## Why identity confirmation is load-bearing
 *
 * Two binaries called `agent` and two called `grok` are in circulation. xAI's
 * installer drops `agent` into `~/.grok/bin`; Cursor's drops one into
 * `~/.local/bin`; a third-party npm package claims `grok` and is not xAI's.
 * Trusting the name on `PATH` means a research run could be handed to a
 * completely different vendor's tool, on a completely different bill.
 *
 * And identity is not always confirmable. Cursor's agent reports its version as
 * `2026.07.17-3e2a980` — a date and a hash, with nothing naming the product in
 * it. So `ambiguous` is a real state here rather than a hedge: a binary that
 * resolves but cannot prove what it is gets reported as such and is never run.
 *
 * ## The discipline on subscription claims
 *
 * Every coverage claim below is dated and sourced, or it is not made. Gemini
 * CLI's consumer tier vanished between two releases of its own README, which
 * still advertises it. An adapter that cannot confirm coverage says
 * `unconfirmed`, because getting this wrong costs somebody real money.
 */

export const CLI_IDS = ['claude', 'codex', 'agy', 'grok', 'cursor', 'gemini'] as const;
export type CliId = (typeof CLI_IDS)[number];

export interface CliAdapter {
  readonly id: CliId;
  readonly label: string;
  /** Executable name, as installed on PATH. */
  readonly bin: string;
  readonly versionArgs: readonly string[];
  /**
   * What `--version` must contain to prove identity. `null` means the tool
   * publishes nothing identifying, so identity can only come from path
   * provenance.
   */
  readonly identity: RegExp | null;
  /**
   * Directory fragments that identify the vendor when the version cannot.
   *
   * Matched against the *directory* the binary resolves into, never the whole
   * path: a hint of `claude` matched against the full path is satisfied by the
   * binary being named `claude`, which is the one thing already known and
   * proves nothing.
   */
  readonly pathHints: readonly string[];
  /** Config paths whose *presence* implies authentication. Never read. */
  readonly authPaths: readonly string[];
  /** Argv for a single headless prompt. */
  readonly headless: (prompt: string) => readonly string[];
  /** Dated, sourced coverage claim. */
  readonly billing: string;
  /** Anything that would cost the user money unexpectedly. */
  readonly caution?: string;
}

const home = (...parts: string[]): string => join(homedir(), ...parts);

export const CLI_ADAPTERS: readonly CliAdapter[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    versionArgs: ['--version'],
    identity: /claude code/i,
    pathHints: ['/claude/', '/.claude/'],
    authPaths: [home('.claude.json'), home('.claude')],
    headless: (prompt) => ['-p', prompt],
    billing:
      'Covered by a Pro/Max/Team subscription (verified 25 July 2026). Web search carries no per-search fee on a subscription, where the API charges $10 per 1,000 searches.',
    caution:
      'ANTHROPIC_API_KEY in the environment OUTRANKS the subscription and is used unconditionally in -p mode with no prompt, which silently converts every call to per-token billing. Unset it to spend the subscription.',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    bin: 'codex',
    versionArgs: ['--version'],
    identity: /codex/i,
    pathHints: ['/.codex/', '/codex/'],
    authPaths: [home('.codex', 'auth.json'), home('.codex')],
    headless: (prompt) => ['exec', '--search', prompt],
    billing:
      'Sign in with ChatGPT is documented (verified 25 July 2026); which tiers qualify and what the limits are is not stated on the CLI page. Treat coverage as unconfirmed.',
  },
  {
    id: 'agy',
    label: 'Antigravity CLI (agy)',
    bin: 'agy',
    versionArgs: ['--version'],
    identity: /agy|antigravity/i,
    pathHints: ['/.gemini/', '/agy/'],
    authPaths: [home('.gemini', 'antigravity-cli', 'settings.json'), home('.gemini', 'antigravity-cli')],
    headless: (prompt) => ['-p', prompt],
    billing:
      'Free tier includes Claude Sonnet and Opus 4.6 as agent models, quoted from antigravity.google/pricing (verified 25 July 2026). The strongest zero-cost option.',
    caution: 'Headless invocation is unconfirmed against the published docs; the -p form is inferred from its siblings.',
  },
  {
    id: 'grok',
    label: 'Grok Build (xAI)',
    bin: 'grok',
    versionArgs: ['--version'],
    // Reports `grok 0.2.112 (9bbd559437aa)`: the product name and nothing that
    // separates it from the third-party npm package of the same name, which
    // would print something similar. Verified against a real install on
    // 25 July 2026, and it is why the earlier `/grok[- ]build|xai/` pattern was
    // wrong: it matched the documentation rather than the binary, and reported
    // the genuine xAI CLI as unidentifiable.
    //
    // So identity comes from provenance instead, exactly as it does for Cursor.
    identity: null,
    // The installer symlinks through `~/.grok`; resolving the link lands in
    // `~/.grok/downloads/`, so the hint is the config home rather than `bin`.
    pathHints: ['/.grok/'],
    authPaths: [home('.grok', 'auth.json')],
    headless: (prompt) => ['-p', prompt],
    billing:
      'Whether the CLI browser-OAuth path draws on a SuperGrok subscription is NOT stated in xAI documentation (checked 25 July 2026). Two third-party integrations report that it does. Corroboration, not confirmation.',
    caution: 'A third-party npm package also installs a `grok` binary and is not xAI’s. PATH order decides which one you get.',
  },
  {
    id: 'cursor',
    label: 'Cursor Agent',
    bin: 'cursor-agent',
    versionArgs: ['--version'],
    // Reports `2026.07.17-3e2a980`: a date and a hash, naming nothing. Identity
    // has to come from the path, which is why `ambiguous` exists as a state.
    identity: null,
    pathHints: ['/cursor-agent/', '/.cursor/'],
    authPaths: [home('.cursor'), home('.local', 'share', 'cursor-agent')],
    headless: (prompt) => ['-p', '--force', prompt],
    billing: 'Covered by a Cursor subscription with plan-level pools (verified 25 July 2026).',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',
    versionArgs: ['--version'],
    identity: /\d+\.\d+/,
    pathHints: ['/gemini/', '/.gemini/'],
    // API key only: there is no subscription auth file to look for.
    authPaths: [],
    headless: (prompt) => ['-p', prompt],
    billing:
      'API key only. Consumer access was withdrawn on 18 June 2026; its own README still advertises the free tier and is stale. This is NOT a subscription path.',
  },
];

export type CliState = 'absent' | 'ambiguous' | 'present-unauthed' | 'ready';

export interface CliStatus {
  readonly id: CliId;
  readonly label: string;
  readonly state: CliState;
  readonly detail: string;
  readonly path?: string;
  readonly version?: string;
  readonly billing: string;
  readonly caution?: string;
}

/** Search PATH for an executable, without a shell. */
export function resolveOnPath(bin: string): string | null {
  const paths = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of paths) {
    for (const ext of exts) {
      const candidate = resolve(dir, `${bin}${ext.toLowerCase()}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep looking; an unreadable PATH entry is normal.
      }
    }
  }
  return null;
}

/**
 * Probe one CLI. Local, offline, and it never reads a credential.
 *
 * `--version` is the only thing executed, with a hard timeout and no shell.
 * Auth is inferred from the *presence* of a config path, because opening one to
 * check would mean reading a token to decide whether a token exists.
 */
export async function probeCli(adapter: CliAdapter, timeoutMs = 4_000): Promise<CliStatus> {
  const found = resolveOnPath(adapter.bin);
  const base = { id: adapter.id, label: adapter.label, billing: adapter.billing } as const;
  const withCaution = adapter.caution ? { caution: adapter.caution } : {};

  if (!found) {
    return { ...base, ...withCaution, state: 'absent', detail: `\`${adapter.bin}\` is not on PATH` };
  }
  const real = await realpath(found).catch(() => found);

  let version: string;
  try {
    const { stdout, stderr } = await run(real, [...adapter.versionArgs], { timeout: timeoutMs });
    version = `${stdout} ${stderr}`.trim().split('\n')[0]?.trim() ?? '';
  } catch {
    return {
      ...base,
      ...withCaution,
      state: 'ambiguous',
      path: real,
      detail: 'the binary resolved but did not answer --version, so its identity is unconfirmed',
    };
  }

  const identified = adapter.identity ? adapter.identity.test(version) : false;
  const byPath = adapter.pathHints.some((hint) => dirname(real).includes(hint));
  if (!identified && !byPath) {
    return {
      ...base,
      ...withCaution,
      state: 'ambiguous',
      path: real,
      version,
      detail:
        `\`${adapter.bin}\` resolves to ${real} but reports "${version}", which does not identify it as ${adapter.label}. ` +
        'Several vendors ship binaries with these names, so this one is not used.',
    };
  }

  const authed = await anyExists(adapter.authPaths);
  // A tool with no auth file to look for cannot be proven authenticated, so it
  // reports the weaker state rather than the flattering one.
  if (adapter.authPaths.length === 0 || !authed) {
    return {
      ...base,
      ...withCaution,
      state: 'present-unauthed',
      path: real,
      version,
      detail:
        adapter.authPaths.length === 0
          ? `installed (${version}); this tool has no local sign-in to detect`
          : `installed (${version}) but no sign-in state found — run \`${adapter.bin}\` once and sign in`,
    };
  }

  return {
    ...base,
    ...withCaution,
    state: 'ready',
    path: real,
    version,
    detail: `installed (${version}) and signed in${identified ? '' : ', identified by install path rather than version string'}`,
  };
}

/** Probe every known CLI in parallel. Bounded, so a hung binary cannot wedge it. */
export async function probeAllClis(timeoutMs = 4_000): Promise<CliStatus[]> {
  return Promise.all(CLI_ADAPTERS.map((a) => probeCli(a, timeoutMs)));
}

async function anyExists(paths: readonly string[]): Promise<boolean> {
  for (const p of paths) {
    if (await access(p).then(() => true).catch(() => false)) return true;
  }
  return false;
}

/**
 * Does a sign-in file exist for this tool?
 *
 * Existence only, and the file is never opened. Dossier does not need to read a
 * session token to know a session exists, and a file it never reads is a file
 * it can never leak or corrupt.
 *
 * Sync because routing is sync, and routing is the caller: `probeCli` makes the
 * same check asynchronously alongside identity confirmation, and this is the
 * cheap half of it. A tool with no `authPaths` reports `false`, matching
 * `probeCli`'s rule that a tool which cannot be proven authenticated gets the
 * weaker answer rather than the flattering one.
 */
export function hasSignInFile(adapter: CliAdapter): boolean {
  return adapter.authPaths.some((p) => {
    try {
      accessSync(p, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** Look up an adapter by id. Takes a plain string: the id arrives from env. */
export function adapterFor(id: string): CliAdapter | null {
  return CLI_ADAPTERS.find((a) => a.id === id) ?? null;
}
