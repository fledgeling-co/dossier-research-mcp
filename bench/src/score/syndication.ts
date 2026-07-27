/**
 * Near-duplicate detection over fetched page text, for syndication.
 *
 * **The failure this exists for.** Four domains carrying one wire story are one
 * source wearing four hats. Counting independent registrable domains cannot see
 * it, because the four domains really are four domains; what they are not is
 * four pieces of evidence. A report resting on all four looks four times better
 * sourced than it is, and the whole point of `docs/plan/benchmark.md`'s source
 * quality axis is to say so.
 *
 * Nothing here knows about reports, sources, benchmarks or scoring. It takes two
 * pieces of text and answers whether they are the same story. That separation is
 * deliberate: it is what lets the thresholds below be argued and tested on their
 * own, in one place, rather than being defended wherever they happen to be used.
 *
 * **This is not the detector in `src/research/corroborate.ts`.** That one
 * (`looksSyndicated`, module-private there) compares the *wording of short
 * claims* across backends and is deliberately crude. This one compares *full
 * fetched page text*. Two different instruments, two different inputs, two
 * different questions, and the product's own is untouched by this file.
 */

/**
 * Ten words per shingle.
 *
 * Broder, Glassman, Manasse and Zweig, *Syntactic Clustering of the Web*
 * (WWW6, 1997), which introduced this technique and states the figure flatly:
 * "The shingle size w is 10." Their AltaVista run over roughly thirty million
 * documents sketched every one of them with ten-word shingles. Read and quoted
 * from the WWW6 proceedings text rather than recalled, because a number nobody
 * checked is the kind of provenance this repo does not accept.
 *
 * Ten is also the right width for the job here rather than merely the cited one:
 * shorter windows collide across unrelated prose about the same subject, which
 * is exactly the pair this detector must NOT join, since two independent
 * articles on one event share vocabulary by definition.
 */
export const SHINGLE_WORDS = 10;

/**
 * The resemblance at which two pages are called the same story.
 *
 * **Provenance, and which part of it is a judgement.**
 *
 * The measure is Broder's resemblance: the size of the intersection of two
 * documents' shingle sets over the size of their union, one when the documents
 * are identical. It is the Jaccard coefficient over w-shingles.
 *
 * Two published anchors were read rather than remembered. Broder et al. (above)
 * clustered the web at **0.50**: "We calculated our clusters based on a 50%
 * resemblance." Manning, Raghavan and Schütze, *Introduction to Information
 * Retrieval* §19.6, give **0.9** as the illustrative cutoff for dropping a page
 * from an index: "if it exceeds a preset threshold (say, 0.9), we declare them
 * near duplicates and eliminate one from indexing."
 *
 * 0.7 sits between them, and **landing there rather than at either end is this
 * project's judgement, not a figure lifted from a paper.** Broder's 0.50 is
 * tuned for grouping a web-scale crawl, where a false grouping costs an index
 * entry; here a false collapse understates a backend's independence, which is a
 * score, so the bar is deliberately higher than his. The IIR 0.9 is tuned for
 * de-duplicating an index, where only a near-verbatim copy should be dropped;
 * a republished wire story carries a house headline, a local standfirst and a
 * different furniture block, so demanding 0.9 would miss the ordinary case.
 *
 * **The objection that does not apply here, said out loud because it will be
 * misapplied otherwise.** An earlier attempt at near-duplicate merging in
 * `src/research/corroborate.ts` was rejected on the grounds that published
 * thresholds around this value are tuned for **article bodies**, and applying
 * one to the short one-sentence claims that file compares would silently
 * collapse genuine corroboration: two backends independently stating the same
 * fact in similar words are two sources, and merging them destroys the very
 * thing being measured. That objection is correct and it is about the *input*,
 * not about the number. This module is given full fetched page text, which is
 * precisely what those thresholds were tuned for, so the objection does not
 * transfer. Do not carry it across.
 */
export const SYNDICATION_RESEMBLANCE = 0.7;

/**
 * The containment at which a truncated republication is still the same story.
 *
 * Resemblance alone cannot see the ordinary shape of syndication. An outlet that
 * runs half of a wire story, verbatim, produces a page whose shingles are a
 * subset of the original's, and a subset of half the size can never exceed about
 * 0.5 resemblance however word-perfect it is. Judged on resemblance alone the
 * most blatant case of republication in the corpus scores below the bar.
 *
 * So the second rule is Broder's other quantity, containment: the intersection
 * over the *smaller* set. It is set high, because containment is the more
 * dangerous of the two — a short page quoted wholesale inside a long one is
 * fully contained without being the same story — and `MIN_SHINGLES` guards the
 * same edge from the other side.
 */
export const SYNDICATION_CONTAINMENT = 0.9;

