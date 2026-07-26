import { describe, expect, it } from 'vitest';
import {
  decompose,
  dispatchWaves,
  MAX_CONCURRENT_TASKS,
  renderDispatch,
  renderTasks,
  topicOf,
} from '../src/research/decompose.js';
import { assessStaleness } from '../src/research/evidence.js';
import {
  assessCapabilities,
  freezeRegistry,
  HostCapabilitiesSchema,
  mergeFindings,
  renderBlackBox,
  renderCapabilities,
  renderCoverageFailures,
  renderDeepNotes,
  renderRefusals,
  renderRegistry,
  renderStaleness,
  SessionSchema,
  validateDraft,
  type HostCapabilities,
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

// Built through the schema rather than as a literal, so every default is
// exercised on the way in. That is not incidental: sessions persisted before
// task groups and staleness existed read back through exactly this path, and a
// literal would have hidden a missing `.default()` until a real one failed.
const session = (over: Partial<Session> = {}): Session =>
  SessionSchema.parse({
    runId: 'dr_loop00000001',
    question: 'which vector databases support binary quantization',
    createdAt: '2026-07-25T00:00:00.000Z',
    tasks: [
      { id: 't1', sourceClass: 'official-docs', depth: 'deep', objective: 'docs' },
      { id: 't2', sourceClass: 'community', depth: 'scan', objective: 'community' },
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

describe('the draft check sees every citation form', () => {
  const gathered = (): Session =>
    freezeRegistry(mergeFindings(session(), 't1', [finding('https://a.com/1')]).session).session;

  it('catches a CommonMark autolink to a source that was never gathered', () => {
    // `<https://invented.example>` is an ordinary citation and was excluded by
    // the bare-URL guard, so it slipped past the one check the whole loop
    // exists to perform.
    const verdict = validateDraft(gathered(), 'A claim <https://invented.example/paper> supports it.');
    expect(verdict.ok).toBe(false);
    expect(verdict.unregistered).toContain('https://invented.example/paper');
  });

  it('accepts an autolink to a source that WAS gathered', () => {
    expect(validateDraft(gathered(), 'A claim <https://a.com/1> supports it.').ok).toBe(true);
  });
});

// ─────────────────────────────────────────── task groups and dispatch ────

describe('tasks are planned in dependency groups', () => {
  const many = () => decompose('vector database binary quantization', { archetype: 'technical', maxTasks: 5 });

  it('makes the first wave independent and the reconciler depend on all of it', () => {
    // LOOP-10. Group A tasks that waited on each other would serialise the one
    // part of the run that is worth parallelising.
    const tasks = many();
    const a = tasks.filter((t) => t.group === 'A');
    const b = tasks.filter((t) => t.group === 'B');
    expect(a.every((t) => t.dependsOn.length === 0)).toBe(true);
    expect(b).toHaveLength(1);
    expect(b[0]?.dependsOn).toEqual(a.map((t) => t.id));
  });

  it('caps a wave at three and gives group B its own', () => {
    // LOOP-11. Above three concurrent workers the host's own rate limits start
    // returning partial result sets, and a partial result set reads exactly
    // like a thin topic.
    const waves = dispatchWaves(many());
    expect(waves.every((w) => w.length <= MAX_CONCURRENT_TASKS)).toBe(true);
    expect(waves.at(-1)?.every((t) => t.group === 'B')).toBe(true);
    const rendered = renderDispatch(many());
    expect(rendered).toMatch(/in parallel, and wait for all of them/);
    expect(rendered).toMatch(/After every group A task has reported/);
  });

  it('suppresses reconciliation below three tasks and in light mode', () => {
    // LOOP-12. Two sources cannot contradict each other interestingly, and a
    // light run is deliberately not paying for a second pass.
    const two = decompose('vector databases', { archetype: 'technical', maxTasks: 2 });
    expect(two.some((t) => t.group === 'B')).toBe(false);
    const light = decompose('vector databases', { archetype: 'technical', maxTasks: 5, reconcile: false });
    expect(light.some((t) => t.group === 'B')).toBe(false);
  });

  it('forces every task to scan when the host cannot fetch a page', () => {
    // LOOP-15. The reconciliation task sets its own depth, so a caller applying
    // this afterwards would leave b1 telling a worker to read pages in full on a
    // host that cannot open one.
    const tasks = decompose('vector databases', { archetype: 'technical', maxTasks: 5, deep: true, scanOnly: true });
    expect(tasks.every((t) => t.depth === 'scan')).toBe(true);
    expect(tasks.some((t) => t.group === 'B')).toBe(true);
  });

  it('states the depth per task, so a scan is never written up as a deep read', () => {
    const rendered = renderTasks(decompose('vector databases', { archetype: 'technical', maxTasks: 5 }));
    expect(rendered).toMatch(/group A/);
    expect(rendered).toMatch(/Read in full|Snippets are enough/);
  });
});

// ──────────────────────────────────────────────── capability gates ────

describe('the loop refuses to run on a host that cannot search', () => {
  const caps = (over: Partial<HostCapabilities> = {}) => HostCapabilitiesSchema.parse(over);

  it('halts without web search', () => {
    // LOOP-14. The failure this prevents is the worst output in the design: a
    // fluent report written from the model's own memory with citations on it.
    const verdict = assessCapabilities(caps({ webSearch: false }));
    expect(verdict.halt).toBe(true);
    expect(renderCapabilities(verdict)).toMatch(/Halted: no web search/);
  });

  it('drops to scan depth without page fetch, and says what that costs', () => {
    // LOOP-15.
    const verdict = assessCapabilities(caps({ webFetch: false }));
    expect(verdict.halt).toBe(false);
    expect(verdict.forceScan).toBe(true);
    expect(renderCapabilities(verdict)).toMatch(/snippet/i);
  });

  it('degrades loudly rather than silently', () => {
    // LOOP-16. A fallback nobody is told about is a product failure wearing a
    // success: the run completes and the reason it is thin is invisible.
    const verdict = assessCapabilities(caps({ subagents: false, filesystem: false }));
    expect(verdict.degradations).toHaveLength(2);
    expect(renderCapabilities(verdict)).toMatch(/Running degraded/);
  });

  it('says nothing when nothing is missing', () => {
    expect(renderCapabilities(assessCapabilities(caps()))).toBe('');
  });
});

// ─────────────────────────────────────────────────────── staleness ────

describe('age is assessed against the as-of date, by source type', () => {
  it('flags a source past its horizon and leaves a fresh one alone', () => {
    // LOOP-17.
    expect(assessStaleness('2019-01-01', '2026-07-26', 'journalism').freshness).toBe('stale');
    expect(assessStaleness('2026-07-01', '2026-07-26', 'journalism').freshness).toBe('fresh');
  });

  it('holds a paper and a news page to different horizons', () => {
    // LOOP-18. A 2019 randomised trial is ordinary evidence; a 2019 pricing
    // page is fiction. One global number gets one of those two wrong.
    expect(assessStaleness('2025-01-01', '2026-07-26', 'academic').freshness).toBe('fresh');
    expect(assessStaleness('2025-01-01', '2026-07-26', 'journalism').freshness).toBe('stale');
  });

  it('separates undated from current', () => {
    // LOOP-17. Undated is unassessable, which is not the same as recent.
    expect(assessStaleness(undefined, '2026-07-26', 'official').freshness).toBe('undated');
    expect(assessStaleness('sometime last year', '2026-07-26', 'official').freshness).toBe('undated');
  });

  it('flags a date after the horizon rather than reading it as very fresh', () => {
    // LOOP-19. A source dated past the as-of date is either mis-parsed or the
    // horizon is wrong, and both are worth saying out loud.
    expect(assessStaleness('2027-01-01', '2026-07-26', 'journalism').freshness).toBe('after-horizon');
  });

  it('reports staleness against the registry numbers at freeze time', () => {
    let s = session({ asOf: '2026-07-26' });
    s = mergeFindings(s, 't1', [
      { claim: 'Old news', url: 'https://news.example/a', published: '2019-01-01' },
      { claim: 'No date at all', url: 'https://news.example/b' },
    ]).session;
    const frozen = freezeRegistry(s);
    expect(frozen.stale.map((e) => e.n)).toEqual([1]);
    expect(frozen.undated).toBe(1);
    expect(renderStaleness(frozen)).toMatch(/Undated is not current/);
  });
});

// ─────────────────────────────────────────────── the information black box ────

describe('an empty run is told apart from an empty world', () => {
  const bothReported = () => {
    let s = session();
    s = mergeFindings(s, 't1', [], { gaps: 'searched the registry and the filings, no entity' }).session;
    s = mergeFindings(s, 't2', [], { gaps: 'searched the forums, nothing' }).session;
    return s;
  };

  it('reports confidence N/A and enumerates the failed checks', () => {
    // LOOP-20. Asked about an entity with no public record, a research loop
    // will otherwise produce a confident report assembled from a domain
    // registration and inference, every sentence of it unfalsifiable.
    const frozen = freezeRegistry(bothReported());
    expect(frozen.blackBox).toBe(true);
    const rendered = renderBlackBox(frozen);
    expect(rendered).toMatch(/Confidence: N\/A/);
    expect(rendered).toMatch(/searched the forums, nothing/);
    expect(rendered).toMatch(/direct contact/i);
  });

  it('never calls an unfinished run a black box', () => {
    // LOOP-21. A run where half the tasks were never dispatched is not a
    // finding about the world.
    const s = mergeFindings(session(), 't1', [], { gaps: 'nothing' }).session;
    expect(freezeRegistry(s).blackBox).toBe(false);
  });

  it('separates a task that searched and found nothing from one that never ran', () => {
    // LOOP-22. Collapsing the two turns a real negative result into an
    // apparent oversight.
    const s = mergeFindings(session(), 't1', [], { gaps: 'nothing there' }).session;
    const frozen = freezeRegistry(s);
    expect(frozen.nothingFoundTasks).toEqual(['t1']);
    expect(frozen.silentTasks).toEqual(['t2']);
  });

  it('does not call a task empty once it has found something', () => {
    let s = mergeFindings(session(), 't1', [], { gaps: 'nothing yet' }).session;
    s = mergeFindings(s, 't1', [finding('https://a.com/1')]).session;
    expect(freezeRegistry(s).nothingFoundTasks).toEqual([]);
  });
});

// ────────────────────────── absence of evidence versus absence of search ────

/**
 * The distinction `last30days-skill` records per source and Dossier previously
 * did not: an empty result from a search that ran is a finding, and an empty
 * result from a search that failed is nothing at all. They arrive in the same
 * shape and only the worker knows which one it was.
 */
describe('a failed search is not a negative result', () => {
  const failed = (outcome: 'rate-limited' | 'blocked' | 'tool-failed') =>
    mergeFindings(session(), 't1', [], { gaps: 'the tool gave up', outcome }).session;

  it('does not count a rate-limited task as having found nothing', () => {
    // LOOP-29. The boolean this replaces set `nothingFound` on any empty
    // report, so a task that never queried the index looked identical to one
    // that queried it properly and established the absence.
    const frozen = freezeRegistry(failed('rate-limited'));
    expect(frozen.nothingFoundTasks).toEqual([]);
    expect(frozen.coverageFailedTasks).toEqual([{ id: 't1', outcome: 'rate-limited' }]);
  });

  it('refuses to call an empty registry a black box when a search failed', () => {
    // LOOP-30. The black box asserts there is no public record. Asserting it
    // off the back of a search that never completed is the exact error the
    // black box exists to prevent, arriving through the back door.
    let s = failed('blocked');
    s = mergeFindings(s, 't2', [], { gaps: 'searched the forums, nothing' }).session;
    const frozen = freezeRegistry(s);
    expect(frozen.session.registry).toHaveLength(0);
    expect(frozen.silentTasks).toEqual([]);
    expect(frozen.blackBox).toBe(false);
  });

  it('names the failure at draft time and says it is not an established negative', () => {
    // LOOP-31. A gap the lead cannot see is a gap the lead writes over.
    const rendered = renderCoverageFailures(freezeRegistry(failed('tool-failed')));
    expect(rendered).toMatch(/unchecked, not empty/i);
    expect(rendered).toMatch(/tool-failed/);
    expect(rendered).toMatch(/the search tool itself failed/);
    expect(rendered).toMatch(/established negatives/i);
    expect(renderCoverageFailures(freezeRegistry(session()))).toBe('');
  });

  it('still treats a clean empty search as coverage, and still reaches the black box', () => {
    // LOOP-32. The point of the vocabulary is that one of the empty states is
    // real. Losing that would trade one wrong output for another.
    let s = mergeFindings(session(), 't1', [], { gaps: 'no filings exist', outcome: 'no-results' }).session;
    s = mergeFindings(s, 't2', [], { gaps: 'no forum threads', outcome: 'no-results' }).session;
    const frozen = freezeRegistry(s);
    expect(frozen.nothingFoundTasks).toEqual(['t1', 't2']);
    expect(frozen.coverageFailedTasks).toEqual([]);
    expect(frozen.blackBox).toBe(true);
    expect(renderCoverageFailures(frozen)).toBe('');
  });

  it('keeps the findings a task got before its search failed, and still calls coverage incomplete', () => {
    // LOOP-34. The `partial` case. A worker that got three findings and was
    // then rate-limited has real findings and incomplete coverage, and a design
    // that forces a choice between them throws away one or the other.
    let s = mergeFindings(session(), 't1', [finding('https://a.com/1')]).session;
    s = mergeFindings(s, 't1', [finding('https://b.com/2')], { outcome: 'rate-limited' }).session;
    const frozen = freezeRegistry(s);
    expect(frozen.session.registry).toHaveLength(2);
    expect(frozen.session.tasks[0]?.findings).toBe(2);
    expect(frozen.coverageFailedTasks).toEqual([{ id: 't1', outcome: 'rate-limited' }]);
    // A successful rerun clears it, which is the whole point of being told to
    // rerun. The failure is a fact about the last attempt, not a permanent mark.
    const after = mergeFindings(s, 't1', [finding('https://c.com/3')]).session;
    expect(after.tasks[0]?.outcome).toBe('ok');
    expect(freezeRegistry(after).coverageFailedTasks).toEqual([]);
  });
});

// ──────────────────────────────────────── finality, notes and modes ────

describe('what the lead is handed at drafting time', () => {
  it('shows the refused sources and says they are final', () => {
    // LOOP-23. Finality is only worth having if it is visible.
    const frozen = freezeRegistry(session()).session;
    const after = mergeFindings(frozen, 't1', [finding('https://late.example/x')]).session;
    const rendered = renderRefusals(after);
    expect(rendered).toMatch(/https:\/\/late\.example\/x/);
    expect(rendered).toMatch(/final/i);
    expect(renderRefusals(frozen)).toBe('');
  });

  it('carries a deep task\'s reading notes through to the draft', () => {
    // LOOP-26. The lead never sees a search result, so everything it drafts
    // from has to arrive through the note.
    const s = mergeFindings(session(), 't1', [finding('https://a.com/1')], {
      notes: 'The vendor page concedes the benchmark used a different recall target.',
    }).session;
    expect(renderDeepNotes(s)).toMatch(/different recall target/);
    expect(renderDeepNotes(session())).toBe('');
  });

  it('lowers the floors in light mode rather than failing a proportionate run', () => {
    // LOOP-27.
    const build = (mode: 'standard' | 'light') => {
      let s = session({ mode });
      s = mergeFindings(s, 't1', [
        finding('https://a.gov/1'),
        finding('https://b.gov/2'),
        finding('https://c.com/3'),
        finding('https://d.net/4'),
        finding('https://e.io/5'),
        finding('https://f.dev/6'),
      ]).session;
      return freezeRegistry(s).profile;
    };
    // Six sources across six domains, a third of them official. Proportionate
    // for a narrow question and half of what a standard run expects.
    expect(build('light').allGatesMet).toBe(true);
    expect(build('standard').allGatesMet).toBe(false);
  });

  it('reads back a session persisted before any of this existed', () => {
    // LOOP-28. Every new field carries a default for exactly this path; without
    // one, an in-flight session from the previous version fails to parse and
    // its evidence is unreachable.
    const old = SessionSchema.parse({
      runId: 'dr_loop00000002',
      question: 'q',
      createdAt: '2026-07-01T00:00:00.000Z',
      tasks: [{ id: 't1', sourceClass: 'official-docs', depth: 'deep', objective: 'docs' }],
    });
    expect(old.mode).toBe('standard');
    expect(old.asOf).toBe('');
    expect(old.tasks[0]?.group).toBe('A');
    expect(old.tasks[0]?.dependsOn).toEqual([]);
    expect(old.tasks[0]?.outcome).toBe('ok');
    // And freezing it still works, with the as-of falling back to today.
    expect(() => freezeRegistry(old)).not.toThrow();
  });
});
