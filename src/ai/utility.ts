import { createGoogle } from '@ai-sdk/google';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import type { Config } from '../config.js';

/**
 * Cheap side-work with the AI SDK (v7): titling, summarising, and turning a
 * report into portable claim cards.
 *
 * Deep Research itself returns prose with no structured-output support, so any
 * structure has to be extracted afterwards. That extraction is a trust boundary
 * like any other model call, so every result comes back through a Zod schema
 * via `Output.object` rather than a JSON-parse-and-hope (CP §1, BP §6).
 *
 * Failure here is never fatal: a utility-model hiccup must not lose a report
 * that already cost real money to produce. But it is never silent either —
 * every call returns the reason it failed so the caller can say something
 * useful instead of a bare "it didn't work".
 */

/**
 * A note on the `.max()` values below, learned the expensive way.
 *
 * These bound a field the MODEL generates, so an over-tight cap does not
 * truncate — it fails the whole call with `AI_NoObjectGeneratedError`. A real
 * report's findings are dense multi-sentence claims, and a `.max(400)` on
 * `claim` turned that into total failure of an extraction over a report that
 * had already cost $2 to produce.
 *
 * So: keep length guidance in the `.describe()` where it steers generation,
 * and set the schema bound generously — high enough that a reasonable answer
 * always validates, low enough to still bound a runaway response.
 */
const SummarySchema = z.object({
  title: z
    .string()
    .min(3)
    .max(200)
    .describe('A specific, literal title for this report, ideally under 100 characters. No colon-subtitle padding.'),
  summary: z
    .string()
    .min(20)
    .max(2000)
    .describe('2-4 sentences stating what the research concluded, including the load-bearing numbers.'),
  confidence: z
    .enum(['high', 'medium', 'low'])
    .describe('Overall confidence the report itself claims for its central findings.'),
});
export type ReportSummary = z.infer<typeof SummarySchema>;

const ClaimsSchema = z.object({
  claims: z
    .array(
      z.object({
        claim: z
          .string()
          .min(5)
          .max(1500)
          .describe('The claim as the report states it. Prefer a single sentence.'),
        confidence: z.enum(['high', 'medium', 'low']),
        sourceUrl: z.string().max(2000).optional(),
        evidence: z.string().max(1000).optional().describe('A short supporting excerpt from the report.'),
      }),
    )
    .max(60),
});
export type ExtractedClaims = z.infer<typeof ClaimsSchema>;

/**
 * Every call reports why it failed rather than collapsing to `null`.
 *
 * The first cut swallowed the error and returned null — which meant a caller
 * saw "claim extraction failed" with no way to tell a quota error from a
 * schema mismatch from a timeout. Silencing an error the caller *can* act on
 * is exactly what CP §1 forbids, and it cost real debugging time the first
 * time this path failed against the live API.
 */
export type UtilityResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export interface UtilityModel {
  summarise(markdown: string): Promise<UtilityResult<ReportSummary>>;
  extractClaims(markdown: string, limit: number): Promise<UtilityResult<ExtractedClaims>>;
  answer(question: string, context: string): Promise<UtilityResult<string>>;
}

function failure(e: unknown): { ok: false; error: string } {
  if (e instanceof Error) {
    // AI SDK errors nest the useful detail (a provider message, a schema
    // validation failure) in `cause`; the outer message alone is often generic.
    const cause = (e as { cause?: unknown }).cause;
    const causeText =
      cause instanceof Error ? ` — ${cause.message}` : cause ? ` — ${String(cause)}` : '';
    return { ok: false, error: `${e.name}: ${e.message}${causeText}`.slice(0, 800) };
  }
  return { ok: false, error: String(e).slice(0, 800) };
}

/** Cap the material sent to the utility model — a 60k-token report is wasteful
 * input for a titling call, and the executive summary carries the conclusions. */
function head(markdown: string, chars = 24_000): string {
  return markdown.length <= chars ? markdown : `${markdown.slice(0, chars)}\n\n[... report truncated for this utility call]`;
}

export function createUtilityModel(config: Config): UtilityModel | null {
  if (config.hermetic) return null;
  if (config.auth.mode !== 'api-key') return null; // AI SDK google provider is API-key based

  const google = createGoogle({ apiKey: config.auth.apiKey });
  const model = google(config.utilityModel);

  return {
    async summarise(markdown) {
      try {
        const { output } = await generateText({
          model,
          output: Output.object({ schema: SummarySchema }),
          system:
            'You title and summarise research reports. Be literal and specific. Never invent findings the report does not contain; if the report is thin, say what it actually establishes.',
          prompt: `Title and summarise this research report.\n\n${head(markdown)}`,
        });
        return { ok: true, value: output };
      } catch (e: unknown) {
        return failure(e);
      }
    },

    async extractClaims(markdown, limit) {
      try {
        const { output } = await generateText({
          model,
          output: Output.object({ schema: ClaimsSchema }),
          system:
            'You extract load-bearing claims from research reports into portable cards. Copy the claim and its confidence qualifier from the report — do not re-assess, re-word into something stronger, or add claims the report does not make. Attach the citation URL the report gives for each claim, when it gives one. Keep each claim to one sentence where the report allows it.',
          prompt: `Extract at most ${limit} load-bearing claims from this report.\n\n${head(markdown, 40_000)}`,
        });
        return { ok: true, value: output };
      } catch (e: unknown) {
        return failure(e);
      }
    },

    async answer(question, context) {
      try {
        const { text } = await generateText({
          model,
          system:
            'You answer questions strictly from the supplied research report. If the report does not contain the answer, say exactly that and name what is missing — never fill the gap from your own knowledge. Preserve the report’s confidence qualifiers when you quote its findings.',
          prompt: `Report:\n\n${head(context, 60_000)}\n\n---\n\nQuestion: ${question}`,
        });
        return { ok: true, value: text };
      } catch (e: unknown) {
        return failure(e);
      }
    },
  };
}
