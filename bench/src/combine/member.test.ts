import { describe, expect, it } from 'vitest';
import {
  assertIndependentMembers,
  memberCostUsd,
  memberRuns,
  PANEL_INDEPENDENCE_INVARIANT,
  type CombinationMember,
} from './member.js';
import { member, run } from './fixtures.js';

describe('the independence invariant (COMB-05)', () => {
  it('refuses a member marked as having seen another member', () => {
    const members: CombinationMember[] = [
      member('a', ['https://example.com/1']),
      { id: 'b', independence: 'saw-other-members', runs: [run('b', ['https://example.com/2'])] },
    ];
    expect(() => {
      assertIndependentMembers(members);
    }).toThrow(/saw another member/i);
  });

  it('names the offending member and carries the ids on the error', () => {
    const members: CombinationMember[] = [
      member('good', ['https://example.com/1']),
      { id: 'tainted', independence: 'saw-other-members', runs: [] },
    ];
    try {
      assertIndependentMembers(members);
      expect.unreachable('should have refused');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(Error);
      const err = e as Error & { dependentMemberIds?: readonly string[]; name: string };
      expect(err.name).toBe('CombinationIndependenceError');
      expect(err.dependentMemberIds).toEqual(['tainted']);
      expect(err.message).toContain('tainted');
      // The refusal carries the reasoning, not just the verdict: the next
      // person to hit this needs to know why the merge is invalid rather than
      // merely that it was declined.
      expect(err.message).toContain('never sees another');
    }
  });

  it('states the invariant as a value, so it can be asserted rather than skimmed', () => {
    expect(PANEL_INDEPENDENCE_INVARIANT).toMatch(/independent/i);
    expect(PANEL_INDEPENDENCE_INVARIANT).toMatch(/invalid/i);
  });

  it('accepts a set where every member is independent', () => {
    expect(() => {
      assertIndependentMembers([member('a', []), member('b', [])]);
    }).not.toThrow();
  });
});

describe('member ids are subset keys (COMB-06)', () => {
  it('refuses two members sharing an id', () => {
    expect(() => {
      assertIndependentMembers([member('same', []), member('same', [])]);
    }).toThrow(/share the id/i);
  });

  it('says why a duplicate matters rather than only that it is one', () => {
    try {
      assertIndependentMembers([member('same', []), member('same', [])]);
      expect.unreachable('should have refused');
    } catch (e: unknown) {
      expect((e as Error).message).toMatch(/collapses part of the lattice/i);
    }
  });

  it('refuses an empty id', () => {
    expect(() => {
      assertIndependentMembers([{ id: '  ', independence: 'independent', runs: [] }]);
    }).toThrow(/non-empty id/i);
  });
});

describe('cost is the sum of reserved worst cases (COMB-07)', () => {
  it('sums a multi-run member rather than averaging it', () => {
    const m: CombinationMember = {
      id: 'repeated',
      independence: 'independent',
      runs: [run('x', [], 3), run('x', [], 3), run('x', [], 3)],
    };
    // Three runs at $3 is $9 reserved. An average would say $3, which is what
    // the panel would be short by when it actually reserves.
    expect(memberCostUsd(m)).toBe(9);
  });

  it('treats a free lane member as zero rather than as missing', () => {
    expect(memberCostUsd(member('local', ['https://example.com/1'], 0))).toBe(0);
  });

  it('refuses a negative or non-finite cost', () => {
    const bad: CombinationMember = {
      id: 'bad',
      independence: 'independent',
      runs: [run('x', [], -1)],
    };
    expect(() => memberCostUsd(bad)).toThrow(/non-negative finite/i);
    const nan: CombinationMember = {
      id: 'nan',
      independence: 'independent',
      runs: [run('x', [], Number.NaN)],
    };
    expect(() => memberCostUsd(nan)).toThrow(/non-negative finite/i);
  });

  it('is zero for a member with no runs', () => {
    expect(memberCostUsd({ id: 'empty', independence: 'independent', runs: [] })).toBe(0);
  });
});

describe('memberRuns', () => {
  it('flattens in member order then run order', () => {
    const a: CombinationMember = {
      id: 'a',
      independence: 'independent',
      runs: [run('a', []), run('a', [])],
    };
    const b = member('b', []);
    const flat = memberRuns([a, b]);
    expect(flat).toHaveLength(3);
    expect(flat.map((r) => r.provider)).toEqual(['a', 'a', 'b']);
  });
});
