import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpHarness } from './harness.js';

/**
 * LOOP-01..06: the whole free path, driven over the real protocol.
 *
 * This is the one flow in Dossier that a caller completes without any
 * credentials at all, so it is worth exercising end to end rather than in
 * pieces: start, report findings, freeze, draft, and read the result back as a
 * normal run.
 */

let mcp: McpHarness;

beforeAll(async () => {
  mcp = await McpHarness.create();
}, 60_000);

afterAll(async () => {
  await mcp.dispose();
});

/** Pull the run handle out of a tool response. */
const handleOf = (text: string): string => {
  const id = /`(dr_[a-z0-9]+)`/.exec(text)?.[1];
  if (!id) throw new Error(`no handle in: ${text.slice(0, 200)}`);
  return id;
};

describe('LOOP-01: the loop runs with no credentials and no charge', () => {
  it('plans tasks in the dialect each index expects', async () => {
    const started = await mcp.callTool('research_local_start', {
      question: 'which vector databases support binary quantization',
      archetype: 'technical',
    });
    expect(started.text).toMatch(/site:github\.com/);
    expect(started.text).toMatch(/arxiv/i);
    expect(started.text).toMatch(/Nothing has been charged/);
    expect(handleOf(started.text)).toMatch(/^dr_/);
  });
});

describe('LOOP-02..06: findings, freeze, draft, submit', () => {
  let runId: string;

  beforeAll(async () => {
    const started = await mcp.callTool('research_local_start', {
      question: 'which vector databases support binary quantization',
      archetype: 'technical',
      maxTasks: 2,
    });
    runId = handleOf(started.text);
  });

  it('LOOP-02: deduplicates one page reported by two tasks', async () => {
    const first = await mcp.callTool('research_local_note', {
      runId,
      taskId: 't1',
      findings: [
        { claim: 'Qdrant documents binary quantization', url: 'https://qdrant.tech/documentation/quantization/' },
        { claim: 'Milvus documents it too', url: 'https://milvus.io/docs/quantization.md' },
      ],
    });
    expect(first.text).toMatch(/2 new source\(s\)/);

    const second = await mcp.callTool('research_local_note', {
      runId,
      taskId: 't2',
      // The same page, spelled differently. One source, not two.
      findings: [{ claim: 'A user confirms it', url: 'https://www.qdrant.tech/documentation/quantization/?utm_source=x' }],
    });
    expect(second.text).toMatch(/\*\*0 new source\(s\)\*\*, 1 already in the registry/);
    expect(second.text).toMatch(/Registry now holds \*\*2 source\(s\)\*\*/);
  });

  it('LOOP-03: refuses a task id that is not in the session', async () => {
    const result = await mcp.callTool('research_local_note', {
      runId,
      taskId: 't99',
      findings: [{ claim: 'A claim long enough to pass validation', url: 'https://example.com/a' }],
    });
    expect(result.text).toMatch(/No task `t99`/);
  });

  it('LOOP-04: refuses to submit before the registry is frozen', async () => {
    const result = await mcp.callTool('research_local_submit', {
      runId,
      markdown: '# Report\n\nSomething <cite url="https://qdrant.tech/documentation/quantization/">1</cite>.'.padEnd(150, ' '),
    });
    expect(result.text).toMatch(/has not been frozen/);
  });

  it('LOOP-05: freezing returns the numbered registry and closes it', async () => {
    const frozen = await mcp.callTool('research_local_draft', { runId });
    expect(frozen.text).toMatch(/Registry frozen/);
    expect(frozen.text).toMatch(/1\. https:\/\/qdrant\.tech/);
    expect(frozen.text).toMatch(/Cite ONLY from this|cite ONLY from this/i);

    // And the closure is real: a late finding is refused, not merged.
    const late = await mcp.callTool('research_local_note', {
      runId,
      taskId: 't1',
      findings: [{ claim: 'found this afterwards', url: 'https://late.example.com/x' }],
    });
    expect(late.text).toMatch(/already frozen/);
    expect(late.text).toMatch(/refused/);
  });

  it('LOOP-06: refuses a draft citing a source the loop never gathered', async () => {
    const refused = await mcp.callTool('research_local_submit', {
      runId,
      markdown: [
        '# Binary quantization support',
        '',
        'Qdrant supports it <cite url="https://qdrant.tech/documentation/quantization/">1</cite>.',
        'And so does this other thing <cite url="https://invented.example/whitepaper">2</cite>.',
      ].join('\n'),
    });
    expect(refused.text).toMatch(/Refused/);
    expect(refused.text).toMatch(/invented\.example/);
    // It names the rule rather than just the failure.
    expect(refused.text).toMatch(/cannot be told apart from one invented/);
  });

  it('LOOP-06: accepts a compliant draft and it becomes a normal run', async () => {
    const accepted = await mcp.callTool('research_local_submit', {
      runId,
      markdown: [
        '# Binary quantization support',
        '',
        '## Executive Summary',
        '',
        '- (High Confidence) Qdrant documents it <cite url="https://qdrant.tech/documentation/quantization/">1</cite>.',
        '- (Medium Confidence) Milvus documents it <cite url="https://milvus.io/docs/quantization.md">2</cite>.',
        '',
        '## Detailed Findings',
        '',
        'Both projects ship it. <INFERENCE from="1,2">Support is therefore mainstream rather than niche.</INFERENCE>',
      ].join('\n'),
    });
    expect(accepted.text).toMatch(/Accepted/);
    expect(accepted.text).toMatch(/cost nothing/);
    expect(accepted.text).toMatch(/distinguishes what it read from what it inferred/);

    // The point of the whole design: it reads like any other run afterwards.
    const read = await mcp.callTool('research_read', { runId });
    expect(read.text).toMatch(/Executive Summary/);
    const evidence = await mcp.callTool('research_evidence', { runId });
    expect(evidence.text).toMatch(/Source profile/);
  });

  it('warns when a draft marks nothing as inference', async () => {
    const started = await mcp.callTool('research_local_start', { question: 'a second question entirely', maxTasks: 1 });
    const second = handleOf(started.text);
    await mcp.callTool('research_local_note', {
      runId: second,
      taskId: 't1',
      findings: [{ claim: 'A fact', url: 'https://example.org/a' }],
    });
    await mcp.callTool('research_local_draft', { runId: second });
    const accepted = await mcp.callTool('research_local_submit', {
      runId: second,
      markdown: '# R\n\nA confident conclusion drawn from one page <cite url="https://example.org/a">1</cite>.'.padEnd(
        150,
        ' ',
      ),
    });
    expect(accepted.text).toMatch(/Nothing in the draft is marked as inference/);
  });

  it('explains a missing session rather than erroring opaquely', async () => {
    const result = await mcp.callTool('research_local_draft', { runId: 'dr_nosuchsession' });
    expect(result.text).toMatch(/No local research session/);
  });
});