/**
 * The shortest page this will compare, in shingles.
 *
 * A page below this is reported unchecked rather than merged. A not-found page,
 * a cookie wall and a "please enable JavaScript" notice are near-identical on
 * every domain that serves them, and merging two of those would collapse two
 * genuinely independent publishers on the strength of two error pages, which is
 * a number moving for a reason that has nothing to do with the evidence.
 *
 * One hundred shingles is about a hundred and ten words: an article's opening
 * two paragraphs. The trade is stated rather than hidden — a genuinely short
 * wire brief falls below it and is reported unchecked, so its domains are
 * counted separately. That is the conservative direction: the raw count is
 * always shown, so a missed collapse leaves the reader with the number they
 * would have had anyway, while a spurious collapse invents an agreement.
 *
 * It is **not** a defence against two domains serving the same third-party
 * interstitial (one vendor's bot-check page, say), which is long enough to pass
 * and identical across hosts. Nothing here can distinguish that from real
 * syndication, which is why every cluster is reported with its URLs and its
 * scores rather than folded silently into a count.
 */
export const MIN_SHINGLES = 100;

/**
 * Words, lowercased, punctuation gone, digits kept.
 *
 * Punctuation is dropped rather than kept because house style is exactly what
 * differs between two printings of one wire story: curly quotes for straight
 * ones, an en dash for a hyphen, a serial comma added by a sub-editor. Keeping
 * it would let typography break shingles that the prose does not.
 *
 * A decimal splits into its parts (`28.6%` becomes `28` and `6`), which loses
 * nothing that matters: inside a ten-word window those digits are still as
 * distinctive as they were, and the alternative — keeping `.` attached — puts
 * every sentence-ending full stop inside a token instead.
 */
export function normaliseForShingling(text: string): string[] {
  const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return cleaned === '' ? [] : cleaned.split(' ');
}

/**
 * FNV-1a, 32-bit.
 *
 * Broder fingerprinted shingles rather than storing them, and the reason still
 * holds: a long page is thousands of ten-word strings and holding several pages
 * of them as text is many times the memory of holding them as numbers.
 *
 * **The collision arithmetic, stated rather than waved at.** At 32 bits the
 * expected number of colliding pairs among n shingles is about n²/2³³. A very
 * long page of twenty thousand shingles gives roughly 0.05 expected collisions,
 * and each one can only ever move a similarity by one shingle in twenty
 * thousand. Against a bar of 0.7 that is not a decision this can change. A wider
 * hash would cost a BigInt or a packed pair for no reachable benefit.
 */
export function hashShingle(shingle: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < shingle.length; i += 1) {
    h ^= shingle.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The set of hashed w-shingles for one page.
 *
 * A set, not a list, exactly as Broder defines S(D, w): "the set of all unique
 * shingles of size w contained in D". Repetition inside one document carries no
 * information about whether another document is the same story.
 */
export function shingleHashes(text: string, width: number = SHINGLE_WORDS): Set<number> {
  const words = normaliseForShingling(text);
  const out = new Set<number>();
  if (words.length < width) return out;
  for (let i = 0; i + width <= words.length; i += 1) {
    out.add(hashShingle(words.slice(i, i + width).join(' ')));
  }
  return out;
}

/** How many members two sets share. */
function intersectionSize(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const v of small) if (large.has(v)) n += 1;
  return n;
}

/**
 * Broder's resemblance: intersection over union, 1 when identical.
 *
 * Zero for an empty set on either side rather than a division by zero. Two
 * pages with nothing to compare are not similar; they are unmeasured, and the
 * caller decides what to do about that.
 */
export function resemblance(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const shared = intersectionSize(a, b);
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Broder's containment, taken over the smaller side.
 *
 * Defined as intersection over |A|; taking the smaller of the two sets as A is
 * what makes the question "is one of these wholly inside the other" rather than
 * "is this specific one inside that specific one", which is the question a
 * truncated republication poses and the caller cannot know the direction of.
 */
export function containment(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  return intersectionSize(a, b) / Math.min(a.size, b.size);
}

export type SameStoryBasis = 'resemblance' | 'containment' | 'below-threshold' | 'too-short';

export interface SameStoryVerdict {
  readonly same: boolean;
  readonly resemblance: number;
  readonly containment: number;
  /** Why it landed there, so a wrong call is arguable rather than opaque. */
  readonly basis: SameStoryBasis;
}

/**
 * Are these two pages the same story?
 *
 * Both scores travel with the verdict, always. The bar is a judgement (see
 * `SYNDICATION_RESEMBLANCE`) and a reader who disagrees with it needs the
 * numbers to re-decide, exactly as a reader who disagrees with the collapsed
 * source count needs the raw one.
 */
export function sameStory(
  a: ReadonlySet<number>,
  b: ReadonlySet<number>,
  minShingles: number = MIN_SHINGLES,
): SameStoryVerdict {
  if (a.size < minShingles || b.size < minShingles) {
    return { same: false, resemblance: 0, containment: 0, basis: 'too-short' };
  }
  const r = resemblance(a, b);
  const c = containment(a, b);
  if (r >= SYNDICATION_RESEMBLANCE) return { same: true, resemblance: r, containment: c, basis: 'resemblance' };
  if (c >= SYNDICATION_CONTAINMENT) return { same: true, resemblance: r, containment: c, basis: 'containment' };
  return { same: false, resemblance: r, containment: c, basis: 'below-threshold' };
}
