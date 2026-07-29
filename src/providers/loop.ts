/**
 * The caller-driven loop, driven by a CLI instead of by a caller.
 *
 * `research_local_start` and its siblings implement this product's own research
 * method: decompose the question by source class, search each class in the
 * dialect that index actually expects, register every source once, freeze the
 * registry before a word is drafted, and refuse a draft that cites anything the
 * run did not gather. It costs nothing and needs no key. What it needs is an AI
 * in the loop to do the searching, which is why it is a tool family rather than
 * a provider, and why nothing could measure it: a benchmark has no caller.
 *
 * This closes that. The methodology stays exactly where it is — this file
 * imports `decompose`, `mergeFindings`, `freezeRegistry` and `validateDraft`
 * rather than reimplementing any of them, so what gets measured is the shipped
 * loop and not a copy of it that drifts. The CLI takes the caller's seat: one
 * spawn per search task returning findings as JSON, then one more to draft from
 * the frozen registry.
 *
 * **The pairing is the point.** `loop-claude` and `local-claude` are the same
 * binary, the same subscription and the same web search, differing only in
 * whether this product's method sits between the question and the answer. Any
 * gap between those two columns is the method's contribution, measured rather
 * than asserted. `docs/plan/benchmark.md` makes that loop the benchmark's
 * control; until now the control could not be run.
 *
 * **One way this is weaker than its siblings, stated plainly.** Every other
 * provider hands its work to a detached supervisor and can be polled back after
 * a server restart. This one orchestrates in-process, so a restart loses the
 * run. That is a real gap and it is bounded by what it costs: the work is a CLI
 * subscription rather than an API balance, so a lost run is re-runnable at no
 * charge, where losing a paid Gemini run would be losing money.
 */

import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { CreateRunArgs, DeepResearchClient } from '../gemini/client.js';
import type { InteractionSnapshot } from '../gemini/types.js';
import { decompose } from '../research/decompose.js';
import {
  FindingSchema,
  freezeRegistry,
  mergeFindings,
  renderRegistry,
  SessionSchema,
  validateDraft,
  type Finding,
  type Session,
  type TaskOutcome,
} from '../research/local-loop.js';
import {
  type CliAdapter,
  cliEnv,
  cliWorkDir,
  hasSignInFile,
  probeCli,
  resolveHeadless,
  resolveOnPath,
} from '../local/cli.js';
import { localCost } from './local.js';
import type { Capabilities, CredentialStatus, ProviderEstimate, ResearchProvider } from './types.js';

/**
 * Tools denied when a run is asked to work without search.
 *
 * The same list `bench/src/failcheck/cli.ts` uses, and for the same reason:
 * denying `WebSearch` alone leaves `WebFetch` and `Bash`, either of which
 * reaches the network, so a run reported as closed-book would have searched
 * through the gap. Claude Code is the only adapter with a documented flag for
 * this, which is why `honoursNoSearch` is per-adapter rather than assumed.
 */
const CLOSED_BOOK_TOOLS = ['WebSearch', 'WebFetch', 'Bash', 'Read', 'Glob', 'Grep', 'Task'] as const;

/**
 * CLIs that can actually be denied their tools.
 *
 * Claude Code documents `--disallowedTools`. No other adapter here does, and
 * inferring a flag would produce the worst possible outcome: a column labelled
 * closed-book whose cells all searched. A no-search request for anything else
 * is refused in `createRun` rather than downgraded.
 *
 * Exported because the benchmark prints which backends its `--no-search` flag
 * reaches, and that message has to be derived from this rather than restate it.
 */
export const NO_SEARCH_CLIS: readonly string[] = ['claude'];

/** How long one CLI spawn may take before it is abandoned. */
const TASK_TIMEOUT_MS = 10 * 60_000;
const DRAFT_TIMEOUT_MS = 15 * 60_000;

/** Output cap per spawn. A CLI that will not stop talking must not exhaust memory. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * What a worker spawn must return.
 *
 * Findings are capped at ten by the same reasoning `research_local_note` uses:
 * a worker that returns everything it saw has handed the sifting back to the
 * lead, which is the job it was dispatched to do.
 */
const WorkerReplySchema = z.object({
  findings: z.array(FindingSchema).max(10).default([]),
  gaps: z.string().max(4000).optional(),
  outcome: z
    .enum(['ok', 'no-results', 'rate-limited', 'blocked', 'tool-failed'])
    .default('ok'),
});

/**
 * Pull the JSON object out of whatever a CLI wrapped it in.
 *
 * CLIs preface answers with prose and fence code, and a worker that found four
 * real sources must not be recorded as having found nothing because its reply
 * began "Here are the results:". Scans for the last balanced `{...}` span,
 * because trailing commentary is more common than leading JSON.
 */