describe('LOOP-14..15: the loop is honest about what the host can do', () => {
  it('halts without web search, and opens nothing', async () => {
    const halted = await mcp.callTool('research_local_start', {
      question: 'a question nobody can search for',
      have: { webSearch: false },
    });
    expect(halted.text).toMatch(/Halted: no web search/);
    // No handle, because no session was opened. A halted run that left one
    // behind would be found later and mistaken for an abandoned run.
    expect(halted.text).not.toMatch(/`dr_/);
  });

  it('drops every task to scan depth when there is no page fetch', async () => {
    const degraded = await mcp.callTool('research_local_start', {
      question: 'which vector databases support binary quantization',
      archetype: 'technical',
      deep: true,
      have: { webFetch: false },
    });
    expect(degraded.text).toMatch(/Running degraded/);
    expect(degraded.text).toMatch(/snippet/i);
    // `deep: true` asked for full reads; without a fetch tool it cannot have them.
    expect(degraded.text).not.toMatch(/\(deep, group/);
  });
});

describe('LOOP-13, 24, 25, 26: the subagent output contract', () => {
  let runId: string;

  beforeAll(async () => {
    const started = await mcp.callTool('research_local_start', {
      question: 'what is the regulatory position on binary quantization exports',
      archetype: 'technical',
      maxTasks: 5,
      asOf: '2026-07-26',
    });
    runId = handleOf(started.text);
    expect(started.text).toMatch(/Do not read raw search results yourself/);
    expect(started.text).toMatch(/in parallel, and wait for all of them/);
  });

  it('LOOP-25: refuses more than ten findings from one worker', async () => {
    const result = await mcp.callTool('research_local_note', {
      runId,
      taskId: 't1',
      findings: Array.from({ length: 11 }, (_, i) => ({
        claim: `A claim number ${String(i)} that is long enough`,
        url: `https://example.com/${String(i)}`,
      })),
    });
    expect(result.text).toMatch(/10|ten/i);
  });

  it('LOOP-24: refuses an empty report with no gaps statement, and accepts one with', async () => {
    const silent = await mcp.callTool('research_local_note', { runId, taskId: 't1', findings: [] });
    expect(silent.text).toMatch(/gaps/i);

    const stated = await mcp.callTool('research_local_note', {
      runId,
      taskId: 't1',
      findings: [],
      gaps: 'Searched the vendor docs and the changelogs for an export restriction; there is none.',
    });
    expect(stated.text).toMatch(/nothing found/i);
    expect(stated.text).toMatch(/not a gap in the run/);
  });

  it('LOOP-13: refuses a reconciliation task that reports before its dependencies', async () => {
    const early = await mcp.callTool('research_local_note', {
      runId,
      taskId: 'b1',
      findings: [{ claim: 'Something found far too early', url: 'https://example.com/early' }],
    });
    expect(early.text).toMatch(/depends on/);
    expect(early.text).toMatch(/searches the topic again instead of the disagreements/);
  });

  it('LOOP-26: hands the lead the registry and the deep-read notes, never the search results', async () => {
    // Everything else in group A reports, which is what unblocks b1.
    const rest = ['t2', 't3', 't4', 't5'];
    for (const [i, taskId] of rest.entries()) {
      const reply = await mcp.callTool('research_local_note', {
        runId,
        taskId,
        findings: [
          {
            claim: `Task ${taskId} established something`,
            url: `https://source-${String(i)}.example/page`,
            published: '2026-07-01',
          },
        ],
        deepReadNotes: `From ${taskId}: the page concedes its benchmark used a different recall target.`,
      });
      if (taskId === rest.at(-1)) {
        // The last of group A hands over what b1 needs to work against.
        expect(reply.text).toMatch(/Group A is in\. Dispatch `b1` now/);
        expect(reply.text).toMatch(/1\. https:\/\/source-0\.example\/page/);
      }
    }

    await mcp.callTool('research_local_note', {
      runId,
      taskId: 'b1',
      findings: [],
      gaps: 'Searched the two disagreeing figures directly; neither source has been corrected.',
    });

    const frozen = await mcp.callTool('research_local_draft', { runId });
    expect(frozen.text).toMatch(/Deep-read notes/);
    expect(frozen.text).toMatch(/different recall target/);
    // Refused sources are shown and stated to be final.
    expect(frozen.text).toMatch(/As of 2026-07-26/);
    // A task that ran and found nothing is not reported as one that never ran.
    expect(frozen.text).toMatch(/Searched and found nothing: t1, b1/);
    expect(frozen.text).toMatch(/Every task reported/);
  });
});

