import { z } from 'zod';
import { IDENTIFIER_KINDS } from '../score/identifiers.js';

/**
 * The labelled corpus format, in Zod.
 *
 * **This file must never import `node:fs`.** It is the contract and nothing
 * else; `files.ts` is the only part of this directory that touches a disk.
 *
 * This slice inverts the shape of every other one in the benchmark. Everywhere
 * else a backend produces a report and code scores it; here the *scorer* is the
 * system under test, so the answers have to exist before it runs and the
 * arithmetic is a confusion matrix rather than a rate.
 *
 * Which makes one thing not ours to choose. The label vocabulary is the five
 * verdicts `research_verify_claims` already asks a caller for, declared in
 * `src/ai/utility.ts`. A corpus in a tidier vocabulary would be a measurement
 * of a product that does not exist.
 */

/**
 * The five, in the product's own spelling.
 *
 * Mirrored rather than imported because `src/ai/utility.ts` reaches the AI SDK
 * at module load, and the benchmark's pure half must not. `verdicts.test.ts`
 * pins the two lists against each other so the mirror cannot drift, which is
 * the same posture BENCH-06 took with `assessStaleness`.
 */
export const SUPPORT_LABELS = [
  'supports',
  'partially_supports',
  'contradicts',
  'not_addressed',
  'unreadable',
] as const;
export type SupportLabel = (typeof SUPPORT_LABELS)[number];

/** What a registry can conclude about an identifier. `unchecked` is an answer, not a gap. */
export const REGISTRY_LABELS = ['present', 'absent', 'unchecked', 'invalid'] as const;
export type RegistryLabel = (typeof REGISTRY_LABELS)[number];

/**
 * The resolvability vocabulary, which is `src/research/citations.ts`'s.
 *
 * Recorded on the captured page so the link-checking arm reads what the
 * production judgement actually was, rather than re-deriving it from a status
 * code this corpus stored separately.
 */
export const PAGE_VERDICTS = [
  'live',
  'not_found',
  'unreachable',
  'blocked',
  'unverified',
  'invalid_url',
] as const;
export type PageVerdict = (typeof PAGE_VERDICTS)[number];

/**
 * Where a fixture came from.
 *
 * `captured` is a real page fetched through the production collector and frozen.
 * `constructed` is written by hand, and is legitimate where the live web will
 * not hold a shape still: a consent interstitial differs by region, by cookie
 * jar and by week, so pinning one means pinning a screenshot of a moving thing.
 * The distinction lives in the corpus rather than in a commit message because a
 * reader weighing a result needs it.
 */
export const PROVENANCE = ['captured', 'constructed'] as const;
export type Provenance = (typeof PROVENANCE)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/, 'an ISO date or timestamp');

/**
 * Reasoning is mandatory and is the field a dispute is settled against.
 *
 * Forty characters is not a formatting rule. A label with no argument behind it
 * is an assertion of authority, and a benchmark that settles a disagreement by
 * authority is the thing this whole design is against.
 */
const why = z.string().min(40).max(2000);

/**
 * One page, as it was when the corpus froze.
 *
 * The text is not here. It lives in a sidecar file under `bench/detector/pages`
 * and is joined by name, because a captured page runs to tens of kilobytes and a
 * YAML file nobody can read is a corpus nobody can audit. `textSha256` is what
 * makes the sidecar trustworthy: the loader recomputes it and refuses the whole
 * corpus on a mismatch.
 */
export const PageSnapshotSchema = z.strictObject({
  provenance: z.enum(PROVENANCE),
  capturedAt: isoDate,
  /** The production verdict `judgeCitationStatus` reached at capture time. */
  verdict: z.enum(PAGE_VERDICTS),
  httpStatus: z.number().int().min(0).max(599).optional(),
  truncated: z.boolean(),
  /**
   * Recorded because the capture pass establishes it, not because this corpus
   * scores it. Anchor honesty is BENCH-03's check over live evidence, and
   * carrying a second copy of every page's anchor set here would be a second
   * source of truth about the same pages for no measurement in return.
   */
  completeHtml: z.boolean(),
  /** File name only, no separators. Resolved under the corpus's own pages directory. */
  textFile: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._-]+\.txt$/, 'a plain file name ending .txt, with no path separators'),
  textSha256: z.string().length(64).regex(/^[0-9a-f]{64}$/, 'lowercase hex'),
  textChars: z.number().int().min(0),
  /** Anything a reader needs to know about how this page behaves. */
  note: z.string().max(600).optional(),
});
export type PageSnapshot = z.infer<typeof PageSnapshotSchema>;

