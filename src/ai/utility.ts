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
 * All of this is best-effort by design: a utility-model failure must never lose
 * a report that already cost real money to produce. Callers get `null` and the
 * report stays exactly as it landed.
 */

const SummarySchema = z.object({
  title: z
    .string()
    .min(3)
    .max(120)
    .describe('A specific, literal title for this report. No colon-subtitle padding.'),
  summary: z
    .string()
    .min(20)
    .max(1200)
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
        claim: z.string().min(5).max(400),
        confidence: z.enum(['high', 'medium', 'low']),
        sourceUrl: z.string().max(2000).optional(),
        evidence: z.string().max(500).optional(),
      }),
    )
    .max(60),
});
export type ExtractedClaims = z.infer<typeof ClaimsSchema>;

export interface UtilityModel {
  summarise(markdown: string): Promise<ReportSummary | null>;
  extractClaims(markdown: string, limit: number): Promise<ExtractedClaims | null>;
  answer(question: string, context: string): Promise<string | null>;
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
        return output;
      } catch {
        return null;
      }
    },

    async extractClaims(markdown, limit) {
      try {
        const { output } = await generateText({
          model,
          output: Output.object({ schema: ClaimsSchema }),
          system:
            'You extract load-bearing claims from research reports into portable cards. Copy the claim and its confidence qualifier from the report — do not re-assess, re-word into something stronger, or add claims the report does not make. Attach the citation URL the report gives for each claim, when it gives one.',
          prompt: `Extract at most ${limit} load-bearing claims from this report.\n\n${head(markdown, 40_000)}`,
        });
        return output;
      } catch {
        return null;
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
        return text;
      } catch {
        return null;
      }
    },
  };
}
