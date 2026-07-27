import { z } from 'zod';
import { IDENTIFIER_KINDS } from '../score/identifiers.js';
import { REGISTRY_IDS } from './registries.js';

/**
 * What one network pass established about a report's citations, and when.
 *
 * **This file must never import `node:fs`.** It is the schema and nothing else;
 * `collect.ts` fills it and `cache.ts` is the only part of this directory that
 * touches a disk.
 *
 * The snapshot exists because of a contradiction the cross-family review found
 * and this design accepted: `docs/plan/benchmark.md` stores raw reports so that
 * a metric added in three months can be applied to runs already paid for, and a
 * scorer that fetches the live web at scoring time cannot deliver that, because
 * the web moved. Splitting collection from scoring is what makes the same stored
 * report score the same twice. It is also what lets every gate test run with no
 * network at all.
 *
 * Read back from a disk this is a trust boundary like any other and is parsed,
 * never cast (CP §1). A malformed snapshot fails loudly rather than being
 * scored against: unlike a listing, where one bad record is skipped so the page
 * still renders, a score computed over evidence nobody can vouch for is worse
 * than no score.
 */

/** Bumped when a field changes meaning, so an old snapshot fails rather than misleads. */
export const EVIDENCE_VERSION = 1;

/**
 * How much extracted page text one snapshot keeps per page.
 *
 * Generous, because the whole point of holding the text is that a number can sit
 * a long way down a page, and a cap that bites turns a present fact into an
 * absent one. Where it does bite, `truncated` is set and containment answers
 * `unchecked` rather than `unsupported`.
 */
export const MAX_PAGE_TEXT_CHARS = 400_000;

const isoTimestamp = z.string().min(1).max(40);

/**
 * One registry's answer about one identifier.
 *
 * `via` names which registry decided it, because a DOI can be settled by either
 * Crossref or the global handle directory and those are different strengths of
 * evidence. `detail` is not decoration: it is what a person reads when they
 * dispute a verdict, and for the book catalogue it is where "catalogue presence,
 * not proof the book exists" is actually said.
 */
export const RegistryAnswerSchema = z.strictObject({
  kind: z.enum(IDENTIFIER_KINDS),
  id: z.string().min(1).max(500),
  status: z.enum(['present', 'absent', 'unchecked', 'invalid']),
  via: z.enum(REGISTRY_IDS).optional(),
  detail: z.string().max(600),
  checkedAt: isoTimestamp,
});
export type RegistryAnswer = z.infer<typeof RegistryAnswerSchema>;

/**
 * One cited page, as far as it could be established.
 *
 * `verdict` is `src/research/citations.ts`'s own vocabulary rather than a second
 * one, so a resolvability answer means the same thing in the benchmark as it
 * does in the product.
 */
export const PageEvidenceSchema = z.strictObject({
  /** Canonical form, which is the key everything downstream joins on. */
  url: z.string().min(1).max(2000),
  /** Where the redirects actually landed, when that differs. */
  finalUrl: z.string().max(2000).optional(),
  verdict: z.enum(['live', 'not_found', 'unreachable', 'blocked', 'unverified', 'invalid_url']),
  httpStatus: z.number().int().optional(),
  /** The readable text, already reduced from HTML. Empty when nothing was read. */
  text: z.string().max(MAX_PAGE_TEXT_CHARS),
  /**
   * True when the text held here is not the whole page, for either reason: the
   * byte cap cut the read short, or the extracted text was longer than a
   * snapshot keeps. One flag rather than two, because containment asks one
   * question of it, and the answer to that question is the same either way.
   */
  truncated: z.boolean(),
  /** True only for a complete, readable HTML body. Gates the anchor check. */
  completeHtml: z.boolean(),
  /** Every `id` and `name` the HTML declared, decoded. */
  anchors: z.array(z.string().min(1).max(300)).max(20_000),
  checkedAt: isoTimestamp,
  note: z.string().max(600).optional(),
});
export type PageEvidence = z.infer<typeof PageEvidenceSchema>;

export const CitationEvidenceSchema = z.strictObject({
  version: z.literal(EVIDENCE_VERSION),
  collectedAt: isoTimestamp,
  /**
   * Present when the collector was told which report it was working on, so a
   * snapshot can be matched to the text it was collected for rather than
   * assumed to belong to whatever it is handed to.
   */
  reportSha256: z.string().length(64).optional(),
  pages: z.array(PageEvidenceSchema).max(5000),
  registry: z.array(RegistryAnswerSchema).max(5000),
  /** Anything the collection pass could not do, so silence is never mistaken for success. */
  notes: z.array(z.string().max(600)).max(200).default([]),
});
export type CitationEvidence = z.infer<typeof CitationEvidenceSchema>;

/** A snapshot with nothing in it, which is what an offline collection returns. */
export function emptyEvidence(collectedAt: string): CitationEvidence {
  return { version: EVIDENCE_VERSION, collectedAt, pages: [], registry: [], notes: [] };
}

/**
 * Parse a snapshot read back from anywhere.
 *
 * Throws on a malformed one. Deliberately fatal, and the opposite of the
 * store's skip-the-bad-record rule: a listing that drops one row still shows
 * the rest, while a score computed over half a snapshot is a number about a
 * sample nobody chose.
 */
export function parseEvidence(raw: unknown): CitationEvidence {
  const parsed = CitationEvidenceSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined ? '' : ` at ${first.path.join('.')}: ${first.message}`;
    throw new TypeError(`citation evidence snapshot is malformed and was not used${where}`);
  }
  return parsed.data;
}

/** Index the pages by canonical URL, which is how the scorer joins them. */
export function pagesByUrl(evidence: CitationEvidence): ReadonlyMap<string, PageEvidence> {
  const map = new Map<string, PageEvidence>();
  for (const page of evidence.pages) map.set(page.url, page);
  return map;
}

/** Index the registry answers by kind and identifier. */
export function registryByIdentifier(
  evidence: CitationEvidence,
): ReadonlyMap<string, RegistryAnswer> {
  const map = new Map<string, RegistryAnswer>();
  for (const answer of evidence.registry) map.set(`${answer.kind} ${answer.id}`, answer);
  return map;
}
