import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpHarness, makeRun, REPORT_FIXTURES } from './harness.js';

/**
 * READ-01..08 and the data-shape axis.
 *
 * The QA plan's data-seeding section is the force multiplier here: the same
 * read modes are driven against realistic, headingless, unicode and huge
 * reports, because slicing and heading detection are exactly where a naive
 * implementation breaks on real content.
 *
 * READ-01 is the load-bearing one for this product. A report is ~60k tokens
 * and returning it inline kills the caller's session, so "the default mode is
 * an outline" is a contract, not a preference.
 */

let mcp: McpHarness;

const RUNS = {
  realistic: 'dr_shaperealis',
  headingless: 'dr_shapenohead',
  unicode: 'dr_shapeunicod',
  huge: 'dr_shapehuge01',
  empty: 'dr_shapeempty1',
} as const;

beforeAll(async () => {
  mcp = await McpHarness.create();
  for (const [shape, id] of Object.entries(RUNS)) {
    await mcp.store.saveRun(makeRun({ id, state: 'completed' }));
    await mcp.store.saveReport(id, REPORT_FIXTURES[shape as keyof typeof REPORT_FIXTURES]);
  }
}, 60_000);

afterAll(async () => {
  await mcp.dispose();
});

describe('READ-01: a full report is never returned inline', () => {
  it('defaults to an outline, not the report', async () => {
    const result = await mcp.callTool('research_read', { runId: RUNS.realistic });
    expect(result.text).toMatch(/Report outline/);
    // The decisive assertion: the body did not come back.
    expect(result.text).not.toContain('Qdrant reports 12ms p99');
  });

  it('keeps the outline far smaller than the report it describes', async () => {
    const outline = await mcp.callTool('research_read', { runId: RUNS.huge });
    const full = await mcp.callTool('research_read', { runId: RUNS.huge, mode: 'full', maxTokens: 120_000 });
    expect(outline.text.length).toBeLessThan(full.text.length / 10);
  });
});

describe('READ-02: the outline carries token estimates', () => {
  it('reports an estimate per section and a total', async () => {
    const result = await mcp.callTool('research_read', { runId: RUNS.realistic });
    // Not just "a string came back": every listed section carries a number,
    // which is what makes the outline usable for budgeting a read.
    const perSection = [...result.text.matchAll(/\(~(\d+) tok\)/g)];
    expect(perSection.length).toBeGreaterThanOrEqual(4);
    expect(result.text).toMatch(/~\d+ estimated tokens total/);
    for (const [, n] of perSection) expect(Number(n)).toBeGreaterThan(0);
  });
});

describe('READ-03/04: section resolution', () => {
  it('resolves by 1-based index', async () => {
    const result = await mcp.callTool('research_read', { runId: RUNS.realistic, mode: 'section', section: '2' });
    expect(result.text).toContain('Executive Summary');
    expect(result.text).toContain('Qdrant leads on p99');
  });

  it('resolves by a case-insensitive heading substring', async () => {
    const result = await mcp.callTool('research_read', { runId: RUNS.realistic, mode: 'section', section: 'evidence' });
    expect(result.text).toContain('Evidence Table');
    expect(result.text).not.toContain('Knowledge Gaps');
  });

  it('names the miss and shows the outline so the caller can retry', async () => {
    const result = await mcp.callTool('research_read', {
      runId: RUNS.realistic,
      mode: 'section',
      section: 'no such heading',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('no such heading');
    expect(result.text).toMatch(/Report outline/);
  });

  it('rejects an out-of-range index rather than clamping to a section', async () => {
    const result = await mcp.callTool('research_read', { runId: RUNS.realistic, mode: 'section', section: '999' });
    expect(result.isError).toBe(true);
  });
});

describe('READ-05: grep', () => {
  it('treats the pattern as a literal by default', async () => {
    // `12ms p99` contains no regex metacharacters, but `$` and `(` in real
    // reports do; literal-by-default is what makes grep usable on prose.
    const result = await mcp.callTool('research_read', { runId: RUNS.realistic, mode: 'grep', pattern: '(High Confidence)' });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/match/);
  });

  it('opts into regex explicitly and reports the containing section', async () => {
    const result = await mcp.callTool('research_read', {
      runId: RUNS.realistic,
      mode: 'grep',
      pattern: 'Qdrant|Milvus',
      regex: true,
    });
    expect(result.text).toMatch(/Executive Summary|p99 at scale/);
  });

  it('reports a clean miss rather than an error', async () => {
    const result = await mcp.callTool('research_read', { runId: RUNS.realistic, mode: 'grep', pattern: 'zzzznotpresent' });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/No matches/i);
  });

  it('refuses a malformed regex with a readable message', async () => {
    const result = await mcp.callTool('research_read', {
      runId: RUNS.realistic,
      mode: 'grep',
      pattern: '([unclosed',
      regex: true,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Invalid regular expression/i);
  });
});

describe('READ-06: maxTokens is a hard cap and truncation is disclosed', () => {
  it('caps the response and says it truncated', async () => {
    const result = await mcp.callTool('research_read', { runId: RUNS.huge, mode: 'full', maxTokens: 500 });
    expect(result.text).toMatch(/truncated at the requested token budget/);
    expect(result.text).toMatch(/estimated tokens remain/);
    // The cap is real, not advisory. 500 tokens is ~2000 chars; allow slack
    // for the truncation notice itself.
    expect(result.text.length).toBeLessThan(500 * 4 + 400);
  });

  it('does not claim truncation when the content fits', async () => {
    const result = await mcp.callTool('research_read', { runId: RUNS.realistic, mode: 'full', maxTokens: 100_000 });
    expect(result.text).not.toMatch(/truncated/);
  });
});

describe('READ-08: every mode survives every data shape', () => {
  const modes = ['outline', 'summary', 'full'] as const;

  for (const [shape, id] of Object.entries(RUNS)) {
    for (const mode of modes) {
      it(`${mode} on a ${shape} report does not error`, async () => {
        const result = await mcp.callTool('research_read', { runId: id, mode, maxTokens: 2000 });
        // An empty report is the one shape where refusing is correct.
        if (shape === 'empty') {
          expect(result.isError).toBe(true);
          return;
        }
        expect(result.isError, `${shape}/${mode}: ${result.text.slice(0, 200)}`).toBe(false);
        expect(result.text.length).toBeGreaterThan(0);
      });
    }
  }

  it('produces a usable outline even with no headings at all', async () => {
    const result = await mcp.callTool('research_read', { runId: RUNS.headingless });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/1 sections|untitled report/i);
  });

  it('does not corrupt unicode, emoji or RTL when slicing', async () => {
    const result = await mcp.callTool('research_read', { runId: RUNS.unicode, mode: 'full', maxTokens: 5000 });
    expect(result.text).toContain('研究レポート');
    expect(result.text).toContain('📊');
    expect(result.text).toContain('اختبار');
    // A replacement character means a slice landed mid-codepoint.
    expect(result.text).not.toContain('�');
  });

  it('finds unicode headings in the outline', async () => {
    const result = await mcp.callTool('research_read', { runId: RUNS.unicode });
    expect(result.text).toContain('詳細な調査結果');
  });
});
