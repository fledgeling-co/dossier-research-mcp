import { z } from 'zod';

/**
 * SSE event folding for a live run.
 *
 * Polling cannot show progress: measured against the live API, an in-flight
 * interaction returns nothing but the echoed `user_input` step until it
 * completes, then delivers everything at once. The stream is the only place
 * progress exists while it is happening.
 *
 * **The shapes here were corrected against a real stream, and the first
 * version was wrong in three ways worth recording**, because the SDK's type
 * declarations describe a far richer event vocabulary than a Deep Research run
 * actually emits:
 *
 *  1. A Deep Research run emits exactly two step types, `thought` and
 *     `model_output`. None of the 24 tool-call delta types the SDK declares
 *     (google_search_call, file_search_call, and so on) ever arrive, so
 *     counters built on them stay at zero forever.
 *  2. Reasoning text lives at `delta.content.text`. The first version read
 *     `delta.content.parts[].text`, found nothing, and silently journalled
 *     nothing at all.
 *  3. `event_id` is absent from `step.delta` events. Resume has to carry the
 *     last id actually seen rather than assume every event supplies one.
 *
 * Report text arrives as a long run of untyped `{text}` deltas whose meaning
 * comes from the enclosing `step.start`, so step types are tracked by index.
 *
 * This module is pure: give it an event and the running state, get back the new
 * state and whatever belongs in the journal. Transport and persistence live in
 * the supervisor.
 */

const EventSchema = z.object({
  event_type: z.string().optional(),
  type: z.string().optional(),
  event_id: z.string().optional(),
  index: z.number().optional(),
  step: z.object({ type: z.string().optional() }).passthrough().optional(),
  delta: z.object({ type: z.string().optional() }).passthrough().optional(),
  interaction: z.object({ id: z.string().optional(), status: z.string().optional() }).passthrough().optional(),
  error: z.unknown().optional(),
});

export type StreamEvent = z.infer<typeof EventSchema>;

export interface StreamProgress {
  /** Completed reasoning steps. The honest live-progress signal for a run. */
  readonly reasoningSteps: number;
  /** Characters of report text streamed so far. */
  readonly reportChars: number;
  /**
   * Tool-call counters. Deep Research does not emit these; they are kept
   * because managed agents share the event vocabulary and may.
   */
  readonly searches: number;
  readonly urlsFetched: number;
  readonly corpusQueries: number;
  readonly codeRuns: number;
  /** Step type by index, learned from `step.start`. */
  readonly stepTypes: Readonly<Record<number, string>>;
  /** Text accumulating for the open step at each index. */
  readonly buffers: Readonly<Record<number, string>>;
  readonly lastThought?: string;
  readonly lastEventId?: string;
  readonly terminal?: 'completed' | 'failed';
  readonly error?: string;
}

export const EMPTY_PROGRESS: StreamProgress = {
  reasoningSteps: 0,
  reportChars: 0,
  searches: 0,
  urlsFetched: 0,
  corpusQueries: 0,
  codeRuns: 0,
  stepTypes: {},
  buffers: {},
};

export interface FoldResult {
  readonly progress: StreamProgress;
  readonly journal?: {
    readonly kind: 'progress' | 'thought' | 'completed' | 'failed';
    readonly message: string;
  };
}

