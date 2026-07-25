import type { DeepResearchClient } from '../gemini/client.js';
import { EMPTY_PROGRESS, foldEvent, type StreamProgress } from '../gemini/events.js';
import type { Store } from '../store/store.js';
import type { RunRecord } from '../store/types.js';

/**
 * Stream supervisor: attaches to a run's SSE stream and keeps it attached.
 *
 * The API's own docs warn the connection can drop or expire (their reconnect
 * example mentions a 600-second timeout), and a run lasts up to an hour, so a
 * single `for await` over one stream is not a design. This owns the retry loop,
 * the resume token, and knowing when to give up.
 *
 * Giving up matters as much as retrying. Polling still works and still finishes
 * the run, so a stream that cannot be re-established must degrade to polling
 * rather than stall the run or spin forever. `streamAbandoned` records that it
 * happened, so `research_status` can say the counters stopped moving for a
 * reason rather than looking silently stuck.
 */

/** Persist counters at most this often; a busy run emits events far faster. */
const PERSIST_INTERVAL_MS = 3_000;
/** Consecutive failed re-attaches before polling takes over. */
const MAX_REATTACHES = 4;
/** Backoff between re-attaches. */
const REATTACH_DELAY_MS = 2_000;

export interface SupervisorDeps {
  readonly store: Store;
  readonly client: DeepResearchClient;
  /** Injectable for tests; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

export class StreamSupervisor {
  /** Runs currently being streamed, so a tick cannot attach twice. */
  private readonly attached = new Set<string>();

  constructor(private readonly deps: SupervisorDeps) {}

  isAttached(runId: string): boolean {
    return this.attached.has(runId);
  }

  /**
   * Attach to a run. Resolves when the stream ends for good, so callers should
   * `void` it rather than await: the run continues either way, and the poller
   * is what actually decides the run is finished.
   */
  async attach(run: RunRecord): Promise<void> {
    const { store, client } = this.deps;
    if (!client.streamRun || !run.interactionId) return;
    if (this.attached.has(run.id)) return;
    this.attached.add(run.id);

    const sleep = this.deps.sleep ?? defaultSleep;
    let progress: StreamProgress = {
      ...EMPTY_PROGRESS,
      searches: run.searches,
      urlsFetched: run.urlsFetched,
      corpusQueries: run.corpusQueries,
      codeRuns: run.codeRuns,
      ...(run.lastEventId ? { lastEventId: run.lastEventId } : {}),
    };
    let lastPersist = 0;
    let failures = 0;

    const persist = async (force: boolean): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastPersist < PERSIST_INTERVAL_MS) return;
      lastPersist = now;
      const current = await store.getRun(run.id);
      if (!current) return;
      await store.saveRun({
        ...current,
        searches: progress.searches,
        urlsFetched: progress.urlsFetched,
        corpusQueries: progress.corpusQueries,
        codeRuns: progress.codeRuns,
        updatedAt: new Date().toISOString(),
        // Any delta at all is forward progress, which is what the stall
        // watchdog keys off. A streaming run should never look stalled.
        lastProgressAt: new Date().toISOString(),
        ...(progress.lastEventId ? { lastEventId: progress.lastEventId } : {}),
      });
    };

    try {
      while (failures <= MAX_REATTACHES) {
        // Re-read each pass: the run may have been cancelled or completed by
        // the poller while the stream was down.
        const current = await store.getRun(run.id);
        if (!current) return;
        if (current.state === 'completed' || current.state === 'failed' || current.state === 'cancelled') return;

        let stream: AsyncIterable<unknown>;
        try {
          stream = await client.streamRun(run.interactionId, {
            ...(progress.lastEventId ? { lastEventId: progress.lastEventId } : {}),
          });
        } catch {
          failures += 1;
          if (failures > MAX_REATTACHES) break;
          await sleep(REATTACH_DELAY_MS);
          continue;
        }

        let sawAnything = false;
        try {
          for await (const event of stream) {
            sawAnything = true;
            const folded = foldEvent(progress, event);
            progress = folded.progress;
            if (folded.journal) {
              await store.appendJournal(run.id, folded.journal.kind, folded.journal.message);
            }
            await persist(Boolean(folded.journal));
            if (progress.terminal) {
              await persist(true);
              return;
            }
          }
        } catch {
          // A mid-stream error is a drop, not a failed run. Reconnect.
        }

        await persist(true);
        // A stream that yields nothing and closes is not worth hammering; a
        // stream that produced events and then closed is a normal drop.
        failures = sawAnything ? 0 : failures + 1;
        if (failures > MAX_REATTACHES) break;
        await sleep(REATTACH_DELAY_MS);
      }

      // Out of re-attaches. Polling still finishes the run; say so once, in the
      // journal, so nobody reads frozen counters as a frozen run.
      const current = await store.getRun(run.id);
      if (current && !current.streamAbandoned) {
        await store.saveRun({ ...current, streamAbandoned: true, updatedAt: new Date().toISOString() });
        await store.appendJournal(
          run.id,
          'note',
          'Live progress stream could not be re-established; falling back to polling. The run continues, but the search counters will stop moving until it completes.',
        );
      }
    } finally {
      this.attached.delete(run.id);
    }
  }
}
