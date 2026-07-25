import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpHarness, makeRun } from './harness.js';

/**
 * SHAPE-01..06 and CMP-01..02.
 *
 * The shapes that are not "one question, one essay". Everything here runs
 * without credentials on purpose: the paths worth pinning at this layer are the
 * guard clauses and the completion gate, and both must behave before any money
 * is involved. The paid halves (actually starting a wide run on Perplexity's
 * preset, actually diffing two live reports) belong to the paid project.
 */

let mcp: McpHarness;

const WIDE_RUN = 'dr_wide00000001';
const DEEP_RUN = 'dr_deep00000001';

const SPEC = {
  topic: 'Vector databases with binary quantization',
  entities: ['Qdrant', 'Milvus'],
  fields: [
    { name: 'binary_quantization', detail: 'brief' },
    { name: 'memory_at_10m', detail: 'moderate' },
  ],
};

/** A returned report that is mostly prose with one table in the middle of it. */
const MATRIX_REPORT = [
  '# Binary quantization across vector databases',
  '',
  'Both projects ship binary quantization; the memory claims differ.',
  '',
  '| entity | binary_quantization | memory_at_10m |',
  '|---|---|---|',
  '| Qdrant | yes | ~1.2 GB `[uncertain]` |',
  '| Milvus | yes | n/a |',
  '',
  '## What could not be established',
  '',
  '- **Milvus**: memory_at_10m',
].join('\n');

beforeAll(async () => {
  mcp = await McpHarness.create();
  await mcp.store.saveRun(
    makeRun({ id: WIDE_RUN, state: 'completed', shape: 'wide', wideSpec: JSON.stringify(SPEC) }),
  );
  await mcp.store.saveReport(WIDE_RUN, MATRIX_REPORT);
  await mcp.store.saveRun(makeRun({ id: DEEP_RUN, state: 'completed' }));
  await mcp.store.saveReport(DEEP_RUN, '# A normal report\n\nProse, no table.\n');
}, 60_000);

afterAll(async () => {
  await mcp.dispose();
});

describe('SHAPE-01: the completion gate runs against what came back', () => {
  it('re-renders the matrix and reports the gate', async () => {
    const result = await mcp.callTool('research_wide', { runId: WIDE_RUN });
    expect(result.text).toContain('| Qdrant | yes | ~1.2 GB `[uncertain]` |');
    expect(result.text).toContain('Completion gate');
    // Milvus declared its gap rather than hiding it, so the gate passes.
    expect(result.text).toMatch(/Every requested cell is either filled or explicitly marked uncertain/);
  });

  it('keeps per-cell uncertainty rather than flattening it to a report-level caveat', async () => {
    const result = await mcp.callTool('research_wide', { runId: WIDE_RUN });
    expect(result.text).toContain('`[uncertain]`');
    // The confident cell beside it is not tarred by the uncertain one.
    expect(result.text).not.toContain('yes `[uncertain]`');
  });
});

describe('SHAPE-05 / SHAPE-06: the guard clauses', () => {
  it('refuses a spec and a runId together', async () => {
    const result = await mcp.callTool('research_wide', {
      runId: WIDE_RUN,
      topic: 'something else',
      entities: ['A'],
      fields: [{ name: 'f' }],
    });
    expect(result.text).toMatch(/Not both/i);
  });

  it('refuses a half-supplied spec instead of guessing the rest', async () => {
    const result = await mcp.callTool('research_wide', { topic: 'Vector databases' });
    expect(result.text).toMatch(/needs `topic`, `entities` and `fields`/);
  });

  it('says a deep run is not a wide one rather than inventing a spec for it', async () => {
    const result = await mcp.callTool('research_wide', { runId: DEEP_RUN });
    expect(result.text).toMatch(/is a deep run, not a wide one/);
  });

  it('explains a missing report by state rather than erroring opaquely', async () => {
    const id = 'dr_wide00000002';
    await mcp.store.saveRun(
      makeRun({ id, state: 'running', shape: 'wide', wideSpec: JSON.stringify(SPEC), reportPath: undefined }),
    );
    const result = await mcp.callTool('research_wide', { runId: id });
    expect(result.text).toMatch(/No report for/);
    expect(result.text).toMatch(/running/);
  });
});

describe('CMP-01 / CMP-02: comparison guards before it spends twice', () => {
  it('refuses both entry conditions at once', async () => {
    const result = await mcp.callTool('research_compare', {
      question: 'who leads?',
      runIds: [WIDE_RUN, DEEP_RUN],
    });
    expect(result.text).toMatch(/Exactly one/);
  });

  it('refuses neither', async () => {
    const result = await mcp.callTool('research_compare', {});
    expect(result.text).toMatch(/Exactly one/);
  });

  it('will not start a comparison it cannot complete', async () => {
    // No credentials here, so there is nothing to compare against. Refusing
    // before spending beats starting one run and calling it a comparison.
    const result = await mcp.callTool('research_compare', { question: 'who leads?' });
    expect(result.text).toMatch(/at least two configured backends/);
  });

  it('needs a utility model to diff, and says which one is missing', async () => {
    const result = await mcp.callTool('research_compare', { runIds: [WIDE_RUN, DEEP_RUN] });
    expect(result.text).toMatch(/utility model/);
    expect(result.text).toMatch(/research_read/);
  });
});

describe('the shape tools describe their own cost', () => {
  it('names the money in every description', async () => {
    const tools = await mcp.listTools();
    for (const name of ['research_wide', 'research_recent', 'research_compare']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.description ?? '', name).toMatch(/SPENDS MONEY/);
      expect(tool?.annotations?.readOnlyHint ?? true, name).toBe(false);
    }
  });
});
