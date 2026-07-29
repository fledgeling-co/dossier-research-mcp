import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

/**
 * Run a binary and collect its output, with stdin closed.
 *
 * `spawn` rather than `execFile`, and the reason is the bug this fixed. A CLI
 * given a prompt in argv may still decide it wants stdin, and `execFile` leaves
 * the child's stdin an open pipe, so it waits on input nobody will ever write.
 * Codex does exactly this: it announces "Reading additional input from stdin"
 * and exits non-zero with no output, which surfaced as "Codex CLI failed to
 * answer" while three other CLIs answered fine.
 *
 * `execFile` accepts a `stdio` option and ignores it, because it manages stdio
 * itself to capture output. Passing `['ignore', 'pipe', 'pipe']` there looks
 * like a fix and does nothing, which is how this survived a first attempt.
 *
 * The research path never had the bug: its supervisor already spawns with
 * stdin ignored. Only this probe path inherited the open pipe.
 */
function run(
  file: string,
  args: readonly string[],
  options: { timeout?: number; maxBuffer?: number; cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const cap = options.maxBuffer ?? 1_000_000;
    const child = spawn(file, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      reject(new Error(`timed out after ${String(options.timeout ?? 0)}ms`));
    }, options.timeout ?? 60_000);

    child.stdout.on('data', (d: Buffer) => { if (stdout.length < cap) stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < cap) stderr += d.toString(); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The CLI's own last line, not a bare exit code. A bare code reads as a
      // broken adapter when it is usually the CLI explaining itself.
      if (code !== 0) {
        const why = stderr.trim().split('\n').pop() ?? '';
        // `stdout`, `stderr` and `code` are attached because callers read them
        // off the rejection: that is `execFile`'s convention and `probeOutput`
        // depends on it to tell a help screen printed with exit 1 from a binary
        // that never answered. Rejecting with a bare Error made every probe
        // report "did not answer" regardless of what the binary actually said.
        const failure = Object.assign(
          new Error(`exited ${String(code)}${why ? `: ${why.slice(0, 200)}` : ''}`),
          { stdout, stderr, code },
        );
        reject(failure);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

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
  /**
   * How this CLI is told which model to use, when it can be told.
   *
   * Every one of the four shipped CLIs accepts a model flag and Dossier passed
   * none of them, so each ran whatever its default happened to be. That is not a
   * neutral default: Cursor's is `composer-2.5`, a CODING model, and it was
   * doing research. Cursor is really a multiplexer — its own `--list-models`
   * offers Grok 4.5, Opus 5 and GPT-5.6 Sol alongside Composer — so one
   * subscription can serve several of the panel's models, and which one it
   * serves was the one thing the operator could not say.
   *
   * Declared per adapter rather than assumed, because the flag differs: `-m`
   * on some, `--model` on others, and Claude Code takes an alias where Cursor
   * takes a full id.
   */
  /**
   * True when this CLI accepts a model flag at all.
   *
   * The flag's POSITION is the adapter's business, not a caller's: `codex exec`
   * is a subcommand, so `-m` has to follow it, while the others take their flag
   * before the prompt. Composing the argv from outside would put it in the
   * wrong place for exactly one CLI, which is the kind of defect that shows up
   * as an unrelated parse error hours later. So `headless` receives the model
   * and each adapter inserts it itself; this flag only says whether asking is
   * meaningful.
   */
  readonly acceptsModel?: boolean;
  /**
   * Argv for a single headless prompt, in the form the current builds want.
   *
   * Used verbatim unless {@link headlessAlternate} is declared and its probe
   * says this binary documents the older form instead.
   */
  /**
   * The argv for a one-shot run. `model` is the operator's override, absent
   * when they did not set one, and each adapter places it where its own parser
   * expects rather than having it composed in from outside.
   */
  readonly headless: (prompt: string, model?: string) => readonly string[];
  /**
   * The form to use instead when *this* binary documents it.
   *
   * Version-awareness by probing rather than by comparing version numbers. A
   * version comparison encodes a belief about which builds changed their flags,
   * and that belief is wrong the moment a vendor backports or a user pins. The
   * probe asks the binary what it documents and uses the answer, so two Codex
   * installs at different versions each get the form they accept.
   */
  readonly headlessAlternate?: {
    /** Argv for the probe. Must be offline, free, and free of side effects. */
    readonly probeArgs: readonly string[];
    /** What the probe output must contain for the alternate form to be chosen. */
    readonly expect: RegExp;
    readonly argv: (prompt: string) => readonly string[];
    /** Said out loud in `research_doctor` when the alternate is selected. */
    readonly why: string;
  };
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
    headless: (prompt, model) => (model ? ['--model', model, '-p', prompt] : ['-p', prompt]),
    acceptsModel: true,
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
    // `--search` is NOT valid on `codex exec`. It is documented on `codex
    // --help` and absent from `codex exec --help`, so every headless run died
    // at clap's argument parsing before any research happened. Verified by hand
    // against codex-cli 0.145.0 on 27 July 2026: `codex exec --search` answers
    // `error: unexpected argument '--search' found` and exits 2. Setting
    // `web_search = "live"` in `~/.codex/config.toml` is not a workaround
    // either, because the invocation dies before config is ever read.
    //
    // The bare positional is the whole fix. Live retrieval was then measured
    // rather than assumed: asked for the current top three Hacker News titles
    // with shell forbidden, a fact that turns over hourly and no local command
    // can reach, plain `codex exec` returned all three in order. So web search
    // is already on by default in `exec` on this build.
    //
    // `-c web_search=live` is deliberately NOT sent. It is accepted and
    // recognised here, but the same measurement showed it changes nothing, and
    // an unrecognised `-c` key is rejected at config load on a build that does
    // not know it. That is the same class of failure as the bug above, on a
    // path the offline argv self-test cannot see, bought for an effect that was
    // proven absent.
    // `--skip-git-repo-check` is deliberate and is only defensible together
    // with `cliWorkDir`. Codex refuses to run in a directory it does not
    // consider trusted, and its trust list is granted interactively, so a fresh
    // `git init` does not satisfy it and no headless invocation ever can. The
    // check exists to stop an agent editing files nobody can revert; running in
    // an empty, git-initialised scratch directory satisfies that purpose even
    // though it bypasses the mechanism, because there is nothing there to
    // damage and anything written is revertible. Skipping it while standing in
    // the user's project would not be defensible, which is why the two changes
    // shipped together.
    // `-m` after `exec`, because `exec` is a subcommand and a flag before it
    // is parsed against the top-level command instead.
    headless: (prompt, model) =>
      model
        ? ['exec', '-m', model, '--skip-git-repo-check', prompt]
        : ['exec', '--skip-git-repo-check', prompt],
    acceptsModel: true,
    headlessAlternate: {
      // An older Codex may genuinely take `--search` on `exec`, and on such a
      // build search may not be on by default, which is what the flag was for.
      // Asked of the binary rather than inferred from a version number.
      probeArgs: ['exec', '--help'],
      expect: /--search\b/,
      argv: (prompt) => ['exec', '--search', prompt],
      why: 'this build documents `--search` on `codex exec`, so it is used; current builds do not and are given the bare positional',
    },
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
    headless: (prompt, model) => (model ? ['-m', model, '-p', prompt] : ['-p', prompt]),
    acceptsModel: true,
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
    // `cursor-agent --list-models` names them: `cursor-grok-4.5-high`,
    // `claude-opus-5-thinking-high`, `gpt-5.6-sol-xhigh`, `composer-2.5`.
    headless: (prompt, model) =>
      model ? ['--model', model, '-p', '--force', prompt] : ['-p', '--force', prompt],
    acceptsModel: true,
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
  } catch (e: unknown) {
    // A timeout is not the same finding as a binary that answers wrongly, and
    // conflating them blames an install for a busy machine. Under heavy local
    // load a `--version` probe can exceed the timeout on a perfectly healthy
    // CLI, and reporting that as "identity unconfirmed" sends the operator to
    // reinstall something that was never broken.
    const timedOut = e instanceof Error && /timed? ?out|ETIMEDOUT|SIGTERM/i.test(e.message);
    return {
      ...base,
      ...withCaution,
      state: 'ambiguous',
      path: real,
      detail: timedOut
        ? `the binary resolved but did not answer \`${adapter.versionArgs.join(' ')}\` within ${String(timeoutMs)}ms, so its identity is unconfirmed. This is usually a busy machine rather than a broken install; re-run \`research_doctor\` when the load drops`
        : `the binary resolved but \`${adapter.versionArgs.join(' ')}\` failed, so its identity is unconfirmed: ${e instanceof Error ? e.message.slice(0, 160) : 'unknown error'}`,
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

/* --------------------------------------------------- headless argv form ---- */

/**
 * Which headless form this particular binary takes.
 *
 * Codex is why this exists: `--search` is valid on `codex` and invalid on
 * `codex exec`, and the adapter shipped the invalid one, so every `local-codex`
 * run died at argument parsing before any research happened. CLI runs ledger at
 * $0, so it cost nothing visible while silently consuming a panel seat.
 *
 * **Probed, never version-compared.** Comparing version numbers encodes a
 * belief about which builds changed their flags, and the belief is wrong the
 * moment a vendor backports or a user pins an old release. `<bin> exec --help`
 * asks the binary what it documents and the answer decides.
 *
 * **Cached in memory, not on disk, and that is the deliberate half.**
 * `model-cache.ts` persists because its probe costs a paid model round trip, so
 * asking twice is asking twice for money. This probe is a `--help` on a local
 * binary: offline, free, and a few milliseconds. Persisting it would buy
 * nothing and introduce the one failure a cache of this shape can have, an
 * upgrade in place at the same path being answered from a stale file. The key
 * is the RESOLVED ABSOLUTE PATH, because two Codex installs on one machine can
 * differ and the name on PATH does not distinguish them.
 */
const headlessForms = new Map<string, 'default' | 'alternate'>();

/** Reset the in-memory probe cache. Tests only; a process never needs it. */
export function clearHeadlessFormCache(): void {
  headlessForms.clear();
}

function formKey(adapter: CliAdapter, binPath: string): string {
  return `${adapter.id}::${binPath}`;
}

/** Run a probe and return its combined output, whatever the exit code. */
async function probeOutput(
  bin: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null } | null> {
  try {
    const { stdout, stderr } = await run(bin, [...args], { timeout: timeoutMs, maxBuffer: 2_000_000 });
    return { stdout, stderr, code: 0 };
  } catch (e: unknown) {
    // `execFile` rejects on a non-zero exit, and the output we need to read is
    // on the error. A help screen printed to stderr with exit 1 is normal.
    const err = e as { stdout?: unknown; stderr?: unknown; code?: unknown };
    if (typeof err.stdout === 'string' || typeof err.stderr === 'string') {
      return {
        stdout: typeof err.stdout === 'string' ? err.stdout : '',
        stderr: typeof err.stderr === 'string' ? err.stderr : '',
        code: typeof err.code === 'number' ? err.code : null,
      };
    }
    return null;
  }
}

/**
 * The argv builder this binary actually takes.
 *
 * Falls back to `adapter.headless` whenever the probe cannot answer. A probe
 * that fails says nothing about which form is right, and the default is the
 * form current builds document, so guessing the alternate on a failure would
 * turn one unreadable binary into a broken run.
 */
export async function resolveHeadless(
  adapter: CliAdapter,
  binPath: string,
  timeoutMs = 4_000,
): Promise<(prompt: string, model?: string) => readonly string[]> {
  const alternate = adapter.headlessAlternate;
  if (!alternate) return adapter.headless;

  const key = formKey(adapter, binPath);
  let form = headlessForms.get(key);
  if (form === undefined) {
    const out = await probeOutput(binPath, alternate.probeArgs, timeoutMs);
    form = out && alternate.expect.test(`${out.stdout}\n${out.stderr}`) ? 'alternate' : 'default';
    headlessForms.set(key, form);
  }
  return form === 'alternate' ? alternate.argv : adapter.headless;
}

/* ------------------------------------------------------ argv self-test ----- */

/**
 * An inert token standing in for the brief.
 *
 * Not `--help` itself: a CLI whose prompt flag requires a value refuses a value
 * beginning with `-`, so substituting the help flag for the brief made `grok`
 * fail with "a value is required for '--single <PROMPT>'", which is our probe
 * starving a flag rather than the adapter being wrong. Measured on 27 July 2026
 * across the four CLIs installed here.
 */
const ARGV_PROBE_PROMPT = 'dossier-argv-self-test';

export type ArgvCheckState = 'accepted' | 'rejected' | 'inconclusive' | 'skipped';

export interface CliArgvCheck {
  readonly id: CliId;
  readonly label: string;
  readonly state: ArgvCheckState;
  /** The argv that was parsed, with the help flag appended. */
  readonly argv: readonly string[];
  readonly detail: string;
}

/**
 * Signatures of an argument parser refusing the argv it was handed.
 *
 * Narrow on purpose. Anything outside this reads as `inconclusive`, because
 * accusing an adapter of being broken when the binary merely wanted a login is
 * a bug report sent to the wrong person.
 */
export const ARGV_REJECTION_PATTERN =
  /unexpected argument|unknown (?:option|argument|flag|switch)|unrecogni[sz]ed (?:option|argument)|invalid (?:option|flag)|no such option|error: unexpected/i;

/**
 * Does the binary accept the argv this adapter would really run?
 *
 * The gap `research_doctor` had: it proved a binary answers `--version` and has
 * a sign-in file, and neither of those touches the headless invocation that
 * actually runs the research. A `--version` probe passed happily for eight
 * months while every `local-codex` run died on an argument the adapter had
 * always sent.
 *
 * The self-test builds the **real** headless argv, with the brief replaced by
 * an inert token and `--help` appended, and runs it against the binary. Every
 * CLI here intercepts `--help` during parsing, so the flags are validated and
 * then the process prints its help and exits without doing any work, reaching
 * no model and spending nothing. Verified by hand across `claude`, `codex`,
 * `grok` and `cursor-agent` on 27 July 2026: all four exit 0 in milliseconds,
 * and `codex exec --search ... --help` exits 2 with the parse error.
 *
 * **What it cannot see.** Argument parsing only. A value the binary accepts as
 * an argument and rejects later while loading config would pass this, because
 * `--help` short-circuits before config is read. That is one reason the Codex
 * adapter sends no `-c` override.
 */
export async function checkHeadlessArgv(
  adapter: CliAdapter,
  timeoutMs = 10_000,
  /** A status already obtained, so the doctor does not run `--version` twice. */
  known?: CliStatus,
): Promise<CliArgvCheck> {
  const base = { id: adapter.id, label: adapter.label } as const;
  const status = known ?? (await probeCli(adapter));
  if (status.state === 'absent' || status.state === 'ambiguous') {
    return {
      ...base,
      state: 'skipped',
      argv: [],
      detail:
        status.state === 'absent'
          ? 'not installed, so there is no argv to check'
          : 'not run: the binary could not be identified, and an unidentified binary is never invoked',
    };
  }

  const bin = status.path ?? resolveOnPath(adapter.bin);
  if (!bin) return { ...base, state: 'skipped', argv: [], detail: 'the binary vanished from PATH between the two checks' };

  const headless = await resolveHeadless(adapter, bin, timeoutMs);
  const argv = [...headless(ARGV_PROBE_PROMPT), '--help'];
  const out = await probeOutput(bin, argv, timeoutMs);
  if (!out) {
    return {
      ...base,
      state: 'inconclusive',
      argv,
      detail: `the binary did not answer within ${String(Math.round(timeoutMs / 1000))}s, so its argument parsing was not exercised`,
    };
  }

  if (out.code === 0) {
    return { ...base, state: 'accepted', argv, detail: 'the binary parsed this invocation and printed its help' };
  }

  const text = `${out.stdout}\n${out.stderr}`.trim();
  const firstLine = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '(no output)';
  // A rejection naming the help flag we appended is our probe's fault, not the
  // adapter's. Reporting it as a broken adapter would be a false accusation.
  const blamesProbe = /'--help'|"--help"|`--help`/.test(firstLine);
  if (ARGV_REJECTION_PATTERN.test(text) && !blamesProbe) {
    return {
      ...base,
      state: 'rejected',
      argv,
      detail: `the binary REFUSED this invocation at argument parsing (exit ${String(out.code ?? -1)}): ${firstLine.slice(0, 300)}`,
    };
  }
  return {
    ...base,
    state: 'inconclusive',
    argv,
    detail:
      `exit ${String(out.code ?? -1)} with no argument-parse signature, so this is not evidence the argv is wrong: ` +
      firstLine.slice(0, 300),
  };
}

/** Self-test every known CLI in parallel. Offline, free, no model is reached. */
export async function checkAllHeadlessArgv(
  timeoutMs = 10_000,
  known?: readonly CliStatus[],
): Promise<CliArgvCheck[]> {
  return Promise.all(
    CLI_ADAPTERS.map((a) => checkHeadlessArgv(a, timeoutMs, known?.find((s) => s.id === a.id))),
  );
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
 * Words that name who is reselling a model, not which model it is.
 *
 * `cursor-grok-4.5-high` and `Grok 4.5` are one set of weights reached two
 * ways. The first token says whose subscription pays for it.
 */
const VENDOR_PREFIXES = new Set(['cursor', 'claude', 'anthropic', 'openai', 'xai', 'google', 'gemini']);

/**
 * Words that name a setting, not a model.
 *
 * A reasoning-effort or speed variant is the same weights turned up or down.
 * For asking "do these two members judge from the same priors", they are.
 */
const EFFORT_SUFFIXES = new Set([
  'high', 'low', 'medium', 'xhigh', 'fast', 'thinking', 'preview', 'latest', 'default', 'auto',
  // Size and speed tiers. `flash` is here for a reason found by a test:
  // without it `gemini-3.6-flash` had its leading `gemini` stripped as a
  // reseller, leaving `3.6 flash` to collide with anything else versioned 3.6.
  'flash', 'pro', 'lite', 'mini', 'nano', 'turbo',
]);

/**
 * The model underneath a vendor's product id.
 *
 * `cursor-grok-4.5-high` and `Grok 4.5` reduce to `grok 4.5`;
 * `claude-opus-5-thinking-high` and `Opus 5` reduce to `opus 5`. Version digits
 * are kept whole, so `gpt 5.6 sol` and `gpt 5.5` stay different models rather
 * than collapsing into `gpt`.
 *
 * **The conservative direction reversed, deliberately.** While a match REMOVED
 * a backend, refusing to match was the safe error: a false positive silently
 * deleted a paid-for member. Nothing is removed now — a match only records that
 * two members share priors — so the costly error is the opposite one. A miss
 * tells the operator they have two independent voices when they have one model
 * in two harnesses, which is the corroboration trap the lane exists to avoid.
 * So this matches harder than `normaliseModelName`, and the two are kept
 * separate rather than one being loosened into the other: the strict form is
 * still what gets displayed.
 */
export function modelFamily(model: string): string {
  const parts = normaliseModelName(model).split(' ').filter(Boolean);
  const kept = parts.filter((w) => !EFFORT_SUFFIXES.has(w));
  const first = kept[0];
  // A leading vendor word is dropped only when a MODEL NAME survives it.
  //
  // `cursor-grok-4.5-high` leaves `grok`, so `cursor` was the reseller.
  // `gemini-3.6-flash` leaves only `3.6`, so `gemini` is the model's own name
  // and stripping it would reduce the id to a bare version that collides with
  // every other 3.6. Found by a test rather than by reading.
  const dropVendor =
    first !== undefined &&
    VENDOR_PREFIXES.has(first) &&
    kept.slice(1).some((w) => /[a-z]/.test(w));
  return (dropVendor ? kept.slice(1) : kept).join(' ');
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
/**
 * The directory a CLI is run in.
 *
 * Two problems, one answer.
 *
 * Without an explicit `cwd` a spawned child inherits the server's, and for a
 * stdio MCP server that is the client's working directory: the user's own
 * project. A research agent with shell access, pointed at a brief that may
 * itself have come from a hostile page, should not be standing in the user's
 * codebase. Nothing in the brief asks it to touch files, and nothing stops it.
 *
 * Separately, `codex exec` refuses to run at all in a directory it does not
 * consider trusted, and exits non-zero. It is the only CLI that does, which is
 * why Codex reported "failed to answer" while the other three answered.
 *
 * A dedicated, empty, git-initialised scratch directory fixes both. Codex's
 * guard is satisfied rather than disabled, which is the better trade:
 * `--skip-git-repo-check` would have made the probe work by turning off the
 * check that exists to stop an agent editing files nobody can revert.
 *
 * **It must not live under the store, and the first version did.** The store
 * holds `reports/`, `runs/`, `sessions/` and `ledger.jsonl`, so a scratch
 * directory inside it put every CLI panel member exactly one `..` from every
 * other member's finished report. That is worse than the problem it replaced,
 * in a way peculiar to this product: a panel is worth more than one backend
 * only because its members answer independently, and `countsAsCorroboration`
 * treats two members agreeing as two sources. A member that read the others
 * first is not a second source, it is an echo, and nothing downstream can tell
 * the difference. Observed in the wild before it was found here — one CLI
 * member summarised two other members' reports.
 *
 * So the scratch directory goes somewhere with nothing of Dossier's above it.
 * The store's own permissions are tightened alongside, because defence that
 * depends on a single path choice is one refactor from being gone.
 */
export function cliWorkDir(storeDir: string): string {
  // Outside the store, but still one directory PER store.
  //
  // The first attempt at this fix returned a single shared directory for every
  // store, which traded one isolation bug for another: two runs, or two tests,
  // then shared a working directory and could see each other's leftovers. The
  // store path is hashed rather than joined, so the directory is unique per
  // store without the store's own path being reconstructable from it.
  const key = createHash('sha256').update(resolve(storeDir)).digest('hex').slice(0, 12);
  const dir = join(tmpdir(), `dossier-cli-workdir-${String(userInfo().uid)}-${key}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Empty and git-initialised: enough for Codex to consider it trusted, with
    // nothing in it worth reaching for.
    // 0700 on a shared temp root is the whole isolation story here, so it is
    // set explicitly rather than left to the umask.
    chmodSync(dir, 0o700);
    if (!existsSync(join(dir, '.git'))) {
      execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
      writeFileSync(join(dir, '.gitignore'), '*\n', { mode: 0o600 });
    }
  } catch {
    // A scratch directory that cannot be made is not worth failing a run over;
    // the caller falls back to the server's cwd, which is the behaviour that
    // shipped, so this can only improve on it.
  }
  return dir;
}

export async function probeCliModel(
  adapter: CliAdapter,
  timeoutMs = 60_000,
  /** Where to run it. Codex refuses an untrusted directory; see `cliWorkDir`. */
  workDir?: string,
): Promise<CliModelProbe> {
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

  // The same form a research run would use. Asking through an argv the binary
  // rejects would report "the CLI did not answer" for a defect in the adapter.
  const headless = await resolveHeadless(adapter, bin);

  let raw: string;
  try {
    const { stdout, stderr } = await run(bin, [...headless(MODEL_PROBE_PROMPT)], {
      timeout: timeoutMs,
      maxBuffer: 4_000_000,
      ...(workDir ? { cwd: workDir } : {}),
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


/**
 * Ask a CLI to actually perform a web search and show its working.
 *
 * The failure this catches: a CLI joins the free lane, its web search is broken,
 * and rather than failing it writes a fluent report explaining why it could not
 * research. That lands `completed` and costs a panel slot.
 *
 * The prompt demands a URL because a URL is the one part of the answer that can
 * be checked from outside the CLI. An answer with no URL is a CLI that did not
 * search; a URL that does not resolve is one that invented its evidence.
 *
 * **What a pass cannot mean.** A model could satisfy this from memory with a URL
 * it happens to know, and a real homepage will resolve. So `working` means the
 * CLI produced a resolvable source on demand, NOT that its search index is live
 * or good. The state that carries real information is the negative one, and that
 * is the one the caller was losing a slot to.
 */
export const SEARCH_PROBE_PROMPT =
  'Search the web right now for a news article published within the last 7 days about any topic. ' +
  'Reply with exactly one line and nothing else, in this exact form: SEARCH_OK=<the full https URL of the article you found>. ' +
  'If you cannot search the web for any reason, reply with exactly: SEARCH_FAILED=<a short reason>. ' +
  'Do not explain, do not add any other line, and do not answer from memory.';

export type SearchProbeState = 'working' | 'no_search' | 'unverified' | 'refused' | 'failed';

export interface CliSearchProbe {
  readonly id: CliId;
  readonly label: string;
  readonly state: SearchProbeState;
  /** The URL the CLI produced, when it produced one. */
  readonly url?: string;
  readonly detail: string;
}

/** The URL a CLI offered as evidence it searched, or the reason it gave for not searching. */
export function parseSearchAnswer(raw: string): { ok: true; url: string } | { ok: false; reason: string } | undefined {
  const failed = /SEARCH_FAILED\s*=\s*(.+)/i.exec(raw);
  const okMatch = /SEARCH_OK\s*=\s*(https?:\/\/\S+)/i.exec(raw);
  // The URL form wins when both appear: CLIs narrate, and a transcript that
  // mentions a failed first attempt and then succeeds is a success.
  if (okMatch?.[1]) return { ok: true, url: okMatch[1].replace(/[)\].,;]+$/, '').slice(0, 2000) };
  if (failed?.[1]) return { ok: false, reason: failed[1].trim().slice(0, 300) };
  return undefined;
}

export async function probeCliSearch(
  adapter: CliAdapter,
  verifyUrl: (url: string) => Promise<boolean>,
  timeoutMs = 120_000,
  workDir?: string,
): Promise<CliSearchProbe> {
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

  const headless = await resolveHeadless(adapter, bin);

  let raw: string;
  try {
    const { stdout, stderr } = await run(bin, [...headless(SEARCH_PROBE_PROMPT)], {
      timeout: timeoutMs,
      maxBuffer: 4_000_000,
      ...(workDir ? { cwd: workDir } : {}),
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

  const answer = parseSearchAnswer(raw);
  if (!answer) {
    return {
      ...base,
      state: 'unverified',
      detail: 'the CLI answered but named no URL, which is what a backend with no working search produces',
    };
  }
  if (!answer.ok) {
    return { ...base, state: 'no_search', detail: `the CLI says it cannot search: ${answer.reason}` };
  }

  // Dereferenced here rather than trusted, because a CLI with no search that has
  // been told to produce a URL will produce one.
  const resolves = await verifyUrl(answer.url);
  return resolves
    ? { ...base, state: 'working', url: answer.url, detail: `searched and returned a source that resolves: ${answer.url}` }
    : {
        ...base,
        state: 'unverified',
        url: answer.url,
        detail: `returned ${answer.url}, which did not resolve. Either its search is broken or it invented the source.`,
      };
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

/**
 * The environment a spawned CLI should get, which is NOT the one Dossier has.
 *
 * Dossier usually runs as a stdio MCP server launched by a coding CLI, so its
 * own environment is that CLI's session state. Passing it through means the CLI
 * Dossier spawns inherits the settings of the CLI that launched Dossier, and
 * those variables are not inert — they configure the very program being run.
 *
 * Observed, not theorised. A research run came back `completed` with a 9,140
 * character report explaining that its own web search was down:
 *
 *     effort 'xhigh' not supported when thinking is disabled
 *
 * The operator's `settings.json` had adaptive thinking ENABLED. The conflict
 * came from `CLAUDE_EFFORT=xhigh`, inherited from the session that started
 * Dossier, landing in a spawn whose thinking configuration was not the parent's.
 * Also inherited: `CLAUDE_CODE_SESSION_ID` — the PARENT's session id — and
 * `CLAUDE_CODE_CHILD_SESSION=1`, which tells the spawn it is part of a
 * conversation it has never seen.
 *
 * So the whole `CLAUDE_CODE_*` family and `CLAUDE_EFFORT` are removed. Claude
 * Code's own credentials live in `~/.claude.json` and `~/.claude`, which is
 * what `authPaths` already checks, so removing them costs no authentication.
 *
 * `ANTHROPIC_API_KEY` goes too, and that one is about honesty rather than
 * correctness. It OUTRANKS the subscription in `-p` mode with no prompt, so a
 * run this provider prices at $0.00 with the basis "no API charge: the run
 * draws on your CLI subscription" would in fact be billed per token. Either the
 * key goes or the cost band is a false statement, and the band is the thing
 * every budget decision is made from.
 */
export function cliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith('CLAUDE_CODE_')) continue;
    if (k === 'CLAUDE_EFFORT' || k === 'ANTHROPIC_API_KEY') continue;
    out[k] = v;
  }
  return out;
}
