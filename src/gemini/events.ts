import { z } from 'zod';

/**
 * SSE event folding for a live run.
 *
 * Polling can only ever report lifecycle transitions: measured against the live
 * API, an in-flight interaction returns nothing but the echoed `user_input`
 * step until it completes, at which point everything arrives at once. The
 * stream is the only place progress exists while it is happening, and it
 * carries far more than text: search calls, URL fetches, file-search calls and
 * reasoning summaries each arrive as their own delta.
 *
 * This module is pure. Given an event it returns what should go in the journal
 * and how the running counters move; the transport, the reconnection and the
 * persistence all live in the runner. That split is what makes the interesting
 * logic testable without a paid run.
 */

/** Deltas we translate into journal events. The rest are folded into counters. */
const DeltaSchema = z.object({ type: z.string().optional() }).passthrough();

const EventSchema = z.object({
  event_type: z.string().optional(),
  // The SDK's own field. Some payloads use `type`; accept either.
  type: z.string().optional(),
  event_id: z.string().optional(),
  index: z.number().optional(),
  delta: DeltaSchema.optional(),
  interaction: z.object({ id: z.string().optional(), status: z.string().optional() }).passthrough().optional(),
  error: z.unknown().optional(),
});

export type StreamEvent = z.infer<typeof EventSchema>;

/** Counters accumulated across a run, surfaced in status and the journal. */
export interface StreamProgress {
  readonly searches: number;
  readonly urlsFetched: number;
  readonly corpusQueries: number;
  readonly codeRuns: number;
  /** Latest reasoning summary text, if the stream has produced one. */
  readonly lastThought?: string;
  /** Resume token: the newest event id seen. */
  readonly lastEventId?: string;
  /** Set once a terminal event arrives. */
  readonly terminal?: 'completed' | 'failed';
  readonly error?: string;
}

export const EMPTY_PROGRESS: StreamProgress = {
  searches: 0,
  urlsFetched: 0,
  corpusQueries: 0,
  codeRuns: 0,
};

/** What the runner should append to the journal for this event, if anything. */
export interface FoldResult {
  readonly progress: StreamProgress;
  readonly journal?: { readonly kind: 'progress' | 'thought' | 'completed' | 'failed'; readonly message: string };
}

function textOf(delta: Record<string, unknown>): string {
  // Reasoning arrives as `content` (a Content object), plain text as `text`.
  const direct = delta['text'];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const content = delta['content'];
  if (content && typeof content === 'object') {
    const parts = (content as { parts?: unknown }).parts;
    if (Array.isArray(parts)) {
      const joined = parts
        .map((p) => (p && typeof p === 'object' ? (p as { text?: unknown }).text : undefined))
        .filter((t): t is string => typeof t === 'string')
        .join('');
      if (joined.trim()) return joined.trim();
    }
  }
  return '';
}

function queryOf(delta: Record<string, unknown>): string {
  const args = delta['arguments'];
  if (args && typeof args === 'object') {
    const q = (args as { queries?: unknown; query?: unknown }).queries ?? (args as { query?: unknown }).query;
    if (typeof q === 'string') return q;
    if (Array.isArray(q)) return q.filter((x): x is string => typeof x === 'string').join(', ');
  }
  const url = delta['url'];
  if (typeof url === 'string') return url;
  return '';
}

/**
 * Fold one stream event into the running progress.
 *
 * Deliberately conservative: an event type we do not recognise advances the
 * resume token and nothing else. A preview API adding a delta type should cost
 * us a missed counter, never a thrown poller.
 */
export function foldEvent(prev: StreamProgress, raw: unknown): FoldResult {
  const parsed = EventSchema.safeParse(raw);
  if (!parsed.success) return { progress: prev };
  const event = parsed.data;
  const kind = event.event_type ?? event.type ?? '';

  const next: StreamProgress = {
    ...prev,
    ...(event.event_id ? { lastEventId: event.event_id } : {}),
  };

  if (kind === 'interaction.completed') {
    return {
      progress: { ...next, terminal: 'completed' },
      journal: { kind: 'completed', message: 'Stream reported the run complete.' },
    };
  }
  if (kind === 'interaction.error' || kind === 'error') {
    const message =
      typeof event.error === 'string' ? event.error : JSON.stringify(event.error ?? {}).slice(0, 500);
    return {
      progress: { ...next, terminal: 'failed', error: message },
      journal: { kind: 'failed', message },
    };
  }
  if (kind !== 'step.delta' || !event.delta) return { progress: next };

  const delta = event.delta as Record<string, unknown>;
  const rawType = delta['type'];
  const type = typeof rawType === 'string' ? rawType : '';

  switch (type) {
    case 'google_search_call': {
      const q = queryOf(delta);
      const progress = { ...next, searches: prev.searches + 1 };
      return {
        progress,
        journal: { kind: 'progress', message: `Search ${progress.searches}${q ? `: ${q.slice(0, 300)}` : ''}` },
      };
    }
    case 'url_context_call': {
      const u = queryOf(delta);
      const progress = { ...next, urlsFetched: prev.urlsFetched + 1 };
      return {
        progress,
        journal: { kind: 'progress', message: `Reading source ${progress.urlsFetched}${u ? `: ${u.slice(0, 300)}` : ''}` },
      };
    }
    case 'file_search_call': {
      const q = queryOf(delta);
      const progress = { ...next, corpusQueries: prev.corpusQueries + 1 };
      return {
        progress,
        // Worth its own line: it is the evidence that corpus grounding is
        // actually being used, which polling can never show you.
        journal: { kind: 'progress', message: `Corpus query ${progress.corpusQueries}${q ? `: ${q.slice(0, 300)}` : ''}` },
      };
    }
    case 'code_execution_call':
      return { progress: { ...next, codeRuns: prev.codeRuns + 1 } };
    case 'thought_summary': {
      const text = textOf(delta);
      if (!text) return { progress: next };
      return { progress: { ...next, lastThought: text }, journal: { kind: 'thought', message: text } };
    }
    default:
      return { progress: next };
  }
}

/** One-line summary of what a run has done so far. */
export function describeProgress(p: StreamProgress): string {
  const bits = [`${p.searches} searches`];
  if (p.urlsFetched > 0) bits.push(`${p.urlsFetched} sources read`);
  if (p.corpusQueries > 0) bits.push(`${p.corpusQueries} corpus queries`);
  if (p.codeRuns > 0) bits.push(`${p.codeRuns} code runs`);
  return bits.join(' · ');
}
