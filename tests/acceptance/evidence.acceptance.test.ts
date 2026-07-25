import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpHarness, makeRun, REPORT_FIXTURES } from './harness.js';

/**
 * EVID-01..05.
 *
 * `research_evidence` is free and needs no credentials, so the whole profiling
 * path is exercised here end to end. The two paid tools are covered for their
 * guard clauses only: what matters before any money moves is that they refuse
 * clearly when they cannot do the job, and that their descriptions say they
 * cost something.
 */

let mcp: McpHarness;

const RUN = 'dr_evid00000001';
const CONCENTRATED = 'dr_evid00000002';

/** One organisation cited through three of its own pages. */
const ONE_VOICE = [
  '# Market position',
  '',
  'Revenue grew 40% <cite url="https://vendor.com/press/2026">1</cite>.',
  'The CEO confirmed it <cite url="https://blog.vendor.com/ceo-note">2</cite>.',
  'Their FAQ repeats it <cite url="https://www.vendor.com/faq?utm_source=x">3</cite>.',
  'An analyst wrote it up <cite url="https://www.g2.com/products/vendor">4</cite>.',
].join('\n');

beforeAll(async () => {
  mcp = await McpHarness.create();
  await mcp.store.saveRun(makeRun({ id: RUN, state: 'completed' }));
  await mcp.store.saveReport(RUN, REPORT_FIXTURES.realistic);
  await mcp.store.saveRun(makeRun({ id: CONCENTRATED, state: 'completed' }));
  await mcp.store.saveReport(CONCENTRATED, ONE_VOICE);
}, 60_000);

afterAll(async () => {
  await mcp.dispose();
});

describe('EVID-01: profiling a report costs nothing and needs no credentials', () => {
  it('classifies the sources and measures them against the floors', async () => {
    const result = await mcp.callTool('research_evidence', { runId: RUN });
    expect(result.text).toMatch(/Source profile/);
    expect(result.text).toMatch(/Distinct domains/);
    expect(result.text).toMatch(/Largest single domain/);
  });

  it('names a failed floor as advisory rather than as a verdict on the report', async () => {
    const result = await mcp.callTool('research_evidence', { runId: RUN });
    expect(result.text).toMatch(/advisory/i);
    // The decisive part: it profiles and returns, it does not withhold.
    expect(result.text).not.toMatch(/refus/i);
  });
});

describe('EVID-02: one organisation wearing several hats is visible', () => {
  it('collapses a vendor’s own pages into one domain', async () => {
    const result = await mcp.callTool('research_evidence', { runId: CONCENTRATED, registry: true });
    // press, blog and www are one source, not three.
    expect(result.text).toMatch(/Largest single domain \| 75%/);
    expect(result.text).toMatch(/secondary-industry: 1/);
  });
});

describe('EVID-03: the registry is numbered and deduplicated', () => {
  it('returns it only when asked, and numbers it from one', async () => {
    const without = await mcp.callTool('research_evidence', { runId: CONCENTRATED });
    expect(without.text).toMatch(/source\(s\) in the registry/);
    const with_ = await mcp.callTool('research_evidence', { runId: CONCENTRATED, registry: true });
    expect(with_.text).toMatch(/Citation registry/);
    expect(with_.text).toMatch(/1\. https:\/\/vendor\.com\/press\/2026/);
  });
});

describe('EVID-04: the search trace records what was asked', () => {
  it('reports the backend and refuses to promise reproducibility', async () => {
    const result = await mcp.callTool('research_evidence', { runId: RUN });
    expect(result.text).toMatch(/Search trace/);
    expect(result.text).toMatch(/Backend: gemini/);
    expect(result.text).toMatch(/not guaranteed to reproduce/);
  });
});

describe('EVID-05: the paid checks refuse clearly before they spend', () => {
  it('offers to let the caller do the judging rather than demanding a key', async () => {
    // It used to refuse without GEMINI_API_KEY. Fetching safely and holding the
    // sample is what a server is for; reading a page is what the caller is for,
    // so a missing key is a different division of labour, not a dead end.
    const result = await mcp.callTool('research_verify_claims', { runId: RUN });
    expect(result.text).toMatch(/you do the judging/i);
    expect(result.text).not.toMatch(/needs a utility model/);
  });

  it('says the same for counter-review', async () => {
    const result = await mcp.callTool('research_counter_review', { runId: RUN });
    expect(result.text).toMatch(/you run the lenses/i);
    expect(result.text).toMatch(/REFUTE/);
  });

  it('explains a missing report by state rather than erroring opaquely', async () => {
    const id = 'dr_evid00000003';
    await mcp.store.saveRun(makeRun({ id, state: 'running', reportPath: undefined }));
    const result = await mcp.callTool('research_evidence', { runId: id });
    expect(result.text).toMatch(/No report for/);
  });

  it('annotates the paid ones as not read-only, and the free one as read-only', async () => {
    const tools = await mcp.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('research_verify_claims')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('research_counter_review')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('research_evidence')?.annotations?.readOnlyHint).toBe(true);
    // It no longer spends money unconditionally, so the description must say
    // both halves: free when you judge, billed when a model does.
    const verify = byName.get('research_verify_claims')?.description ?? '';
    expect(verify).toMatch(/free/i);
    expect(verify).toMatch(/spends money/i);
  });
});

