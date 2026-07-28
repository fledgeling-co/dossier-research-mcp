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
import {
  boughtNothing,
  classifyCreateFailure,
  describeFailureKind,
  failureTag,
  isArgvRejection,
  statusOfFailure,
  type RunFailureKind,
} from './failure.js';
import { extractPlan } from './plan.js';
import { KeyedMutex, Mutex } from './spend.js';
import { StreamSupervisor } from './stream.js';
import { extractCitedUrls, normaliseCitations } from './report.js';
import { describeOverlap, mergeEvidence, type RunEvidence } from './synthesise.js';

/**
 * Run lifecycle.
 *
 * The poller is in-process and runs on a timer; the store is the source of
 * truth. Restart the server mid-run and it picks the run back up from disk on
 * the next tick. Disconnect the MCP client mid-run and nothing is lost — the
 * journal keeps accumulating and `research_tail` replays it by cursor.
 */

/**
 * How the automatic panel merge marks its journal note.
 *
 * Matched on to make the merge idempotent: every member settles independently
 * and the last one to arrive does the work, so a restart mid-panel must not
 * write the same summary twice.
 */
const PANEL_MERGE_PREFIX = 'Panel merge:';

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
    /**
     * What the refused request wanted to reserve, when it is a panel.
     *
     * A panel reserves the sum of its members' worst cases in one go, so the
     * refusal has to name that sum. "$4 of $20 committed" reads like there is
     * headroom; "a panel needing $19.00 on top of $4.00" says why there is not.
     */
    readonly neededUsd?: number,
  ) {
    super(
      neededUsd === undefined
        ? `Budget gate: $${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} already committed in the last ${windowHours}h. ` +
            'Raise DOSSIER_BUDGET_USD, wait for the window to roll, or cancel a run.'
        : `Budget gate: this panel reserves $${neededUsd.toFixed(2)} in full before any member starts, ` +
            `and $${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} is already committed in the last ${windowHours}h. ` +
            'No member has been started and nothing has been charged. ' +
            'Raise DOSSIER_BUDGET_USD, wait for the window to roll, cancel a run, or name one backend with the `provider` argument.',
    );
    this.name = 'BudgetExceededError';
  }
}

