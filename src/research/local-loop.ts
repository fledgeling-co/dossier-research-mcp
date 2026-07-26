import { z } from 'zod';
import { canonicaliseUrl, registrableDomain } from './corroborate.js';
import {
  assessStaleness,
  classifySource,
  profileEvidence,
  type EvidenceProfile,
  type Freshness,
} from './evidence.js';
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

// ──────────────────────────────────────────────────── P0 capability gates ────

/**
 * What the host must be able to do before the loop is worth starting.
 *
 * Declared by the caller, never detected. Dossier is a stdio server: it cannot
 * see whether its client has web search, and a probe that guessed would be
 * wrong in the direction that matters, since the failure this exists to prevent
 * is a loop that runs cheerfully with no search at all and produces a fluent
 * report from the model's own memory. Every field defaults to the optimistic
 * answer, because a caller that says nothing is the common case and halting it
 * would make the tool useless; the point is to give a caller that *knows* it is
 * degraded somewhere to say so.
 *
 * The gate structure is daymade's; the decision to make it declared rather than
 * probed is forced by where Dossier sits.
 */
export const HostCapabilitiesSchema = z.object({
  webSearch: z.boolean().default(true).describe('You can issue a web search. Without this the loop cannot run at all.'),
  webFetch: z.boolean().default(true).describe('You can open a URL and read the page. Without this every task drops to scan depth.'),
  subagents: z.boolean().default(true).describe('You can dispatch parallel workers. Without this the tasks run one at a time, by you.'),
  filesystem: z.boolean().default(true).describe('You can write notes to disk. Without this notes live only in your context.'),
});
export type HostCapabilities = z.infer<typeof HostCapabilitiesSchema>;

export interface CapabilityVerdict {
  /** The loop cannot proceed. There is exactly one cause: no web search. */
  readonly halt: boolean;
  /** Every task is forced to scan depth. */
  readonly forceScan: boolean;
  /** Named degradations, each with what it costs. */
  readonly degradations: readonly string[];
}

/**
 * Decide what the loop can honestly do with what the host has.
 *
 * Degradation is announced, never silent. A fallback nobody is told about is a
 * product failure wearing a success: the run completes, the report looks
 * normal, and the reason it is thin is invisible to the only person who could
 * have done something about it.
 */
export function assessCapabilities(caps: HostCapabilities): CapabilityVerdict {
  const degradations: string[] = [];
  if (!caps.webFetch) {
    degradations.push(
      '**No page fetch, so every task drops to scan depth.** The report will be assembled from search-result snippets, and a snippet is a publisher\'s summary of its own page. Say so in the method section.',
    );
  }
  if (!caps.subagents) {
    degradations.push(
      '**No parallel workers, so you run the tasks yourself, one at a time, adopting each role in turn.** Discard each task\'s raw results after you report it; carrying them all is the context blowout the split exists to avoid.',
    );
  }
  if (!caps.filesystem) {
    degradations.push(
      '**No notes on disk, so the registry here is the only durable record.** Report each task the moment it finishes rather than batching, because anything not reported is lost when your context turns over.',
    );
  }
  return { halt: !caps.webSearch, forceScan: !caps.webFetch, degradations };
}

/** The preflight block, rendered for the caller. */
export function renderCapabilities(verdict: CapabilityVerdict): string {
  if (verdict.halt) {
    return [
      '> [!CAUTION]',
      '> **Halted: no web search.**',
      '',
      'This loop is research you run and Dossier disciplines. Without a search tool there is nothing to discipline, and a loop that continued would produce a report from the model\'s own memory with citations attached to it, which is the single worst output this whole design exists to prevent.',
      '',
      'Either enable web search in this client, or use a paid backend that brings its own: `research_start` routes to one.',
    ].join('\n');
  }
  if (verdict.degradations.length === 0) return '';
  return ['> [!IMPORTANT]', '> **Running degraded.** What that costs:', '', ...verdict.degradations.map((d) => `- ${d}`)].join('\n');
}

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

/**
 * How much evidence this run is expected to gather.
 *
 * `light` is not a worse run, it is a smaller question. Asking what one library
 * does and asking which of six vector databases to standardise on should not be
 * held to the same source count, and holding the small one to the large floors
 * produces a run that fails its gates for being proportionate. Floors live in
 * `evidence.ts`; the thresholds are daymade's.
 */
export const LoopModeSchema = z.enum(['standard', 'light']);
export type LoopMode = z.infer<typeof LoopModeSchema>;