/**
 * One claim, one page, one label.
 *
 * `topic` groups the claims written against a single captured page. Several
 * claims per page is deliberate and is what makes the corpus hard: the same real
 * page supporting one claim and not addressing another is exactly the
 * discrimination being measured, and a corpus of one claim per page would let a
 * detector succeed by recognising the page.
 */
export const SupportCaseSchema = z.strictObject({
  id: z
    .string()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and hyphens'),
  topic: z.string().min(1).max(200),
  claim: z.string().min(5).max(2000),
  url: z.string().min(1).max(2000),
  label: z.enum(SUPPORT_LABELS),
  why,
  page: PageSnapshotSchema,
});
export type SupportCase = z.infer<typeof SupportCaseSchema>;

/** One scripted registry answer, in the transport's own shape. */
export const ScriptedResponseSchema = z.strictObject({
  status: z.number().int().min(0).max(599),
  body: z.string().max(20_000).default(''),
  /** Set when the transport failed rather than answered. */
  error: z.string().max(300).optional(),
  /** Which registry step this answers, for a human reading the case. */
  step: z.string().max(60).optional(),
});
export type ScriptedResponse = z.infer<typeof ScriptedResponseSchema>;

/**
 * One identifier, and what the registries said about it.
 *
 * The responses are scripted rather than live for the reason BENCH-03 found the
 * hard way: arXiv answered `429 Rate exceeded` to every probe across seven
 * minutes, so a corpus that fetched would score a different thing every run. The
 * ones marked `captured` are what a live probe actually returned on the recorded
 * date; the ones marked `constructed` are failure modes written to shape.
 *
 * `reportSnippet` exists because extraction is context-sensitive: a PMID is a
 * bare run of digits and needs a context word before it is an identifier at all.
 * Carrying the snippet means the case exercises the real extractor rather than
 * handing it a pre-parsed identifier it would never see in a report.
 */
export const RegistryCaseSchema = z.strictObject({
  id: z
    .string()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and hyphens'),
  kind: z.enum(IDENTIFIER_KINDS),
  identifier: z.string().min(1).max(500),
  reportSnippet: z.string().min(1).max(2000),
  label: z.enum(REGISTRY_LABELS),
  why,
  provenance: z.enum(PROVENANCE),
  observedAt: isoDate,
  responses: z.array(ScriptedResponseSchema).max(10).default([]),
});
export type RegistryCase = z.infer<typeof RegistryCaseSchema>;

/**
 * What one judged pass answered, and what it cost.
 *
 * Stored rather than called, which is the same split BENCH-03 made between
 * collection and scoring and for a sharper reason here: a model call is
 * asynchronous, non-deterministic and billed, and a scorer with any one of those
 * three properties cannot be re-run over a corpus. The model id and the date ride
 * on the file so a later re-run against a newer model is a new evidence file
 * rather than an edit to this one.
 */
export const JudgedVerdictsSchema = z.strictObject({
  version: z.literal(1),
  model: z.string().min(1).max(200),
  judgedAt: isoDate,
  note: z.string().max(2000).default(''),
  verdicts: z
    .array(
      z.strictObject({
        caseId: z.string().min(1).max(120),
        verdict: z.enum(SUPPORT_LABELS),
        quote: z.string().max(1000).optional(),
        note: z.string().max(600).optional(),
      }),
    )
    .max(2000),
  /** Cases the pass could not judge at all, named rather than dropped. */
  failures: z
    .array(z.strictObject({ caseId: z.string().min(1).max(120), error: z.string().max(600) }))
    .max(2000)
    .default([]),
});
export type JudgedVerdicts = z.infer<typeof JudgedVerdictsSchema>;

/** A generous ceiling on one case file, so a runaway cannot be read into memory. */
export const MAX_CASE_FILE_BYTES = 256 * 1024;

/** A page fixture may be large; this still bounds it. */
export const MAX_PAGE_FILE_BYTES = 2 * 1024 * 1024;
