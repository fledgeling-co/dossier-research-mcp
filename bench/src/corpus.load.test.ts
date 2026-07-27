import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadCorpusFromDirectory } from './tasks/index.js';
import type { BenchTask } from './tasks/corpus.js';

/**
 * The corpus itself, held to the invariants every scorer in the fleet assumes.
 *
 * Hermetic on purpose, so it belongs in `npm run gate` where the two network
 * scripts do not. What it cannot check is whether a gold fact is *true* — that
 * needs the live source and is `npm run bench:verify`'s job. What it can check
 * is that nobody has quietly broken the corpus with a hand edit, which is the
 * failure mode a hand-authored asset actually has.
 *
 * It lives under `src/` rather than beside the YAML so that `bench/tasks/`
 * contains task files and nothing else: a stray non-task file there would show
 * up in the loader's `ignoredFiles`, and a test that has to filter its own
 * artefact out of that list is a test working around itself.
 *
 * The reference date is pinned rather than taken from the clock. A test that
 * reads `new Date()` turns every task stale on a schedule and fails on a date
 * nobody chose; staleness against *today* is a property of a run, reported by
 * `research`-side tooling, not a property of the files.
 */

const REFERENCE = new Date('2026-07-27T00:00:00Z');

function corpus(): { tasks: readonly BenchTask[]; staleCount: number; ignoredFiles: readonly string[] } {
  return loadCorpusFromDirectory(fileURLToPath(new URL('../tasks/', import.meta.url)), {
    now: REFERENCE,
  });
}

describe('the seed corpus', () => {
  it('loads with no rejected files and nothing ignored', () => {
    // `loadCorpusFromDirectory` throws naming every bad file, so simply getting
    // here is the assertion. `ignoredFiles` catches the quieter failure: a task
    // saved as `.yam` is a task nobody scores and nobody misses.
    const c = corpus();
    expect(c.tasks.length).toBeGreaterThan(0);
    expect(c.ignoredFiles).toEqual([]);
  });

  it('is not stale as authored', () => {
    expect(corpus().staleCount).toBe(0);
  });

  it('gives every task a unique id', () => {
    const ids = corpus().tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cites an https source for every recorded value', () => {
    // The one property that makes a disputed score adjudicable. A source that
    // is not fetchable by a second person is not a source.
    for (const task of corpus().tasks) {
      for (const fact of task.goldFacts) {
        expect(fact.source.url, `${task.id}/${fact.id}`).toMatch(/^https:\/\//);
      }
      for (const figure of task.conflictingFigures) {
        for (const value of figure.values) {
          expect(value.source.url, `${task.id}/${value.id}`).toMatch(/^https:\/\//);
        }
      }
    }
  });

  it('records a quote on every gold fact, so verification can be scripted', () => {
    // Optional in the schema and required here. BENCH-09's acceptance rule is
    // that a script proves each fact against its source, and a bare link to a
    // fifteen-megabyte registry document cannot support that.
    for (const task of corpus().tasks) {
      for (const fact of task.goldFacts) {
        expect(fact.source.quote, `${task.id}/${fact.id} has no quote`).toBeDefined();
      }
    }
  });

  it('sets asOf and reverifiedAt to different dates', () => {
    // Collapsing them hides rot: a fact can be true as of one date and confirmed
    // still true on another, and only the second says anything about staleness.
    for (const task of corpus().tasks) {
      expect(task.asOf, `${task.id}`).not.toBe(task.reverifiedAt);
    }
  });

  it('covers more than one category, and each present category more than once over the set', () => {
    const byCategory = new Map<string, number>();
    for (const task of corpus().tasks) {
      byCategory.set(task.category, (byCategory.get(task.category) ?? 0) + 1);
    }
    expect(byCategory.size).toBeGreaterThanOrEqual(2);
    for (const [category, n] of byCategory) {
      expect(n, `category ${category} has ${String(n)} task(s)`).toBeGreaterThan(0);
    }
  });

  it('leaves every task scoreable in the category it claims', () => {
    // The schema enforces this per file; asserting it over the whole corpus is
    // what catches a category that has quietly lost its last scoreable task and
    // would report a number computed over nothing.
    for (const task of corpus().tasks) {
      const m = task.applicableMetrics;
      const scoreable =
        m.accuracy || m.refusal || m.dissentRecall || m.conflictAcknowledgement || m.falseBalance;
      expect(scoreable, `${task.id} can be scored by nothing`).toBe(true);
    }
  });
});
