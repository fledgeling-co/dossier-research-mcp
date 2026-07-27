import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpHarness, makeRun } from './harness.js';

/**
 * PROTO-01..06, RES-01..02, DEGRADE-02.
 *
 * The protocol surface itself. Everything here is invisible to the unit suite,
 * because these defects live between the code and the client.
 */

let mcp: McpHarness;

beforeAll(async () => {
  mcp = await McpHarness.create();
}, 60_000);

afterAll(async () => {
  await mcp.dispose();
});

/** Tools that spend money or send data somewhere. Kept explicit, not derived. */
// Anything that invokes a model bills, however small. `research_followup` and
// `research_claims` both call the utility model; annotating them read-only told
// callers a paid operation was free to retry.
const SPENDING = [
  'research_start',
  'agent_run',
  'research_followup',
  'research_claims',
  'research_wide',
  'research_recent',
  'research_compare',
  'research_verify_claims',
  'research_counter_review',
  // Merges reports you already paid for, so it is free in caller mode, but it
  // will use the utility model to extract and cross-check claims when one is
  // configured. A tool that can invoke a model is not read-only.
  'research_synthesise',
];
// Imports store a run but buy nothing: whatever produced the report was billed
// wherever it ran. Not read-only (it writes), not spending.
const WRITES_WITHOUT_SPENDING = [
  'research_import',
  'research_local_start',
  'research_local_note',
  'research_local_draft',
  'research_local_submit',
  // Writes files into the caller's project. No model, no network, still a write.
  'research_export',
];
const EGRESS = ['corpus_add_file'];
const READ_ONLY = [
  'research_plan',
  'research_status',
  'research_tail',
  'research_read',
  'research_verify_citations',
  'research_list',
  'research_budget',
  'research_evidence',
  'corpus_list',
  'corpus_local_list',
  'corpus_local_search',
  'agent_list',
];

describe('PROTO-01: every tool registers', () => {
  it('exposes the full documented surface via tools/list', async () => {
    const tools = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'agent_create', 'agent_delete', 'agent_list', 'agent_run',
        'corpus_add_file', 'corpus_create', 'corpus_delete', 'corpus_list',
        'corpus_local_list', 'corpus_local_search',
        'research_approve_plan', 'research_budget', 'research_cancel', 'research_claims',
        'research_compare', 'research_counter_review', 'research_doctor',
        'research_evidence',
      'research_export', 'research_followup', 'research_list', 'research_plan',
        'research_read', 'research_recent', 'research_start', 'research_status',
      'research_synthesise',
        'research_import', 'research_local_draft', 'research_local_note',
        'research_local_start', 'research_local_submit',
        'research_tail', 'research_verify_citations',
        'research_verify_claims', 'research_wide',
      ].sort(),
    );
  });

  it('every tool carries a non-trivial description', async () => {
    // Tool descriptions are the agent's only documentation, so an empty or
    // stub one is a real defect rather than a style nit.
    for (const tool of await mcp.listTools()) {
      expect(tool.description ?? '', tool.name).not.toBe('');
      expect((tool.description ?? '').length, tool.name).toBeGreaterThan(60);
    }
  });
});

describe('PROTO-02: annotations match what the tool actually does', () => {
  it('marks spending and egress tools as not read-only', async () => {
    const tools = await mcp.listTools();
    for (const name of [...SPENDING, ...EGRESS]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations?.['readOnlyHint'], name).toBe(false);
    }
  });

  it('marks genuinely read-only tools as read-only', async () => {
    const tools = await mcp.listTools();
    for (const name of READ_ONLY) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations?.['readOnlyHint'], name).toBe(true);
    }
  });

  it('marks a tool that writes without buying as neither read-only nor spending', async () => {
    // `research_import` stores a run, so it is not read-only; it buys nothing,
    // so claiming it spends money would be the opposite error. Both halves
    // matter: an agent decides whether to retry on exactly this signal.
    const tools = await mcp.listTools();
    for (const name of WRITES_WITHOUT_SPENDING) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations?.['readOnlyHint'], name).toBe(false);
      expect(tool?.description ?? '', name).not.toMatch(/SPENDS MONEY/);
      // The meaning, not one phrasing: an agent reading only the description
      // must be able to tell this is free before it decides whether to retry.
      expect(tool?.description ?? '', name).toMatch(/spends nothing|nothing is charged|nothing will be|\bfree\b/i);
    }
  });

  it('marks the destructive tools destructive', async () => {
    const tools = await mcp.listTools();
    for (const name of ['research_cancel', 'corpus_delete', 'agent_delete']) {
      expect(tools.find((t) => t.name === name)?.annotations?.['destructiveHint'], name).toBe(true);
    }
  });
});

