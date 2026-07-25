import type { Config } from '../config.js';
import type { DeepResearchClient, ResearchToolSpec } from '../gemini/client.js';
import { estimateCost } from '../gemini/cost.js';
import type { InteractionSnapshot, ResearchTier } from '../gemini/types.js';
import { newRunId, Store } from '../store/store.js';
import { TERMINAL_STATES, type RunRecord, type RunState } from '../store/types.js';
import type { Archetype } from './archetypes.js';
import { fingerprint } from './contract.js';
import { extractPlan } from './plan.js';
import { StreamSupervisor } from './stream.js';
import { extractCitedUrls, normaliseCitations } from './report.js';

/**
 * Run lifecycle.
 *
 * The poller is in-process and runs on a timer; the store is the source of
 * truth. Restart the server mid-run and it picks the run back up from disk on
 * the next tick. Disconnect the MCP client mid-run and nothing is lost — the
 * journal keeps accumulating and `research_tail` replays it by cursor.
 */

export class BudgetExceededError extends Error {
  readonly code = 'budget_exceeded' as const;
  constructor(
    readonly spentUsd: number,
    readonly budgetUsd: number,
    readonly windowHours: number,
  ) {
    super(
      `Budget gate: $${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} already committed in the last ${windowHours}h. ` +
        'Raise DOSSIER_BUDGET_USD, wait for the window to roll, or cancel a run.',
    );
    this.name = 'BudgetExceededError';
  }
}

export class ConcurrencyExceededError extends Error {
  readonly code = 'concurrency_exceeded' as const;
  constructor(readonly active: number, readonly max: number) {
    super(`${active} runs already in flight (max ${max}). Wait for one to finish or cancel it.`);
    this.name = 'ConcurrencyExceededError';
  }
}

export interface StartRunArgs {
  readonly question: string;
  readonly prompt: string;
  readonly archetype: Archetype;
  readonly tier: ResearchTier;
  readonly tools: readonly ResearchToolSpec[];
  readonly collaborativePlanning: boolean;
  readonly thinkingSummaries: boolean;
  readonly visualization: boolean;
  readonly preEngineered: boolean;
  readonly label?: string;
  readonly tags?: readonly string[];
  readonly attachments?: readonly {
    readonly kind: 'document' | 'image';
    readonly uri: string;
    readonly mimeType: string;
  }[];
}

export interface StartRunResult {
  readonly run: RunRecord;
  /** True when an identical in-flight/recent run was returned instead. */
  readonly deduped: boolean;
}

export interface BudgetSnapshot {
  readonly budgetUsd: number;
  readonly windowHours: number;
  readonly committedUsd: number;
  readonly remainingUsd: number;
  readonly runsInWindow: number;
  readonly activeRuns: number;
  readonly maxConcurrent: number;
}