/** Pull text out of a delta, covering every shape the API has been seen to use. */
function textOf(delta: Record<string, unknown>): string {
  const direct = delta['text'];
  if (typeof direct === 'string') return direct;
  const content = delta['content'];
  if (content && typeof content === 'object') {
    // The live shape: content is `{ text, type }`.
    const text = (content as { text?: unknown }).text;
    if (typeof text === 'string') return text;
    // Defensive: the multi-part Content shape, in case the API adopts it.
    const parts = (content as { parts?: unknown }).parts;
    if (Array.isArray(parts)) {
      return parts
        .map((p) => (p && typeof p === 'object' ? (p as { text?: unknown }).text : undefined))
        .filter((t): t is string => typeof t === 'string')
        .join('');
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
  return typeof url === 'string' ? url : '';
}

/** Collapse a reasoning summary to one journal line. They run long. */
function summarise(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed;
}

/**
 * Fold one stream event into the running progress.
 *
 * Conservative by design: an unrecognised event advances the resume token and
 * changes nothing else, so a preview API growing a new event type costs a
 * missed counter rather than a thrown supervisor.
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

  switch (kind) {
    case 'interaction.completed':
      return {
        progress: { ...next, terminal: 'completed' },
        journal: { kind: 'completed', message: 'Stream reported the run complete.' },
      };

    case 'interaction.error':
    case 'error': {
      const message =
        typeof event.error === 'string' ? event.error : JSON.stringify(event.error ?? {}).slice(0, 500);
      return { progress: { ...next, terminal: 'failed', error: message }, journal: { kind: 'failed', message } };
    }

    case 'step.start': {
      const index = event.index ?? 0;
      const type = event.step?.type ?? '';
      return {
        progress: {
          ...next,
          stepTypes: { ...next.stepTypes, [index]: type },
          buffers: { ...next.buffers, [index]: '' },
        },
      };
    }

    case 'step.stop': {
      const index = event.index ?? 0;
      const type = next.stepTypes[index] ?? '';
      const buffered = next.buffers[index] ?? '';
      const buffers = { ...next.buffers };
      delete buffers[index];

      // One clean journal entry per reasoning step, rather than the ~40
      // fragments the deltas arrive in.
      if (type === 'thought' && buffered.trim()) {
        const progress: StreamProgress = {
          ...next,
          buffers,
          reasoningSteps: next.reasoningSteps + 1,
          lastThought: summarise(buffered),
        };
        return { progress, journal: { kind: 'thought', message: summarise(buffered) } };
      }
      return { progress: { ...next, buffers } };
    }

    case 'step.delta': {
      if (!event.delta) return { progress: next };
      const delta = event.delta as Record<string, unknown>;
      const rawType = delta['type'];
      const deltaType = typeof rawType === 'string' ? rawType : '';
      const index = event.index ?? 0;
      const stepType = next.stepTypes[index] ?? '';

      // Tool-call deltas, if this agent ever emits them.
      switch (deltaType) {
        case 'google_search_call': {
          const q = queryOf(delta);
          const progress = { ...next, searches: next.searches + 1 };
          return {
            progress,
            journal: { kind: 'progress', message: `Search ${progress.searches}${q ? `: ${q.slice(0, 300)}` : ''}` },
          };
        }
        case 'url_context_call': {
          const progress = { ...next, urlsFetched: next.urlsFetched + 1 };
          return { progress, journal: { kind: 'progress', message: `Reading source ${progress.urlsFetched}` } };
        }
        case 'file_search_call': {
          const q = queryOf(delta);
          const progress = { ...next, corpusQueries: next.corpusQueries + 1 };
          return {
            progress,
            journal: {
              kind: 'progress',
              message: `Corpus query ${progress.corpusQueries}${q ? `: ${q.slice(0, 300)}` : ''}`,
            },
          };
        }
        case 'code_execution_call':
          return { progress: { ...next, codeRuns: next.codeRuns + 1 } };
        default:
          break;
      }

      // Text deltas: buffer against the open step, journal at step.stop.
      const text = textOf(delta);
      if (!text) return { progress: next };
      const isThought = deltaType === 'thought_summary' || stepType === 'thought';
      const buffers = { ...next.buffers, [index]: (next.buffers[index] ?? '') + text };
      return {
        progress: {
          ...next,
          buffers,
          ...(isThought ? {} : { reportChars: next.reportChars + text.length }),
        },
      };
    }

    default:
      return { progress: next };
  }
}

/** One-line summary of what a run has done so far. */
export function describeProgress(p: StreamProgress): string {
  const bits: string[] = [];
  if (p.reasoningSteps > 0) bits.push(`${p.reasoningSteps} reasoning steps`);
  if (p.reportChars > 0) bits.push(`${p.reportChars} chars of report`);
  if (p.searches > 0) bits.push(`${p.searches} searches`);
  if (p.urlsFetched > 0) bits.push(`${p.urlsFetched} sources read`);
  if (p.corpusQueries > 0) bits.push(`${p.corpusQueries} corpus queries`);
  if (p.codeRuns > 0) bits.push(`${p.codeRuns} code runs`);
  return bits.length > 0 ? bits.join(' · ') : 'no progress reported yet';
}
