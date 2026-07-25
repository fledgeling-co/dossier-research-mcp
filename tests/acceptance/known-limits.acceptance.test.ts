import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpHarness } from './harness.js';

/**
 * VERTEX-01 and STREAM-03: the gaps that cannot be closed by testing harder,
 * encoded so they stop being tribal knowledge.
 *
 * Two different kinds of gap, handled two different ways:
 *
 * **Vertex** is untestable here for want of a GCP project with
 * `aiplatform.interactions.create`. What IS testable is that the server tells
 * the truth about it, which is the part that was wrong: the docs claimed File
 * Search was the only Vertex trade-off when follow-ups, titles, summaries and
 * claim extraction are all unavailable too. The live test runs only when a
 * project is configured.
 *
 * **Stream buffering** is a fact about the upstream API, not a bug here. A
 * 7.1-minute run delivered nothing until completion. It is written down as an
 * executable note so that if the API starts emitting incrementally, someone
 * notices rather than the docs quietly staying wrong for a year.
 */

let mcp: McpHarness;

beforeAll(async () => {
  mcp = await McpHarness.create({ VERTEX_PROJECT: 'acceptance-fake-project', VERTEX_LOCATION: 'global' });
}, 60_000);

afterAll(async () => {
  await mcp.dispose();
});

describe('VERTEX-01: the server is honest about the Vertex backend', () => {
  it('reports Vertex as the auth mode when a project is configured', async () => {
    const caps = JSON.parse(await mcp.readResource('research://capabilities')) as {
      auth: string;
      limitations: string[];
    };
    expect(caps.auth).toMatch(/Vertex/i);
    expect(caps.auth).toContain('acceptance-fake-project');
    // Never the key itself, under any backend.
    expect(caps.auth).not.toMatch(/AIza|AQ\./);
  });

  it('names every Vertex limitation, not just File Search', async () => {
    // The docs used to claim File Search was the only trade-off. It is not:
    // the Interactions API on Vertex serves agents and specialised media
    // models, not the standard Gemini models a follow-up or a summary needs.
    const caps = JSON.parse(await mcp.readResource('research://capabilities')) as { limitations: string[] };
    const all = caps.limitations.join(' ');
    expect(caps.limitations.length).toBeGreaterThan(1);
    expect(all).toMatch(/[Cc]orpus grounding is unavailable/);
    expect(all).toMatch(/research_followup is unavailable/);
    expect(all).toMatch(/titles, summaries and research_claims/i);
    // And it does not overclaim: the path is unverified, and says so.
    expect(all).toMatch(/not been verified against a live Vertex project/);
  });

  it('prints those limitations at start-up, not only on request', async () => {
    // A caller who never reads the capabilities resource still needs to know.
    expect(mcp.stderr.join('')).toMatch(/NOTE: .*unavailable/);
  });

  it('disables corpus tools rather than letting them fail at the API', async () => {
    const result = await mcp.callTool('corpus_list');
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Developer API|GEMINI_API_KEY/);
  });
});

/**
 * The live Vertex path. Skipped unless a real project is configured, so it is
 * ready the moment someone has one rather than needing to be written then.
 * Run with: DOSSIER_VERTEX_TESTS=1 VERTEX_PROJECT=… (plus ADC).
 */
const VERTEX_LIVE =
  process.env['DOSSIER_VERTEX_TESTS'] === '1' && Boolean(process.env['VERTEX_PROJECT']);

describe.skipIf(!VERTEX_LIVE)('VERTEX-02: the live Vertex backend', () => {
  it('starts a Deep Research run against Vertex', async () => {
    const live = await McpHarness.create({
      DOSSIER_HERMETIC: '',
      VERTEX_PROJECT: process.env['VERTEX_PROJECT'] ?? '',
      VERTEX_LOCATION: process.env['VERTEX_LOCATION'] ?? 'global',
    });
    try {
      const plan = await live.callTool('research_plan', { question: 'A short verification question.' });
      expect(plan.isError).toBe(false);
      const start = await live.callTool('research_start', {
        question: 'A short verification question.',
        tier: 'fast',
      });
      // The open question this answers: do the Deep Research agents route on
      // Vertex at all, given standard models do not?
      expect(start.isError).toBe(false);
      const runId = /`(dr_[a-f0-9]+)`/.exec(start.text)?.[1] ?? '';
      await live.callTool('research_cancel', { runId });
    } finally {
      await live.dispose();
    }
  }, 5 * 60_000);

  it('refuses a follow-up with the reason, rather than a routing error', async () => {
    const live = await McpHarness.create({
      DOSSIER_HERMETIC: '',
      VERTEX_PROJECT: process.env['VERTEX_PROJECT'] ?? '',
    });
    try {
      const result = await live.callTool('research_followup', { runId: 'dr_any', question: 'why?' });
      expect(result.isError).toBe(true);
      expect(result.text).not.toMatch(/routing|404|not found for model/i);
    } finally {
      await live.dispose();
    }
  }, 2 * 60_000);
});

describe('STREAM-03: the documented buffering limitation', () => {
  it('does not promise live mid-run progress in the tail description', async () => {
    // Measured: a 7.1-minute run delivered nothing until completion. If the
    // description ever promises a live feed again without the behaviour
    // changing, this fails and someone re-reads the measurement.
    const tools = await mcp.listTools();
    const tail = tools.find((t) => t.name === 'research_tail');
    expect(tail?.description).toMatch(/lifecycle events|reasoning summaries all land|at the end/i);
    expect(tail?.description).toMatch(/SSE stream|does not consume|not consume/i);
  });

  it('keeps the live-progress fields on the record, ready for when it changes', async () => {
    // The plumbing stays because it is correct and costs nothing. Its absence
    // would be the thing to notice, so assert the shape survives.
    const caps = JSON.parse(await mcp.readResource('research://capabilities')) as Record<string, unknown>;
    expect(caps['features']).toBeDefined();
  });
});
