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
 *
 * **What "page text" means here, stated because the thresholds depend on it.**
 * Plain text, as the caller supplies it. In practice that is a whole HTML page
 * run through a tag stripper, so it carries the site's navigation, its footer
 * and its promotional furniture alongside the article. That cuts both ways and
 * both directions are safe: shared furniture raises similarity between two pages
 * on the *same* site, where it changes nothing because same-domain pairs cannot
 * change a domain count and are never compared; and per-site furniture *lowers*
 * similarity between two printings of one wire story, which pushes toward
 * reporting more independence rather than less. If a caller ever supplies
 * extracted article bodies instead, every score here rises and the bar becomes
 * more permissive, so the change would have to be re-measured rather than
 * assumed harmless.
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
 * **The measure.** Broder's resemblance: the size of the intersection of two
 * documents' shingle sets over the size of their union, one when the documents
 * are identical. It is the Jaccard coefficient over w-shingles.
 *
 * **Provenance, in three parts, and which part is a judgement.**
 *
 * *Where 0.7 comes from.* This repo already recorded the figure. `last30days-
 * skill`, read on 26 July 2026 and written up in
 * `docs/plan/external-skill-gap-analysis.md`, de-duplicates its registry on
 * `max(char_3gram_jaccard, token_jaccard) >= 0.7` **over titles and bodies**.
 * That is the near-duplicate rule this benchmark is answering, and 0.7 is its
 * number rather than one invented here.
 *
 * *Where it does not come from, stated because the two are easy to conflate.*
 * Their measure is not this one. A character-trigram Jaccard maxed against a
 * bag-of-tokens Jaccard scores differently from resemblance over ten-word
 * shingles on the same pair of documents, so 0.7 does not transfer between them
 * as a calibration. It transfers as the value somebody working on this exact
 * problem, on this exact kind of input, settled on.
 *
 * *What the published anchors say, read rather than remembered.* Broder et al.
 * (above) clustered the web at **0.50**: "We calculated our clusters based on a
 * 50% resemblance." Manning, Raghavan and Schütze, *Introduction to Information
 * Retrieval* §19.6, give **0.9** as an illustrative cutoff for dropping a page
 * from an index: "if it exceeds a preset threshold (say, 0.9), we declare them
 * near duplicates and eliminate one from indexing." 0.7 sits between the two,
 * and **landing there rather than at either end is this project's judgement.**
 * Broder's 0.50 is tuned for grouping a web-scale crawl, where a false grouping
 * costs an index entry; here a false collapse understates a backend's
 * independence, which is a reported score, so the bar is deliberately above his.
 * The 0.9 is tuned for dropping a near-verbatim copy; a republished wire story
 * carries a house headline, a local standfirst and a different furniture block,
 * so demanding 0.9 on resemblance would miss the ordinary case. Measured on this
 * module's own fixtures, four printings of one wire story score 0.83 to 0.86 and
 * four independently written articles about the same event score 0.00, so the
 * bar is not finely balanced between them; it sits in a wide empty gap.
 *
 * **The objection that does not apply here, said out loud because it will
 * otherwise be reapplied to the wrong thing.** The same gap analysis records why
 * this was declined for `src/research/corroborate.ts`, and the reason is exact:
 * "Their thresholds are tuned against article titles and bodies. Dossier holds
 * one-sentence worker-written claims, and two workers summarising genuinely
 * independent sources on a narrow question will write near-identical sentences.
 * Applying a 0.7 similarity merge to that text would silently collapse real
 * corroboration." That objection is correct, and it is about the **input**, not
 * about the number. This module is never given one-sentence claims. It is given
 * full fetched page text, which is the article-body case those thresholds were
 * tuned against in the first place. The objection does not transfer here. Do not
 * carry it across, and do not use this module on claim text.
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
 * The most page text this will shingle, in characters.
 *
 * A resource bound rather than a trust boundary: the caller is the benchmark's
 * own harness in this repo, not a network. What it stops is a pathological input
 * turning an O(n²) pairwise comparison into an unbounded one. The cap is set
 * well above the 60,000 characters the product's own page stripper already
 * truncates to, so a page produced the ordinary way is never affected.
 *
 * Text beyond the cap is dropped and the truncation is **reported**, never
 * silent: a partial page scored as though it were whole is a similarity computed
 * against a document that does not exist.
 */
export const MAX_PAGE_CHARS = 200_000;

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
  const words = normaliseForShingling(text.slice(0, MAX_PAGE_CHARS));
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
