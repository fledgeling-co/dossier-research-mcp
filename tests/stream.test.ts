import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeepResearchClient } from '../src/gemini/client.js';
import { StreamSupervisor } from '../src/research/stream.js';
import { Store } from '../src/store/store.js';
import type { RunRecord } from '../src/store/types.js';

/**
 * Supervisor tests. The event folding is covered in events.test.ts; what
 * matters here is the behaviour around the stream: reconnection, the resume
 * token, and giving up in a way that leaves the run finishable by polling.
 */

const now = new Date().toISOString();
const RUN: RunRecord = {
  id: 'dr_stream01',
  interactionId: 'int_1',
  state: 'running',
  tier: 'fast',
  archetype: 'technical',
  question: 'q',
  prompt: 'p',
  promptWasPreEngineered: false,
  fingerprint: 'fp',
  createdAt: now,
  updatedAt: now,
  lastProgressAt: now,
  estimatedCostUsd: 2,
  tags: [],
  planApproved: true,
  reportChars: 0,
  sourceCount: 0,
  imageCount: 0,
  searches: 0,
  urlsFetched: 0,
  corpusQueries: 0,
  codeRuns: 0,
  streamAbandoned: false,
  toolsUsed: [],
  corpusStores: [],
};

/** A client whose stream yields the given batches, one per attach. */
function streamingClient(batches: unknown[][], opts: { failFirst?: number } = {}) {
  const attaches: (string | undefined)[] = [];
  let attach = 0;
  let failed = 0;
  const client: DeepResearchClient = {
    async createRun() {
      throw new Error('unused');
    },
    async getRun() {
      throw new Error('unused');
    },
    async cancelRun() {},
    async followUp() {
      return '';
    },
    async streamRun(_id, options) {
      attaches.push(options?.lastEventId);
      if (failed < (opts.failFirst ?? 0)) {
        failed += 1;
        throw new Error('connection refused');
      }
      const batch = batches[attach] ?? [];
      attach += 1;
      return (async function* () {
        for (const e of batch) yield e;
      })();
    },
  };
  return { client, attaches };
}

let dir: string;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dossier-stream-'));
  store = new Store(dir);
  await store.init();
  await store.saveRun(RUN);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const search = (q: string, id: string) => ({
  event_type: 'step.delta',
  event_id: id,
  delta: { type: 'google_search_call', arguments: { queries: [q] } },
});

describe('StreamSupervisor', () => {
  it('folds events into the record and journals each one', async () => {
    const { client } = streamingClient([
      [search('a', 'e1'), search('b', 'e2'), { event_type: 'interaction.completed', event_id: 'e3' }],
    ]);
    await new StreamSupervisor({ store, client, sleep: async () => {} }).attach(RUN);

    const saved = await store.getRun(RUN.id);
    expect(saved?.searches).toBe(2);
    expect(saved?.lastEventId).toBe('e3');

    const journal = await store.readJournal(RUN.id);
    expect(journal.filter((e) => e.kind === 'progress')).toHaveLength(2);
    expect(journal.some((e) => e.message.includes('Search 1: a'))).toBe(true);
  });

  it('resumes from the last event id after a drop, rather than replaying', async () => {
    const { client, attaches } = streamingClient([
      [search('a', 'e1'), search('b', 'e2')], // stream closes without a terminal
      [search('c', 'e3'), { event_type: 'interaction.completed', event_id: 'e4' }],
    ]);
    await new StreamSupervisor({ store, client, sleep: async () => {} }).attach(RUN);

    expect(attaches[0]).toBeUndefined(); // first attach has no cursor
    expect(attaches[1]).toBe('e2'); // reconnect resumes from where it stopped
    expect((await store.getRun(RUN.id))?.searches).toBe(3); // no double-count
  });

  it('retries a refused connection, then gives up and hands over to polling', async () => {
    // Every attach throws. The supervisor must stop, not spin.
    const { client, attaches } = streamingClient([], { failFirst: 99 });
    await new StreamSupervisor({ store, client, sleep: async () => {} }).attach(RUN);

    expect(attaches.length).toBeGreaterThan(1);
    expect(attaches.length).toBeLessThan(10); // bounded
    const saved = await store.getRun(RUN.id);
    expect(saved?.streamAbandoned).toBe(true);
    // The run must still be finishable; abandoning the stream is not failing.
    expect(saved?.state).toBe('running');
    const journal = await store.readJournal(RUN.id);
    expect(journal.some((e) => e.message.includes('falling back to polling'))).toBe(true);
  });

  it('stops immediately when the run has already reached a terminal state', async () => {
    await store.saveRun({ ...RUN, state: 'completed' });
    const { client, attaches } = streamingClient([[search('a', 'e1')]]);
    await new StreamSupervisor({ store, client, sleep: async () => {} }).attach({ ...RUN, state: 'completed' });
    expect(attaches).toHaveLength(0);
  });

  it('refuses to attach the same run twice', async () => {
    const { client, attaches } = streamingClient([
      [{ event_type: 'interaction.completed', event_id: 'e1' }],
    ]);
    const s = new StreamSupervisor({ store, client, sleep: async () => {} });
    await Promise.all([s.attach(RUN), s.attach(RUN)]);
    expect(attaches).toHaveLength(1);
    expect(s.isAttached(RUN.id)).toBe(false); // released when done
  });

  it('keeps lastProgressAt moving so a streaming run never looks stalled', async () => {
    const stale = new Date(Date.now() - 60 * 60_000).toISOString();
    await store.saveRun({ ...RUN, lastProgressAt: stale });
    const { client } = streamingClient([
      [search('a', 'e1'), { event_type: 'interaction.completed', event_id: 'e2' }],
    ]);
    await new StreamSupervisor({ store, client, sleep: async () => {} }).attach(RUN);
    const saved = await store.getRun(RUN.id);
    expect(Date.parse(saved!.lastProgressAt)).toBeGreaterThan(Date.parse(stale));
  });

  it('does nothing when the client has no streaming support', async () => {
    const noStream: DeepResearchClient = {
      async createRun() { throw new Error('unused'); },
      async getRun() { throw new Error('unused'); },
      async cancelRun() {},
      async followUp() { return ''; },
    };
    await new StreamSupervisor({ store, client: noStream, sleep: async () => {} }).attach(RUN);
    expect((await store.getRun(RUN.id))?.searches).toBe(0);
  });
});