describe('IMPORT-01: a report from elsewhere becomes a normal run', () => {
  it('stores pasted markdown and charges nothing', async () => {
    const result = await mcp.callTool('research_import', {
      question: 'Which vector database has the lowest p99?',
      markdown:
        '# Latency\n\n## Executive Summary\n\n- (High Confidence) Qdrant leads <cite url="https://qdrant.tech/benchmarks/">1</cite>.\n',
      label: 'from my Gemini subscription',
    });
    expect(result.text).toMatch(/Imported/);
    expect(result.text).toMatch(/Charged: \*\*nothing\*\*/);
    const handle = /`(dr_[a-z0-9]+)`/.exec(result.text)?.[1];
    expect(handle).toBeDefined();

    // The point of the feature: it behaves like any other run afterwards.
    const read = await mcp.callTool('research_read', { runId: handle });
    expect(read.text).toMatch(/Executive Summary/);
    const evidence = await mcp.callTool('research_evidence', { runId: handle });
    expect(evidence.text).toMatch(/Source profile/);
  });

  it('refuses both a url and markdown, and neither', async () => {
    const both = await mcp.callTool('research_import', {
      question: 'which one leads?',
      url: 'https://example.com/share/x',
      markdown: 'x'.repeat(60),
    });
    expect(both.text).toMatch(/Exactly one/);
    const neither = await mcp.callTool('research_import', { question: 'which one leads?' });
    expect(neither.text).toMatch(/Exactly one/);
  });

  it('warns when the imported text cites nothing', async () => {
    const result = await mcp.callTool('research_import', {
      question: 'which one leads?',
      markdown: '# A confident report\n\nMany assertions, no sources whatsoever. '.repeat(4),
    });
    expect(result.text).toMatch(/No citations were found/);
  });

  it('does not charge the budget for an import', async () => {
    const before = await mcp.callTool('research_budget');
    await mcp.callTool('research_import', {
      question: 'which one leads?',
      markdown: '# R\n\nA claim <cite url="https://example.org/a">1</cite>.\n'.padEnd(200, ' '),
    });
    const after = await mcp.callTool('research_budget');
    const committed = (text: string) => /Committed: \*\*\$([\d.]+)\*\*/.exec(text)?.[1];
    expect(committed(after.text)).toBe(committed(before.text));
  });
});

describe('EVID-06: the checking tools work with no key at all', () => {
  // The whole argument for this server is that the calling assistant can do the
  // thinking. These two were the last tools that disagreed, and the harness runs
  // hermetic with every credential blank, so this is the real no-key path.
  let runId: string;

  beforeAll(async () => {
    const started = await mcp.callTool('research_local_start', {
      question: 'binary quantization support in vector databases',
      maxTasks: 1,
    });
    runId = /`(dr_[a-z0-9]+)`/.exec(started.text)?.[1] ?? '';
    await mcp.callTool('research_local_note', {
      runId,
      taskId: 't1',
      findings: [{ claim: 'Qdrant documents binary quantization', url: 'https://qdrant.tech/documentation/' }],
    });
    await mcp.callTool('research_local_draft', { runId });
    await mcp.callTool('research_local_submit', {
      runId,
      markdown:
        '# BQ\n\n## Executive Summary\n\n- Qdrant documents it <cite url="https://qdrant.tech/documentation/">1</cite>.\n',
    });
  }, 60_000);

  it('offers the caller path instead of demanding a credential', async () => {
    const result = await mcp.callTool('research_verify_claims', { runId });
    expect(result.text).toMatch(/you do the judging/i);
    expect(result.text).toMatch(/research_verify_claims \{ runId/);
  });

  it('refuses a verdict on a claim it never fetched', async () => {
    // The reason the sample is held server-side. A verdict on a page nobody
    // opened is the same defect as a report citing a source it never read.
    const result = await mcp.callTool('research_verify_claims', {
      runId,
      verdicts: [{ n: 99, verdict: 'supports' }],
    });
    expect(result.text).toMatch(/No claim sample is held|never fetched/);
  });

  it('hands over four lens briefs, each told to refute', async () => {
    const result = await mcp.callTool('research_counter_review', { runId });
    expect(result.text).toMatch(/REFUTE/);
    for (const lens of ['claim validator', 'source diversity', 'recency', 'contradiction']) {
      expect(result.text, lens).toContain(lens);
    }
  });

  it('applies the coverage rule to caller-supplied findings', async () => {
    const result = await mcp.callTool('research_counter_review', {
      runId,
      findings: [
        { lens: 'claim validator', checked: 'every cited claim against its source', issues: [] },
        { lens: 'source diversity', checked: 'domain concentration across the registry', issues: [] },
        { lens: 'recency', checked: 'publication dates on every citation', issues: [] },
        { lens: 'contradiction', checked: 'the summary against the body', issues: [] },
      ],
    });
    // Four adversarial passes finding nothing is a failed review, not a pass,
    // and that rule has to hold whoever did the reviewing.
    expect(result.text).toMatch(/failed review/i);
  });

  it('names the lenses that were never applied', async () => {
    const result = await mcp.callTool('research_counter_review', {
      runId,
      findings: [{ lens: 'recency', checked: 'publication dates across the report', issues: [] }],
    });
    expect(result.text).toMatch(/Not run: claim validator/);
    expect(result.text).toMatch(/never applied is not a lens that found nothing/);
  });
});
