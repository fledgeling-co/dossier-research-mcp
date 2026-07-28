/**
 * When two members have read the same page.
 *
 * The fold and its whole reasoning live in `../score/source-identity.ts`, which
 * is the **one** implementation. This file held the first of two copies and the
 * private `sourceIdentity` in `bench/src/score/due-weight/index.ts` held the
 * second; they were byte-identical, nothing pinned them together, and BENCH-15
 * merged them.
 *
 * Re-exported from here rather than repointed at every call site, so this
 * directory's own purity guard still reads a file in its own directory and
 * `merge.ts` keeps the import it already had.
 */
export { sourceIdentity } from '../score/source-identity.js';
