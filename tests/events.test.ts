import { describe, expect, it } from 'vitest';
import { EMPTY_PROGRESS, describeProgress, foldEvent, type StreamProgress } from '../src/gemini/events.js';

/** Fold a sequence, as the runner does. */
function foldAll(events: unknown[]): { progress: StreamProgress; journal: string[] } {
  let progress = EMPTY_PROGRESS;
  const journal: string[] = [];
  for (const e of events) {
    const r = foldEvent(progress, e);
    progress = r.progress;
    if (r.journal) journal.push(`${r.journal.kind}: ${r.journal.message}`);
  }
  return { progress, journal };
}

describe('foldEvent', () => {
  it('journals one entry per reasoning step, from the real live shapes', () => {
    // Captured verbatim from a live Deep Research stream. Note what is NOT
    // here: the delta carries content.text (not content.parts), and the
    // model_output deltas carry no type at all.
    const { progress, journal } = foldAll([
      { event_type: 'interaction.created', interaction: { id: 'v1_x', status: 'in_progress' } },
      { event_type: 'step.start', index: 0, step: { type: 'thought' } },
      { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { text: '***Generating research plan***', type: 'text' } } },
      { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { text: ' and mapping candidates', type: 'text' } } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'step.start', index: 1, step: { type: 'model_output' } },
      { event_type: 'step.delta', index: 1, delta: { text: '# The Report\n\n' } },
      { event_type: 'step.stop', index: 1 },
      { event_type: 'interaction.completed' },
    ]);
    // Two deltas, one journal entry: the fragments are coalesced at step.stop.
    expect(progress.reasoningSteps).toBe(1);
    expect(journal.filter((j) => j.startsWith('thought:'))).toHaveLength(1);
    expect(journal[0]).toBe('thought: ***Generating research plan*** and mapping candidates');
    expect(progress.reportChars).toBe('# The Report\n\n'.length);
    expect(progress.terminal).toBe('completed');
  });

  it('reads content.text, the shape the API actually sends', () => {
    // The first implementation only read content.parts[].text, found nothing,
    // and silently journalled nothing for an entire run.
    const { journal } = foldAll([
      { event_type: 'step.start', index: 0, step: { type: 'thought' } },
      { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { text: 'real text', type: 'text' } } },
      { event_type: 'step.stop', index: 0 },
    ]);
    expect(journal[0]).toBe('thought: real text');
  });

  it('attributes untyped deltas via the enclosing step, not the delta', () => {
    // A model_output delta has no type of its own; only step.start says so.
    const { progress } = foldAll([
      { event_type: 'step.start', index: 3, step: { type: 'model_output' } },
      { event_type: 'step.delta', index: 3, delta: { text: 'abcde' } },
    ]);
    expect(progress.reportChars).toBe(5);
    expect(progress.reasoningSteps).toBe(0);
  });

  it('still counts tool calls if an agent ever emits them', () => {
    const { progress, journal } = foldAll([
      { event_type: 'step.delta', delta: { type: 'google_search_call', arguments: { queries: ['q'] } } },
    ]);
    expect(progress.searches).toBe(1);
    expect(journal[0]).toContain('Search 1: q');
  });

  it('tracks corpus queries separately, which would be the only proof grounding is used', () => {
    const { progress, journal } = foldAll([
      { event_type: 'step.delta', delta: { type: 'file_search_call', arguments: { query: 'internal standard' } } },
    ]);
    expect(progress.corpusQueries).toBe(1);
    expect(progress.searches).toBe(0);
    expect(journal[0]).toContain('Corpus query 1: internal standard');
  });

  it('still handles the multi-part Content shape defensively', () => {
    const { journal } = foldAll([
      { event_type: 'step.start', index: 0, step: { type: 'thought' } },
      { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { parts: [{ text: 'a' }, { text: 'b' }] } } },
      { event_type: 'step.stop', index: 0 },
    ]);
    expect(journal[0]).toBe('thought: ab');
  });

  it('carries the last event id seen, since deltas often omit it', () => {
    // event_id is absent from step.delta on the live stream; a resume token
    // that only updated when present must keep the newest one it saw.
    const { progress } = foldAll([
      { event_type: 'interaction.created', event_id: 'e1' },
      { event_type: 'step.delta', index: 0, delta: { text: 'x' } },
      { event_type: 'step.delta', index: 0, delta: { text: 'y' } },
    ]);
    expect(progress.lastEventId).toBe('e1');
  });

  it('advances the resume token on every event, including ones it ignores', () => {
    const { progress } = foldAll([
      { event_type: 'step.start', event_id: 'e1' },
      { event_type: 'step.delta', event_id: 'e2', delta: { type: 'some_future_delta_type' } },
      { event_type: 'step.stop', event_id: 'e3' },
    ]);
    // A resume that skipped unrecognised events would replay them forever.
    expect(progress.lastEventId).toBe('e3');
    expect(progress.searches).toBe(0);
  });

  it('records terminal states', () => {
    expect(foldAll([{ event_type: 'interaction.completed', event_id: 'z' }]).progress.terminal).toBe('completed');
    const failed = foldAll([{ event_type: 'interaction.error', error: 'quota exhausted' }]);
    expect(failed.progress.terminal).toBe('failed');
    expect(failed.progress.error).toBe('quota exhausted');
  });

  it('never throws on a malformed or unknown payload', () => {
    for (const bad of [null, 'not an object', 42, {}, { event_type: 'step.delta' }, { delta: { type: 'x' } }]) {
      expect(() => foldEvent(EMPTY_PROGRESS, bad)).not.toThrow();
    }
  });

  it('is a pure fold: the same event twice does not mutate the input', () => {
    const start = EMPTY_PROGRESS;
    const e = { event_type: 'step.delta', delta: { type: 'google_search_call', arguments: {} } };
    foldEvent(start, e);
    foldEvent(start, e);
    expect(start.searches).toBe(0);
  });
});

