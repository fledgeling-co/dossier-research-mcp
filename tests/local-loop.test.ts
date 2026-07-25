import { describe, expect, it } from 'vitest';
import { decompose, renderTasks, topicOf } from '../src/research/decompose.js';
import {
  freezeRegistry,
  mergeFindings,
  renderRegistry,
  validateDraft,
  type Session,
} from '../src/research/local-loop.js';

/**
 * The local loop.
 *
 * Two things are worth testing here and they are both about refusal: that the
 * registry deduplicates before it counts, and that a draft cannot cite a source
 * the loop never gathered. The second is the only guarantee in the whole design
 * that a client-side skill could not make, so it gets the most attention.
 */

const session = (over: Partial<Session> = {}): Session => ({
  runId: 'dr_loop00000001',
  question: 'which vector databases support binary quantization',
  createdAt: '2026-07-25T00:00:00.000Z',
  tasks: [
    { id: 't1', sourceClass: 'official-docs', depth: 'deep', objective: 'docs', reported: false, findings: 0 },
    { id: 't2', sourceClass: 'community', depth: 'scan', objective: 'community', reported: false, findings: 0 },
  ],
  registry: [],
  rejectedAfterFreeze: [],
  ...over,
});

const finding = (url: string, claim = 'Something is true') => ({ claim, url });

describe('decomposition routes by source class', () => {
  it('gives each index the query dialect it expects', () => {
    // Searching an academic index the way you search an issue tracker finds
    // nothing, and still returns results, which is why it goes unnoticed.
    const tasks = decompose('which vector databases support binary quantization', { archetype: 'technical' });
    const issues = tasks.find((t) => t.sourceClass === 'issue-tracker');
    const academic = tasks.find((t) => t.sourceClass === 'academic');
    expect(issues?.queries.join(' ')).toContain('site:github.com');
    expect(issues?.queries.join(' ')).toContain('is:issue');
    expect(academic?.queries.join(' ')).toMatch(/arxiv|doi\.org/);
    expect(academic?.queries.join(' ')).not.toContain('is:issue');
  });

  it('picks classes that suit the archetype rather than sweeping all of them', () => {
    // A regulatory question has nothing to gain from an issue tracker, and
    // dispatching one spends a worker on a guaranteed miss.
    const regulatory = decompose('what are the AU privacy obligations', { archetype: 'regulatory' });
    expect(regulatory.map((t) => t.sourceClass)).toContain('filings');
    expect(regulatory.map((t) => t.sourceClass)).not.toContain('issue-tracker');
  });

  it('strips the question down to searchable terms', () => {
    expect(topicOf('What is the best way to do X for our team?')).not.toMatch(/\bwhat\b|\bthe\b|\bour\b/);
    // And never returns nothing, however stop-worded the question is.
    expect(topicOf('what is the best')).not.toBe('');
  });

  it('renders tasks with the role, the queries and a stopping condition', () => {
    const rendered = renderTasks(decompose('vector databases', { archetype: 'technical', maxTasks: 2 }));
    expect(rendered).toMatch(/\*\*You are\*\*/);
    expect(rendered).toMatch(/\*\*Done when\*\*/);
  });
});

