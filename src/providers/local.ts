import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { CreateRunArgs, DeepResearchClient } from '../gemini/client.js';
import type { CostBand, DurationOptions } from '../gemini/cost.js';
import type { InteractionSnapshot } from '../gemini/types.js';
import {
  adapterFor,
  CLI_ADAPTERS,
  hasSignInFile,
  probeCli,
  resolveOnPath,
  type CliAdapter,
} from '../local/cli.js';
import type { Capabilities, CredentialStatus, ProviderEstimate, ResearchProvider } from './types.js';

/**
 * A coding CLI you already pay for, as a research backend.
 *
 * No API bill: the run draws on a subscription the user already has, which for
 * most people is the tier they will actually use. The evidence says it is not a
 * downgrade either — Claude Code driving plain web search scored 97.0% at $1.54
 * on the April 2026 agent bench while a premium deep-research API scored 75.8%
 * at $10.92 on the same questions.
 *
 * ## Preferred when it is installed, signed in and capable
 *
 * This was the other way round until 0.5.1. The old rule kept `local` out of
 * automatic selection entirely, on the grounds that a $0 backend wins every
 * cost tie-break while spending a subscription quota Dossier cannot meter, and
 * running a third-party binary on the user's machine. The reasoning was sound
 * and the default was still wrong: the owner asked for the subscription they
 * already pay for to be used ahead of an API bill, and a research tool that
 * quietly bills an API when a capable CLI is sitting on PATH is not serving
 * them.
 *
 * So the router now prefers this backend, honestly:
 *
 * - **Capability first, unchanged.** A CLI cannot enforce a date window, reach
 *   X, filter domains, or offer an editable plan, and the capability filter
 *   eliminates it from all of those before preference is ever consulted. The
 *   preference only ever picks between backends that can all do the job.
 * - **Installed and signed in**, established by file existence alone. A CLI
 *   nobody has signed into would trade a working paid run for a failing free
 *   one.
 * - **Said out loud.** The routing reason states that a subscription quota is
 *   being spent rather than an API balance, and that Dossier cannot meter it.
 * - **`DOSSIER_PROVIDERS` overrides in both directions**: list it to force the
 *   CLI, or omit it to keep the CLI out of automatic selection entirely.
 *
 * Identity is still confirmed at spawn, not at routing time. Preference decides
 * *which* backend; `probeCli` in `createRun` decides whether the binary on PATH
 * is really the tool it claims to be, and refuses an unidentified one.
 *
 * ## Durability
 *
 * The child is detached and its lifecycle is recorded by a small supervisor
 * process rather than by this server, so a run survives Dossier restarting —
 * the same promise the API-backed runs make. Output streams to a file in the
 * store; a sidecar records the exit. If the supervisor dies too, `getRun` falls
 * back to "process gone, output present" and reports that inference rather than
 * a confident status it cannot support.
 */

/**
 * The supervisor, run as `node -e`.
 *
 * Deliberately not a shell: the brief is passed as an argv element, and a shell
 * would make a research question with a backtick in it an arbitrary command.
 * Deliberately not this process either: an in-process child dies with the
 * server, and durability across restarts is the whole point of the store.
 */
