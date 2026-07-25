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
  it('counts searches and journals each one with its query', () => {
    const { progress, journal } = foldAll([
      { event_type: 'step.delta', event_id: 'e1', delta: { type: 'google_search_call', arguments: { queries: ['vertex ai deep research'] } } },
      { event_type: 'step.delta', event_id: 'e2', delta: { type: 'google_search_call', arguments: { queries: ['interactions api'] } } },
    ]);
    expect(progress.searches).toBe(2);
    expect(progress.lastEventId).toBe('e2');
    expect(journal[0]).toContain('Search 1: vertex ai deep research');
    expect(journal[1]).toContain('Search 2: interactions api');
  });

  it('tracks corpus queries separately, which is the only proof grounding is used', () => {
    const { progress, journal } = foldAll([
      { event_type: 'step.delta', delta: { type: 'file_search_call', arguments: { query: 'internal standard' } } },
    ]);
    expect(progress.corpusQueries).toBe(1);
    expect(progress.searches).toBe(0);
    expect(journal[0]).toContain('Corpus query 1: internal standard');
  });

  it('reads reasoning out of content.parts, not just a text field', () => {
    const { progress, journal } = foldAll([
      {
        event_type: 'step.delta',
        delta: { type: 'thought_summary', content: { parts: [{ text: '**Mapping candidates**' }, { text: ' and sources' }] } },
      },
    ]);
    expect(progress.lastThought).toBe('**Mapping candidates** and sources');
    expect(journal[0]).toBe('thought: **Mapping candidates** and sources');
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
    expect(describeProgress({ ...EMPTY_PROGRESS, searches: 12 })).toBe('12 searches');
    expect(describeProgress({ ...EMPTY_PROGRESS, searches: 12, corpusQueries: 3 })).toBe(
      '12 searches · 3 corpus queries',
    );
  });
});