export class ConcurrencyExceededError extends Error {
  readonly code = 'concurrency_exceeded' as const;
  constructor(
    readonly active: number,
    readonly max: number,
    /** How many slots the refused request wanted at once, when it is a panel. */
    readonly wanted?: number,
  ) {
    super(
      wanted === undefined
        ? `${active} runs already in flight (max ${max}). Wait for one to finish or cancel it.`
        : `A panel of ${wanted} needs ${wanted} slots at once and ${active} runs are already in flight (max ${max}). ` +
            'No member has been started. Wait for one to finish, cancel one, raise DOSSIER_MAX_CONCURRENT, ' +
            'or name one backend with the `provider` argument.',
    );
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
  /** The panel this run is a member of, when it is one. */
  readonly panelId?: string;
  /** The artefact shape asked for. Defaults to a deep report. */
  readonly shape?: 'deep' | 'wide' | 'recent' | 'corpus';
  /** The time window asked for, recorded for the audit trail. */
  readonly window?: string;
  /** The wide spec, serialised, when this is a wide run. */
  readonly wideSpec?: string;
  /**
   * A deliberate repetition index, for measuring non-determinism.
   *
   * Omitted for every ordinary run. The benchmark harness sets it so `n = 5` of
   * one task on one backend is five paid runs rather than one run reported five
   * times; see `FingerprintInput.repeat`.
   */
  readonly repeat?: number;
  readonly label?: string;
  readonly tags?: readonly string[];
  /**
   * Prior Dossier runs this one was given to work from.
   *
   * Recorded rather than only hashed into the prompt, because every downstream
   * presentation of the report has to declare it: a reader who cannot see the
   * grounding cannot tell accumulated evidence from an echo.
   */
  readonly groundedIn?: readonly string[];
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
 * One brief, several backends.
 *
 * `members` replaces `provider`: a panel names every backend up front so the
 * whole bill can be reserved in one go, which is the only ordering that lets an
 * unaffordable panel refuse before it has spent anything.
 */
export interface PanelStartArgs extends Omit<StartRunArgs, 'provider'> {
  readonly members: readonly ProviderId[];
}

export interface PanelStartResult {
  /** Shared handle binding the member runs together. */
  readonly panelId: string;
  /** Every member that started, plus any that deduped onto an existing run. */
  readonly started: readonly StartRunResult[];
  /** Members whose backend refused at create time. The panel continued without them. */
  readonly failed: readonly { readonly provider: ProviderId; readonly error: string }[];
  /** The sum of the members' worst cases, reserved before any member started. */
  readonly reservedUsd: number;
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
    const committed = Store.netCommittedUsd(entries) + unreadableLines * estimateCost('max').highUsd;
    const active = (await this.store.activeRuns()).filter(occupiesSlot);
    return {
      budgetUsd: this.config.budgetUsd,
      windowHours: this.config.budgetWindowHours,
      committedUsd: Number(committed.toFixed(2)),
      remainingUsd: Number(Math.max(0, this.config.budgetUsd - committed).toFixed(2)),
      // Reservations only. A release is a correction to a line already counted
      // here, not a second thing that ran, and counting it would report two
      // runs for one refused request.
      runsInWindow: entries.filter((e) => e.kind !== 'release').length,
      activeRuns: active.length,
      maxConcurrent: this.config.maxConcurrent,
    };
  }

  fingerprintFor(
    args: Pick<
      StartRunArgs,
      | 'prompt'
      | 'tier'
      | 'tools'
      | 'collaborativePlanning'
      | 'attachments'
      | 'shape'
      | 'window'
      | 'wideSpec'
      | 'repeat'
    > & {
      /**
       * The backend, or a panel token naming every member.
       *
       * Wider than `ProviderId` because a panel is a purchase too, and one that
       * has to be distinguishable from any of its members running alone.
       */
      readonly provider?: string;
    },
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
      // `!== undefined`, never truthiness. `NaN` is falsy, so a truthiness test
      // silently DROPPED a malformed repetition index and let it dedupe onto
      // the no-repeat purchase, which is the exact collapse this field exists
      // to prevent, arriving through the guard meant to stop it. Passing it on
      // makes `fingerprint()` throw, which is the fail-closed answer.
      ...(args.repeat !== undefined ? { repeat: args.repeat } : {}),
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
        ...(args.panelId ? { panelId: args.panelId } : {}),
        // Stamped from config, so it is set exactly when this server is a child
        // of a CLI Dossier spawned. An ordinary launch has no such parent and
        // records nothing, which keeps every existing run's meaning intact.
        ...(this.config.spawnedBy ? { spawnedBy: this.config.spawnedBy } : {}),
        shape: args.shape ?? 'deep',
        ...(args.window ? { window: args.window } : {}),
        ...(args.wideSpec ? { wideSpec: args.wideSpec } : {}),
        // Recorded, not merely hashed. A stored cell has to be attributable to
        // its repetition an hour later, or a resumed batch cannot tell which of
        // five it already bought. Unreachable with a malformed index, because
        // `fingerprintFor` above has already thrown on one.
        ...(args.repeat !== undefined && args.repeat > 0 ? { repeat: args.repeat } : {}),
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
        ...(args.groundedIn && args.groundedIn.length > 0
          ? { groundedIn: [...args.groundedIn] }
          : {}),
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

    return this.launch(reserved.record, args, client);
  }

  /**
   * Create the interaction for an already-reserved record.
   *
   * Split from `start()` so the panel path can reserve the whole panel in one
   * critical section and then launch its members, without a second copy of the
   * failure handling that took the longest to get right. Everything here runs
   * *after* the money is committed, which is why none of it retries: a create
   * that timed out after the provider accepted it has already bought the report.
   */
  private async launch(
    record: RunRecord,
    args: StartRunArgs,
    client: DeepResearchClient,
  ): Promise<StartRunResult> {
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
      // Say WHICH kind of failure this is. "failed" alone made a broken adapter
      // and a hard question look identical in the run list, and they need
      // opposite responses: one is a bug report, the other is a re-scope.
      const kind = classifyCreateFailure(e);
      const status = statusOfFailure(e);
      const upstream = e instanceof Error ? e.message : String(e);
      const failed: RunRecord = {
        ...record,
        state: 'failed',
        failureKind: kind,
        ...(status !== undefined ? { failureStatus: status } : {}),
        // The upstream message FIRST, then what it means. The owner could read
        // the raw text off the stored record and diagnose a quota problem in
        // minutes; nothing surfaced it where a person looking at a failed run
        // would see it, so it read as an unexplained failure.
        error: `${upstream}\n\n${describeFailureKind(kind, status)}`.slice(0, 4000),
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveRun(failed);
      await this.store.appendJournal(id, 'failed', failed.error ?? 'unknown error');
      // Give the money back only when the provider proved it created nothing.
      if (boughtNothing(kind)) {
        await this.releaseReservation(failed, `the ${record.provider} request was refused (${failureTag(kind)}), so nothing was created.`);
      }
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
   * Start every member of a panel, reserving the whole panel first.
   *
   * The one rule that makes this safe: **the sum of the members' worst cases is
   * reserved in a single critical section, before any member starts.** Not per
   * member as it goes. Half a panel is a worse answer than one good backend and
   * it has already spent money to be worse, so a panel that cannot be afforded
   * in full does not begin at all.
   *
   * Everything after the lock is per member and independent. One backend
   * refusing at create time must not strand the members that already started
   * and are already being billed, so a member that throws is recorded failed and
   * reported, and the rest continue. Each member is attempted exactly once: the
   * adapters route paid creation through `attemptOnceThenSettle`, and nothing
   * here wraps that in a retry.
   */
  async startPanel(args: PanelStartArgs): Promise<PanelStartResult> {
    if (args.members.length === 0) throw new Error('A panel needs at least one member.');
    // A member appearing twice would compute the same dedupe fingerprint twice,
    // so neither copy would find the other and the panel would buy one backend's
    // answer at two backends' prices. `assemblePanel` never repeats a provider;
    // this is here because a caller could.
    const members = [...new Set(args.members)];

    // Resolve every client before reserving anything. Reserving budget for a
    // member that cannot be started would commit money against a run that will
    // never exist, and the ledger has no way to take it back.
    const clients = new Map<ProviderId, DeepResearchClient>();
    for (const member of members) {
      const client = this.resolveClient(member);
      if (!client) {
        throw new Error(
          `No ${member} client available, so this panel cannot be started in full. ` +
            'Check its credentials with `research_doctor`, or name a backend with the `provider` argument.',
        );
      }
      clients.set(member, client);
    }

    const panelId = args.panelId ?? newRunId();
    const estimateInput: DurationOptions = {
      tier: args.tier,
      tools: args.tools.map((x) => x.type),
      attachments: args.attachments?.length ?? 0,
      collaborativePlanning: args.collaborativePlanning,
      ...(args.shape ? { shape: args.shape } : {}),
    };
    const bandFor = (p: ProviderId): CostBand =>
      this.estimateFor ? this.estimateFor(p, estimateInput) : estimateCost(estimateInput);

    const reserved = await this.withAdmissionLock(async () => {
      // Dedupe first, and per member: each member's fingerprint carries its own
      // provider, so a panel re-run after a partial failure collapses onto the
      // members that already exist and pays only for the ones that do not.
      const deduped: RunRecord[] = [];
      const admit: { provider: ProviderId; band: CostBand; fingerprint: string }[] = [];
      for (const member of members) {
        const fp = this.fingerprintFor({ ...args, provider: member });
        const existing = await this.store.findByFingerprint(fp, this.config.dedupeTtlMinutes);
        if (existing) {
          deduped.push(existing);
          continue;
        }
        admit.push({ provider: member, band: bandFor(member), fingerprint: fp });
      }

      if (admit.length === 0) return { deduped, records: [] as RunRecord[], reservedUsd: 0 };

      const active = (await this.store.activeRuns()).filter(occupiesSlot);
      const unreadable = await this.store.unreadableRunCount();
      const occupied = active.length + unreadable;
      // The panel wants every slot at once, so the cap is checked against the
      // whole panel rather than one member. With one member this is exactly the
      // `occupied >= max` check `start()` makes.
      if (occupied + admit.length > this.config.maxConcurrent) {
        throw new ConcurrencyExceededError(occupied, this.config.maxConcurrent, admit.length);
      }

      const totalHigh = Number(admit.reduce((sum, m) => sum + m.band.highUsd, 0).toFixed(2));

      if (this.config.budgetUsd > 0) {
        // Per-provider ceilings are checked on the panel's demand at that
        // provider, not on one member's. Two members on one backend is one bill.
        const wantedPerProvider = new Map<ProviderId, number>();
        for (const m of admit) {
          wantedPerProvider.set(m.provider, (wantedPerProvider.get(m.provider) ?? 0) + m.band.highUsd);
        }
        for (const [provider, wanted] of wantedPerProvider) {
          const ceiling = this.config.providerBudgetsUsd[provider] ?? 0;
          if (ceiling > 0) {
            const spentHere = await this.committedFor(provider);
            if (spentHere + wanted > ceiling) {
              throw new BudgetExceededError(spentHere, ceiling, this.config.budgetWindowHours, wanted);
            }
          }
        }
        const snapshot = await this.budget();
        if (snapshot.committedUsd + totalHigh > snapshot.budgetUsd) {
          throw new BudgetExceededError(
            snapshot.committedUsd,
            snapshot.budgetUsd,
            snapshot.windowHours,
            totalHigh,
          );
        }
      }

      // Both counters, for every member, before the lock releases.
      const records: RunRecord[] = [];
      for (const m of admit) {
        const id = newRunId();
        const at = new Date().toISOString();
        const model = this.modelFor?.(m.provider, args.tier);
        const record: RunRecord = {
          id,
          interactionId: '',
          state: args.collaborativePlanning ? 'planning' : 'running',
          tier: args.tier,
          ...(model ? { model } : {}),
          archetype: args.archetype,
          question: args.question.slice(0, 20_000),
          prompt: args.prompt.slice(0, 200_000),
          promptWasPreEngineered: args.preEngineered,
          provider: m.provider,
          panelId,
          shape: args.shape ?? 'deep',
          ...(args.window ? { window: args.window } : {}),
          ...(args.wideSpec ? { wideSpec: args.wideSpec } : {}),
          fingerprint: m.fingerprint,
          createdAt: at,
          updatedAt: at,
          lastProgressAt: at,
          estimatedCostUsd: m.band.highUsd,
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
          ...(args.groundedIn && args.groundedIn.length > 0
            ? { groundedIn: [...args.groundedIn] }
            : {}),
          ...(args.label ? { label: args.label } : {}),
        };
        await this.store.saveRun(record);
        await this.store.appendLedger({
          at,
          runId: id,
          tier: args.tier,
          estimatedCostUsd: m.band.highUsd,
          provider: m.provider,
          ...(args.label ? { label: args.label } : {}),
        });
        records.push(record);
      }
      return { deduped, records, reservedUsd: totalHigh };
    });

    const started: StartRunResult[] = reserved.deduped.map((run) => ({ run, deduped: true }));
    const failed: { provider: ProviderId; error: string }[] = [];

    for (const record of reserved.records) {
      const client = clients.get(record.provider);
      if (!client) continue;
      try {
        started.push(await this.launch(record, { ...args, provider: record.provider }, client));
      } catch (e: unknown) {
        // `launch` has already marked the record failed and journalled why. The
        // panel keeps going: the members that started are already being billed
        // and stranding them would waste the money this refusal did not save.
        failed.push({ provider: record.provider, error: e instanceof Error ? e.message : String(e) });
      }
    }

    for (const result of started) {
      if (result.deduped) continue;
      await this.store.appendJournal(
        result.run.id,
        'note',
        `Panel member ${result.run.provider} of ${String(members.length)}, panel ${panelId}. ` +
          'Agreement between members is not corroboration; support is counted in independent registrable domains.',
      );
    }

    return { panelId, started, failed, reservedUsd: reserved.reservedUsd };
  }

  /** Every run belonging to a panel, oldest first. */
  async panelMembers(panelId: string): Promise<readonly RunRecord[]> {
    const runs = await this.store.listRuns();
    return runs.filter((r) => r.panelId === panelId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
      `Imported from ${args.source}, ${String(markdown.length)} chars, ${String(record.sourceCount)} cited sources. Nothing was charged.`,
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
      `Local-loop report accepted: ${String(report.length)} chars, ${String(completed.sourceCount)} cited sources, all from the frozen registry.`,
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
        const upstream = snapshot.error ?? 'The research run failed with no reported reason.';
        // The adapter's own verdict wins where it has one; otherwise the text
        // is checked for an argument parser's refusal, which is the signature
        // of broken software rather than of hard research.
        const kind: RunFailureKind =
          snapshot.failureKind ?? (isArgvRejection(upstream) ? 'adapter-rejected' : 'research');
        next = {
          ...next,
          state: 'failed',
          failureKind: kind,
          error: `${upstream}\n\n${describeFailureKind(kind)}`.slice(0, 4000),
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
            'Research plan proposed, approve it with `research_approve_plan` to spend the run.',
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
          `Report ready: ${markdown.length} chars, ${next.sourceCount} cited sources.`,
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
        // Persist the terminal state BEFORE titling, not after.
        //
        // `onFinalise` reserves a utility call and then waits on a model, which
        // takes seconds. Saving afterwards left the record non-terminal for that
        // whole window, so every concurrent `refresh` re-read a running run,
        // polled it, found it completed again, and titled it again. Measured on
        // a real ledger: one run was titled 23 times in 64 seconds, 49 of 67
        // runs were titled more than once, and $17 of $22 of utility spend was
        // this. The guard in `refresh` was present and correct the whole time —
        // it just had nothing to read yet.
        //
        // The report is already on disk by here, so this only brings forward
        // the fact that the run is over. Line ~1094 saves again with the title
        // merged in, which is idempotent.
        await this.store.saveRun(next);
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
    if (next.panelId && TERMINAL_STATES.includes(next.state)) {
      // Best-effort and free. A merge that throws must not un-complete a report
      // that has already been bought and written to disk.
      try {
        await this.synthesisePanel(next.panelId);
      } catch {
        await this.store.appendJournal(
          run.id,
          'note',
          'The automatic panel merge failed. Run `research_synthesise` over the member run ids by hand.',
        );
      }
    }
    return next;
  }

  /**
   * Merge a panel's reports the moment its last member settles.
   *
   * This is the point of a panel, and leaving it for the caller to remember is
   * how a five-member panel that read the same ten pages gets reported as five
   * agreeing backends. `mergeEvidence` counts support in independent registrable
   * domains and `describeOverlap` says so when the fan-out taught you little, so
   * the operator is told what the extra money bought before they read anything.
   *
   * Deliberately the deterministic merge only. It costs nothing, so it can fire
   * on every panel without a reservation; the model-written distillation stays
   * behind `research_synthesise` with `distil: 'model'`, where it is asked for.
   * Written once: a note already on the journal means another member finished
   * first and did this.
   */
  private async synthesisePanel(panelId: string): Promise<void> {
    const members = await this.panelMembers(panelId);
    if (members.length < 2) return;
    if (!members.every((m) => TERMINAL_STATES.includes(m.state))) return;

    const completed = members.filter((m) => m.state === 'completed');
    const anchor = members[0];
    if (!anchor) return;
    const existing = await this.store.readJournal(anchor.id);
    if (existing.some((e) => e.kind === 'note' && e.message.startsWith(PANEL_MERGE_PREFIX))) return;

    const lines: string[] = [];
    // Who actually contributed, always, before anything is said about breadth.
    //
    // A silently failing member inflates the apparent breadth of a panel: four
    // members returning one report looked exactly like four-way coverage,
    // because the only thing reported was the merge, and the merge only ever
    // described the members that finished. The whole argument for paying five
    // times is that five backends read different parts of the web, so how many
    // of them actually did is the first fact a reader needs.
    const contributed = members.filter((m) => m.state === 'completed' && m.reportChars > 0);
    lines.push(
      `${PANEL_MERGE_PREFIX} ${String(contributed.length)} of ${String(members.length)} members produced a report.`,
      '',
      ...members.map((m) => {
        const label = `\`${m.id}\` ${m.provider}`;
        if (m.state === 'completed' && m.reportChars > 0) {
          const derivative = m.spawnedBy ? ' — **NOT INDEPENDENT**, started by a CLI Dossier spawned' : '';
          return `- ✅ ${label}: ${String(m.reportChars)} chars, ${String(m.sourceCount)} cited sources${derivative}`;
        }
        if (m.state === 'completed') return `- ⚠ ${label}: completed but produced no report text`;
        const why = m.failureKind ? failureTag(m.failureKind) : m.state;
        return `- ❌ ${label}: ${m.state} (${why})${m.error ? `, ${m.error.split('\n')[0]?.slice(0, 160) ?? ''}` : ''}`;
      }),
      '',
    );
    // A member that a panel member started is not a member. It read the brief,
    // it may have read the other members' reports, and its agreement with them
    // is not evidence of anything. Named before the merge rather than after,
    // because the merge below counts agreement across members and a reader who
    // learns this in a footnote has already read the number.
    const derivative = members.filter((m) => m.spawnedBy);
    if (derivative.length > 0) {
      lines.push(
        `> [!CAUTION]\n> ${String(derivative.length)} of ${String(members.length)} members ` +
          'was started by a CLI that Dossier itself spawned, not by you. ' +
          'Such a member has already seen the brief and may have read the other members’ reports, ' +
          'so its agreement is an echo rather than corroboration, and its cost is charged to your budget ' +
          'while adding no independent evidence. Treat the breadth below as ' +
          `${String(members.length - derivative.length)}-way, not ${String(members.length)}-way.`,
        '',
        ...derivative.map((m) => `> - \`${m.id}\` ${m.provider}, spawned by \`${m.spawnedBy ?? ''}\``),
        '',
      );
    }

    if (contributed.length < members.length) {
      lines.push(
        `> [!WARNING]\n> ${String(members.length - contributed.length)} of ${String(members.length)} members contributed nothing. ` +
          'Read anything below as the breadth of the members that answered, not of the panel that was paid for.',
        '',
      );
    }

    if (completed.length < 2) {
      lines.push(
        `${String(completed.length)} of ${String(members.length)} members completed, ` +
          'so there is nothing to merge. Nothing was charged for this check.',
      );
    } else {
      const evidence: RunEvidence[] = [];
      for (const m of completed) {
        const markdown = await this.store.readReport(m.id);
        if (markdown) evidence.push({ runId: m.id, provider: m.provider, ...(m.model ? { model: m.model } : {}), markdown });
      }
      if (evidence.length < 2) return;
      const merged = mergeEvidence(evidence);
      lines.push(
        `Merged ${String(evidence.length)} members: ` +
          `${String(merged.sources.length)} distinct sources across ${String(merged.independentDomains)} independent registrable domains.`,
        '',
        describeOverlap(merged),
        '',
        `Full merged registry: \`research_synthesise\` with runIds ${completed.map((m) => m.id).join(', ')}.`,
      );
    }

    const note = lines.join('\n');
    for (const m of members) await this.store.appendJournal(m.id, 'note', note);
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
    return Store.netCommittedUsd(entries.filter((e) => e.provider === provider));
  }

  /**
   * Give back the commitment for a request the provider provably refused.
   *
   * The ledger is written *before* the paid call on purpose, so a crash
   * over-counts rather than under-counts. That default is right and is not
   * changing. But a 429, 400, 401 or 403 is the provider saying it never
   * created anything, and holding money against a call that never reached a
   * model is a ceiling reduced for nothing: two of the owner's runs held $9
   * each on requests that were refused in under a second.
   *
   * Three properties make this safe to have at all:
   *
   * - **Only on a definitive rejection.** `boughtNothing` gates it, and an
   *   ambiguous failure keeps its commitment, always. The safe direction is
   *   unchanged for every case where the outcome is unknown.
   * - **Append-only.** A compensating `release` line, never an edit to the
   *   reservation. The ledger stays a record of what happened, including the
   *   part where we reserved and then learned better.
   * - **Idempotent and bounded.** The record carries `budgetReleased`, and
   *   `netCommittedUsd` refuses to give back more than the run reserved, so
   *   neither a retry nor a replayed line can release twice.
   *
   * The spend-affecting order in `start()` is untouched: this runs afterwards,
   * as compensation, and never as a step inside admission control.
   */
  private async releaseReservation(run: RunRecord, reason: string): Promise<RunRecord> {
    if (run.budgetReleased || run.estimatedCostUsd <= 0) return run;
    const released: RunRecord = { ...run, budgetReleased: true };
    await this.withAdmissionLock(async () => {
      await this.store.appendLedger({
        at: new Date().toISOString(),
        runId: run.id,
        tier: run.tier,
        estimatedCostUsd: run.estimatedCostUsd,
        provider: run.provider,
        kind: 'release',
        reason: reason.slice(0, 300),
        ...(run.label ? { label: run.label } : {}),
      });
      await this.store.saveRun(released);
    });
    await this.store.appendJournal(
      run.id,
      'note',
      `Budget commitment of $${run.estimatedCostUsd.toFixed(2)} released: ${reason} ` +
        'The reservation line stays on the ledger and is compensated by a release line, so the history is intact.',
    );
    return released;
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
    // The failure kind rides on the state word itself, so a broken adapter is
    // visible in a dense listing without anyone opening the run.
    `${run.id} [${run.state}${run.failureKind ? `: ${failureTag(run.failureKind)}` : ''}]`,
    `${run.tier}/${run.archetype}`,
    `${age}m old`,
  ];
  if (run.state === 'completed') bits.push(`${run.sourceCount} sources`);
  if (run.budgetReleased) bits.push(`$${run.estimatedCostUsd.toFixed(2)} released`);
  // The upstream message, not a paraphrase. The first line is the provider's
  // own words, which is what turns "it failed" into "you were over your
  // tokens-per-minute limit by 24,000 tokens".
  if (run.error) bits.push(`error: ${(run.error.split('\n')[0] ?? run.error).slice(0, 160)}`);
  return bits.join(' · ');
}

/**
 * What to do next, given a state and, when it failed, why.
 *
 * `failed` used to say one thing for every failure. It is the difference
 * between "file a bug" and "try a narrower question", so the kind decides.
 */
export function stateHint(state: RunState, failureKind?: RunFailureKind, status?: number): string {
  switch (state) {
    case 'planning':
      return 'Awaiting plan approval, call `research_approve_plan`.';
    case 'running':
      return 'In flight. Poll with `research_status`, or replay progress with `research_tail`.';
    case 'stalled':
      return 'No progress within the watchdog window. It may still recover; `research_cancel` stops it.';
    case 'completed':
      return 'Read it with `research_read` (starts with an outline, not the whole report).';
    case 'failed':
      return failureKind
        ? describeFailureKind(failureKind, status)
        : 'Failed. The error is on the record; starting again will cost another run.';
    case 'cancelled':
      return 'Cancelled.';
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}
