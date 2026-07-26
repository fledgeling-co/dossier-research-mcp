import type { Config } from '../config.js';
import type { DeepResearchClient, ResearchToolSpec } from '../gemini/client.js';
import { pollDelayMs } from '../net/retry.js';
import { AGENT_RUN_BAND, AGENT_RUN_HARD_CAP_USD, UTILITY_CALL_BAND, estimateCost } from '../gemini/cost.js';
import type { CostBand, DurationOptions } from '../gemini/cost.js';
import type { InteractionSnapshot, ResearchTier } from '../gemini/types.js';
import { newRunId, Store } from '../store/store.js';
import { TERMINAL_STATES, type RunRecord, type RunState } from '../store/types.js';
import type { Archetype } from './archetypes.js';
import type { ProviderId } from '../providers/types.js';
import { fingerprint } from './contract.js';
import { extractPlan } from './plan.js';
import { KeyedMutex, Mutex } from './spend.js';
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

/** The report's own first heading, which is a better title than a bought one. */
function firstHeading(markdown: string): string | undefined {
  const match = /^#{1,3}\s+(.+)$/m.exec(markdown);
  const text = match?.[1]?.trim().slice(0, 300);
  return text && text.length > 0 ? text : undefined;
}

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
  /** Which backend runs this. Defaults to Gemini. */
  readonly provider?: ProviderId;
  /** The artefact shape asked for. Defaults to a deep report. */
  readonly shape?: 'deep' | 'wide' | 'recent' | 'corpus';
  /** The time window asked for, recorded for the audit trail. */
  readonly window?: string;
  /** The wide spec, serialised, when this is a wide run. */
  readonly wideSpec?: string;
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

/**
 * Does this run hold a slot the concurrency cap exists to limit?
 *
 * The cap bounds work in flight at a provider, not records in a directory. A
 * local-loop session is an open notebook: nothing is executing anywhere, it is
 * waiting for its host to report findings, and it may sit open for an hour
 * while somebody searches. Counting those would let ten free sessions refuse a
 * paid run with "10 runs already in flight", which is both wrong and baffling.
 *
 * An interaction id means something is genuinely running (an API job, or a
 * subprocess). A non-zero reservation covers the window inside `start()` where
 * the record exists and the paid call has not returned yet, which is precisely
 * the window the admission lock is protecting.
 */