const SUPERVISOR = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const [out, side, deadlineMs, maxBytes, bin, ...rest] = process.argv.slice(1);
const sink = fs.createWriteStream(out, { flags: 'a' });
const done = (payload) => { try { fs.writeFileSync(side, JSON.stringify(payload)); } catch {} };
let written = 0, truncated = false, finished = false;
try {
  const child = spawn(bin, rest, { stdio: ['ignore', 'pipe', 'pipe'] });
  // Cap the output. A chatty CLI could otherwise fill the store, and the cap
  // is announced in the file rather than silently swallowing the tail.
  const take = (chunk) => {
    if (truncated) return;
    written += chunk.length;
    if (written > Number(maxBytes)) {
      truncated = true;
      try { fs.appendFileSync(out, '\\n\\n_[output truncated: the CLI exceeded the size limit]_\\n'); } catch {}
      try { child.kill('SIGTERM'); } catch {}
      return;
    }
    sink.write(chunk);
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  // And a deadline. A hung CLI holds a run open forever otherwise, and the
  // run has no other way to end.
  const timer = setTimeout(() => {
    if (finished) return;
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 10000).unref();
  }, Number(deadlineMs));
  child.on('error', (e) => { finished = true; clearTimeout(timer); done({ exit: -1, error: String(e && e.message), at: Date.now() }); });
  child.on('close', (code, signal) => {
    finished = true;
    clearTimeout(timer);
    done({
      exit: truncated ? -1 : code === null ? -1 : code,
      signal: signal || null,
      at: Date.now(),
      ...(truncated ? { error: 'the CLI produced more output than the limit allows' } : {}),
    });
  });
} catch (e) {
  done({ exit: -1, error: String(e && e.message), at: Date.now() });
}
`;

const SidecarSchema = z.object({
  exit: z.number(),
  signal: z.string().nullable().optional(),
  error: z.string().optional(),
  at: z.number(),
});

/** A research report is large; a runaway CLI is larger. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Preference order when no CLI is named: quality first, then cost, then breadth. */
const PREFERENCE: readonly string[] = ['claude', 'agy', 'codex', 'cursor', 'grok'];

/** The first CLI whose binary resolves, in preference order. */
export function pickCli(config: Config): CliAdapter | null {
  if (config.localCli) return adapterFor(config.localCli);
  for (const id of PREFERENCE) {
    const adapter = CLI_ADAPTERS.find((a) => a.id === id);
    if (adapter && resolveOnPath(adapter.bin)) return adapter;
  }
  return null;
}

export function localCost(): CostBand {
  return {
    lowUsd: 0,
    highUsd: 0,
    midUsd: 0,
    basis:
      'no API charge: the run draws on your CLI subscription. It is not free in every sense — it consumes that subscription’s quota, which Dossier cannot see or meter',
  };
}

export function localProvider(config: Config): ResearchProvider {
  const adapter = pickCli(config);
  const capabilities: Capabilities = {
    // Deep only, deliberately. A CLI agent will happily write a table, but
    // nothing about the shape is enforced and no date or domain filter exists,
    // so advertising `wide` or `recent` here would put it in the running for
    // exactly the jobs where enforcement is the point.
    shapes: ['deep'],
    background: true,
    planReview: false,
    followUp: false,
    dateFilter: 'none',
    domainFilter: 0,
    corpus: 'local',
    socialSources: [],
    structuredOutput: false,
    fileOutput: true,
    maxWallClockMinutes: 30,
    billedTo: 'subscription',
    limitations: [
      'Preferred automatically when installed, signed in and capable of the job. Set DOSSIER_PROVIDERS to keep it out.',
      'Spends your subscription quota rather than an API balance, and Dossier cannot meter that.',
      'No editable plan, no date filter, no domain filter, no follow-up turn.',
      'Runs a third-party binary on this machine, with your brief as an argument.',
      ...(adapter?.caution ? [adapter.caution] : []),
    ],
  };

  const dir = join(config.storeDir, 'local');
  const outPath = (id: string): string => join(dir, `${id}.out`);
  const sidePath = (id: string): string => join(dir, `${id}.exit.json`);
  const pidPath = (id: string): string => join(dir, `${id}.pid.json`);

  const client: DeepResearchClient = {
    async createRun(args: CreateRunArgs): Promise<InteractionSnapshot> {
      if (!adapter) throw new Error('No supported research CLI found on PATH.');
      // Identity is confirmed HERE, not only in `research_doctor`. Detection
      // is sync and can only see that a name resolves; this is the last point
      // before a brief is handed to whatever that name happens to be today,
      // and on a machine where one installer symlinks over another's binary
      // that changes between one run and the next.
      const status = await probeCli(adapter);
      if (status.state === 'absent') {
        throw new Error(`\`${adapter.bin}\` is no longer on PATH.`);
      }
      if (status.state === 'ambiguous') {
        throw new Error(
          `Refusing to run \`${adapter.bin}\`: ${status.detail} ` +
            'Handing your brief to a different vendor\'s tool is a different bill and a different privacy posture, so an unidentified binary is never used. ' +
            'Set DOSSIER_LOCAL_CLI to a backend you have verified with `research_doctor`.',
        );
      }
      const bin = status.path ?? resolveOnPath(adapter.bin);
      if (!bin) throw new Error(`\`${adapter.bin}\` is no longer on PATH.`);

      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Millisecond-plus-counter rather than a random id: this is a file name,
      // not a security boundary, and a sortable one is easier to clean up.
      const id = `loc_${Date.now().toString(36)}${String(counter++).padStart(3, '0')}`;
      writeFileSync(outPath(id), '', { mode: 0o600 });

      const child = spawn(
        process.execPath,
        [
          '-e',
          SUPERVISOR,
          outPath(id),
          sidePath(id),
          String(capabilities.maxWallClockMinutes * 60_000),
          String(MAX_OUTPUT_BYTES),
          bin,
          ...adapter.headless(args.prompt),
        ],
        { detached: true, stdio: 'ignore' },
      );
      child.unref();
      writeFileSync(
        pidPath(id),
        JSON.stringify({ pid: child.pid ?? 0, cli: adapter.id, startedAt: Date.now() }),
        { mode: 0o600 },
      );

      return {
        interactionId: id,
        status: 'in_progress',
        markdown: '',
        thoughts: [],
        images: [],
      };
    },

    getRun(interactionId: string): Promise<InteractionSnapshot> {
      const markdown = read(outPath(interactionId));
      const raw = read(sidePath(interactionId));

      if (raw) {
        const parsed = SidecarSchema.safeParse(safeJson(raw));
        if (parsed.success) {
          const ok = parsed.data.exit === 0;
          return Promise.resolve({
            interactionId,
            status: ok ? 'completed' : 'failed',
            markdown,
            thoughts: [],
            images: [],
            ...(ok
              ? {}
              : {
                  error:
                    parsed.data.error ??
                    `the CLI exited with code ${String(parsed.data.exit)}${parsed.data.signal ? ` (signal ${parsed.data.signal})` : ''}`,
                }),
          });
        }
      }

      // No sidecar. Either still running, or the supervisor died with it.
      const pid = pidOf(read(pidPath(interactionId)));
      if (pid && alive(pid)) {
        return Promise.resolve({ interactionId, status: 'in_progress', markdown, thoughts: [], images: [] });
      }
      if (markdown.trim().length > 0) {
        return Promise.resolve({
          interactionId,
          status: 'completed',
          markdown: `${markdown}\n\n---\n\n_Dossier did not observe this run exit: the supervising process is gone and no exit status was recorded. The output above is what it wrote before that. Treat it as possibly truncated._`,
          thoughts: [],
          images: [],
        });
      }
      return Promise.resolve({
        interactionId,
        status: 'failed',
        markdown: '',
        thoughts: [],
        images: [],
        error: 'the CLI process is gone and produced no output',
      });
    },

    cancelRun(interactionId: string): Promise<void> {
      const pid = pidOf(read(pidPath(interactionId)));
      if (!pid) throw new Error('No process recorded for this run; nothing to cancel.');
      try {
        // Negative pid: the supervisor is a detached group leader, so this
        // stops the CLI it spawned as well rather than orphaning it.
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          throw new Error('The process was already gone.');
        }
      }
      // Confirm it actually died before recording a terminal state. Writing the
      // sidecar straight after SIGTERM declared a run finished while it was
      // still running and still consuming quota.
      return (async () => {
        for (let i = 0; i < 20; i += 1) {
          await new Promise((r) => setTimeout(r, 100));
          if (!alive(pid)) break;
          if (i === 9) {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              try {
                process.kill(pid, 'SIGKILL');
              } catch {
                /* already gone */
              }
            }
          }
        }
        if (alive(pid)) {
          throw new Error(
            'The CLI did not stop after SIGTERM and SIGKILL. It is still running and still consuming your quota; stop it by hand before starting another.',
          );
        }
        writeFileSync(sidePath(interactionId), JSON.stringify({ exit: -1, error: 'cancelled', at: Date.now() }), {
          mode: 0o600,
        });
      })();
    },

    followUp(): Promise<string> {
      // A CLI run is one shot. Pretending otherwise would spend a second full
      // run while calling it a cheap follow-up.
      throw new Error(
        'The local CLI backend has no follow-up turn: each invocation is a fresh session with no memory of the last. Read the report with `research_read`.',
      );
    },
  };

  return {
    id: 'local',
    label: adapter ? `${adapter.label} (local CLI, no API charge)` : 'Local CLI (none detected)',
    capabilities,
    detect(): CredentialStatus {
      if (config.hermetic) return { state: 'not-configured', detail: 'hermetic mode: no subprocesses are spawned' };
      if (!adapter) {
        return {
          state: 'not-configured',
          detail: 'no supported research CLI found on PATH',
          fix: 'Install one of: claude, agy, codex, cursor-agent, grok. `research_doctor` identifies and verifies what you have.',
        };
      }
      if (!resolveOnPath(adapter.bin)) {
        return {
          state: 'not-configured',
          detail: `DOSSIER_LOCAL_CLI names ${adapter.id}, but \`${adapter.bin}\` is not on PATH`,
          fix: `Install ${adapter.label}, or unset DOSSIER_LOCAL_CLI to auto-detect`,
        };
      }
      // Deliberately not `ready`: presence on PATH is not proof of identity,
      // and `research_doctor` is where the version string is checked.
      //
      // `signedIn` is the one thing that can be settled synchronously, by
      // asking whether a session file exists. Routing needs it, because
      // preferring a CLI nobody has signed into trades a working paid run for a
      // failing free one. The file is never opened.
      const signedIn = hasSignInFile(adapter);
      return {
        state: 'configured-unverified',
        detail: signedIn
          ? `${adapter.label} is on PATH with a sign-in on disk; run \`research_doctor\` to confirm its identity`
          : `${adapter.label} is on PATH but no sign-in state was found; run \`${adapter.bin}\` once and sign in`,
        signedIn,
        ...(signedIn ? {} : { fix: `Run \`${adapter.bin}\` once and sign in, then re-run \`research_doctor\`` }),
      };
    },
    estimate(_input: DurationOptions): ProviderEstimate {
      return {
        cost: localCost(),
        duration: {
          lowMinutes: 2,
          highMinutes: 20,
          factors: ['a local agent loop over the host’s own web search'],
          sources: ['whatever web search the CLI itself has'],
          awaitsApproval: false,
          cappedByApiLimit: false,
        },
      };
    },
    client(): DeepResearchClient {
      if (!adapter) throw new Error('No supported research CLI found on PATH.');
      return client;
    },
  };
}

let counter = 0;

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function pidOf(raw: string): number | null {
  const parsed = safeJson(raw);
  const pid = (parsed as { pid?: unknown } | null)?.pid;
  return typeof pid === 'number' && pid > 0 ? pid : null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as { code?: string }).code === 'EPERM';
  }
}
