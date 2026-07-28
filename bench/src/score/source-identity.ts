import { canonicaliseUrl } from '../../../src/research/corroborate.js';

/**
 * When two citations name the same document.
 *
 * **One implementation, two callers.** `bench/src/combine/identity.ts` and
 * `bench/src/score/due-weight/index.ts` each wrote this one-line fold, with the
 * same reasoning arrived at twice and no test pinning them together. BENCH-15
 * merged them; both now re-export or import this.
 *
 * `canonicaliseUrl` does nearly all of the work: tracking parameters, a `www.`
 * prefix, a trailing slash and a fragment all collapse. It deliberately
 * **preserves the scheme**, and that is right for the job it exists to do, which
 * is counting independent sources for corroboration, where `http` and `https`
 * are two strings it has no business equating. Measured rather than assumed: it
 * returns `http://example.org/a` and `https://example.org/a` unchanged and
 * distinct.
 *
 * It is wrong for a different question. "Did this member read that page" and
 * "did the report reach that document" are questions about a *document*, and a
 * citation of the `http` form of a page another cited as `https` has plainly
 * reached the same page. Left unfolded, a pair reports no overlap at all, which
 * understates the number `docs/bench/combinations.md` calls the money question,
 * in the direction that flatters a combination.
 *
 * The fold is layered here rather than pushed into the product's function,
 * because a benchmark that edits the behaviour it is measuring to make its own
 * numbers nicer has stopped being a benchmark.
 *
 * ## Where this deliberately does not go, and why that is a decision
 *
 * `bench/src/score/source-quality.ts`, `bench/src/score/citations.ts` and
 * `bench/src/score/matrix.ts` do **not** apply it, and BENCH-15 kept it that
 * way rather than folding everywhere for tidiness.
 *
 * They ask the product's question rather than the document question, and two of
 * them answer it by calling the product's own counter. `scoreSourceQuality`
 * hands its canonical list to `assessSupport`, which is the rule the whole
 * product turns on. Folding there would make the benchmark's independent-source
 * count diverge from the number the product computes, which is measuring
 * something the product does not do. Registrable-domain counts are unaffected
 * either way, since both schemes fold to one domain, so what would change is
 * only the URL-level population, and only in the direction of disagreement.
 *
 * The boundary is pinned by a test that names which modules apply the fold and
 * which do not, because a boundary nobody can see is a boundary the next reader
 * crosses.
 */
export function sourceIdentity(raw: string): string {
  return canonicaliseUrl(raw).replace(/^http:\/\//i, 'https://');
}