export function extractJsonObject(raw: string): unknown {
  const text = raw.trim();
  if (text === '') return undefined;
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        // Only meaningful inside a string, but harmless outside one: a
        // backslash cannot legally appear in JSON structure anyway.
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            break; // Not JSON after all; try the next opening brace.
          }
        }
      }
    }
  }
  return undefined;
}

/** The brief handed to one search worker. */
export function workerPrompt(
  question: string,
  task: { objective: string; role: string; queries: readonly string[]; done: string; depth: string },
  noSearch: boolean,
): string {
  const lines = [
    `You are one worker in a research loop. The overall question is: ${question}`,
    '',
    `Your role: ${task.role}`,
    `Your objective: ${task.objective}`,
    `You are done when: ${task.done}`,
    '',
    'Queries to issue, in this index’s own dialect:',
    ...task.queries.map((q) => `  - ${q}`),
    '',
    task.depth === 'deep'
      ? 'Open the pages and read them. Report what they actually argued, including the caveats.'
      : 'Reading result listings is enough for this task; you need not open every page.',
    '',
    noSearch
      ? 'You have NO search tools. Answer only from what you already know, and if you do not know, say so and return an empty findings array with outcome "no-results".'
      : 'Use your web search.',
    '',
    'Reply with ONE JSON object and nothing else:',
    '{"findings":[{"claim":"...","url":"https://...","quote":"...","published":"..."}],"gaps":"what you searched for and did not find","outcome":"ok"}',
    '',
    'Rules that decide whether your reply is usable:',
    '  - At most 10 findings. One sentence per claim. Sift; do not dump.',
    '  - Every finding needs a real URL you actually saw. Never invent one.',
    '  - Found nothing? Return an empty array, say what you searched in "gaps",',
    '    and set outcome "no-results". That is a real result, not a failure.',
    '  - Search rate-limited, walled off or broken? Set outcome to',
    '    "rate-limited", "blocked" or "tool-failed". Do NOT report those as',
    '    "no-results": an empty search that never ran proves nothing, and',
    '    misfiling it makes the report claim there is no public record of',
    '    something nobody managed to look for.',
  ];
  return lines.join('\n');
}

/** The brief handed to the drafting spawn, after the registry is frozen. */
export function draftPrompt(question: string, session: Session, notes: readonly string[]): string {
  return [
    `Write the research report answering: ${question}`,
    '',
    'You did not do this searching. Everything you may cite was gathered by',
    'workers and is listed below. The list is FROZEN: you may not add a source,',
    'including one you happen to know. A draft citing anything not on this list',
    'is rejected, so reach for the list rather than for memory.',
    '',
    renderRegistry(session),
    ...(notes.length > 0 ? ['', 'Reading notes from the deep tasks:', ...notes] : []),
    '',
    'Cite by URL, inline. Where the sources disagree, give both readings and say',
    'who holds which rather than averaging them into one number. Where the',
    'evidence does not settle the question, say that instead of implying it does.',
    'Mark anything you inferred rather than read as <INFERENCE>.',
    '',
    'Output the report as markdown. No preamble.',
  ].join('\n');
}

/** One CLI spawn. Resolves with stdout; rejects only on a failure to start. */
function askCli(
  bin: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  spawnedBy: string,
): Promise<{ readonly stdout: string; readonly code: number | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    // No shell, matching `local.ts`: the brief is author-written text and a
    // quoting mistake in a shell would be command execution.
    const child = spawn(bin, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Same marker as the direct lane. A loop worker is a panel member too,
      // and one that reaches for `research_start` rather than its own search
      // would otherwise buy a paid run charged to the user.
      env: { ...cliEnv(), DOSSIER_SPAWNED_BY: spawnedBy },
    });
    let stdout = '';
    let bytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolvePromise({ stdout, code: null });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        return;
      }
      stdout += chunk.toString('utf8');
    });
    // Drained rather than ignored: a full stderr pipe blocks the child.
    child.stderr.on('data', () => undefined);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, code });
    });
  });
}

interface LoopRun {
  status: 'in_progress' | 'completed' | 'failed';
  markdown: string;
  error?: string;
  readonly startedAt: number;
}

let counter = 0;

/**
 * A provider that runs this product's own loop over one CLI's web search.
 *
 * `honoursNoSearch` is the adapter's own answer, not an assumption. An adapter
 * with no documented way to deny its tools cannot be run closed-book, and a
 * request to do so is refused rather than quietly run with search on — the
 * failure mode being a column labelled closed-book whose cells all searched.
 */
