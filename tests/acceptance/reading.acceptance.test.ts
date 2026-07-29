import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpHarness, makeRun } from './harness.js';

/**
 * The wiring, not the logic.
 *
 * `reading.ts` had unit tests and was imported nowhere, so a changelog entry
 * claimed a feature that ran never. These drive the real MCP surface, which is
 * the only layer that can tell a wired module from an unwired one.
 */
let mcp: McpHarness;
const A = 'dr_readcova';
const B = 'dr_readcovb';
const REPORT = '# R\n\n## Alpha\n\nalpha body\n\n## Beta\n\nbeta body\n\n## Gamma\n\ngamma body\n';

beforeAll(async () => {
  mcp = await McpHarness.create();
  for (const id of [A, B]) {
    await mcp.store.saveRun(makeRun({ id, state: 'completed' }));
    await mcp.store.saveReport(id, REPORT);
  }
}, 60_000);

afterAll(async () => {
  await mcp.dispose();
});

describe('READ-04: a merge reports what was actually read', () => {
  it('warns at the top when nothing has been opened', async () => {
    const result = await mcp.callTool('research_synthesise', { runIds: [A, B], distil: 'caller' });
    expect(result.text.slice(0, 400)).toMatch(/WARNING/);
    expect(result.text).toMatch(/never opened/);
  });

  it('still counts an outline read as never having read a section', async () => {
    await mcp.callTool('research_read', { runId: A, mode: 'outline' });
    const result = await mcp.callTool('research_synthesise', { runIds: [A, B], distil: 'caller' });
    // The whole point: an outline gives every heading and no content.
    expect(result.text).toMatch(/outline only, \*\*no section read\*\*/);
  });

  it('records a real section read and says so', async () => {
    // Its own runs, because these tests share a store and an assertion that
    // depends on an earlier test having run is an assertion about test order.
    const C = 'dr_readcovc';
    const D = 'dr_readcovd';
    for (const id of [C, D]) {
      await mcp.store.saveRun(makeRun({ id, state: 'completed' }));
      await mcp.store.saveReport(id, REPORT);
    }
    await mcp.callTool('research_read', { runId: C, mode: 'section', section: '1' });
    const result = await mcp.callTool('research_synthesise', { runIds: [C, D], distil: 'caller' });
    expect(result.text).toMatch(/1 of 4 section\(s\) read/);
    expect(result.text, 'the unread sibling must still be named').toMatch(/never opened/);
  });

  it('says plainly that the claims list is not a substitute for the reports', async () => {
    const result = await mcp.callTool('research_synthesise', { runIds: [A, B], distil: 'caller' });
    expect(result.text).toMatch(/not a substitute for the reports/);
  });
});

describe('READ-05: a merge cannot overflow the caller\'s context', () => {
  /**
   * The defect this covers, from a real session: six merged runs returned
   * ~50,000 characters in one tool result and blew the token limit. Every part
   * that grew with the input was unbounded, so the failure scaled with exactly
   * the case the tool exists for.
   */
  const BIG = [
    '# Big report',
    '',
    '## Findings',
    '',
    // Distinct sentences with distinct sources: the merge keys on claims, so
    // repeating one line would collapse to a single claim and prove nothing.
    ...Array.from(
      { length: 400 },
      (_, i) =>
        `Finding ${String(i)}: the measured value for subject ${String(i)} was ${String(i * 7)} units in trials. See https://example${String(i % 40)}.com/study-${String(i)}`,
    ),
  ].join('\n');

  it('stays within the requested budget and says what it withheld', async () => {
    const ids = Array.from({ length: 6 }, (_, i) => `dr_big${String(i)}`);
    for (const id of ids) {
      await mcp.store.saveRun(makeRun({ id, state: 'completed' }));
      await mcp.store.saveReport(id, BIG);
    }
    const result = await mcp.callTool('research_synthesise', {
      runIds: ids,
      distil: 'caller',
      maxTokens: 4_000,
    });
    // 4k tokens of budget; the shell and registry are outside it, so the ceiling
    // is generous rather than exact. The defect was ~50k with no ceiling at all.
    expect(result.text.length).toBeLessThan(4_000 * 4 * 2.5);
    // `distil: 'caller'` is the free branch and the default with no utility
    // model, so it is the path most runs take. It returns early, which is why it
    // was the one without a ceiling.
    expect(result.text).toMatch(/did not fit `maxTokens`/);
  });

  it('never trims the registry it tells the caller to cite from', async () => {
    const ids = Array.from({ length: 6 }, (_, i) => `dr_reg${String(i)}`);
    for (const id of ids) {
      await mcp.store.saveRun(makeRun({ id, state: 'completed' }));
      await mcp.store.saveReport(id, BIG);
    }
    const result = await mcp.callTool('research_synthesise', {
      runIds: ids,
      distil: 'caller',
      maxTokens: 2_000,
    });
    // The instruction and the list it refers to must both survive, or the tool
    // tells you to cite only from a list whose tail you were never shown.
    // The instruction must never claim a completeness the list does not have.
    expect(result.text).toMatch(/Cite only from this registry/);
    expect(result.text).toMatch(/Do not cite a source that is not shown here/);
    expect(result.text).toMatch(/Showing \d+ of \d+ registry lines/);
  });
});
