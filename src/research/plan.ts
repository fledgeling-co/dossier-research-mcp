/**
 * Extracting the research plan from a collaborative-planning turn.
 *
 * The API does not return a bare plan. Measured against the live preview API,
 * the planning turn's `model_output` looks like:
 *
 *     **Title:** <a title it invented>
 *     **Input:** <your entire submitted prompt, echoed verbatim>
 *     **Research Plan:**
 *     (1) …
 *
 * With an engineered brief that echo is ~6,700 characters, so a caller shown
 * the raw text sees their own prompt and has to scroll past it to reach the
 * thing they are meant to review. Plan review is the highest-leverage
 * intervention available on a Deep Research run; burying it under the input
 * defeats the entire feature.
 *
 * Pure string work, no I/O.
 */

/** Markers the API has been observed to use ahead of the plan body. */
const PLAN_MARKERS = [/\*\*Research Plan:?\*\*/i, /\*\*Plan:?\*\*/i, /^Research Plan:?$/im];

const TITLE = /\*\*Title:\*\*\s*(.+)/i;

export interface ExtractedPlan {
  /** The plan body a human should actually review. */
  readonly plan: string;
  /** The title the model gave the investigation, when it supplied one. */
  readonly title?: string;
  /** True when an echoed input block was stripped. */
  readonly strippedEcho: boolean;
}

/**
 * Pull the reviewable plan out of a planning turn.
 *
 * `submittedPrompt` is used as a second line of defence: if the API stops
 * emitting a `**Research Plan:**` marker, we can still remove the echo by
 * matching what we sent. Falling all the way through returns the text
 * unchanged — showing too much beats showing nothing.
 */
export function extractPlan(raw: string, submittedPrompt?: string): ExtractedPlan {
  const text = raw.trim();
  if (!text) return { plan: '', strippedEcho: false };

  const title = TITLE.exec(text)?.[1]?.trim();

  for (const marker of PLAN_MARKERS) {
    const match = marker.exec(text);
    if (match && match.index !== undefined) {
      const body = text.slice(match.index + match[0].length).trim();
      if (body) {
        return {
          plan: body,
          ...(title ? { title } : {}),
          strippedEcho: match.index > 0,
        };
      }
    }
  }

  // No marker: strip the echoed prompt by value if we can recognise it.
  if (submittedPrompt) {
    const echo = submittedPrompt.trim();
    // Long enough that an exact match cannot be coincidence, low enough that a
    // short un-engineered question still qualifies. An engineered brief runs to
    // thousands of characters; a bare question is often only a line or two.
    if (echo.length > 80 && text.includes(echo)) {
      const body = text.replace(echo, '').replace(/\*\*Input:\*\*\s*/i, '').trim();
      if (body) return { plan: body, ...(title ? { title } : {}), strippedEcho: true };
    }
  }

  return { plan: text, ...(title ? { title } : {}), strippedEcho: false };
}
