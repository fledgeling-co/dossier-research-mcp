import { z } from 'zod';
import { canonicaliseUrl, registrableDomain } from './corroborate.js';
import { classifySource, profileEvidence, type EvidenceProfile } from './evidence.js';
import { extractCitedUrls } from './report.js';

/**
 * The local research loop's state, and the rules it enforces.
 *
 * The loop itself runs in the *host*: it has the web search, and Dossier does
 * not. What Dossier owns is the discipline, and the discipline is the part that
 * actually decides whether a report is trustworthy:
 *
 * - findings accumulate into **one numbered, deduplicated registry**;
 * - the registry is **frozen** before drafting begins;
 * - the draft may cite **only from the frozen registry**.
 *
 * That last rule is why this lives server-side rather than in a prompt. A
 * prompt can *ask* a model not to invent a supporting reference mid-sentence. A
 * server holding the registry can check, and reject the draft that did. It is
 * the one guarantee in the whole loop that a client-side skill cannot make.
 */

export const FindingSchema = z.object({
  claim: z.string().min(5).max(2000).describe('What this source establishes, in one sentence.'),
  url: z.string().url().max(2000),
  quote: z.string().max(1000).optional().describe('The sentence that supports it, verbatim.'),
  published: z.string().max(40).optional().describe('Publication date as the source states it.'),
});
export type Finding = z.infer<typeof FindingSchema>;

export const RegistryEntrySchema = z.object({
  n: z.number().int().positive(),
  url: z.string(),
  domain: z.string(),
  claims: z.array(z.string()).max(50),
  firstSeenIn: z.string(),
  published: z.string().optional(),
});
export type LoopRegistryEntry = z.infer<typeof RegistryEntrySchema>;

export const SessionSchema = z.object({
  runId: z.string(),
  question: z.string(),
  createdAt: z.string(),
  tasks: z.array(
    z.object({
      id: z.string(),
      sourceClass: z.string(),
      depth: z.string(),
      objective: z.string(),
      reported: z.boolean().default(false),
      findings: z.number().int().nonnegative().default(0),
    }),
  ),
  registry: z.array(RegistryEntrySchema).default([]),
  /** Set once drafting starts. After this, no source may be added. */
  frozenAt: z.string().optional(),
  /** URLs submitted after the freeze, recorded rather than silently dropped. */
  rejectedAfterFreeze: z.array(z.string()).default([]),
});
export type Session = z.infer<typeof SessionSchema>;

export interface MergeResult {
  readonly session: Session;
  readonly added: number;
  readonly merged: number;
  /** Findings refused because the registry was already frozen. */
  readonly refused: readonly string[];
}

/**
 * Fold a worker's findings into the registry.
 *
 * Deduplication is by canonical URL, so the same page submitted by three
 * different tasks is entry 7 three times rather than 7, 12 and 19 — which is
 * exactly the arithmetic that turns one source into apparent corroboration.
 * Numbers are assigned once and never reused.
 */
export function mergeFindings(session: Session, taskId: string, findings: readonly Finding[]): MergeResult {
  const registry = [...session.registry];
  const byUrl = new Map(registry.map((e) => [e.url, e]));
  const refused: string[] = [];
  let added = 0;
  let merged = 0;

  for (const finding of findings) {
    const url = canonicaliseUrl(finding.url);
    if (session.frozenAt) {
      // A source arriving after the freeze is the failure the freeze exists to
      // catch. Recorded, never merged: a registry that grows during drafting is
      // not a registry.
      refused.push(url);
      continue;
    }
    const existing = byUrl.get(url);
    if (existing) {
      if (!existing.claims.includes(finding.claim) && existing.claims.length < 50) {
        existing.claims.push(finding.claim);
      }
      merged += 1;
      continue;
    }
    const entry: LoopRegistryEntry = {
      n: registry.length + 1,
      url,
      domain: registrableDomain(url),
      claims: [finding.claim],
      firstSeenIn: taskId,
      ...(finding.published ? { published: finding.published } : {}),
    };
    registry.push(entry);
    byUrl.set(url, entry);
    added += 1;
  }

  const tasks = session.tasks.map((t) =>
    t.id === taskId ? { ...t, reported: true, findings: t.findings + findings.length - refused.length } : t,
  );

  return {
    session: {
      ...session,
      tasks,
      registry,
      rejectedAfterFreeze: [...session.rejectedAfterFreeze, ...refused],
    },
    added,
    merged,
    refused,
  };
}

export interface FrozenRegistry {
  readonly session: Session;
  readonly profile: EvidenceProfile;
  /** Tasks that never reported. Coverage gaps, named rather than averaged away. */
  readonly silentTasks: readonly string[];
}

/** Freeze the registry and profile what was gathered. Idempotent. */
export function freezeRegistry(session: Session, now = new Date()): FrozenRegistry {
  const frozen: Session = session.frozenAt ? session : { ...session, frozenAt: now.toISOString() };
  const profile = profileEvidence(frozen.registry.map((e) => classifySource(e.url)));
  return {
    session: frozen,
    profile,
    silentTasks: frozen.tasks.filter((t) => !t.reported).map((t) => t.id),
  };
}

export interface DraftVerdict {
  readonly ok: boolean;
  /** Cited URLs that are not in the frozen registry. */
  readonly unregistered: readonly string[];
  /** Registry entries the draft never used. Not an error; often the honest answer. */
  readonly unused: readonly number[];
  readonly citedCount: number;
  /** True when the draft distinguishes what it read from what it inferred. */
  readonly marksInference: boolean;
}

/**
 * Check a draft against the frozen registry.
 *
 * The rule being enforced: **no new sources at drafting time**. A model that
 * reaches for a plausible-looking reference to support a sentence it has
 * already written produces a report that is both fluent and unsourced, and the
 * citation resolves perfectly, so nothing downstream catches it. Comparing
 * against a registry frozen before drafting began does.
 *
 * Unused entries are reported and are not a failure. A source that turned out
 * not to bear on the question should be dropped, and a draft that cites all
 * forty sources it gathered is usually padding rather than thorough.
 */
export function validateDraft(session: Session, markdown: string): DraftVerdict {
  const registered = new Set(session.registry.map((e) => e.url));
  const cited = new Set(extractCitedUrls(markdown).map((u) => canonicaliseUrl(u)));
  const unregistered = [...cited].filter((u) => !registered.has(u));
  const used = new Set([...cited].filter((u) => registered.has(u)));
  return {
    ok: unregistered.length === 0,
    unregistered,
    unused: session.registry.filter((e) => !used.has(e.url)).map((e) => e.n),
    citedCount: cited.size,
    marksInference: /<INFERENCE|\bsynthesised\b|\bsynthesized\b/i.test(markdown),
  };
}

/** Render the frozen registry as the only list a draft may cite from. */
export function renderRegistry(session: Session): string {
  if (session.registry.length === 0) return '_The registry is empty. There is nothing to draft from._';
  return session.registry
    .map((e) => `${String(e.n)}. ${e.url}${e.published ? ` (${e.published})` : ''} — ${e.claims[0] ?? ''}`)
    .join('\n');
}