describe('PROTO-03: cost is disclosed where it exists', () => {
  it('research_start says it spends money, in its description', async () => {
    const tools = await mcp.listTools();
    const start = tools.find((t) => t.name === 'research_start');
    expect(start?.description).toMatch(/SPENDS MONEY/i);
    expect(start?.description).toMatch(/\$\d/);
  });

  it('corpus_add_file says the file leaves your machine', async () => {
    const tools = await mcp.listTools();
    const upload = tools.find((t) => t.name === 'corpus_add_file');
    expect(upload?.description).toMatch(/leaves your machine|sends? .*to Google|UPLOAD/i);
  });

  it('research_plan says it is free', async () => {
    const tools = await mcp.listTools();
    expect(tools.find((t) => t.name === 'research_plan')?.description).toMatch(/WITHOUT spending|free/i);
  });
});

describe('PROTO-04: resources and prompts register and are readable', () => {
  it('exposes the documented resources and templates', async () => {
    expect((await mcp.listResources()).map((r) => r.uri).sort()).toEqual([
      'research://budget',
      'research://capabilities',
      'research://runs',
    ]);
    expect((await mcp.listResourceTemplates()).map((r) => r.uriTemplate).sort()).toEqual([
      'research://run/{runId}',
      'research://run/{runId}/citations',
      'research://run/{runId}/report',
    ]);
  });

  it('exposes the documented prompts, and each renders real content', async () => {
    const prompts = (await mcp.listPrompts()).map((p) => p.name).sort();
    expect(prompts.sort()).toEqual(
      ['deep-research-brief', 'gemini-web-session', 'research-red-team', 'research-triage'].sort(),
    );

    // Rendering, not just listing: a prompt that throws on load lists fine.
    const brief = await mcp.getPrompt('deep-research-brief', { need: 'compare two vector databases' });
    expect(brief).toContain('<core_directive>');
    const triage = await mcp.getPrompt('research-triage', { question: 'what is 2+2' });
    expect(triage).toContain('2+2');
    const red = await mcp.getPrompt('research-red-team', { runId: 'dr_x' });
    expect(red).toContain('dr_x');

    // The subscription route: it must hand over a usable brief, and it must
    // state the terms-of-service position rather than burying it. The default
    // mode is the one that touches nothing Google disallows.
    const web = await mcp.getPrompt('gemini-web-session', { question: 'which vector db leads on p99' });
    expect(web).toContain('<core_directive>');
    expect(web).toContain('research_import');
    expect(web).toMatch(/menuitemcheckbox|checkbox, not a button/);
    const automated = await mcp.getPrompt('gemini-web-session', {
      question: 'which vector db leads on p99',
      mode: 'automated',
    });
    expect(automated).toMatch(/robots\.txt/);
    expect(automated).toMatch(/suspension of your Google account/i);
    expect(automated).toMatch(/Never type a password/i);
  });
});

describe('PROTO-05: stdout is the protocol', () => {
  it('emits no non-JSON-RPC output on stdout', async () => {
    // A stray console.log corrupts the stream and the client sees a parse
    // error rather than a message. The harness collects unparseable lines.
    await mcp.callTool('research_budget');
    await mcp.listTools();
    expect(mcp.stdoutNoise).toEqual([]);
  });

  it('writes its start-up diagnostics to stderr instead', async () => {
    expect(mcp.stderr.join('')).toMatch(/dossier|auth:/i);
  });
});

describe('PROTO-06 / DEGRADE-02: usable with no credentials', () => {
  it('serves read-only tools and reports itself degraded', async () => {
    const budget = await mcp.callTool('research_budget');
    expect(budget.isError).toBe(false);

    const caps = JSON.parse(await mcp.readResource('research://capabilities')) as {
      degraded: boolean;
      limitations: string[];
      archetypes: unknown[];
      tiers: unknown[];
    };
    expect(caps.degraded).toBe(true);
    expect(caps.archetypes).toHaveLength(5);
    expect(caps.tiers).toHaveLength(2);
  });

  it('research_start fails cleanly rather than crashing the server', async () => {
    const started = await mcp.callTool('research_start', { question: 'a valid question here' });
    expect(started.isError).toBe(true);
    expect(started.text).toMatch(/credential/i);
    // The decisive part: the server is still alive and answering afterwards.
    expect((await mcp.listTools()).length).toBe(36);
  });
});

