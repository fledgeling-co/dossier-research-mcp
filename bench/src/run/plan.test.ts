import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cellKey, spreadEligibility } from './cell.js';
import { planBatch } from './plan.js';

/**
 * Planning is the only place a batch can refuse, so these are the tests that
 * stand between a mistyped repetition count and four figures of research.
 * Every one of them runs without a filesystem, a network or a wallet.
 */

const FLAT = (): number => 3;

const base = {
  taskIds: ['t1', 't2', 't3'],
  providers: ['gemini', 'perplexity'],
  repetitions: 5,
  estimateCellUsd: FLAT,
  ceilingUsd: 0,
};

describe('planBatch', () => {
  // BATCH-01
  it('BATCH-01: the matrix is task times backend times repetition, with a distinct key per cell', () => {
    const plan = planBatch(base);
    expect(plan.totalCells).toBe(3 * 2 * 5);
    expect(plan.queue).toHaveLength(30);
    expect(new Set(plan.queue.map(cellKey)).size).toBe(30);
    // Task-major, then backend, then repetition. Deterministic, so a resumed
    // batch is the same batch.
    expect(plan.queue.slice(0, 3).map(cellKey)).toEqual(['t1/gemini/1', 't1/gemini/2', 't1/gemini/3']);
    expect(plan.queue.every((c) => c.repeat >= 1)).toBe(true);
  });

  // BATCH-02. The brief's first acceptance criterion, in its planning half.
  it('BATCH-02: re-planning subtracts recorded cells and queues exactly the remainder', () => {
    const first = planBatch(base);
    const done = first.queue.slice(0, 11).map(cellKey);

    const second = planBatch({ ...base, completedKeys: done });
    expect(second.totalCells).toBe(30);
    expect(second.alreadyDone).toBe(11);
    expect(second.queue).toHaveLength(19);

    // Exactly the remainder: no overlap with what was done, and together they
    // reconstitute the whole matrix.
    const remaining = new Set(second.queue.map(cellKey));
    for (const key of done) expect(remaining.has(key)).toBe(false);
    expect(new Set([...done, ...remaining]).size).toBe(30);
  });

  it('BATCH-02: a fully recorded matrix queues nothing and projects nothing', () => {
    const all = planBatch(base).queue.map(cellKey);
    const plan = planBatch({ ...base, completedKeys: all });
    expect(plan.queue).toHaveLength(0);
    expect(plan.alreadyDone).toBe(30);
    expect(plan.projectedUsd).toBe(0);
    expect(plan.refused).toBe(false);
  });

  // BATCH-03. Refuse on the SUM, before the batch starts, naming the total.
  it('BATCH-03: a projection over the ceiling refuses before anything starts and names the total', () => {
    const plan = planBatch({ ...base, ceilingUsd: 50 });
    expect(plan.projectedUsd).toBe(90);
    expect(plan.refused).toBe(true);
    expect(plan.refusal).toContain('$90.00');
    expect(plan.refusal).toContain('$50.00');
    expect(plan.refusal).toContain('nothing has been charged');
  });

  it('BATCH-03: a projection at the ceiling is allowed; one cent over is not', () => {
    expect(planBatch({ ...base, ceilingUsd: 90 }).refused).toBe(false);
    expect(planBatch({ ...base, ceilingUsd: 89.99 }).refused).toBe(true);
    // A ceiling of zero disables the gate rather than refusing everything.
    expect(planBatch({ ...base, ceilingUsd: 0 }).refused).toBe(false);
  });

  // BATCH-04. The projection must cover the REMAINDER, not the matrix. A plan
  // that totalled the whole matrix would refuse a resume that costs almost
  // nothing, which is the failure that makes people turn the gate off.
  it('BATCH-04: the projection totals the remaining cells only, at worst case per cell', () => {
    const all = planBatch(base).queue.map(cellKey);
    const resumed = planBatch({ ...base, completedKeys: all.slice(0, 28), ceilingUsd: 10 });
    expect(resumed.queue).toHaveLength(2);
    expect(resumed.projectedUsd).toBe(6);
    expect(resumed.refused).toBe(false);
  });

  it('BATCH-04: each backend is costed with its own band, not a shared one', () => {
    const plan = planBatch({
      ...base,
      repetitions: 1,
      estimateCellUsd: (p) => (p === 'gemini' ? 3 : 7),
    });
    // 3 tasks, one cheap backend and one expensive one, one repetition each.
    expect(plan.projectedUsd).toBe(3 * 3 + 3 * 7);
  });

  // BATCH-05
  it('BATCH-05: a failed cell stays subtracted by default and is re-queued only on request', () => {
    const all = planBatch(base).queue.map(cellKey);
    const failed = [all[0] as string, all[7] as string];

    const shy = planBatch({ ...base, completedKeys: all, failedKeys: failed });
    expect(shy.queue).toHaveLength(0);

    const retry = planBatch({
      ...base,
      completedKeys: all,
      failedKeys: failed,
      includeFailed: true,
    });
    expect(retry.queue.map(cellKey).sort()).toEqual([...failed].sort());
  });

  // BATCH-06
  it('BATCH-06: n = 1 plans one cell per pair and refuses a spread', () => {
    const plan = planBatch({ ...base, repetitions: 1 });
    expect(plan.totalCells).toBe(6);
    expect(plan.queue.every((c) => c.repeat === 1)).toBe(true);
    expect(plan.spreadIfComplete.reportable).toBe(false);
    expect(plan.spreadIfComplete.reason).toContain('below the floor');
  });

  it('BATCH-06: three repetitions is the floor at which a spread becomes reportable', () => {
    expect(planBatch({ ...base, repetitions: 2 }).spreadIfComplete.reportable).toBe(false);
    expect(planBatch({ ...base, repetitions: 3 }).spreadIfComplete.reportable).toBe(true);
    expect(planBatch({ ...base, repetitions: 5 }).spreadIfComplete.reportable).toBe(true);
  });

  it('refuses a nonsensical repetition count rather than planning an empty or infinite matrix', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, 1001]) {
      expect(() => planBatch({ ...base, repetitions: bad }), String(bad)).toThrow(
        /integer repetitions/,
      );
    }
  });

  it('refuses a cost estimate that is not a usable number, rather than projecting NaN', () => {
    for (const bad of [Number.NaN, -1, Infinity]) {
      expect(
        () => planBatch({ ...base, estimateCellUsd: () => bad }),
        String(bad),
      ).toThrow(/cost estimate must be a non-negative finite number/);
    }
  });

  it('reports rolling-window headroom as a warning and never refuses on it', () => {
    // The window rolls while a multi-day batch runs, so refusing on it would be
    // wrong more often than right. The runner still enforces it per cell.
    const plan = planBatch({ ...base, rollingRemainingUsd: 12 });
    expect(plan.refused).toBe(false);
    expect(plan.rollingWindowWarning).toContain('$12.00');
    expect(plan.rollingWindowWarning).toContain('may start');

    const roomy = planBatch({ ...base, rollingRemainingUsd: 500 });
    expect(roomy.rollingWindowWarning).toBe('');
  });

  it('plans an empty corpus or an empty backend list without throwing', () => {
    expect(planBatch({ ...base, taskIds: [] }).totalCells).toBe(0);
    expect(planBatch({ ...base, providers: [] }).queue).toHaveLength(0);
  });
});

