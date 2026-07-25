import { z } from 'zod';

/**
 * Wire schemas for the Gemini Interactions API.
 *
 * The API response is a trust boundary — it is parsed, never cast (CP §1). The
 * schemas are deliberately permissive about *extra* fields (Zod strips unknown
 * keys by default) and strict about the ones we branch on, so a preview API
 * adding a field cannot break us while a missing `status` fails loudly.
 */

export const RESEARCH_TIERS = ['fast', 'max'] as const;
export type ResearchTier = (typeof RESEARCH_TIERS)[number];

/** Agent ids as documented for the Deep Research preview. */
export const AGENT_BY_TIER: Record<ResearchTier, string> = {
  fast: 'deep-research-preview-04-2026',
  max: 'deep-research-max-preview-04-2026',
};

export const INTERACTION_STATUSES = ['in_progress', 'completed', 'failed'] as const;
export type InteractionStatus = (typeof INTERACTION_STATUSES)[number];

const ContentItemSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string().default('') }),
  z.object({
    type: z.literal('image'),
    data: z.string().optional(),
    mime_type: z.string().optional(),
  }),
  // Any other content type the preview API grows: keep the step parseable.
  z.object({ type: z.string() }).transform((v) => ({ type: v.type as string })),
]);

export type ContentItem = z.infer<typeof ContentItemSchema>;

/**
 * A step carries its payload in one of two shapes, and they are not
 * interchangeable: `model_output` and `user_input` steps use `content[]`, while
 * a `thought` step has no `content` at all and puts its reasoning in
 * `summary[]`. Parsing only `content` silently yields zero thoughts.
 */
const StepSchema = z.object({
  type: z.string().optional(),
  content: z.array(ContentItemSchema).optional(),
  summary: z.array(z.object({ type: z.string().optional(), text: z.string().default('') })).optional(),
});

export type InteractionStep = z.infer<typeof StepSchema>;

/**
 * `status` is the only field we branch on, so it is the only required one.
 * Anything else missing degrades to "no progress information yet", which is
 * exactly what an early poll of a background run looks like.
 */
export const InteractionSchema = z.object({
  id: z.string().min(1).optional(),
  status: z.enum(INTERACTION_STATUSES).catch('in_progress'),
  error: z.unknown().optional(),
  steps: z.array(StepSchema).optional(),
});

export type Interaction = z.infer<typeof InteractionSchema>;

/** Normalised snapshot the rest of the server works with. */
export interface InteractionSnapshot {
  readonly interactionId: string;
  readonly status: InteractionStatus;
  /** Concatenated text of the final model output, when present. */
  readonly markdown: string;
  /** Reasoning/thinking text emitted so far, newest last. */
  readonly thoughts: readonly string[];
  /** Base64 images (charts) the run produced. */
  readonly images: readonly { readonly data: string; readonly mimeType: string }[];
  readonly error?: string;
}

/** Flatten a validated Interaction into the snapshot the runner persists. */
export function toSnapshot(interactionId: string, raw: unknown): InteractionSnapshot {
  const parsed = InteractionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      interactionId,
      status: 'failed',
      markdown: '',
      thoughts: [],
      images: [],
      error: `Unparseable interaction payload: ${parsed.error.issues[0]?.message ?? 'unknown shape'}`,
    };
  }
  const it = parsed.data;
  /** Text from steps typed exactly `model_output` — the documented report. */
  const modelOutput: string[] = [];
  /** Text from any other non-echo, non-reasoning step — the fallback. */
  const otherOutput: string[] = [];
  const thoughts: string[] = [];
  const images: { data: string; mimeType: string }[] = [];

  for (const step of it.steps ?? []) {
    const type = step.type ?? '';
    // The API echoes the submitted prompt back as a `user_input` step. Without
    // this guard the echoed prompt is the only text step for most of a run's
    // life, so a mid-flight read would hand back the prompt as if it were the
    // report. Observed against the live preview API, not hypothetical.
    if (type === 'user_input') continue;
    const isThought = type.includes('thought') || type.includes('reasoning') || type.includes('thinking');
    // Reasoning lives in `summary[]`, not `content[]`.
    for (const part of step.summary ?? []) {
      if (part.text) thoughts.push(part.text);
    }
    const sink = type === 'model_output' ? modelOutput : otherOutput;
    for (const item of step.content ?? []) {
      if (item.type === 'text' && 'text' in item && item.text) {
        if (isThought) thoughts.push(item.text);
        else sink.push(item.text);
      } else if (item.type === 'image' && 'data' in item && item.data) {
        images.push({ data: item.data, mimeType: ('mime_type' in item && item.mime_type) || 'image/png' });
      }
    }
  }

  // The report is EVERY model_output text step, joined in order.
  //
  // Measured against the live API: a completed run's steps are
  // `user_input` (the echoed prompt) → `thought` (reasoning) → `model_output`
  // × N, where the report is chunked across those N. A real 32k-character
  // report arrived as 7,318 + 25,222 chars in two steps — so taking only the
  // last one silently dropped the title and the whole Executive Summary.
  //
  // Prefer the documented `model_output` type, but fall back to any other
  // non-echo, non-reasoning text when none is present. That way a preview
  // rename of the step type degrades to "possibly some extra text" rather
  // than to "the report is empty" — losing report content is the worse
  // failure of the two, and it is the one that actually happened.
  const markdown = (modelOutput.length > 0 ? modelOutput : otherOutput).join('');

  return {
    interactionId,
    status: it.status,
    markdown,
    thoughts,
    images,
    ...(it.error !== undefined && it.error !== null
      ? { error: typeof it.error === 'string' ? it.error : JSON.stringify(it.error).slice(0, 2000) }
      : {}),
  };
}
