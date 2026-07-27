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
