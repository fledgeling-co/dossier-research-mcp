/**
 * The two refusals this slice can raise, as named error shapes.
 *
 * Both are structural rather than operational: they mean the question being
 * asked cannot be answered correctly, not that answering it failed. A caller
 * that catches one has a design problem to fix, which is why each carries the
 * offending ids or count rather than only a sentence.
 */

/** A member was marked as having seen another member's output. */
export interface CombinationIndependenceError extends Error {
  readonly name: 'CombinationIndependenceError';
  readonly dependentMemberIds: readonly string[];
}

/** The member count is past the point where exactness is affordable. */
export interface ExactnessRefusedError extends Error {
  readonly name: 'ExactnessRefusedError';
  readonly memberCount: number;
  readonly ceiling: number;
}