describe('LOOP-20: an entity with no public footprint', () => {
  it('reports confidence N/A with the failed checks, rather than drafting anyway', async () => {
    const started = await mcp.callTool('research_local_start', {
      question: 'what does Fnordlebeam Pty Ltd of Wagga Wagga actually do',
      maxTasks: 2,
      mode: 'light',
    });
    const runId = handleOf(started.text);
    await mcp.callTool('research_local_note', {
      runId,
      taskId: 't1',
      findings: [],
      gaps: 'Searched the company register, the news archives and the trade press. No entity by that name.',
    });
    await mcp.callTool('research_local_note', {
      runId,
      taskId: 't2',
      findings: [],
      gaps: 'Searched the forums and the review sites. Nothing.',
    });

    const frozen = await mcp.callTool('research_local_draft', { runId });
    expect(frozen.text).toMatch(/Unable to verify anything about this subject/);
    expect(frozen.text).toMatch(/Confidence: N\/A/);
    expect(frozen.text).toMatch(/Searched the company register/);
    expect(frozen.text).toMatch(/direct contact/i);
    // And it does not hand over drafting rules for a report there is no evidence for.
    expect(frozen.text).not.toMatch(/Drafting rules/);
  });
});

describe('LOOP-31..35: a search that failed is not a search that found nothing', () => {
  let runId: string;

  beforeAll(async () => {
    const started = await mcp.callTool('research_local_start', {
      question: 'what does Fnordlebeam Pty Ltd of Wagga Wagga actually do',
      maxTasks: 2,
      mode: 'light',
      asOf: '2026-07-26',
    });
    runId = handleOf(started.text);
  });

  it('LOOP-33: still demands a gaps statement when the search failed', async () => {
    const silent = await mcp.callTool('research_local_note', {
      runId,
      taskId: 't1',
      findings: [],
      outcome: 'rate-limited',
    });
    expect(silent.text).toMatch(/gaps/i);
  });

  it('LOOP-35: refuses `no-results` reported alongside findings', async () => {
    const contradictory = await mcp.callTool('research_local_note', {
      runId,
      taskId: 't1',
      findings: [{ claim: 'The register lists an entity of that name', url: 'https://abr.example/1' }],
      outcome: 'no-results',
    });
    expect(contradictory.text).toMatch(/cannot come with findings/);
  });

  it('LOOP-31, 32: names the failed search at draft time and does not call the run a black box', async () => {
    const failed = await mcp.callTool('research_local_note', {
      runId,
      taskId: 't1',
      findings: [],
      gaps: 'Tried the company register three times. Every attempt came back throttled.',
      outcome: 'rate-limited',
    });
    expect(failed.text).toMatch(/unchecked rather than empty/i);
    expect(failed.text).toMatch(/must not be written up as an established negative/i);

    await mcp.callTool('research_local_note', {
      runId,
      taskId: 't2',
      findings: [],
      gaps: 'Searched the forums and the review sites. Nothing.',
      outcome: 'no-results',
    });

    const frozen = await mcp.callTool('research_local_draft', { runId });
    // LOOP-31: the failure is named, with its reason, and fenced off.
    expect(frozen.text).toMatch(/could not complete their search/i);
    expect(frozen.text).toMatch(/rate-limited/);
    expect(frozen.text).toMatch(/never fully queried/);
    expect(frozen.text).toMatch(/Do not write these up as established negatives/);
    // LOOP-32: the clean empty search still counts as an established negative.
    expect(frozen.text).toMatch(/Searched and found nothing: t2/);
    // LOOP-30/32: an empty registry with a failed search is not the black box.
    expect(frozen.text).not.toMatch(/Unable to verify anything about this subject/);
    expect(frozen.text).toMatch(/Drafting rules/);
  });
});
