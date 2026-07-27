import { describe, expect, it } from 'vitest';
import { memberUrlSet, mergeCombination, UNION_SEMANTICS } from './merge.js';
import type { CombinationMember } from './member.js';
import { member, reportCiting, run } from './fixtures.js';

describe('a combination of one is that member, exactly (COMB-03)', () => {
  it('returns the run markdown byte-identical, with no wrapper and no separator', () => {
    const markdown = '# A report\n\nWith a [source](https://example.com/one) in it.\n';
    const m: CombinationMember = {
      id: 'solo',
      independence: 'independent',
      runs: [run('gemini', [], 1, markdown)],
    };
    const merged = mergeCombination([m]);
    // Byte-identical, not merely equivalent. Any wrapper moves every character
    // offset a scorer reports and changes anything that counts paragraphs.
    expect(merged.markdown).toBe(markdown);
  });

  it('returns the member cited set unchanged, canonicalised and deduplicated', () => {
    const m = member('solo', ['https://example.com/a', 'https://example.com/b']);
    const merged = mergeCombination([m]);
    expect(merged.citedUrls).toEqual([...memberUrlSet(m)]);
  });

  it('separates runs once a member has more than one, so statements cannot run together', () => {
    const m: CombinationMember = {
      id: 'repeated',
      independence: 'independent',
      runs: [run('x', [], 1, 'first'), run('x', [], 1, 'second')],
    };
    const merged = mergeCombination([m]);
    expect(merged.markdown).toContain('first');
    expect(merged.markdown).toContain('second');
    expect(merged.markdown).not.toBe('firstsecond');
  });
});

describe('the union is deduplicated by canonical URL (COMB-09 support)', () => {
  it('counts one page cited three different ways as one source', () => {
    const m = member('solo', [
      'https://example.com/page',
      'https://example.com/page?utm_source=x',
      'https://example.com/page#section',
    ]);
    const merged = mergeCombination([m]);
    expect(merged.citedUrls).toHaveLength(1);
  });

  it('takes the union across members without double-counting a shared page', () => {
    const a = member('a', ['https://example.com/shared', 'https://a.example.com/own']);
    const b = member('b', ['https://example.com/shared', 'https://b.example.com/own']);
    const merged = mergeCombination([a, b]);
    expect(merged.citedUrls).toHaveLength(3);
  });
});

describe('provenance stays per run (COMB-08)', () => {
  it('does not report a shared source as unique when one backend contributed several runs', () => {
    // The defect this guards: keying provenance on the provider name collapses
    // several runs of one backend onto one label, every source then looks
    // unique to that label, and the overlap reads zero however much the runs
    // actually shared. That is the repetition axis, broken.
    const shared = 'https://example.com/everyone-finds-this';
    const m: CombinationMember = {
      id: 'gemini-x2',
      independence: 'independent',
      runs: [
        run('gemini', [shared, 'https://one.example.com/x']),
        run('gemini', [shared, 'https://two.example.com/x']),
      ],
    };
    const merged = mergeCombination([m]);
    const sharedSource = merged.evidence.sources.find((s) => s.url.includes('everyone-finds-this'));
    expect(sharedSource?.citedBy).toHaveLength(2);
    // And the two runs are distinguishable labels, not one.
    expect(new Set(merged.evidence.runs.map((r) => r.runId)).size).toBe(2);
  });
});

describe('cost and semantics ride on the merge (COMB-07, COMB-32)', () => {
  it('sums the members worst cases', () => {
    const merged = mergeCombination([member('a', [], 3), member('b', [], 4.5)]);
    expect(merged.costUsd).toBe(7.5);
  });

  it('carries the union semantics on every result, naming all three directions', () => {
    const merged = mergeCombination([member('a', ['https://example.com/1'])]);
    expect(merged.semantics).toBe(UNION_SEMANTICS);
    expect(merged.semantics).toMatch(/faithful/i);
    expect(merged.semantics).toMatch(/upper bound/i);
    expect(merged.semantics).toMatch(/harshest/i);
  });

  it('records the member ids and the run count', () => {
    const merged = mergeCombination([member('a', []), member('b', [])]);
    expect(merged.memberIds).toEqual(['a', 'b']);
    expect(merged.runCount).toBe(2);
  });
});

describe('the merge refuses a dependent member (COMB-05)', () => {
  it('throws rather than merging', () => {
    expect(() =>
      mergeCombination([
        member('a', []),
        { id: 'b', independence: 'saw-other-members', runs: [] },
      ]),
    ).toThrow(/saw another member/i);
  });
});

describe('memberUrlSet', () => {
  it('unions a member own runs and canonicalises them', () => {
    const m: CombinationMember = {
      id: 'x',
      independence: 'independent',
      runs: [
        run('x', [], 1, reportCiting('one', ['https://example.com/a?utm_source=q'])),
        run('x', [], 1, reportCiting('two', ['https://example.com/a', 'https://example.com/b'])),
      ],
    };
    expect([...memberUrlSet(m)].sort()).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('is empty for a member citing nothing', () => {
    expect(memberUrlSet(member('none', []))).toEqual(new Set());
  });
});
