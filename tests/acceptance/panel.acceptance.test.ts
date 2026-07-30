import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpHarness, makeRun } from './harness.js';

/**
 * PANEL-01: a panel reports once, not member by member.
 *
 * The behaviour this locks, from real use: each member was its own run and the
 * tools said so, so the driving agent polled each handle, watched members land
 * one at a time, and reported each finding to its user as it arrived. By the time
 * the merge said "these agreed because they read the same page", four
 * single-sourced findings had already been presented as corroborated.
 *
 * Driven over the real MCP surface because the defect was in what the tools SAY,
 * and a unit test over the renderer cannot see whether the tool calls it.
 */
let mcp: McpHarness;
const P = 'panel_accept_1';
const DONE = 'dr_panelmemb1';
const RUNNING = 'dr_panelmemb2';
const REPORT = '# R\n\n## Alpha\n\nbody\n\nSee https://example.com/a\n';

beforeAll(async () => {
  mcp = await McpHarness.create();
  await mcp.store.saveRun(
    makeRun({ id: DONE, panelId: P, state: 'completed', reportChars: 900, sourceCount: 7 }),
  );
  await mcp.store.saveReport(DONE, REPORT);
  await mcp.store.saveRun(makeRun({ id: RUNNING, panelId: P, state: 'running' }));
}, 60_000);

afterAll(async () => {
  await mcp.dispose();
});

describe('PANEL-01: an unfinished panel', () => {
  it('does not invite reading a finished member while siblings run', async () => {
    const r = await mcp.callTool('research_status', { runId: DONE, refresh: false });
    // The old text. An agent handed this reads the report and reports findings.
    expect(r.text).not.toMatch(/Read it with `research_read \{ runId \}`, outline first/);
    expect(r.text).toMatch(/member of an unfinished panel/);
  });

  it('names the panel, the count settled, and the time REMAINING', async () => {
    const r = await mcp.callTool('research_status', { runId: DONE, refresh: false });
    expect(r.text).toMatch(new RegExp(`panel \`${P}\``));
    expect(r.text).toMatch(/1 of 2 members have settled/);
    expect(r.text).toMatch(/minute\(s\)|due any moment|past the expected band/);
  });

  it('tells the caller to set up a monitor instead of polling', async () => {
    const r = await mcp.callTool('research_status', { runId: DONE, refresh: false });
    expect(r.text).toMatch(/Set up a monitor rather than polling by hand/);
    expect(r.text).toMatch(/every two minutes/);
  });

  it('groups the in-flight listing by panel with one remaining estimate', async () => {
    const r = await mcp.callTool('research_status', { refresh: false });
    expect(r.text).toMatch(new RegExp(`Panel \\\`${P}\\\``));
    expect(r.text).toMatch(/Time remaining:/);
  });
});

describe('PANEL-01: a settled panel', () => {
  it('returns every member together, with the merge and the reading order', async () => {
    // Its own panel: an assertion that depends on an earlier test having mutated
    // shared state is an assertion about test order.
    const p2 = 'panel_accept_2';
    const a = 'dr_panelfin_a';
    const b = 'dr_panelfin_b';
    for (const id of [a, b]) {
      await mcp.store.saveRun(
        makeRun({ id, panelId: p2, state: 'completed', reportChars: 900, sourceCount: 5 }),
      );
      await mcp.store.saveReport(id, REPORT);
    }
    const r = await mcp.callTool('research_status', { runId: a, refresh: false });
    expect(r.text).toMatch(/is complete: 2 of 2 members produced evidence/);
    expect(r.text).toMatch(/research_synthesise/);
    expect(r.text).toMatch(/in detail, not in outline/);
    expect(r.text).toMatch(/Present this to the user as one result/);
    // And the waiting language must be gone.
    expect(r.text).not.toMatch(/nothing to report to the user yet/);
  });
});