describe('RES-01/02: run resources', () => {
  it('returns the record and omits the bulky prompt', async () => {
    const run = makeRun({ id: 'dr_resource001', prompt: 'x'.repeat(6000) });
    await mcp.store.saveRun(run);

    const raw = await mcp.readResource(`research://run/${run.id}`);
    const record = JSON.parse(raw) as Record<string, unknown>;
    expect(record['id']).toBe(run.id);
    // A 6k-character prompt in an index response is the kind of thing that
    // makes a resource unusable; the record reports its size instead.
    expect(record['prompt']).toBeUndefined();
    expect(record['promptChars']).toBe(6000);
  });

  it('explains an unknown run rather than throwing', async () => {
    const raw = await mcp.readResource('research://run/dr_doesnotexist');
    expect(raw).toMatch(/No run|error/i);
  });

  it('says citations are unchecked rather than pretending they passed', async () => {
    const run = makeRun({ id: 'dr_resource002' });
    await mcp.store.saveRun(run);
    const raw = await mcp.readResource(`research://run/${run.id}/citations`);
    const parsed = JSON.parse(raw) as { checked: boolean; hint?: string };
    expect(parsed.checked).toBe(false);
    expect(parsed.hint).toMatch(/research_verify_citations/);
  });
});

describe('PLAN-04: an explicit provider is reported, not just honoured', () => {
  // Shipped in 0.6.0 and reported by a user: research_start honoured
  // `provider` while research_plan showed the routed backend instead, so
  // asking for Gemini and being shown xAI made the argument look ignored. The
  // plan exists to confirm what the run will do; showing a different backend
  // is a lie about the one thing it was called to check.
  it('names the requested backend rather than the routed one', async () => {
    const result = await mcp.callTool('research_plan', {
      question: 'statutory liability provisions for company directors',
      provider: 'gemini',
    });
    const backend = result.text.split('\n').find((l) => l.includes('**Backend**')) ?? '';
    expect(backend).toMatch(/Gemini/);
    expect(backend).toMatch(/you asked for this one/);
  });

  it('still explains its own choice when nothing was requested', async () => {
    const result = await mcp.callTool('research_plan', {
      question: 'statutory liability provisions for company directors',
    });
    const backend = result.text.split('\n').find((l) => l.includes('**Backend**')) ?? '';
    expect(backend).not.toMatch(/you asked for this one/);
  });
});

describe('PANEL-17: research_plan prints the panel before the fingerprint', () => {
  // Hermetic mode reports every provider not-configured, so the panel this
  // harness assembles is always the empty one. That is the point of asserting
  // here: the shape of the section and its position relative to the contract
  // handshake are machine-independent, while membership is not. Membership
  // lives in tests/panel.test.ts against scripted providers.
  it('shows a panel section and a question profile, above the fingerprint', async () => {
    const result = await mcp.callTool('research_plan', {
      question: 'Which vendors shipped an MCP research server since 2025, and what do they charge?',
    });
    const lines = result.text.split('\n');
    const panelAt = lines.findIndex((l) => l.includes('**Panel**'));
    const profileAt = lines.findIndex((l) => l.includes('**Question profile**'));
    const printAt = lines.findIndex((l) => l.includes('**Contract fingerprint**'));

    expect(panelAt).toBeGreaterThanOrEqual(0);
    expect(profileAt).toBeGreaterThan(panelAt);
    // The panel is what the fingerprint is issued over, so it has to be
    // readable before the caller is asked to commit to it.
    expect(printAt).toBeGreaterThan(profileAt);
    expect(lines[profileAt]).toMatch(/enumeration|time-bound|breadth/);
  });

  it('says the panel is empty rather than inventing a member', async () => {
    const result = await mcp.callTool('research_plan', { question: 'Who leads this market?' });
    expect(result.text).toMatch(/\*\*Panel\*\*: empty/);
  });

  it('prints no panel at all when one backend was named', async () => {
    const result = await mcp.callTool('research_plan', {
      question: 'Who leads this market?',
      provider: 'gemini',
    });
    expect(result.text).not.toMatch(/\*\*Panel\*\*/);
  });
});
