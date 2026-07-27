import { createHash } from 'node:crypto';
import type { ResearchToolSpec } from '../gemini/client.js';
import type { ResearchTier } from '../gemini/types.js';

/**
 * The research contract — the two-step spend handshake.
 *
 * `research_plan` costs nothing material and returns a contract: the exact
 * resolved prompt, the tier, the tool set, and a cost band, all bound to a
 * fingerprint. `research_start` will only spend money against a fingerprint it
 * can recompute from its own arguments.
 *
 * The point is not cryptographic authorisation — the caller and the server are
 * the same trust domain. The point is that **an agent stuck in a loop cannot
 * spend money by accident**: without the deliberate second call carrying the
 * fingerprint, forty retries are forty free no-ops. The same hash doubles as
 * the de-duplication key, so a retry storm collapses onto one paid job.
 */

export interface FingerprintInput {
  readonly prompt: string;
  readonly tier: ResearchTier;
  readonly tools: readonly ResearchToolSpec[];
  readonly collaborativePlanning: boolean;
  /**
   * Attachments are part of the purchase and must be part of its identity.
   * Without them, "summarise this document" with PDF A and the same sentence
   * with PDF B hash identically, so the second call is declared a duplicate and
   * silently returns the first document's report. Wrong answer, no error.
   */
  readonly attachments?: readonly string[];
  /**
   * Which backend will run it. Part of the purchase, not a detail of it.
   *
   * Without this, `research_compare` deduped its second backend onto its first:
   * the same brief shaped the same way hashes identically whoever runs it, so
   * the second run collapsed onto the first, and the comparison then reported
   * that two independent providers agreed while diffing one report against
   * itself. The one output the tool exists to produce, fabricated.
   */
  readonly provider?: string;
  /** Shape, window and matrix spec all change what is bought. */
  readonly shape?: string;
  readonly window?: string;
  readonly wideSpec?: string;
  /**
   * Which deliberate repetition of an otherwise identical purchase this is.
   *
   * Dedupe exists to stop *accidental* duplicate spend, and a benchmark repeat
   * is not accidental. Without this field, `n = 5` of one task on one backend
   * inside the dedupe window collapsed onto **one** paid run, so every spread,
   * every `pass^k` and every non-determinism figure would have been computed
   * over a single sample while reporting five. The measurement most sensitive
   * to the defect is the one the defect makes look cleanest: five identical
   * copies of one report have zero variance.
   *
   * The fix is to make a repeat *expressible*, never to add a nonce to every
   * request. A nonce would delete the protection for the case it exists for:
   * an agent stuck in a retry loop passes the same arguments each time,
   * including this one, and still collapses onto one run. Only a caller that
   * deliberately counts gets a second purchase.
   *
   * Omitted or `0` is the ordinary single run, and hashes to exactly the string
   * it hashed to before this field existed — so no stored fingerprint is
   * invalidated and no in-flight dedupe window is reopened by the upgrade.
   */
  readonly repeat?: number;
}

/**
 * Normalise before hashing so cosmetic differences collapse: whitespace runs,
 * leading/trailing space, and case do not change what gets researched. Tool
 * configuration and tier DO — a `fast` run and a `max` run over the same
 * question are genuinely different purchases.
 */
function normalisePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().toLowerCase();
}

function normaliseTools(tools: readonly ResearchToolSpec[]): string {
  return tools
    .map((t) => {
      switch (t.type) {
        case 'file_search':
          return `file_search:${[...t.fileSearchStoreNames].sort().join(',')}`;
        case 'mcp_server':
          // Headers are excluded on purpose: they carry credentials, and a
          // rotated token must not fork the dedupe key.
          return `mcp_server:${t.name}:${t.url}:${[...(t.allowedTools ?? [])].sort().join(',')}`;
        case 'google_search':
        case 'url_context':
        case 'code_execution':
          return t.type;
        default: {
          const _exhaustive: never = t;
          return _exhaustive;
        }
      }
    })
    .sort()
    .join('|');
}

export function fingerprint(input: FingerprintInput): string {
  const repeat = input.repeat ?? 0;
  // Fail closed rather than hash whatever arrived. `NaN`, `1.5` and `-1` all
  // stringify to something, and every `NaN` stringifies to the *same* thing —
  // so a bad index would silently collapse the cells it was added to separate,
  // which is the exact defect this field exists to fix, wearing a disguise.
  if (!Number.isInteger(repeat) || repeat < 0) {
    throw new TypeError(
      `fingerprint: repeat must be a non-negative integer; received ${String(input.repeat)}`,
    );
  }
  const canonical = [
    normalisePrompt(input.prompt),
    input.tier,
    normaliseTools(input.tools),
    input.collaborativePlanning ? 'plan' : 'auto',
    // Sorted, so attachment order is cosmetic while presence and identity are not.
    [...(input.attachments ?? [])].sort().join(','),
    input.provider ?? 'default',
    input.shape ?? 'deep',
    input.window ?? 'none',
    input.wideSpec ?? '',
    // Appended only when a repeat was actually asked for, so the ordinary run
    // hashes to the byte-identical string it did before this field existed.
    ...(repeat > 0 ? [`repeat:${String(repeat)}`] : []),
  ].join(' ');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** Constant-time-ish comparison. Cheap, and avoids a needless timing signal. */
export function fingerprintMatches(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
