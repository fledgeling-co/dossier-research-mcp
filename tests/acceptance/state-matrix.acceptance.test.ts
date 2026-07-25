import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpHarness, makeRun, REPORT_FIXTURES } from './harness.js';

/**
 * The state matrix. STATE-01..06, TAIL-01..02, LIST-01, READ-07, START-01,
 * DEGRADE-01, STREAM-01..02.
 *
 * The QA plan's unit of work is a surface × state cell. For this server the
 * states are a run's lifecycle plus "absent", and the interesting assertions
 * are about what a tool says when the run is NOT in the happy state, because
 * that is what a caller hits and what nothing else tests.
 */

let mcp: McpHarness;

beforeAll(async () => {
  mcp = await McpHarness.create();

  // Seed one run per state. Every test below reads these; none mutates them,
  // so the file is order-independent and green on a re-run.
  await mcp.store.saveRun(makeRun({ id: 'dr_completed01', state: 'completed', sourceCount: 12, tags: ['alpha'] }));
  await mcp.store.saveReport('dr_completed01', REPORT_FIXTURES.realistic);

  await mcp.store.saveRun(makeRun({ id: 'dr_running0001', state: 'running', completedAt: undefined, tags: ['beta'] }));
  await mcp.store.saveRun(
    makeRun({
      id: 'dr_planning001',
      state: 'planning',
      planApproved: false,
      plan: '(1) Locate the specification.\n(2) Extract the transport details.',
      completedAt: undefined,
    }),
  );
  await mcp.store.saveRun(makeRun({ id: 'dr_planning002', state: 'planning', planApproved: false, completedAt: undefined }));
  await mcp.store.saveRun(makeRun({ id: 'dr_failed00001', state: 'failed', error: 'upstream quota exhausted', completedAt: undefined }));
  await mcp.store.saveRun(makeRun({ id: 'dr_cancelled01', state: 'cancelled', completedAt: undefined }));
  await mcp.store.saveRun(
    makeRun({
      id: 'dr_stalled0001',
      state: 'stalled',
      completedAt: undefined,
      lastProgressAt: new Date(Date.now() - 40 * 60_000).toISOString(),
    }),
  );
  await mcp.store.saveRun(
    makeRun({ id: 'dr_streaming01', state: 'running', completedAt: undefined, reasoningSteps: 7, streamedChars: 4200 }),
  );
  await mcp.store.saveRun(
    makeRun({ id: 'dr_abandoned01', state: 'running', completedAt: undefined, streamAbandoned: true, reasoningSteps: 2 }),
  );

  await mcp.store.appendJournal('dr_completed01', 'created', 'Run started.');
  await mcp.store.appendJournal('dr_completed01', 'progress', 'Searching.');
  await mcp.store.appendJournal('dr_completed01', 'completed', 'Report ready.');
}, 60_000);

afterAll(async () => {
  await mcp.dispose();
});

describe('STATE-01: liveness is reported separately from state', () => {
  it('distinguishes stalled from running, so a caller can branch on it', async () => {
    const running = await mcp.callTool('research_status', { runId: 'dr_running0001', refresh: false });
    const stalled = await mcp.callTool('research_status', { runId: 'dr_stalled0001', refresh: false });
    expect(running.text).toMatch(/running/);
    expect(stalled.text).toMatch(/stalled/);
    // Not merely a different word: the stalled reply must tell you what to do.
    expect(stalled.text).toMatch(/may still recover|research_cancel/i);
  });

  it('reports how long since forward progress, not just the state', async () => {
    const stalled = await mcp.callTool('research_status', { runId: 'dr_stalled0001', refresh: false });
    const minutes = /Last forward progress: (\d+) minute/.exec(stalled.text)?.[1];
    expect(minutes).toBeDefined();
    expect(Number(minutes)).toBeGreaterThan(30);
  });
});