export function loopProvider(config: Config, adapter: CliAdapter): ResearchProvider {
  // Mirrors `localProvider`'s block, because the loop's capabilities are the
  // CLI's capabilities: the method between the question and the answer changes
  // how well it searches, not what it can enforce. The one honest difference is
  // wall clock, since this spawns once per task rather than once per run.
  const capabilities: Capabilities = {
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
    maxWallClockMinutes: 60,
    billedTo: 'subscription',
    limitations: [
      'Orchestrates in-process, so a server restart loses a run in flight. Nothing is charged: the work spends a CLI subscription.',
      'Spawns the CLI once per search task plus once to draft, so it is slower and spends more subscription quota than running that CLI directly.',
      'A no-search run is implemented for Claude Code only; other CLIs have no documented way to deny their tools and the request is refused rather than run with search on.',
      'The draft is checked against the frozen registry and reported as written when it cites outside it. It is never silently repaired, because a report edited to pass its own gate is no longer evidence about the backend.',
    ],
  };

  const runs = new Map<string, LoopRun>();
  const workDir = cliWorkDir(config.storeDir);

  async function orchestrate(id: string, args: CreateRunArgs, bin: string, headless: (p: string, model?: string) => readonly string[]): Promise<void> {
    const run = runs.get(id);
    if (!run) return;
    const noSearch = (args.tools ?? []).length === 0;

    const tasks = decompose(args.prompt, { archetype: 'technical', maxTasks: 5 });
    const session: Session = SessionSchema.parse({
      runId: id,
      question: args.prompt,
      createdAt: new Date().toISOString(),
      asOf: new Date().toISOString().slice(0, 10),
      tasks: tasks.map((t) => ({
        id: t.id,
        sourceClass: t.sourceClass,
        depth: t.depth,
        objective: t.objective,
        group: t.group,
        dependsOn: [...t.dependsOn],
      })),
    });

    const notes: string[] = [];
    for (const task of tasks) {
      const prompt = workerPrompt(args.prompt, task, noSearch);
      const argv = noSearch
        ? ['-p', '--disallowedTools', ...CLOSED_BOOK_TOOLS, '--', prompt]
        : headless(prompt, config.localModels[adapter.id]);

      let findings: readonly Finding[] = [];
      let gaps: string | undefined;
      // No initialiser on purpose: every path below assigns it, and letting the
      // compiler prove that beats seeding it with `'ok'`, which is the one value
      // that would be wrong to fall through with. An unassigned outcome
      // defaulting to a clean run is how a worker that never answered gets
      // recorded as one that searched and found nothing.
      let outcome: TaskOutcome;
      try {
        const { stdout } = await askCli(bin, argv, workDir, TASK_TIMEOUT_MS, id);
        const parsed = WorkerReplySchema.safeParse(extractJsonObject(stdout));
        if (parsed.success) {
          findings = parsed.data.findings;
          gaps = parsed.data.gaps;
          outcome = parsed.data.outcome;
        } else {
          // A worker whose reply could not be read established nothing. Recording
          // that as `no-results` would claim its index is empty, which is the
          // exact misfiling the worker prompt warns against.
          outcome = 'tool-failed';
          gaps = 'the worker’s reply could not be parsed as the required JSON object';
        }
      } catch (err) {
        outcome = 'tool-failed';
        gaps = err instanceof Error ? err.message.slice(0, 500) : 'the worker could not be started';
      }

      mergeFindings(session, task.id, findings, {
        outcome,
        ...(gaps === undefined ? {} : { gaps }),
      });
      if (task.depth === 'deep' && gaps !== undefined) notes.push(`- ${task.id}: ${gaps}`);
    }

    freezeRegistry(session);

    if (session.registry.length === 0) {
      run.status = 'failed';
      run.error =
        'No worker returned a usable source, so there is nothing to draft from. ' +
        'The per-task outcomes distinguish an index with nothing in it from a search that never ran.';
      return;
    }

    const draft = draftPrompt(args.prompt, session, notes);
    const draftArgv = noSearch
      ? ['-p', '--disallowedTools', ...CLOSED_BOOK_TOOLS, '--', draft]
      : headless(draft, config.localModels[adapter.id]);
    const { stdout } = await askCli(bin, draftArgv, workDir, DRAFT_TIMEOUT_MS, id);

    const verdict = validateDraft(session, stdout);
    run.markdown = verdict.ok
      ? stdout
      : [
          '> [!WARNING]',
          `> This draft cited ${String(verdict.unregistered.length)} source(s) the run never gathered.`,
          '> They are listed below and the draft is reported as written, not silently repaired,',
          '> because a report edited to pass its own gate is no longer evidence about the backend.',
          '>',
          ...verdict.unregistered.map((u) => `> - ${u}`),
          '',
          stdout,
        ].join('\n');
    run.status = 'completed';
  }

  const client: DeepResearchClient = {
    async createRun(args: CreateRunArgs): Promise<InteractionSnapshot> {
      const status = await probeCli(adapter);
      if (status.state === 'absent') throw new Error(`\`${adapter.bin}\` is no longer on PATH.`);
      if (status.state === 'ambiguous') {
        throw new Error(
          `Refusing to run \`${adapter.bin}\`: ${status.detail} ` +
            'Set DOSSIER_LOCAL_CLI to a backend you have verified with `research_doctor`.',
        );
      }
      const bin = status.path ?? resolveOnPath(adapter.bin);
      if (!bin) throw new Error(`\`${adapter.bin}\` is no longer on PATH.`);

      if ((args.tools ?? []).length === 0 && !NO_SEARCH_CLIS.includes(adapter.id)) {
        throw new Error(
          `A no-search run is implemented for claude only; \`${adapter.id}\` has no documented way to deny its tools. ` +
            'Running it with search on and labelling the column closed-book would be the benchmark lying about its own conditions.',
        );
      }

      const headless = await resolveHeadless(adapter, bin);
      const id = `loop_${adapter.id}_${Date.now().toString(36)}${String(counter++).padStart(3, '0')}`;
      runs.set(id, { status: 'in_progress', markdown: '', startedAt: Date.now() });

      // Deliberately not awaited: `createRun` returns as soon as the id exists,
      // exactly as its siblings do, and the runner polls `getRun` from there.
      void orchestrate(id, args, bin, headless).catch((err: unknown) => {
        const run = runs.get(id);
        if (!run) return;
        run.status = 'failed';
        run.error = err instanceof Error ? err.message.slice(0, 500) : String(err);
      });

      return { interactionId: id, status: 'in_progress', markdown: '', thoughts: [], images: [] };
    },

    getRun(interactionId: string): Promise<InteractionSnapshot> {
      const run = runs.get(interactionId);
      if (!run) {
        // The in-process limit surfacing. Named for what it is rather than
        // reported as a run that failed, which would put the blame on the CLI.
        return Promise.reject(
          new Error(
            `No local loop run \`${interactionId}\` in memory. This provider orchestrates in-process, ` +
              'so a server restart loses runs in flight. Nothing was charged: the work spends a CLI subscription.',
          ),
        );
      }
      return Promise.resolve({
        interactionId,
        status: run.status,
        markdown: run.markdown,
        thoughts: [],
        images: [],
        ...(run.error === undefined ? {} : { error: run.error }),
      });
    },

    cancelRun(interactionId: string): Promise<void> {
      const run = runs.get(interactionId);
      if (run && run.status === 'in_progress') {
        run.status = 'failed';
        run.error = 'cancelled';
      }
      return Promise.resolve();
    },

    followUp(): Promise<string> {
      throw new Error('The local loop has no follow-up turn.');
    },
  };

  return {
    id: `loop-${adapter.id}` as ResearchProvider['id'],
    label: `${adapter.label} driving Dossier’s own research loop`,
    capabilities,
    detect(): CredentialStatus {
      if (config.hermetic) {
        return { state: 'not-configured', detail: 'hermetic mode: no subprocesses are spawned' };
      }
      if (resolveOnPath(adapter.bin) === null) {
        return { state: 'not-configured', detail: `\`${adapter.bin}\` is not on PATH` };
      }
      // Reported truthfully, matching the direct lane. Omitting it did not keep
      // this backend out of panels cleanly — it kept it out with the reason
      // "installed but not signed in", which is false and would send someone
      // debugging a sign-in that is fine. Panel membership is decided
      // deliberately in the registry instead.
      return {
        state: 'configured-unverified',
        detail: `${adapter.label} is on PATH; the loop drives it once per search task.`,
        signedIn: hasSignInFile(adapter),
      };
    },
    estimate(): ProviderEstimate {
      return {
        cost: localCost(),
        duration: {
          // One spawn per search task plus one to draft, against `local`'s
          // single spawn. Slower by construction, and that is the trade the
          // comparison exists to price.
          lowMinutes: 6,
          highMinutes: 45,
          factors: ['one CLI spawn per search task, plus one to draft from the frozen registry'],
          sources: ['whatever web search the CLI itself has'],
          awaitsApproval: false,
          cappedByApiLimit: false,
        },
      };
    },
    client(): DeepResearchClient {
      return client;
    },
  };
}