/**
 * What actually happened when a task went looking.
 *
 * Adapted from `last30days-skill`'s per-source `source_status`, which records a
 * typed outcome per source and states the rule plainly: only a clean completion
 * with zero matches means the source had nothing. A failure state is never
 * evidence of absence.
 *
 * Dossier had a boolean here and the boolean was wrong. Any empty report set
 * `nothingFound`, so a worker whose search tool rate-limited looked identical to
 * one that searched a healthy index and established there was nothing there. An
 * all-empty run then rendered the black box, which asserts a finding about the
 * public record. Asserting it on the strength of four failed searches is the
 * exact error the black box exists to prevent.
 *
 * Ten states in the original collapse to five here because Dossier's reporter is
 * a model driving a search tool rather than an HTTP client. `schema-drift` and
 * `partial` are distinctions a client can make and a worker cannot, and a state
 * nobody can report accurately is a state that gets guessed.
 */
export const TaskOutcomeSchema = z.enum(['ok', 'no-results', 'rate-limited', 'blocked', 'tool-failed']);
export type TaskOutcome = z.infer<typeof TaskOutcomeSchema>;

/** Outcomes where the search did not complete, so coverage was never established. */
const COVERAGE_FAILED: ReadonlySet<TaskOutcome> = new Set<TaskOutcome>([
  'rate-limited',
  'blocked',
  'tool-failed',
]);

/** Why each failed outcome means the absence of a result proves nothing. */
const OUTCOME_REASON: Record<string, string> = {
  'rate-limited': 'the search tool was rate-limited, so the index was never fully queried',
  blocked: 'the results were behind a login, a paywall or a bot check, so the pages were never read',
  'tool-failed': 'the search tool itself failed, so nothing was searched',
};

/** True when this outcome means the search did not complete. */
export function coverageFailed(outcome: TaskOutcome): boolean {
  return COVERAGE_FAILED.has(outcome);
}

