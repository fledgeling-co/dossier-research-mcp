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