describe('describeProgress', () => {
  it('names only the counters that moved', () => {
    expect(describeProgress({ ...EMPTY_PROGRESS, reasoningSteps: 4 })).toBe('4 reasoning steps');
    expect(describeProgress({ ...EMPTY_PROGRESS, reasoningSteps: 4, searches: 12 })).toBe(
      '4 reasoning steps · 12 searches',
    );
  });

  it('says so plainly when nothing has arrived', () => {
    expect(describeProgress(EMPTY_PROGRESS)).toBe('no progress reported yet');
  });
});

describe('replay of a real captured stream', () => {
  it('folds a verbatim live stream into sane progress', async () => {
    // tests/fixtures-live-stream.json is the actual SSE stream from a live
    // fast-tier Deep Research run, captured unmodified. This is the test that
    // would have caught every one of the three shape errors in the first
    // implementation, and it is why the fixture is committed.
    const events = (await import('./fixtures-live-stream.json', { with: { type: 'json' } })).default as unknown[];
    const { progress, journal } = foldAll(events);

    expect(events.length).toBeGreaterThan(40);
    // A Deep Research run emits thought and model_output steps and nothing else.
    expect(progress.reasoningSteps).toBeGreaterThan(0);
    expect(progress.reportChars).toBeGreaterThan(1000);
    expect(journal.some((j) => j.startsWith('thought:'))).toBe(true);
    // Coalescing works: far fewer journal entries than raw deltas.
    // 41 raw deltas collapse to a handful of journal entries.
    expect(journal.length).toBeLessThan(events.length / 4);
    expect(progress.terminal).toBe('completed');
    // No buffer is left open once every step has stopped.
    expect(Object.keys(progress.buffers)).toHaveLength(0);
    // The tool-call counters stay at zero, which is the documented reality.
    expect(progress.searches).toBe(0);
    expect(progress.corpusQueries).toBe(0);
  });
});
