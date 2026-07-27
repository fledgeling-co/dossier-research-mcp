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
          : `installed (${version}) but no sign-in state found: run \`${adapter.bin}\` once and sign in`,
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

/* ------------------------------------------------------- model identity ---- */

/**
 * Which model is behind this CLI, asked of the CLI itself.
 *
 * A product name is not a model. `cursor-agent` serves Cursor's own Composer by
 * default and can be pointed at Grok 4.5; `grok` serves Grok 4.5. Two CLIs on
 * one model are one perspective, and a panel that seats both buys one and
 * reports two, which is the corroboration trap living inside the lane that
 * exists to prevent it. The only way to know is to ask, so this asks.
 *
 * **This is not on the detection path and must never be put there.** Detection
 * is sync, offline and costs nothing, which is what lets it run on every
 * routing decision. This spawns the CLI and waits for a model to answer: a few
 * seconds, and a round trip against the subscription quota that CLI bills to.
 * It is opt-in behind `research_doctor`'s `probeModels` flag, and the answer is
 * cached on disk by `src/local/model-cache.ts` so it is asked once rather than
 * once per detection.
 */
export const MODEL_PROBE_PROMPT =
  'Reply with exactly one line and nothing else, in this exact form: MODEL=<the name of the model writing this reply>. ' +
  'Do not search the web, do not call tools, do not explain, do not add any other line.';

export type ModelProbeState = 'probed' | 'unreadable' | 'refused' | 'failed';

export interface CliModelProbe {
  readonly id: CliId;
  readonly label: string;
  readonly state: ModelProbeState;
  /** The model as the CLI named it. Present only when `state` is `probed`. */
  readonly model?: string;
  readonly detail: string;
}

/** A model name is a short string; anything longer is the CLI ignoring the form. */
const MAX_MODEL_NAME = 120;

/**
 * Pull `MODEL=...` out of whatever the CLI wrote.
 *
 * Exported because the parsing is the fragile half: a CLI that prefaces its
 * answer with a banner, or wraps it in backticks, is normal, and a parser that
 * only accepts a bare single line would report every one of them unreadable.
 *
 * One rejection is deliberate rather than defensive. A CLI that echoes the
 * prompt back hands us `MODEL=<the name of the model writing this reply>`, and
 * caching that placeholder as a model name would make two CLIs that both echoed
 * look like the same model and silently drop one from the panel. Anything still
 * carrying the angle brackets is refused.
 */
export function parseModelAnswer(raw: string): string | null {
  const match = /MODEL\s*=\s*(.+)/i.exec(raw);
  if (!match) return null;
  // Quotes, backticks and markdown emphasis only. A trailing dot is NOT
  // stripped: `Grok 4.5` ends in one and trimming it would silently rename the
  // model to `Grok 4`, which is a different model and would compare unequal to
  // every other spelling of the same one.
  const value = (match[1] ?? '').trim().replace(/^["'`*]+|["'`*]+$/g, '').trim();
  if (!value) return null;
  if (value.includes('<') || value.includes('>')) return null;
  return value.slice(0, MAX_MODEL_NAME);
}

/**
 * Flatten a model name for comparison.
 *
 * `Grok 4.5`, `grok-4.5` and `Grok_4.5` are one model reported three ways, and
 * a dedupe that compared raw strings would seat all three. Dots survive, so
 * `4.5` does not become `45` and collide with something else. Deliberately
 * nothing cleverer: two names that differ by more than punctuation are treated
 * as two models, because keeping a backend that might be distinct is the safe
 * direction and dropping one that is not is the expensive one.
 */
export function normaliseModelName(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();
}

/**
 * Ask one CLI which model it serves.
 *
 * Refuses anything short of `ready`. Identity confirmation is the same rule
 * that governs `createRun`: handing a prompt to an unidentified binary is
 * handing it to a vendor nobody chose, and that is true of a one-line question
 * as much as of a research brief. A CLI that is installed but not signed in is
 * also refused, because prompting it would either fail or open an interactive
 * login, and neither belongs in an audit command.
 */
export async function probeCliModel(adapter: CliAdapter, timeoutMs = 60_000): Promise<CliModelProbe> {
  const base = { id: adapter.id, label: adapter.label } as const;
  const status = await probeCli(adapter);
  if (status.state !== 'ready') {
    return {
      ...base,
      state: 'refused',
      detail:
        status.state === 'ambiguous'
          ? 'not asked: the binary could not be identified, and an unidentified binary is never run'
          : status.state === 'absent'
            ? 'not asked: not installed'
            : 'not asked: installed but not signed in, so a prompt would fail or open a login',
    };
  }

  const bin = status.path ?? resolveOnPath(adapter.bin);
  if (!bin) return { ...base, state: 'failed', detail: 'the binary vanished from PATH between the two checks' };

  let raw: string;
  try {
    const { stdout, stderr } = await run(bin, [...adapter.headless(MODEL_PROBE_PROMPT)], {
      timeout: timeoutMs,
      maxBuffer: 4_000_000,
    });
    raw = `${stdout}\n${stderr}`;
  } catch (e: unknown) {
    return {
      ...base,
      state: 'failed',
      detail: `the CLI did not answer within ${String(Math.round(timeoutMs / 1000))}s or exited non-zero: ${
        e instanceof Error ? e.message.split('\n')[0] : String(e)
      }`,
    };
  }

  const model = parseModelAnswer(raw);
  if (!model) {
    return {
      ...base,
      state: 'unreadable',
      detail: 'the CLI answered but not in the MODEL=<name> form, so nothing is cached rather than a guess',
    };
  }
  return { ...base, state: 'probed', model, detail: `reports its model as ${model}` };
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