describe('STATE-02: an unknown run', () => {
  it('says so and points at how to find the real one', async () => {
    const result = await mcp.callTool('research_status', { runId: 'dr_nosuchrun01' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/No run/i);
    expect(result.text).toMatch(/research_list/);
  });
});

describe('STATE-03/04: the planning state', () => {
  it('tells a caller with a plan waiting to approve it', async () => {
    const result = await mcp.callTool('research_status', { runId: 'dr_planning001', refresh: false });
    expect(result.text).toMatch(/research_approve_plan/);
    // And shows the plan, since reviewing it is the whole point of the state.
    expect(result.text).toContain('Locate the specification');
  });

  it('refuses to approve a run whose plan has not arrived yet', async () => {
    const result = await mcp.callTool('research_approve_plan', { runId: 'dr_planning002' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/no plan yet/i);
    // The refusal must not silently mark it approved.
    const after = await mcp.store.getRun('dr_planning002');
    expect(after?.planApproved).toBe(false);
  });
});

describe('STATE-05: cancelling', () => {
  it('is a no-op on a terminal run rather than an error', async () => {
    const result = await mcp.callTool('research_cancel', { runId: 'dr_cancelled01' });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/already cancelled/i);
  });
});

describe('STATE-06 / READ-07: tools that need a completed run', () => {
  it('research_followup names the state instead of failing opaquely', async () => {
    const result = await mcp.callTool('research_followup', { runId: 'dr_running0001', question: 'why?' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/running/);
  });

  it('research_read explains why there is no report yet', async () => {
    const result = await mcp.callTool('research_read', { runId: 'dr_failed00001' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/failed/i);
  });

  it('research_verify_citations refuses a run with no report', async () => {
    const result = await mcp.callTool('research_verify_citations', { runId: 'dr_running0001' });
    expect(result.isError).toBe(true);
  });
});

describe('TAIL-01/02: journal replay', () => {
  it('replays from a cursor and hands back the next one', async () => {
    const all = await mcp.callTool('research_tail', { runId: 'dr_completed01', refresh: false });
    expect(all.text).toContain('Run started.');
    expect(all.text).toContain('Report ready.');
    const cursor = /Next cursor: `sinceSeq: (\d+)`/.exec(all.text)?.[1];
    expect(cursor).toBe('2');

    const tail = await mcp.callTool('research_tail', { runId: 'dr_completed01', sinceSeq: 1, refresh: false });
    expect(tail.text).not.toContain('Run started.');
    expect(tail.text).toContain('Report ready.');
  });

  it('says there is nothing new rather than returning an empty reply', async () => {
    const result = await mcp.callTool('research_tail', { runId: 'dr_completed01', sinceSeq: 99, refresh: false });
    expect(result.text).toMatch(/No new events/i);
    expect(result.text).toMatch(/Cursor unchanged/i);
  });
});

describe('LIST-01: filtering', () => {
  it('filters by state', async () => {
    const completed = await mcp.callTool('research_list', { state: 'completed' });
    expect(completed.text).toContain('dr_completed01');
    expect(completed.text).not.toContain('dr_failed00001');
  });

  it('filters by tag', async () => {
    const alpha = await mcp.callTool('research_list', { tag: 'alpha' });
    expect(alpha.text).toContain('dr_completed01');
    expect(alpha.text).not.toContain('dr_running0001');
  });

  it('reports an empty result rather than an empty string', async () => {
    const none = await mcp.callTool('research_list', { tag: 'no-such-tag' });
    expect(none.text).toMatch(/No runs match/i);
  });
});

describe('STREAM-01/02: live progress disclosure', () => {
  it('surfaces live counters when the stream has contributed', async () => {
    const result = await mcp.callTool('research_status', { runId: 'dr_streaming01', refresh: false });
    expect(result.text).toMatch(/Live progress/);
    expect(result.text).toMatch(/7 reasoning steps/);
  });

  it('omits the line entirely when there is nothing to report', async () => {
    // Reporting "0 searches" would read as a stalled run rather than a quiet one.
    const result = await mcp.callTool('research_status', { runId: 'dr_running0001', refresh: false });
    expect(result.text).not.toMatch(/Live progress/);
  });

  it('discloses an abandoned stream instead of leaving frozen counters', async () => {
    const result = await mcp.callTool('research_status', { runId: 'dr_abandoned01', refresh: false });
    expect(result.text).toMatch(/stopped moving|could not be re-established/i);
  });
});

describe('START-01 / DEGRADE-01: degraded backend', () => {
  it('corpus tools explain the requirement rather than failing opaquely', async () => {
    const result = await mcp.callTool('corpus_list');
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/GEMINI_API_KEY|Developer API/);
  });

  it('agent tools do the same', async () => {
    const result = await mcp.callTool('agent_list');
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/credential|GEMINI_API_KEY|VERTEX_PROJECT/i);
  });
});