export class Runner {
  private timer: NodeJS.Timeout | null = null;
  /** Guards against overlapping ticks when a poll outlives its interval. */
  private ticking = false;
  private readonly supervisor: StreamSupervisor | null;

  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly client: DeepResearchClient | null,
    private readonly onFinalise?: (run: RunRecord, markdown: string) => Promise<void>,
  ) {
    // Streaming is additive: without a client that supports it, everything
    // below still works on polling alone.
    this.supervisor = client?.streamRun ? new StreamSupervisor({ store, client }) : null;
  }

  /**
   * Attach the live progress stream to a run, if the client supports it.
   * Deliberately fire-and-forget: the poller, not the stream, decides when a
   * run is finished, so a stream that never attaches costs progress detail and
   * nothing else.
   */
  private attachStream(run: RunRecord): void {
    if (!this.supervisor || run.streamAbandoned || !run.interactionId) return;
    if (run.state === 'planning' && !run.planApproved) return;
    void this.supervisor.attach(run).catch(() => undefined);
  }

  /** Current spend position within the rolling window. */
  async budget(): Promise<BudgetSnapshot> {
    const since = new Date(Date.now() - this.config.budgetWindowHours * 3_600_000).toISOString();
    const entries = await this.store.readLedger(since);
    const committed = entries.reduce((sum, e) => sum + e.estimatedCostUsd, 0);
    const active = await this.store.activeRuns();
    return {
      budgetUsd: this.config.budgetUsd,
      windowHours: this.config.budgetWindowHours,
      committedUsd: Number(committed.toFixed(2)),
      remainingUsd: Number(Math.max(0, this.config.budgetUsd - committed).toFixed(2)),
      runsInWindow: entries.length,
      activeRuns: active.length,
      maxConcurrent: this.config.maxConcurrent,
    };
  }

  fingerprintFor(args: Pick<StartRunArgs, 'prompt' | 'tier' | 'tools' | 'collaborativePlanning'>): string {
    return fingerprint({
      prompt: args.prompt,
      tier: args.tier,
      tools: args.tools,
      collaborativePlanning: args.collaborativePlanning,
    });
  }

  /**
   * Start a run. Order matters: dedupe first (free), then the concurrency and
   * budget gates (still free), and only then the paid API call. The ledger is
   * written *before* the interaction is created so a crash between the two
   * over-counts rather than under-counts — the safe direction for a spend gate.
   */
  async start(args: StartRunArgs): Promise<StartRunResult> {
    if (!this.client) {
      throw new Error(
        'No Gemini client available. Set GEMINI_API_KEY or VERTEX_PROJECT (and unset DOSSIER_HERMETIC).',
      );
    }

    const fp = this.fingerprintFor(args);

    const existing = await this.store.findByFingerprint(fp, this.config.dedupeTtlMinutes);
    if (existing) return { run: existing, deduped: true };

    const active = await this.store.activeRuns();
    if (active.length >= this.config.maxConcurrent) {
      throw new ConcurrencyExceededError(active.length, this.config.maxConcurrent);
    }

    const band = estimateCost(args.tier);
    if (this.config.budgetUsd > 0) {
      const snapshot = await this.budget();
      if (snapshot.committedUsd + band.midUsd > snapshot.budgetUsd) {
        throw new BudgetExceededError(
          snapshot.committedUsd,
          snapshot.budgetUsd,
          snapshot.windowHours,
        );
      }
    }

    const now = new Date().toISOString();
    const id = newRunId();
    const record: RunRecord = {
      id,
      interactionId: '',
      state: args.collaborativePlanning ? 'planning' : 'running',
      tier: args.tier,
      archetype: args.archetype,
      question: args.question.slice(0, 20_000),
      prompt: args.prompt.slice(0, 200_000),
      promptWasPreEngineered: args.preEngineered,
      fingerprint: fp,
      createdAt: now,
      updatedAt: now,
      lastProgressAt: now,
      estimatedCostUsd: band.midUsd,
      tags: [...(args.tags ?? [])],
      planApproved: !args.collaborativePlanning,
      reportChars: 0,
      sourceCount: 0,
      imageCount: 0,
      searches: 0,
      urlsFetched: 0,
      corpusQueries: 0,
      codeRuns: 0,
      streamAbandoned: false,
      toolsUsed: args.tools.map((t) => t.type),
      corpusStores: args.tools.flatMap((t) =>
        t.type === 'file_search' ? [...t.fileSearchStoreNames] : [],
      ),
      ...(args.label ? { label: args.label } : {}),
    };

    await this.store.saveRun(record);
    await this.store.appendLedger({
      at: now,
      runId: id,
      tier: args.tier,
      estimatedCostUsd: band.midUsd,
      ...(args.label ? { label: args.label } : {}),
    });

    let snapshot: InteractionSnapshot;
    try {
      snapshot = await this.client.createRun({
        prompt: args.prompt,
        tier: args.tier,
        collaborativePlanning: args.collaborativePlanning,
        thinkingSummaries: args.thinkingSummaries,
        visualization: args.visualization,
        tools: args.tools,
        ...(args.attachments ? { attachments: args.attachments } : {}),
      });
    } catch (e: unknown) {
      const failed: RunRecord = {
        ...record,
        state: 'failed',
        error: e instanceof Error ? e.message : String(e),
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveRun(failed);
      await this.store.appendJournal(id, 'failed', failed.error ?? 'unknown error');
      throw e;
    }

    const started: RunRecord = { ...record, interactionId: snapshot.interactionId };
    await this.store.saveRun(started);
    await this.store.appendJournal(
      id,
      'created',
      `Run started (${args.tier} tier, ${args.archetype} archetype, interaction ${snapshot.interactionId || 'pending'}).`,
    );

    // The create call may already carry the collaborative plan.
    const advanced = await this.applySnapshot(started, snapshot);
    this.attachStream(advanced);
    return { run: advanced, deduped: false };
  }

  /**
   * Fold an interaction snapshot into a run record, appending journal events for
   * anything new. Idempotent: re-applying the same snapshot is a no-op, which is
   * what makes the poller safe to run on an overlapping schedule.
   */
  private async applySnapshot(run: RunRecord, snapshot: InteractionSnapshot): Promise<RunRecord> {
    const now = new Date().toISOString();
    let next: RunRecord = { ...run, updatedAt: now };
    let progressed = false;

    if (snapshot.interactionId && next.interactionId !== snapshot.interactionId) {
      next = { ...next, interactionId: snapshot.interactionId };
      progressed = true;
    }

    if (snapshot.thoughts.length > 0) {
      const latest = snapshot.thoughts.at(-1) ?? '';
      const journal = await this.store.readJournal(run.id);
      const lastThought = journal.filter((e) => e.kind === 'thought').at(-1)?.message;
      if (latest && latest !== lastThought) {
        await this.store.appendJournal(run.id, 'thought', latest);
        progressed = true;
      }
    }

    switch (snapshot.status) {
      case 'failed': {
        next = {
          ...next,
          state: 'failed',
          error: snapshot.error ?? 'The research run failed with no reported reason.',
        };
        await this.store.appendJournal(run.id, 'failed', next.error ?? 'failed');
        break;
      }
      case 'completed': {
        // A collaborative-planning first turn also comes back `completed`: the
        // plan IS the output of that turn. Distinguish by approval state.
        if (!next.planApproved && next.state === 'planning') {
          // The planning turn wraps the plan behind an echo of the submitted
          // prompt; store only the reviewable part (see research/plan.ts).
          const extracted = extractPlan(snapshot.markdown, next.prompt);
          next = {
            ...next,
            plan: extracted.plan,
            ...(extracted.title ? { title: extracted.title } : {}),
          };
          await this.store.appendJournal(
            run.id,
            'plan',
            'Research plan proposed — approve it with `research_approve_plan` to spend the run.',
          );
          progressed = true;
          break;
        }
        const markdown = normaliseCitations(snapshot.markdown);
        await this.store.saveReport(run.id, markdown);
        next = {
          ...next,
          state: 'completed',
          completedAt: now,
          reportPath: `reports/${run.id}.md`,
          reportChars: markdown.length,
          sourceCount: extractCitedUrls(markdown).length,
          imageCount: snapshot.images.length,
        };
        await this.store.appendJournal(
          run.id,
          'completed',
          `Report ready — ${markdown.length} chars, ${next.sourceCount} cited sources.`,
        );
        if (this.onFinalise) {
          // Title/summary generation is best-effort: a utility-model hiccup must
          // not lose a report that already cost dollars to produce.
          try {
            await this.onFinalise(next, markdown);
            const reloaded = await this.store.getRun(run.id);
            if (reloaded) next = { ...reloaded, ...next, ...(reloaded.title ? { title: reloaded.title } : {}), ...(reloaded.summary ? { summary: reloaded.summary } : {}) };
          } catch {
            await this.store.appendJournal(
              run.id,
              'note',
              'Title/summary generation failed; the report itself is unaffected.',
            );
          }
        }
        break;
      }
      case 'in_progress': {
        if (next.state === 'planning' && next.planApproved) next = { ...next, state: 'running' };
        else if (next.state === 'stalled') {
          next = { ...next, state: 'running' };
          await this.store.appendJournal(run.id, 'progress', 'Run resumed after a stall.');
          progressed = true;
        }
        break;
      }
      default: {
        const _exhaustive: never = snapshot.status;
        return _exhaustive;
      }
    }

    if (progressed || snapshot.status !== 'in_progress') {
      next = { ...next, lastProgressAt: now };
    }

    await this.store.saveRun(next);
    return next;
  }

  /** Poll one run against the API and persist whatever changed. */
  async refresh(runId: string): Promise<RunRecord | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    if (TERMINAL_STATES.includes(run.state)) return run;
    if (!run.interactionId) return run;
    // A planning run must still be polled until the plan ARRIVES — the plan is
    // the output of the collaborative-planning turn. Only once it is captured
    // does the run park, waiting on a human rather than on Gemini.
    if (run.state === 'planning' && !run.planApproved && run.plan) return run;
    if (!this.client) return run;

    let snapshot: InteractionSnapshot;
    try {
      snapshot = await this.client.getRun(run.interactionId);
    } catch (e: unknown) {
      // A transient poll failure is not a failed run. Record a breadcrumb and
      // let the watchdog decide when silence has gone on too long.
      await this.store.appendJournal(
        run.id,
        'note',
        `Poll failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return this.checkStall(run);
    }
    const advanced = await this.applySnapshot(run, snapshot);
    return this.checkStall(advanced);
  }

  /**
   * Liveness, separate from status. `in_progress` is a lie after minute 50 and
   * a caller has no way to tell a thinking run from a dead one — so a run with
   * no forward progress inside the watchdog window is marked `stalled`, which
   * is a state a caller can actually branch on. It is deliberately recoverable:
   * a later delta flips it back to `running`.
   */
  private async checkStall(run: RunRecord): Promise<RunRecord> {
    if (TERMINAL_STATES.includes(run.state) || run.state === 'stalled') return run;
    if (run.state === 'planning' && !run.planApproved) return run;
    const idleMs = Date.now() - Date.parse(run.lastProgressAt);
    if (idleMs < this.config.stallMinutes * 60_000) return run;
    const stalled: RunRecord = { ...run, state: 'stalled', updatedAt: new Date().toISOString() };
    await this.store.saveRun(stalled);
    await this.store.appendJournal(
      run.id,
      'stalled',
      `No forward progress for ${Math.round(idleMs / 60_000)} minutes. The run may still recover; cancel it with \`research_cancel\` if not.`,
    );
    return stalled;
  }

  /** Approve a collaborative plan, releasing the run to execute. */
  async approvePlan(runId: string, amendment?: string): Promise<RunRecord | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    if (run.planApproved) return run;
    if (!this.client) throw new Error('No Gemini client available.');

    // Approval is "continue from the planning interaction with the flag off" —
    // an amendment rides along as the input for that turn.
    const snapshot = await this.client.createRun({
      prompt:
        amendment?.trim() ||
        'The plan is approved as proposed. Proceed with the research and produce the full report in the specified output format.',
      tier: run.tier,
      collaborativePlanning: false,
      thinkingSummaries: true,
      visualization: true,
      previousInteractionId: run.interactionId,
    });

    const approved: RunRecord = {
      ...run,
      planApproved: true,
      state: 'running',
      interactionId: snapshot.interactionId || run.interactionId,
      updatedAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
    };
    await this.store.saveRun(approved);
    this.attachStream(approved);
    await this.store.appendJournal(
      runId,
      'progress',
      amendment?.trim()
        ? `Plan approved with an amendment: ${amendment.trim().slice(0, 500)}`
        : 'Plan approved as proposed. Research is now executing.',
    );
    return this.applySnapshot(approved, snapshot);
  }

  async cancel(runId: string): Promise<RunRecord | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    if (TERMINAL_STATES.includes(run.state)) return run;
    if (this.client && run.interactionId) {
      await this.client.cancelRun(run.interactionId).catch(() => undefined);
    }
    const cancelled: RunRecord = {
      ...run,
      state: 'cancelled',
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveRun(cancelled);
    await this.store.appendJournal(runId, 'cancelled', 'Run cancelled by the caller.');
    return cancelled;
  }

  /** Advance every in-flight run once. Safe to call concurrently with itself. */
  async tick(): Promise<{ polled: number }> {
    if (this.ticking) return { polled: 0 };
    this.ticking = true;
    try {
      const active = await this.store.activeRuns();
      let polled = 0;
      for (const run of active) {
        // Parked awaiting human approval — polling it costs nothing but the
        // run cannot advance until `research_approve_plan` releases it.
        if (run.state === 'planning' && !run.planApproved && run.plan) continue;
        // Re-attach anything the supervisor is not currently following, which
        // covers a server restart mid-run as well as an abandoned stream.
        if (this.supervisor && !this.supervisor.isAttached(run.id)) this.attachStream(run);
        await this.refresh(run.id).catch(() => undefined);
        polled += 1;
      }
      return { polled };
    } finally {
      this.ticking = false;
    }
  }

  /** Start the background poller. Idempotent. */
  startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.config.pollSeconds * 1000);
    // Never hold the process open on the poller alone — a stdio server must
    // exit when its client disconnects.
    this.timer.unref?.();
  }

  stopPolling(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

/** Human-readable one-liner for a run, used across every tool response. */
export function describeRun(run: RunRecord): string {
  const age = Math.round((Date.now() - Date.parse(run.createdAt)) / 60_000);
  const bits = [
    `${run.id} [${run.state}]`,
    `${run.tier}/${run.archetype}`,
    `${age}m old`,
  ];
  if (run.state === 'completed') bits.push(`${run.sourceCount} sources`);
  if (run.error) bits.push(`error: ${run.error.slice(0, 120)}`);
  return bits.join(' · ');
}

export function stateHint(state: RunState): string {
  switch (state) {
    case 'planning':
      return 'Awaiting plan approval — call `research_approve_plan`.';
    case 'running':
      return 'In flight. Poll with `research_status`, or replay progress with `research_tail`.';
    case 'stalled':
      return 'No progress within the watchdog window. It may still recover; `research_cancel` stops it.';
    case 'completed':
      return 'Read it with `research_read` (starts with an outline, not the whole report).';
    case 'failed':
      return 'Failed. The error is on the record; starting again will cost another run.';
    case 'cancelled':
      return 'Cancelled.';
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}