describe('the registry deduplicates before it counts', () => {
  it('collapses one page found by three tasks into one source', () => {
    // The arithmetic that otherwise turns one source into three apparent
    // corroborations.
    let s = session();
    s = mergeFindings(s, 't1', [finding('https://vendor.com/docs?utm_source=a')]).session;
    s = mergeFindings(s, 't2', [finding('https://www.vendor.com/docs/', 'A second claim')]).session;
    expect(s.registry).toHaveLength(1);
    expect(s.registry[0]?.claims).toHaveLength(2);
    expect(s.registry[0]?.n).toBe(1);
  });

  it('numbers entries once and never reuses a number', () => {
    let s = session();
    s = mergeFindings(s, 't1', [finding('https://a.com/1'), finding('https://b.org/2')]).session;
    s = mergeFindings(s, 't2', [finding('https://c.net/3')]).session;
    expect(s.registry.map((e) => e.n)).toEqual([1, 2, 3]);
    expect(renderRegistry(s)).toContain('3. https://c.net/3');
  });

  it('marks a task as reported even when it found nothing new', () => {
    let s = session();
    s = mergeFindings(s, 't1', [finding('https://a.com/1')]).session;
    const second = mergeFindings(s, 't2', [finding('https://a.com/1')]);
    expect(second.added).toBe(0);
    expect(second.merged).toBe(1);
    expect(second.session.tasks.find((t) => t.id === 't2')?.reported).toBe(true);
  });
});

describe('freezing names the gaps instead of averaging them away', () => {
  it('reports a task that never reported', () => {
    let s = session();
    s = mergeFindings(s, 't1', [finding('https://a.com/1')]).session;
    const frozen = freezeRegistry(s);
    expect(frozen.silentTasks).toEqual(['t2']);
    expect(frozen.session.frozenAt).toBeDefined();
  });

  it('is idempotent, so a second freeze does not move the timestamp', () => {
    const first = freezeRegistry(session());
    const second = freezeRegistry(first.session);
    expect(second.session.frozenAt).toBe(first.session.frozenAt);
  });

  it('refuses findings submitted after the freeze, and records them', () => {
    // The rule working. A source that appears once drafting has begun cannot be
    // distinguished from one invented to support a sentence already written.
    const frozen = freezeRegistry(session()).session;
    const result = mergeFindings(frozen, 't1', [finding('https://late.com/x')]);
    expect(result.added).toBe(0);
    expect(result.refused).toEqual(['https://late.com/x']);
    expect(result.session.registry).toHaveLength(0);
    expect(result.session.rejectedAfterFreeze).toEqual(['https://late.com/x']);
  });
});

describe('a draft may cite only what was gathered', () => {
  const gathered = (): Session =>
    freezeRegistry(
      mergeFindings(session(), 't1', [finding('https://a.com/1'), finding('https://b.org/2')]).session,
    ).session;

  it('accepts a draft citing registry sources', () => {
    const verdict = validateDraft(gathered(), 'Claim <cite url="https://a.com/1">1</cite>.');
    expect(verdict.ok).toBe(true);
    expect(verdict.citedCount).toBe(1);
    expect(verdict.unused).toEqual([2]);
  });

  it('refuses a draft that cites a source the loop never gathered', () => {
    // The single guarantee a client-side skill cannot make: a plausible-looking
    // reference reached for mid-sentence resolves perfectly and is invented.
    const verdict = validateDraft(
      gathered(),
      'Claim <cite url="https://a.com/1">1</cite>. Another <cite url="https://invented.example/x">2</cite>.',
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.unregistered).toEqual(['https://invented.example/x']);
  });

  it('sees through a re-spelling of a registered URL rather than flagging it', () => {
    const verdict = validateDraft(gathered(), 'Claim <cite url="https://www.a.com/1/?utm_source=x">1</cite>.');
    expect(verdict.ok).toBe(true);
  });

  it('notices whether the draft distinguishes inference from what it read', () => {
    const plain = validateDraft(gathered(), 'A confident conclusion <cite url="https://a.com/1">1</cite>.');
    expect(plain.marksInference).toBe(false);
    const marked = validateDraft(
      gathered(),
      'A conclusion <INFERENCE from="1,2">assembled from both</INFERENCE> <cite url="https://a.com/1">1</cite>.',
    );
    expect(marked.marksInference).toBe(true);
  });

  it('treats unused sources as normal, not as a failure', () => {
    const verdict = validateDraft(gathered(), 'Nothing cited here at all.');
    expect(verdict.ok).toBe(true);
    expect(verdict.unused).toEqual([1, 2]);
  });
});