describe('the deciding half of the harness is pure', () => {
  /**
   * Any way a module can reach the filesystem, not just the static import.
   * Copied deliberately from `bench/src/tasks/corpus.test.ts` rather than
   * reworded: a second spelling of the same rule is how two checks end up
   * enforcing different things.
   */
  const FS_REACH =
    /(?:from|import|require)\s*\(?\s*['"](?:node:)?fs(?:\/promises)?['"]|createRequire/;

  it('cell.ts, plan.ts and harness.ts import nothing from the filesystem', () => {
    for (const file of ['./cell.ts', './plan.ts', './harness.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(FS_REACH);
    }
  });

  it('and none of them can reach the runner, so none of them can spend', () => {
    for (const file of ['./cell.ts', './plan.ts', './harness.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/from '\.\.\/\.\.\/\.\.\/src\//);
    }
  });

  it('would catch a filesystem import added later, in any of its forms', () => {
    for (const smuggled of [
      "import { readFileSync } from 'node:fs';",
      'import { readFileSync } from "node:fs";',
      "import { readFile } from 'node:fs/promises';",
      "void import('node:fs/promises');",
      "const fs = require('fs');",
      "import { createRequire } from 'node:module';",
    ]) {
      expect(smuggled).toMatch(FS_REACH);
    }
  });
});

describe('spreadEligibility', () => {
  // BATCH-06. Counted over COMPLETED repetitions, never over the n that was
  // asked for: a batch that requested five and landed two has two samples, and
  // quoting a spread from the request is the same fabrication as counting a
  // deduped run five times.
  it('BATCH-06: refuses a spread below three completed repetitions, with a reason', () => {
    expect(spreadEligibility(0)).toMatchObject({ reportable: false });
    expect(spreadEligibility(0).reason).toContain('nothing to spread');
    expect(spreadEligibility(1)).toMatchObject({ reportable: false, completed: 1, floor: 3 });
    expect(spreadEligibility(1).reason).toContain('1 completed repetition,');
    expect(spreadEligibility(2).reason).toContain('2 completed repetitions');
    expect(spreadEligibility(3).reportable).toBe(true);
    expect(spreadEligibility(5).reportable).toBe(true);
  });

  it('refuses a count that is not a whole number of runs', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => spreadEligibility(bad), String(bad)).toThrow(/non-negative integer/);
    }
  });

  describe('the search variant', () => {
    const base = {
      taskIds: ['t1'],
      providers: ['openai'],
      repetitions: 1,
      estimateCellUsd: () => 1,
      ceilingUsd: 100,
    };

    it('a variant cell does not collide with the default cell for the same pair', () => {
      // The whole point of the flag. If these shared a key, resume would treat
      // the search-off cell as already bought by the search-on run and the
      // comparison would be one column against itself.
      const on = planBatch(base).queue[0];
      const off = planBatch({ ...base, variant: 'nosearch' }).queue[0];
      expect(on).toBeDefined();
      expect(off).toBeDefined();
      expect(cellKey(off!)).not.toBe(cellKey(on!));
    });

    it('omitting the variant leaves the key byte-identical to before variants existed', () => {
      // Cells bought before this field was added carry three-segment keys. If
      // the default appended an empty segment, every one of them would re-plan
      // as unbought and be paid for twice.
      expect(cellKey({ taskId: 't1', provider: 'openai', repeat: 1 })).toBe('t1/openai/1');
    });

    it('a recorded variant cell is subtracted on resume, and the default one is not', () => {
      const off = { ...base, variant: 'nosearch' };
      const done = cellKey({ taskId: 't1', provider: 'openai', repeat: 1, variant: 'nosearch' });
      expect(planBatch({ ...off, completedKeys: [done] }).queue).toHaveLength(0);
      expect(planBatch({ ...base, completedKeys: [done] }).queue).toHaveLength(1);
    });
  });
});
