import { canonicaliseUrl } from '../../../src/research/corroborate.js';

/**
 * When two members have read the same page.
 *
 * `canonicaliseUrl` does nearly all of the work: tracking parameters, `www.`, a
 * trailing slash and a fragment all collapse. It deliberately **preserves the
 * scheme**, and that is right for the job it exists to do, which is counting
 * independent sources for corroboration, where `http` and `https` are two
 * strings it has no business equating.
 *
 * It is wrong for this job. Pairwise source overlap asks whether two members
 * read the same *document*, and a member citing the `http` form of a page
 * another cited as `https` has plainly read the same page. Left unfolded, the
 * pair reports no overlap at all, which understates the one number the brief
 * calls the money question and does so in the direction that flatters a
 * combination: it makes members look more independent than they are.
 *
 * The fold is layered here rather than pushed into the product's function, for
 * the reason `bench/src/score/due-weight/index.ts` already gives for the
 * identical decision: a benchmark that edits the behaviour it is measuring to
 * make its own numbers nicer has stopped being a benchmark.
 *
 * **This is the second copy of that fold in `bench/`.** The first is
 * `sourceIdentity` in `bench/src/score/due-weight/index.ts`, which is private to
 * that module. Two implementations of one rule eventually disagree about what
 * the rule is, so they should be unified into one exported helper; that is a
 * restructure of another merged item's file and is recorded rather than done
 * here. **No test pins the two together**, contrary to what this comment said
 * until a cross-slice audit checked for one. They are byte-identical today and
 * that is the whole of the guarantee; BENCH-15 owns unifying them.
 */
export function sourceIdentity(raw: string): string {
  return canonicaliseUrl(raw).replace(/^http:\/\//i, 'https://');
}