function occupiesSlot(run: RunRecord): boolean {
  return run.interactionId !== '' || run.estimatedCostUsd > 0;
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
  /** Drives poll backoff; reset to 0 by any successful tick. */
  private consecutivePollFailures = 0;
  /** Guards against overlapping ticks when a poll outlives its interval. */
  private ticking = false;
  private readonly supervisor: StreamSupervisor | null;
  /**
   * Serialises check-and-reserve *within* this process. Fast, and the common
   * case: an agent making parallel tool calls.
   */
  private readonly spendLock = new Mutex();
  /** Serialises lifecycle transitions per run: approve, cancel, finalise. */
  private readonly runLock = new KeyedMutex();

  constructor(
    private readonly store: Store,
    private readonly config: Config,
    /**
     * Resolve the client for a given backend.
     *
     * A function rather than a fixed client because a run's provider is now a
     * property of the run, not of the server: a Gemini run and a Perplexity run
     * are polled, cancelled and continued through different clients, and the
     * runner must be able to pick the right one an hour after the run started.
     * Returns null when that backend has no credentials.
     */
    private readonly resolveClient: (provider: ProviderId) => DeepResearchClient | null,
    private readonly onFinalise?: (run: RunRecord, markdown: string) => Promise<void>,
    /**
     * Per-provider cost band.
     *
     * The gate reserves before it spends, so it has to reserve the band of the
     * backend that will actually run. Reserving Google's $1-3 for a Perplexity
     * wide run that can reach $6 is not a ceiling, it is a ceiling-shaped hole.
     * Optional so every existing single-provider caller keeps working on the
     * Gemini bands, which is what they were already getting.
     */
    private readonly estimateFor?: (provider: ProviderId, input: DurationOptions) => CostBand,
    /** The model a backend will use for a tier, so the run can be attributed. */
    private readonly modelFor?: (provider: ProviderId, tier: ResearchTier) => string | null,
  ) {
    // Streaming is additive: without a client that supports it, everything
    // below still works on polling alone.
    // Streaming is a Gemini capability today. Resolved once for the default
    // backend rather than per run: a provider without a stream simply polls,
    // which is the same fallback that already existed.
    const streaming = resolveClient('gemini');
    this.supervisor = streaming?.streamRun ? new StreamSupervisor({ store, client: streaming }) : null;
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

  /**
   * Run a check-and-reserve section under both locks.
   *
   * In-process mutex first, so concurrent calls in one server queue cheaply
   * without touching the filesystem. Cross-process file lock second, so a
   * second server on the same store cannot observe headroom this one has
   * already claimed. Order matters: taking the file lock first would hold a
   * filesystem lock while waiting on an in-memory queue, which is the slow way
   * round and blocks other processes for no reason.
   */
  private async withAdmissionLock<T>(task: () => Promise<T>): Promise<T> {
    return this.spendLock.run(async () => this.store.admissionLock().run(task));
  }

  /** Current spend position within the rolling window. */
  async budget(): Promise<BudgetSnapshot> {
    const since = new Date(Date.now() - this.config.budgetWindowHours * 3_600_000).toISOString();
    const { entries, unreadableLines } = await this.store.readLedgerStrict(since);
    // A line we cannot parse is spend we cannot see. Charging the worst case
    // per damaged line keeps corruption from raising the ceiling; the
    // alternative is that editing the ledger grants free runs.
    const committed =
      entries.reduce((sum, e) => sum + e.estimatedCostUsd, 0) +
      unreadableLines * estimateCost('max').highUsd;
    const active = (await this.store.activeRuns()).filter(occupiesSlot);
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

  fingerprintFor(
    args: Pick<
      StartRunArgs,
      'prompt' | 'tier' | 'tools' | 'collaborativePlanning' | 'attachments' | 'provider' | 'shape' | 'window' | 'wideSpec'
    >,
  ): string {
    return fingerprint({
      prompt: args.prompt,
      tier: args.tier,
      tools: args.tools,
      collaborativePlanning: args.collaborativePlanning,
      // Identity, not just order: `kind` and `uri` both change the purchase.
      attachments: (args.attachments ?? []).map((a) => `${a.kind}:${a.uri}`),
      ...(args.provider ? { provider: args.provider } : {}),
      ...(args.shape ? { shape: args.shape } : {}),
      ...(args.window ? { window: args.window } : {}),
      ...(args.wideSpec ? { wideSpec: args.wideSpec } : {}),
    });
  }

  /**
   * Start a run. Order matters: dedupe first (free), then the concurrency and
   * budget gates (still free), and only then the paid API call. The ledger is
   * written *before* the interaction is created so a crash between the two
   * over-counts rather than under-counts — the safe direction for a spend gate.
   */
  async start(args: StartRunArgs): Promise<StartRunResult> {
    const provider: ProviderId = args.provider ?? 'gemini';
    const client = this.resolveClient(provider);
    if (!client) {
      throw new Error(
        `No ${provider} client available. Check its credentials with \`research_doctor\`.`,
      );
    }

    const fp = this.fingerprintFor(args);
    // Same estimate the caller was shown in `research_plan`. If the gate
    // reserved a bare tier band while the plan advertised a tool-inflated one,
    // the ceiling would quietly under-reserve exactly the heaviest runs.
    const estimateInput: DurationOptions = {
      tier: args.tier,
      tools: args.tools.map((x) => x.type),
      attachments: args.attachments?.length ?? 0,
      collaborativePlanning: args.collaborativePlanning,
      ...(args.shape ? { shape: args.shape } : {}),
    };
    const band = this.estimateFor
      ? this.estimateFor(provider, estimateInput)
      : estimateCost(estimateInput);

    // Everything from here to the ledger write is one critical section. Dedupe
    // is inside it too: two identical concurrent requests must collapse onto
    // one run rather than both missing and both paying.
    const reserved = await this.withAdmissionLock(async () => {
      const existing = await this.store.findByFingerprint(fp, this.config.dedupeTtlMinutes);
      if (existing) return { existing } as const;

      const active = (await this.store.activeRuns()).filter(occupiesSlot);
      // Unreadable run files count as occupied slots. Skipping them would mean
      // corrupting a file raises the concurrency cap.
      const unreadable = await this.store.unreadableRunCount();
      const occupied = active.length + unreadable;
      if (occupied >= this.config.maxConcurrent) {
        throw new ConcurrencyExceededError(occupied, this.config.maxConcurrent);
      }

      if (this.config.budgetUsd > 0) {
        const perProvider = this.config.providerBudgetsUsd[provider] ?? 0;
        if (perProvider > 0) {
          const spentHere = await this.committedFor(provider);
          if (spentHere + band.highUsd > perProvider) {
            throw new BudgetExceededError(spentHere, perProvider, this.config.budgetWindowHours);
          }
        }
        const snapshot = await this.budget();
        // Reserve the WORST case, not the midpoint. A max run is $3-7;
        // reserving $5 for a run that costs $7 overshoots systematically, and
        // a ceiling that overshoots is not a ceiling. Reserving high can only
        // refuse slightly early, which is the safe direction.
        if (snapshot.committedUsd + band.highUsd > snapshot.budgetUsd) {
          throw new BudgetExceededError(
            snapshot.committedUsd,
            snapshot.budgetUsd,
            snapshot.windowHours,
          );
        }
      }

      // Reserve BOTH counters before releasing the lock. The ledger covers the
      // budget; the run record covers concurrency, because `activeRuns()`
      // reads records, so a record written after the lock releases is
      // invisible to the next contender and the cap leaks. Writing only the
      // ledger here let a cap of 2 admit 3.
      const id = newRunId();
      const at = new Date().toISOString();
      const record: RunRecord = {
        id,
        interactionId: '',
        state: args.collaborativePlanning ? 'planning' : 'running',
        tier: args.tier,
        // Recorded at start, not at completion: a run that fails halfway is
        // exactly the one you want to attribute to a model.
        ...(this.modelFor?.(provider, args.tier) ? { model: this.modelFor(provider, args.tier)! } : {}),
        archetype: args.archetype,
        question: args.question.slice(0, 20_000),
        prompt: args.prompt.slice(0, 200_000),
        promptWasPreEngineered: args.preEngineered,
        provider,
        shape: args.shape ?? 'deep',
        ...(args.window ? { window: args.window } : {}),
        ...(args.wideSpec ? { wideSpec: args.wideSpec } : {}),
        fingerprint: fp,
        createdAt: at,
        updatedAt: at,
        lastProgressAt: at,
        estimatedCostUsd: band.highUsd,
        tags: [...(args.tags ?? [])],
        planApproved: !args.collaborativePlanning,
        reportChars: 0,
        sourceCount: 0,
        imageCount: 0,
        reasoningSteps: 0,
        streamedChars: 0,
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
        at,
        runId: id,
        tier: args.tier,
        estimatedCostUsd: band.highUsd,
        provider,
        ...(args.label ? { label: args.label } : {}),
      });
      return { record } as const;
    });

    if ('existing' in reserved) return { run: reserved.existing, deduped: true };

    const record = reserved.record;
    const id = record.id;

    let snapshot: InteractionSnapshot;
    try {
      snapshot = await client.createRun({
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

    if (!snapshot.interactionId) {
      // The call was billed but returned nothing we can poll. Failing loudly
      // beats a record that polls forever and never resolves, because the only
      // useful action here is a human looking at the provider console.
      const orphaned: RunRecord = {
        ...record,
        state: 'failed',
        error:
          'The provider accepted the run but returned no interaction id, so it cannot be polled or cancelled from here. ' +
          'It has been charged against your budget. Check the provider console for an in-flight run before retrying.',
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveRun(orphaned);
      await this.store.appendJournal(id, 'failed', orphaned.error ?? '');
      return { run: orphaned, deduped: false };
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
   * Store a report that was produced somewhere else.
   *
   * The subscription path, and the reason it exists: someone with a Google AI
   * Pro or a ChatGPT plan has already paid for deep research, and the only
   * thing standing between that and Dossier's durable, greppable,
   * citation-checked store is a copy and a paste. No admission control runs
   * here because nothing is being bought — this is the one entry point to the
   * store that costs nothing, and pretending otherwise by charging it against
   * the ceiling would refuse imports on a day the budget happened to be full.
   */
  async importRun(args: {
    question: string;
    markdown: string;
    source: string;
    label?: string;
    tags?: readonly string[];
  }): Promise<RunRecord> {
    const markdown = normaliseCitations(args.markdown);
    const id = newRunId();
    const at = new Date().toISOString();
    const record: RunRecord = {
      id,
      interactionId: '',
      provider: 'local',
      shape: 'deep',
      state: 'completed',
      tier: 'fast',
      archetype: 'technical',
      question: args.question.slice(0, 20_000),
      // The "prompt" is a provenance note. There was no prompt: whatever
      // produced this ran somewhere Dossier could not see, and recording a
      // fabricated one would put a prompt in the store that never existed.
      prompt: `[imported from ${args.source}; the original brief is not recorded here]`,
      promptWasPreEngineered: false,
      fingerprint: fingerprint({
        prompt: `import:${args.source}:${args.question}`,
        tier: 'fast',
        tools: [],
        collaborativePlanning: false,
        attachments: [],
      }),
      createdAt: at,
      updatedAt: at,
      lastProgressAt: at,
      completedAt: at,
      estimatedCostUsd: 0,
      tags: [...(args.tags ?? [])],
      planApproved: true,
      reportPath: `reports/${id}.md`,
      reportChars: markdown.length,
      sourceCount: extractCitedUrls(markdown).length,
      imageCount: 0,
      reasoningSteps: 0,
      streamedChars: 0,
      searches: 0,
      urlsFetched: 0,
      corpusQueries: 0,
      codeRuns: 0,
      streamAbandoned: false,
      toolsUsed: [],
      corpusStores: [],
      ...(args.label ? { label: args.label } : {}),
    };
    await this.store.saveReport(id, markdown);
    await this.store.saveRun(record);
    await this.store.appendJournal(
      id,
      'created',
      `Imported from ${args.source} — ${String(markdown.length)} chars, ${String(record.sourceCount)} cited sources. Nothing was charged.`,
    );

    // Deliberately NOT titled by the model.
    //
    // `onFinalise` reserves and calls the summariser, which bills. Doing that
    // here while the tool's own response says "Charged: nothing" made the one
    // claim this path exists to make into a false one. A deterministic title
    // off the report's first heading costs nothing and is usually better than a
    // generated one anyway, because it is what the document actually says.
    const titled: RunRecord = { ...record, ...(firstHeading(markdown) ? { title: firstHeading(markdown) } : {}) };
    if (titled.title !== record.title) await this.store.saveRun(titled);
    return (await this.store.getRun(id)) ?? titled;
  }

  /**
   * Open a local-loop run: a record with no interaction behind it.
   *
   * No admission control, for the same reason `importRun` has none: nothing is
   * being bought. The host does the searching with capability it already has,
   * and charging that against a spend ceiling would refuse free work on a day
   * the budget happened to be full.
   */
  async openLoop(args: { question: string; archetype: Archetype; label?: string }): Promise<RunRecord> {
    const id = newRunId();
    const at = new Date().toISOString();
    const record: RunRecord = {
      id,
      interactionId: '',
      provider: 'local',
      shape: 'deep',
      state: 'running',
      tier: 'fast',
      archetype: args.archetype,
      question: args.question.slice(0, 20_000),
      prompt: '[local loop: the host ran the searches; the task list is in the session record]',
      promptWasPreEngineered: false,
      fingerprint: fingerprint({
        prompt: `local-loop:${args.question}:${at}`,
        tier: 'fast',
        tools: [],
        collaborativePlanning: false,
        attachments: [],
      }),
      createdAt: at,
      updatedAt: at,
      lastProgressAt: at,
      estimatedCostUsd: 0,
      tags: ['local-loop'],
      planApproved: true,
      reportChars: 0,
      sourceCount: 0,
      imageCount: 0,
      reasoningSteps: 0,
      streamedChars: 0,
      searches: 0,
      urlsFetched: 0,
      corpusQueries: 0,
      codeRuns: 0,
      streamAbandoned: false,
      toolsUsed: [],
      corpusStores: [],
      ...(args.label ? { label: args.label } : {}),
    };
    await this.store.saveRun(record);
    await this.store.appendJournal(id, 'created', 'Local research loop opened. Nothing charged.');
    return record;
  }

  /** Store a local-loop draft and complete the run. */
  async closeLoop(runId: string, markdown: string): Promise<RunRecord> {
    const existing = await this.store.getRun(runId);
    if (!existing) throw new Error(`No run ${runId}.`);
    const report = normaliseCitations(markdown);
    await this.store.saveReport(runId, report);
    const at = new Date().toISOString();
    const completed: RunRecord = {
      ...existing,
      state: 'completed',
      updatedAt: at,
      lastProgressAt: at,
      completedAt: at,
      reportPath: `reports/${runId}.md`,
      reportChars: report.length,
      sourceCount: extractCitedUrls(report).length,
    };
    await this.store.saveRun(completed);
    await this.store.appendJournal(
      runId,
      'completed',
      `Local-loop report accepted — ${String(report.length)} chars, ${String(completed.sourceCount)} cited sources, all from the frozen registry.`,
    );
    // Same rule as `importRun`: a path that advertises itself as free does not
    // quietly buy a title.
    const titled: RunRecord = {
      ...completed,
      ...(firstHeading(report) ? { title: firstHeading(report) } : {}),
    };
    if (titled.title !== completed.title) await this.store.saveRun(titled);
    return (await this.store.getRun(runId)) ?? titled;
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

    // Thought journalling belongs to whichever producer is actually running.
    // When the stream is attached it owns reasoning, and the poller writing
    // the same content again produced duplicate, out-of-order entries.
    const streamOwnsThoughts = this.supervisor?.isAttached(run.id) === true || run.reasoningSteps > 0;
    if (!streamOwnsThoughts && snapshot.thoughts.length > 0) {
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
        // An authoritative figure beside our estimate, when the provider gives
        // one. It is the only way to tell whether the reserved bands are
        // calibrated rather than merely conservative.
        if (snapshot.actualCostUsd !== undefined) {
          await this.store.appendJournal(
            run.id,
            'note',
            `The provider reports this run cost $${snapshot.actualCostUsd.toFixed(4)}; ` +
              `$${next.estimatedCostUsd.toFixed(2)} was reserved against your ceiling. ` +
              'The ledger keeps the reservation, because that is what the gate counted.',
          );
        }
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
      case 'unknown': {
        // We could not read the provider's status. Treat it as a stall signal
        // rather than progress: the watchdog will surface it, and the caller
        // is told plainly rather than watching a run that never moves.
        next = {
          ...next,
          state: 'stalled',
          error:
            'The provider returned a status this server does not recognise, so the run cannot be tracked reliably. ' +
            'Check the provider console; the run may still be executing and billing.',
        };
        await this.store.appendJournal(
          run.id,
          'progress',
          'Provider returned an unrecognised status; treating the run as stalled.',
        );
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

  /**
   * Reserve budget for a spend that is not a research run.
   *
   * `agent_run` had no ceiling of any kind: no check, no ledger entry, no
   * concurrency cap, on a path Google documents as up to 3M tokens per call.
   * It goes through the same critical section as a research run so the two
   * cannot race each other either.
   */
  /**
   * Reserve for a managed-agent run.
   *
   * The band is a guess: the agent's model and token volume are the caller's
   * choice, not ours, and a Pro-class agent can exceed a Flash-rate estimate
   * several times over. Reserving the hard cap rather than the band means an
   * unpredictable call cannot quietly outrun the ceiling. It refuses earlier
   * than strictly necessary, which is the correct direction for a guardrail.
   */
  async reserveNonResearchSpend(label: string): Promise<void> {
    await this.reserveSpend(label, Math.max(AGENT_RUN_BAND.highUsd, AGENT_RUN_HARD_CAP_USD), 'agent');
  }

  /**
   * Reserve for a utility-model call: titles, summaries, follow-ups, claims.
   *
   * Every one of these bills, and every one of them used to run outside the
   * ledger, so the advertised daily ceiling covered research runs only. Same
   * mutex and same worst-case reservation as everything else; only the band
   * differs.
   */
  async reserveUtilitySpend(label: string, provider: ProviderId = 'gemini'): Promise<void> {
    await this.reserveSpend(label, UTILITY_CALL_BAND.highUsd, 'util', provider);
  }

  private async reserveSpend(
    label: string,
    amountUsd: number,
    prefix: string,
    provider: ProviderId = 'gemini',
  ): Promise<void> {
    await this.withAdmissionLock(async () => {
      // The ceiling check is skipped when the gate is disabled; the ledger
      // entry is not. `DOSSIER_BUDGET_USD=0` used to return before appending,
      // so disabling the *limit* also erased the *history* for utility and
      // agent calls while research starts kept recording theirs. Spend
      // reporting that is silently partial is worse than none.
      if (this.config.budgetUsd > 0) {
        const snapshot = await this.budget();
        if (snapshot.committedUsd + amountUsd > snapshot.budgetUsd) {
          throw new BudgetExceededError(snapshot.committedUsd, snapshot.budgetUsd, snapshot.windowHours);
        }
        const perProvider = this.config.providerBudgetsUsd[provider] ?? 0;
        if (perProvider > 0) {
          const spentHere = await this.committedFor(provider);
          if (spentHere + amountUsd > perProvider) {
            throw new BudgetExceededError(spentHere, perProvider, snapshot.windowHours);
          }
        }
      }
      await this.store.appendLedger({
        at: new Date().toISOString(),
        runId: `${prefix}_${Date.now().toString(36)}_${Math.trunc(performance.now() * 1000) % 1000}`,
        tier: 'fast',
        estimatedCostUsd: amountUsd,
        provider,
        label,
      });
    });
  }

  /** Committed dollars against one backend inside the rolling window. */
  private async committedFor(provider: ProviderId): Promise<number> {
    const since = new Date(Date.now() - this.config.budgetWindowHours * 3_600_000).toISOString();
    const { entries } = await this.store.readLedgerStrict(since);
    return entries.filter((e) => e.provider === provider).reduce((sum, e) => sum + e.estimatedCostUsd, 0);
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
    const client = this.resolveClient(run.provider);
    if (!client) return run;

    let snapshot: InteractionSnapshot;
    try {
      snapshot = await client.getRun(run.interactionId);
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
    // The whole read-check-pay-write sequence is one critical section. Without
    // it two concurrent approvals both observe `planApproved === false`, both
    // start a paid continuation, and only one interaction id survives the
    // write: the other run is orphaned upstream and still billing.
    return this.runLock.run(runId, async () => this.approvePlanLocked(runId, amendment));
  }

  private async approvePlanLocked(runId: string, amendment?: string): Promise<RunRecord | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    if (run.planApproved) return run;
    // A cancelled or failed run must not be resurrected into a paid run by a
    // late approval; neither layer used to check.
    if (TERMINAL_STATES.includes(run.state)) {
      throw new Error(
        `Run ${runId} is ${run.state} and cannot be approved. Start a new run if you still want this research.`,
      );
    }
    const client = this.resolveClient(run.provider);
    if (!client) throw new Error(`No ${run.provider} client available to continue this run.`);

    // Approval is "continue from the planning interaction with the flag off" —
    // an amendment rides along as the input for that turn.
    const snapshot = await client.createRun({
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
    return this.runLock.run(runId, async () => {
      const run = await this.store.getRun(runId);
      if (!run) return null;
      if (TERMINAL_STATES.includes(run.state)) return run;

      // Swallowing this error and recording local success was a lie with a
      // price attached: a timeout or a 503 leaves the provider running and
      // billing while Dossier reports the run cancelled. Say which happened.
      let providerError: string | null = null;
      const client = this.resolveClient(run.provider);
      if (client && run.interactionId) {
        try {
          await client.cancelRun(run.interactionId);
        } catch (e: unknown) {
          providerError = e instanceof Error ? e.message : String(e);
        }
      }

      const cancelled: RunRecord = {
        ...run,
        state: 'cancelled',
        updatedAt: new Date().toISOString(),
        ...(providerError
          ? {
              error:
                `Cancelled locally, but the provider did not confirm: ${providerError}. ` +
                'The upstream run may still be executing and billing. Check the provider console.',
            }
          : {}),
      };
      await this.store.saveRun(cancelled);
      await this.store.appendJournal(
        runId,
        'cancelled',
        providerError
          ? `Cancellation requested but NOT confirmed upstream (${providerError}). The provider run may still be running and billing.`
          : 'Run cancelled by the caller and confirmed upstream.',
      );
      return cancelled;
    });
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

  /**
   * Start the background poller. Idempotent.
   *
   * Self-rescheduling rather than `setInterval`, so the interval can widen when
   * the provider is failing. A fixed interval sends exactly the same request
   * rate into a 429 as into a 200, which is the one case where backing off is
   * the whole remedy. Consecutive failures double the wait (jittered, capped);
   * one success returns it to the configured cadence immediately.
   */
  startPolling(): void {
    if (this.timer) return;
    const schedule = (delayMs: number): void => {
      this.timer = setTimeout(() => {
        void this.tick()
          .then(() => {
            this.consecutivePollFailures = 0;
          })
          .catch((e: unknown) => {
            this.consecutivePollFailures += 1;
            // stdout is the MCP protocol; diagnostics go to stderr.
            process.stderr.write(
              `[dossier] poll failed (${this.consecutivePollFailures} in a row): ${
                e instanceof Error ? e.message : String(e)
              }\n`,
            );
          })
          .finally(() => {
            if (this.timer) schedule(pollDelayMs(this.config.pollSeconds * 1000, this.consecutivePollFailures));
          });
      }, delayMs);
      // Never hold the process open on the poller alone — a stdio server must
      // exit when its client disconnects.
      this.timer.unref?.();
    };
    schedule(this.config.pollSeconds * 1000);
  }

  stopPolling(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
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