export const SessionSchema = z.object({
  runId: z.string(),
  question: z.string(),
  createdAt: z.string(),
  /**
   * The date every claim in this run is current as of.
   *
   * Recorded once, at the start, rather than derived at draft time. A run
   * spanning a day boundary would otherwise silently grade its own early
   * findings against a later horizon than the one they were gathered under.
   */
  asOf: z.string().default(''),
  mode: LoopModeSchema.default('standard'),
  tasks: z.array(
    z.object({
      id: z.string(),
      sourceClass: z.string(),
      depth: z.string(),
      objective: z.string(),
      group: z.string().default('A'),
      dependsOn: z.array(z.string()).default([]),
      reported: z.boolean().default(false),
      findings: z.number().int().nonnegative().default(0),
      /** What this task searched for and did not find. Coverage, stated. */
      gaps: z.string().optional(),
      /**
       * A deep task's reading notes, kept so the lead can draft from them.
       *
       * The lead never sees a search result, by design, so everything it writes
       * from has to arrive through here. A registry entry carries the claim and
       * the URL; the argument a page actually made, and the caveat buried three
       * paragraphs in, live nowhere else.
       */
      notes: z.string().optional(),
      /**
       * What happened when this task went looking.
       *
       * Three states used to be two. A task that never ran leaves a hole nobody
       * measured. A task that ran, searched its index properly and came back
       * empty has *established* something: there is nothing there to find. A
       * task whose search was rate-limited or walled off has established
       * nothing at all, and is the one that used to be misfiled as the second.
       */
      outcome: TaskOutcomeSchema.default('ok'),
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
export interface NoteOptions {
  /** What the task searched for and did not find. Recorded against the task. */
  readonly gaps?: string;
  /** A deep task's reading notes, carried through to drafting. */
  readonly notes?: string;
  /** What happened when the task searched. Defaults to a clean run. */
  readonly outcome?: TaskOutcome;
}

export function mergeFindings(
  session: Session,
  taskId: string,
  findings: readonly Finding[],
  opts: NoteOptions = {},
): MergeResult {
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

  const tasks = session.tasks.map((t) => {
    if (t.id !== taskId) return t;
    const total = t.findings + findings.length - refused.length;
    // A declared failure beats the count. A worker that got three findings and
    // was then rate-limited has real findings and incomplete coverage, and
    // reading the count as proof the search finished is the conflation this
    // field exists to end. Only an empty clean run is `no-results`; anything
    // with findings and no declared failure is `ok`. A later successful report
    // on the same task does clear an earlier failure, because that is what
    // rerunning it means.
    const declared = opts.outcome ?? 'ok';
    const outcome: TaskOutcome = coverageFailed(declared)
      ? declared
      : total === 0
        ? 'no-results'
        : 'ok';
    return {
      ...t,
      reported: true,
      findings: total,
      outcome,
      ...(opts.gaps ? { gaps: opts.gaps } : {}),
      ...(opts.notes ? { notes: opts.notes } : {}),
    };
  });

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

export interface StaleEntry {
  readonly n: number;
  readonly url: string;
  readonly freshness: Freshness;
  readonly why: string;
}

export interface FrozenRegistry {
  readonly session: Session;
  readonly profile: EvidenceProfile;
  /** Tasks that never reported. Coverage gaps, named rather than averaged away. */
  readonly silentTasks: readonly string[];
  /** Tasks that reported and found nothing. A negative result, not a gap. */
  readonly nothingFoundTasks: readonly string[];
  /**
   * Tasks whose search did not complete. Neither a negative result nor a gap.
   *
   * A third category, because the two that existed both make a claim this one
   * cannot support: a silent task says nobody looked, a nothing-found task says
   * somebody looked and there was nothing, and this one says the looking broke.
   */
  readonly coverageFailedTasks: readonly { readonly id: string; readonly outcome: TaskOutcome }[];
  /** Registry entries whose age should downgrade confidence in what they support. */
  readonly stale: readonly StaleEntry[];
  /** Entries carrying no readable publication date, so recency is unassessable. */
  readonly undated: number;
  /**
   * Nothing public exists on this subject, and the searching was real.
   *
   * True only when every task actually ran, every search completed cleanly, and
   * every one came back empty. A run where half the tasks were never dispatched
   * is not a black box, it is an unfinished run, and reporting the two the same
   * way would let an abandoned loop present itself as a finding about the world.
   * A run whose searches failed is not one either, for the same reason one step
   * further in: absence of evidence and absence of search look identical from
   * the inside, and only the declared outcome tells them apart.
   */
  readonly blackBox: boolean;
}

/** Freeze the registry and profile what was gathered. Idempotent. */
export function freezeRegistry(session: Session, now = new Date()): FrozenRegistry {
  const frozen: Session = session.frozenAt ? session : { ...session, frozenAt: now.toISOString() };
  const classified = frozen.registry.map((e) => classifySource(e.url));
  const profile = profileEvidence(classified, frozen.mode);

  const asOf = frozen.asOf || now.toISOString().slice(0, 10);
  const stale: StaleEntry[] = [];
  let undated = 0;
  frozen.registry.forEach((entry, i) => {
    const type = classified[i]?.type ?? 'other';
    const verdict = assessStaleness(entry.published, asOf, type);
    if (verdict.freshness === 'undated') undated += 1;
    else if (verdict.freshness !== 'fresh') {
      stale.push({ n: entry.n, url: entry.url, freshness: verdict.freshness, why: verdict.why });
    }
  });

  const silentTasks = frozen.tasks.filter((t) => !t.reported).map((t) => t.id);
  const coverageFailedTasks = frozen.tasks
    .filter((t) => t.reported && coverageFailed(t.outcome))
    .map((t) => ({ id: t.id, outcome: t.outcome }));
  return {
    session: frozen,
    profile,
    silentTasks,
    nothingFoundTasks: frozen.tasks
      .filter((t) => t.reported && t.outcome === 'no-results')
      .map((t) => t.id),
    coverageFailedTasks,
    stale,
    undated,
    blackBox:
      frozen.registry.length === 0 &&
      frozen.tasks.length > 0 &&
      silentTasks.length === 0 &&
      coverageFailedTasks.length === 0,
  };
}

/**
 * The verdict when the searching worked and the subject has no public footprint.
 *
 * Adapted from the "information black box" rule in daymade's `deep-research`
 * skill. The failure it prevents is specific: asked about an entity with no
 * public record, a research loop will happily produce a confident-sounding
 * report assembled from a domain registration, a jobs board and inference, and
 * every sentence of it will be unfalsifiable. The correct output is a refusal
 * with the failed checks enumerated, so the reader can see the searching was
 * real, and a pointer at the only channel that can actually answer.
 */
export function renderBlackBox(frozen: FrozenRegistry): string {
  const attempts = frozen.session.tasks.map(
    (t) => `- \`${t.id}\` (${t.sourceClass}): ${t.gaps ?? 'searched, nothing found'}`,
  );
  return [
    '> [!WARNING]',
    '> **Unable to verify anything about this subject from public sources.**',
    '',
    `**Sources found: 0.** **Confidence: N/A**, for want of evidence rather than because the evidence conflicts.`,
    '',
    'Every planned task ran and every one came back empty, so this is a finding about the public record rather than an unfinished run. What was checked:',
    '',
    ...attempts,
    '',
    'What must not happen next, because each of these manufactures a verifiable-looking answer out of nothing:',
    '',
    '- Inferring that the subject exists, or what it does, from a domain registration.',
    '- Filling the gap from anything the user privately holds and then presenting it as verification. A private document is primary evidence of the user\'s own position and never independent corroboration of an external fact.',
    '- Writing the report anyway with hedging language. Hedged prose built on zero sources still reads as research.',
    '',
    'The honest next step is direct contact with the subject, or a narrower question that public sources can actually reach.',
  ].join('\n');
}

/**
 * Tasks whose search never completed, shown at drafting time.
 *
 * The point of separating this from "found nothing" is what the reader is
 * entitled to conclude. A clean empty search licenses the sentence "there is no
 * public record of X". A rate-limited one licenses nothing, and the two are
 * indistinguishable by the time they reach a draft unless somebody says which
 * happened. This is the say-so.
 */
export function renderCoverageFailures(frozen: FrozenRegistry): string {
  if (frozen.coverageFailedTasks.length === 0) return '';
  const byId = new Map(frozen.session.tasks.map((t) => [t.id, t]));
  return [
    '> [!WARNING]',
    `> **${String(frozen.coverageFailedTasks.length)} task(s) could not complete their search.** Their source classes are unchecked, not empty.`,
    '',
    ...frozen.coverageFailedTasks.map((t) => {
      const task = byId.get(t.id);
      const reason = OUTCOME_REASON[t.outcome] ?? 'the search did not complete';
      return `- \`${t.id}\` (${task?.sourceClass ?? 'unknown'}): ${t.outcome}, so ${reason}.`;
    }),
    '',
    'Do not write these up as established negatives. Nothing was ruled out here, and a sentence saying no evidence was found for something that was never searched is wrong in a way the citations cannot catch. Name them in Knowledge Gaps as unchecked, and rerun them if the answer turns on what they would have covered.',
  ].join('\n');
}

/**
 * Sources refused after the freeze, shown at drafting time.
 *
 * `mergeFindings` has always recorded these; nothing rendered them, so the
 * strongest evidence that the freeze did its job was invisible to the person it
 * protected. Finality is only worth having if it is visible: a dropped source
 * never reappears, and the reader can see which ones were dropped and decide
 * whether the run should be redone rather than patched.
 */
export function renderRefusals(session: Session): string {
  if (session.rejectedAfterFreeze.length === 0) return '';
  const unique = [...new Set(session.rejectedAfterFreeze)];
  return [
    `> [!NOTE]`,
    `> **${String(unique.length)} source(s) arrived after the freeze and were refused. They are final.**`,
    '',
    ...unique.map((u) => `- ${u}`),
    '',
    'These cannot be revived into this run, by you or by anything downstream. If one of them matters, the honest fix is a new session that gathers it before drafting, not a draft that reaches for it afterwards.',
  ].join('\n');
}

/** The staleness section, when there is anything to say. */
export function renderStaleness(frozen: FrozenRegistry): string {
  const asOf = frozen.session.asOf || 'not recorded';
  if (frozen.stale.length === 0 && frozen.undated === 0) {
    return `_As of ${asOf}. Every dated source is within its recency horizon._`;
  }
  const lines = [`**As of ${asOf}.**`, ''];
  if (frozen.stale.length > 0) {
    lines.push(
      `${String(frozen.stale.length)} source(s) should downgrade the confidence of anything resting on them:`,
      '',
      ...frozen.stale.map((s) => `- **[${String(s.n)}]** ${s.freshness}: ${s.why}`),
      '',
    );
  }
  if (frozen.undated > 0) {
    lines.push(
      `${String(frozen.undated)} source(s) carry no readable publication date, so their recency cannot be assessed. Undated is not current: say so rather than implying either.`,
    );
  }
  return lines.join('\n');
}

/**
 * The deep tasks' reading notes, handed to the lead at drafting time.
 *
 * This is the other half of the lead/subagent split. Telling the lead not to
 * read search results only works if what it *should* write from arrives some
 * other way; without this it would be drafting from one-line claims and would
 * have to go back to the pages, which is the context blowout the split existed
 * to avoid.
 */
export function renderDeepNotes(session: Session): string {
  const withNotes = session.tasks.filter((t) => t.notes);
  if (withNotes.length === 0) return '';
  return [
    '## Deep-read notes',
    '',
    'What the workers took from the pages they opened. Draft from this and from the registry; do not go back to the search results.',
    '',
    ...withNotes.map((t) => `### \`${t.id}\` · ${t.sourceClass}\n\n${t.notes ?? ''}`),
  ].join('\n');
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
