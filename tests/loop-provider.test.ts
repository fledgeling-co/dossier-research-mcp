import { describe, expect, it } from 'vitest';
import { draftPrompt, extractJsonObject, workerPrompt } from '../src/providers/loop.js';
import { SessionSchema, type Session } from '../src/research/local-loop.js';

/**
 * The loop provider's pure parts.
 *
 * `extractJsonObject` gets the most attention because it is the seam where a
 * real CLI's habits meet a schema. Everything a worker found is thrown away if
 * this misreads its reply, and the failure is silent: the run continues, the
 * task is recorded as having established nothing, and the report says the index
 * was empty. So the cases here are the ones real CLIs actually produce, not the
 * ones a parser is comfortable with.
 */

const session = (): Session =>
  SessionSchema.parse({
    runId: 'r1',
    question: 'q',
    createdAt: '2026-07-28T00:00:00Z',
    tasks: [],
    registry: [
      { n: 1, url: 'https://example.com/a', domain: 'example.com', claims: ['a'], firstSeenIn: 't1' },
    ],
  });

describe('extractJsonObject', () => {
  it('reads a bare object', () => {
    expect(extractJsonObject('{"outcome":"ok"}')).toEqual({ outcome: 'ok' });
  });

  it('reads an object a CLI prefaced with prose', () => {
    // The single most common real shape, and the one that costs a whole task's
    // findings when it is not handled.
    const raw = 'Here are the results:\n\n{"findings":[],"outcome":"no-results"}';
    expect(extractJsonObject(raw)).toEqual({ findings: [], outcome: 'no-results' });
  });

  it('reads an object inside a fenced code block with trailing commentary', () => {
    const raw = '```json\n{"outcome":"ok","gaps":"none"}\n```\n\nLet me know if you want more.';
    expect(extractJsonObject(raw)).toEqual({ outcome: 'ok', gaps: 'none' });
  });

  it('reads nested objects without stopping at the first inner brace', () => {
    const raw = '{"findings":[{"claim":"c","url":"https://e.com"}],"outcome":"ok"}';
    expect(extractJsonObject(raw)).toEqual({
      findings: [{ claim: 'c', url: 'https://e.com' }],
      outcome: 'ok',
    });
  });

  it('is not fooled by an unmatched brace inside a string value', () => {
    // A claim quoting a fragment of code or a log line is not exotic in a
    // technical corpus. The brace has to be UNMATCHED to test anything: a
    // balanced `{"a":1}` inside a string self-corrects, because the counter
    // returns to the right depth and `JSON.parse` accepts the full span, so a
    // scanner with no string tracking passes that case and fails this one.
    //
    // Here the early close yields `{"claim":"unmatched } `, which does not
    // parse, and there is no later `{` to retry from — so without string
    // tracking the whole reply is discarded and the task is recorded as having
    // established nothing.
    const raw = '{"claim":"unmatched } here","outcome":"ok"}';
    expect(extractJsonObject(raw)).toEqual({ claim: 'unmatched } here', outcome: 'ok' });
  });

  it('skips a leading brace that does not open valid JSON, and finds the real one', () => {
    const raw = 'Consider {this} an aside.\n{"outcome":"blocked"}';
    expect(extractJsonObject(raw)).toEqual({ outcome: 'blocked' });
  });

  it('returns undefined rather than guessing when there is no object', () => {
    // Load-bearing. `undefined` fails the schema, which the caller records as
    // `tool-failed`. Returning `{}` here would sail through the schema's
    // defaults and be recorded as a clean run that found nothing, turning a
    // worker that never answered into evidence that the index is empty.
    expect(extractJsonObject('I could not complete this task.')).toBeUndefined();
    expect(extractJsonObject('')).toBeUndefined();
    expect(extractJsonObject('{ not json at all')).toBeUndefined();
  });
});

describe('workerPrompt', () => {
  const task = {
    objective: 'find the release date',
    role: 'release engineer',
    queries: ['site:github.com releases'],
    done: 'the date is confirmed by two sources',
    depth: 'scan',
  };

  it('carries the queries in the dialect the task chose', () => {
    expect(workerPrompt('q', task, false)).toContain('site:github.com releases');
  });

  it('names the three non-results outcomes, so a blocked search is not filed as an empty one', () => {
    // The distinction the whole loop rests on. A worker that reports a bot wall
    // as `no-results` makes the report claim there is no public record of
    // something nobody managed to look for.
    const p = workerPrompt('q', task, false);
    for (const outcome of ['rate-limited', 'blocked', 'tool-failed']) {
      expect(p, outcome).toContain(outcome);
    }
  });

  it('tells a no-search worker it has no tools, and an ordinary one to search', () => {
    expect(workerPrompt('q', task, true)).toContain('NO search tools');
    expect(workerPrompt('q', task, false)).toContain('Use your web search');
    expect(workerPrompt('q', task, false)).not.toContain('NO search tools');
  });
});

describe('draftPrompt', () => {
  it('states the registry is frozen and that memory is not a source', () => {
    const p = draftPrompt('q', session(), []);
    expect(p).toContain('FROZEN');
    expect(p).toMatch(/may not add a source/);
  });

  it('includes the registry the draft must cite from', () => {
    expect(draftPrompt('q', session(), [])).toContain('https://example.com/a');
  });

  it('asks for disagreement to be kept rather than averaged', () => {
    // The due-weight rule, carried into the one prompt that decides what the
    // report says. A drafter told only to be accurate resolves a genuine split
    // into one number, which is the failure `contested` tasks exist to catch.
    expect(draftPrompt('q', session(), [])).toMatch(/give both readings/);
  });

  it('carries deep-task reading notes, which live nowhere else', () => {
    expect(draftPrompt('q', session(), ['- t1: the caveat'])).toContain('the caveat');
  });
});
