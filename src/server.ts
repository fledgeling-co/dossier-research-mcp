import { timingSafeEqual } from 'node:crypto';
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { createUtilityModel, type UtilityModel } from './ai/utility.js';
import { describeAuth, loadConfig, type Config } from './config.js';
import { assertStoreName, resolveCorpusClient, type CorpusClient } from './corpus/files.js';
import {
  DEFAULT_BASE_AGENT,
  RESEARCH_AGENT_INSTRUCTION,
  resolveAgentsClient,
  type AgentsClient,
} from './gemini/agents.js';
import { resolveClient, type DeepResearchClient, type ResearchToolSpec } from './gemini/client.js';
import { estimateCost, estimateDuration, formatCostBand } from './gemini/cost.js';
import { AGENT_BY_TIER, RESEARCH_TIERS } from './gemini/types.js';
import { ARCHETYPE_NAMES, ARCHETYPE_OVERRIDES, type Archetype } from './research/archetypes.js';
import { renderScorecard, scoreCitations, verifyCitations } from './research/citations.js';
import { fingerprintMatches } from './research/contract.js';
import {
  CORPUS_GROUNDING_BLOCK,
  CORPUS_OUTPUT_REQUIREMENT,
  buildPrompt,
  operatorNotes,
  type ResearchScope,
} from './research/prompt.js';
import {
  clampToTokens,
  estimateTokens,
  findSection,
  grepReport,
  outlineReport,
  readSection,
  renderOutline,
} from './research/report.js';
import { describeRun, Runner, stateHint } from './research/runner.js';
import { Store } from './store/store.js';
import { RUN_STATES, type RunRecord } from './store/types.js';
import { version } from './version.js';

/** Everything the tools need, assembled once at start-up. */
export interface ServerDeps {
  readonly config: Config;
  readonly store: Store;
  readonly runner: Runner;
  readonly client: DeepResearchClient | null;
  readonly corpus: CorpusClient | null;
  readonly agents: AgentsClient | null;
  readonly utility: UtilityModel | null;
}

const TierSchema = z.enum(RESEARCH_TIERS).describe(
  'fast = deep-research-preview (~4-20 min, ~$1-3). max = deep-research-max-preview (~10-60 min, ~$3-7, roughly double the searches).',
);

const ArchetypeSchema = z.enum(ARCHETYPE_NAMES).describe(
  'Research archetype. Omit to auto-select from the question. Exactly one is applied — mixing two is a decomposition trigger, not a prompt expansion.',
);

const ScopeSchema = z
  .object({
    jurisdiction: z.string().max(300).optional().describe('Jurisdiction or geography — load-bearing for regulatory and market work.'),
    timeHorizon: z.string().max(300).optional().describe('e.g. "January 2024 to present, with a 12-month forward outlook".'),
    decisionContext: z.string().max(600).optional().describe('What you will DO with the findings. Drives the analysis lens; this is the single highest-value field here.'),
    analysisLenses: z.array(z.string().max(300)).max(6).optional().describe('Extra analytical frames on top of the archetype defaults.'),
    exclude: z.array(z.string().max(200)).max(10).optional().describe('Explicitly out of scope.'),
  })
  .optional();

const CorpusSchema = z
  .array(z.string().max(300))
  .max(10)
  .optional()
  .describe('File Search store names (fileSearchStores/…) to ground the run in. Adds a hierarchy-of-truth instruction and asks for an explicit contradictions section.');

function requireClient(deps: ServerDeps): DeepResearchClient {
  if (!deps.client) {
    throw new UserError(
      `No Gemini credentials configured (${describeAuth(deps.config)}). Set GEMINI_API_KEY or VERTEX_PROJECT and restart the server.`,
    );
  }
  return deps.client;
}

async function requireRun(deps: ServerDeps, runId: string): Promise<RunRecord> {
  const run = await deps.store.getRun(runId);
  if (!run) throw new UserError(`No run with id "${runId}". List them with \`research_list\`.`);
  return run;
}

function buildTools(corpusStores: readonly string[] | undefined): ResearchToolSpec[] {
  const tools: ResearchToolSpec[] = [
    { type: 'google_search' },
    { type: 'url_context' },
    { type: 'code_execution' },
  ];
  if (corpusStores && corpusStores.length > 0) {
    tools.push({
      type: 'file_search',
      fileSearchStoreNames: corpusStores.map((s) => assertStoreName(s)),
    });
  }
  return tools;
}

/**
 * Resolve a caller's question into the prompt that will actually be sent.
 * A pre-engineered brief (from the bundled prompt-creator skill, or written by
 * hand) passes through verbatim — only the corpus grounding block is appended,
 * because that is additive rather than a competing instruction set.
 */
function resolvePrompt(args: {
  question: string;
  archetype?: Archetype | undefined;
  scope?: ResearchScope | undefined;
  corpusStores?: readonly string[] | undefined;
}): { prompt: string; archetype: Archetype; preEngineered: boolean } {
  const hasCorpus = (args.corpusStores?.length ?? 0) > 0;
  const built = buildPrompt({
    question: args.question,
    corpusGrounding: hasCorpus,
    ...(args.archetype ? { archetype: args.archetype } : {}),
    ...(args.scope ? { scope: args.scope } : {}),
  });
  // A pre-engineered brief is sent verbatim, so the corpus block cannot be
  // woven into its scaffold. Insert it before that brief's own trailing
  // re-anchor where one exists, rather than after it — appending after the
  // final `<core_directive>` is what made the instruction invisible once.
  let prompt = built.prompt;
  if (hasCorpus && built.preEngineered) {
    const anchor = prompt.lastIndexOf('<core_directive>');
    const insert = `<corpus_grounding>\n${CORPUS_GROUNDING_BLOCK}\n\n${CORPUS_OUTPUT_REQUIREMENT}\n</corpus_grounding>\n\n`;
    prompt = anchor > 0 ? prompt.slice(0, anchor) + insert + prompt.slice(anchor) : `${insert}${prompt}`;
  }
  return { prompt, archetype: built.archetype, preEngineered: built.preEngineered };
}

/**
 * Bearer-token check for the HTTP transport. Compared in constant time because
 * the token is secret material (CP §4 A02), and only installed when tokens are
 * actually configured — on stdio there is no request to authenticate.
 */
function tokenAuthenticator(tokens: readonly string[]) {
  const expected = tokens.map((t) => Buffer.from(t));
  return (request: { headers: Record<string, string | string[] | undefined> }): Promise<{ id: string }> => {
    const raw = request.headers['authorization'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    const presented = Buffer.from((header ?? '').replace(/^Bearer\s+/i, ''));
    const ok = expected.some(
      (candidate) => candidate.length === presented.length && timingSafeEqual(candidate, presented),
    );
    if (!ok) {
      // FastMCP's documented auth contract: throwing a Response is how a
      // rejection becomes a 401 on the wire. An Error would surface as a 500.
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- see above
      throw new Response(null, { status: 401, statusText: 'Unauthorized' });
    }
    return Promise.resolve({ id: 'token' });
  };
}

export function createServer(deps: ServerDeps): FastMCP {
  const { config, store, runner } = deps;

  const server = new FastMCP({
    name: 'dossier',
    version,
    ...(config.httpTokens.length > 0
      ? { authenticate: tokenAuthenticator(config.httpTokens) }
      : {}),
    instructions: [
      'Google Gemini Deep Research, wrapped so it is safe for an agent to drive.',
      '',
      'The shape that matters:',
      '1. `research_plan` — free. Returns the engineered prompt, a cost band, and a contract fingerprint.',
      '2. `research_start` — spends money. Returns a HANDLE immediately; the run continues for 4-60 minutes with or without you.',
      '3. `research_status` / `research_tail` — check on it. Runs survive your disconnect and this server restarting.',
      '4. `research_read` — read the report by OUTLINE first, then by section. It never returns a ~60k-token report inline.',
      '5. `research_verify_citations` — dereference every cited URL before anyone acts on the findings.',
      '',
      'Costs are real: roughly $1-3 per fast run and $3-7 per max run, charged whether or not you read the result. There is a budget gate and identical requests de-duplicate onto one run.',
      '',
      'If you already have an engineered Deep Research brief (from the bundled deep-research-prompt-creator skill, say), pass it as `question` — it is detected and sent verbatim rather than re-wrapped.',
    ].join('\n'),
    health: { enabled: true, path: '/health' },
  });

  // ───────────────────────────────────────────────────────── plan (free) ────
  server.addTool({
    name: 'research_plan',
    description:
      'Plan a Deep Research run WITHOUT spending anything. Returns the fully engineered prompt, the selected archetype, a cost and duration band, and a contract fingerprint you pass to `research_start`. Always call this first for anything non-trivial — it is free, and it is where you catch a badly-scoped question before it costs $7.',
    annotations: { title: 'Plan a research run', readOnlyHint: true, openWorldHint: false },
    parameters: z.object({
      question: z
        .string()
        .min(3)
        .max(20_000)
        .describe('Your research question, or an already-engineered Deep Research brief (detected and passed through verbatim).'),
      tier: TierSchema.default('fast'),
      archetype: ArchetypeSchema.optional(),
      scope: ScopeSchema,
      corpusStores: CorpusSchema,
      collaborativePlanning: z
        .boolean()
        .default(false)
        .describe('Ask Gemini for a research plan first, to review and approve. The highest-leverage intervention available on a decision-critical run.'),
    }),
    execute: async (args) => {
      const resolved = resolvePrompt({
        question: args.question,
        ...(args.archetype ? { archetype: args.archetype } : {}),
        ...(args.scope ? { scope: args.scope } : {}),
        ...(args.corpusStores ? { corpusStores: args.corpusStores } : {}),
      });
      const tools = buildTools(args.corpusStores);
      const fp = runner.fingerprintFor({
        prompt: resolved.prompt,
        tier: args.tier,
        tools,
        collaborativePlanning: args.collaborativePlanning,
      });
      const band = estimateCost(args.tier);
      const duration = estimateDuration(args.tier);
      const budget = await runner.budget();
      const notes = operatorNotes({
        archetype: resolved.archetype,
        tier: args.tier,
        collaborativePlanning: args.collaborativePlanning,
        hasCorpus: (args.corpusStores?.length ?? 0) > 0,
        questionLength: args.question.length,
      });

      const existing = await store.findByFingerprint(fp, config.dedupeTtlMinutes);

      return [
        `## Research plan (nothing spent)`,
        '',
        `- **Archetype**: ${resolved.archetype}${resolved.preEngineered ? ' (your brief was already engineered — it will be sent verbatim)' : ''}`,
        `- **Tier**: ${args.tier} (\`${AGENT_BY_TIER[args.tier]}\`)`,
        `- **Estimated cost**: ${formatCostBand(band)} — ${band.basis}. This is a guardrail estimate, not a quote.`,
        `- **Estimated duration**: ${duration.lowMinutes}-${duration.highMinutes} minutes, background.`,
        `- **Tools**: ${tools.map((t) => t.type).join(', ')}`,
        `- **Plan review**: ${args.collaborativePlanning ? 'ON — you will approve a plan before the run executes' : 'OFF — the run executes autonomously'}`,
        `- **Budget**: $${budget.committedUsd.toFixed(2)} committed of $${budget.budgetUsd.toFixed(2)} in the last ${budget.windowHours}h; $${budget.remainingUsd.toFixed(2)} remaining.`,
        `- **Contract fingerprint**: \`${fp}\``,
        '',
        existing
          ? `⚠ **An identical run already exists** (${describeRun(existing)}). Calling \`research_start\` with this fingerprint returns that run instead of paying again.`
          : `Start it with \`research_start { question, tier: "${args.tier}", contractFingerprint: "${fp}" }\` — pass the same question, tier, scope and corpusStores or the fingerprint will not match.`,
        '',
        '### Operator notes',
        ...notes.map((n) => `- ${n}`),
        '',
        '### Prompt that will be sent',
        '```',
        resolved.prompt,
        '```',
      ].join('\n');
    },
  });

  // ──────────────────────────────────────────────────────── start (paid) ────
  server.addTool({
    name: 'research_start',
    description:
      'Start a Deep Research run. THIS SPENDS MONEY (~$1-3 fast, ~$3-7 max) and cannot be undone once the agent begins searching. Returns a run handle immediately — the run then proceeds in the background for 4-60 minutes and survives your disconnect. Identical requests inside the dedupe window return the existing run instead of paying twice.',
    annotations: {
      title: 'Start a research run (spends money)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      question: z.string().min(3).max(20_000).describe('The research question, or an already-engineered brief.'),
      tier: TierSchema.default('fast'),
      archetype: ArchetypeSchema.optional(),
      scope: ScopeSchema,
      corpusStores: CorpusSchema,
      collaborativePlanning: z
        .boolean()
        .default(false)
        .describe('Return a plan for approval before executing. Use for decision-critical runs.'),
      contractFingerprint: z
        .string()
        .max(128)
        .optional()
        .describe('The fingerprint from `research_plan`. Required when the server runs with DOSSIER_REQUIRE_CONTRACT=true.'),
      label: z.string().max(200).optional().describe('Short human label, shown in listings and the spend ledger.'),
      tags: z.array(z.string().max(60)).max(20).optional(),
      attachments: z
        .array(
          z.object({
            kind: z.enum(['document', 'image']),
            uri: z.string().url().max(2000),
            mimeType: z.string().max(120),
          }),
        )
        .max(10)
        .optional()
        .describe('Public URIs for multimodal inputs (PDFs, images) the researcher should read.'),
    }),
    execute: async (args, { log }) => {
      requireClient(deps);
      const resolved = resolvePrompt({
        question: args.question,
        ...(args.archetype ? { archetype: args.archetype } : {}),
        ...(args.scope ? { scope: args.scope } : {}),
        ...(args.corpusStores ? { corpusStores: args.corpusStores } : {}),
      });
      const tools = buildTools(args.corpusStores);
      const expected = runner.fingerprintFor({
        prompt: resolved.prompt,
        tier: args.tier,
        tools,
        collaborativePlanning: args.collaborativePlanning,
      });

      if (config.requireContract && !args.contractFingerprint) {
        throw new UserError(
          `This server requires the plan→start handshake. Call \`research_plan\` first and pass its contractFingerprint. (Expected for these arguments: ${expected})`,
        );
      }
      if (args.contractFingerprint && !fingerprintMatches(args.contractFingerprint, expected)) {
        throw new UserError(
          `Contract mismatch — the arguments changed since \`research_plan\`. Expected ${expected}, got ${args.contractFingerprint}. Re-plan, or drop contractFingerprint to start from these arguments.`,
        );
      }

      log.info('Starting deep research run', { tier: args.tier, archetype: resolved.archetype });

      const { run, deduped } = await runner.start({
        question: args.question,
        prompt: resolved.prompt,
        archetype: resolved.archetype,
        tier: args.tier,
        tools,
        collaborativePlanning: args.collaborativePlanning,
        thinkingSummaries: true,
        visualization: true,
        preEngineered: resolved.preEngineered,
        ...(args.label ? { label: args.label } : {}),
        ...(args.tags ? { tags: args.tags } : {}),
        ...(args.attachments ? { attachments: args.attachments } : {}),
      });

      const band = estimateCost(run.tier);
      const duration = estimateDuration(run.tier);

      if (deduped) {
        return [
          `**De-duplicated onto an existing run — nothing new was charged.**`,
          '',
          `- Handle: \`${run.id}\``,
          `- ${describeRun(run)}`,
          `- ${stateHint(run.state)}`,
        ].join('\n');
      }

      return [
        `**Run started.** Handle: \`${run.id}\``,
        '',
        `- State: ${run.state} — ${stateHint(run.state)}`,
        `- Tier: ${run.tier} · archetype: ${run.archetype}`,
        `- Committed against your budget: ~$${run.estimatedCostUsd.toFixed(2)} (band ${formatCostBand(band)})`,
        `- Expect it back in ${duration.lowMinutes}-${duration.highMinutes} minutes.`,
        '',
        'Do NOT block on this. Check back with `research_status { runId }`, or replay progress with `research_tail { runId }`. The run continues if you disconnect and if this server restarts.',
      ].join('\n');
    },
  });

  // ────────────────────────────────────────────────────── approve a plan ────
  server.addTool({
    name: 'research_approve_plan',
    description:
      'Approve (optionally amending) the research plan a collaborative-planning run proposed, releasing it to execute. Editing the plan here — pruning tangential branches, injecting missing angles, narrowing broad definitions — is the highest-leverage intervention available on a Deep Research run.',
    annotations: { title: 'Approve a research plan', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    parameters: z.object({
      runId: z.string().max(64),
      amendment: z
        .string()
        .max(10_000)
        .optional()
        .describe('Instructions that amend the proposed plan. Omit to approve it as proposed.'),
    }),
    execute: async (args) => {
      requireClient(deps);
      const run = await requireRun(deps, args.runId);
      if (run.planApproved) return `Run \`${run.id}\` is already approved (state: ${run.state}).`;
      if (!run.plan) {
        throw new UserError(
          `Run \`${run.id}\` has no plan yet (state: ${run.state}). Poll \`research_status\` until a plan appears.`,
        );
      }
      const updated = await runner.approvePlan(args.runId, args.amendment);
      if (!updated) throw new UserError(`Run \`${args.runId}\` disappeared.`);
      return `Plan approved${args.amendment ? ' with your amendment' : ' as proposed'}. \`${updated.id}\` is now ${updated.state}. ${stateHint(updated.state)}`;
    },
  });

  // ──────────────────────────────────────────────────────────────  status ────
  server.addTool({
    name: 'research_status',
    description:
      'Check one run, or all in-flight runs. Reports liveness separately from status: a run with no forward progress inside the watchdog window is marked `stalled`, which is a state you can branch on — `in_progress` alone cannot distinguish a thinking run from a dead one.',
    annotations: { title: 'Check research status', readOnlyHint: true, openWorldHint: true },
    parameters: z.object({
      runId: z.string().max(64).optional().describe('Omit to report every non-terminal run.'),
      refresh: z.boolean().default(true).describe('Poll the API before answering.'),
    }),
    execute: async (args) => {
      if (args.runId) {
        await requireRun(deps, args.runId);
        const run = args.refresh
          ? ((await runner.refresh(args.runId)) ?? (await requireRun(deps, args.runId)))
          : await requireRun(deps, args.runId);
        const idleMinutes = Math.round((Date.now() - Date.parse(run.lastProgressAt)) / 60_000);
        const lines = [
          `### \`${run.id}\` — ${run.state}`,
          '',
          `- ${stateHint(run.state)}`,
          `- Tier ${run.tier} · archetype ${run.archetype} · started ${run.createdAt}`,
          `- Last forward progress: ${idleMinutes} minute(s) ago`,
          `- Committed cost: ~$${run.estimatedCostUsd.toFixed(2)}`,
        ];
        if (run.label) lines.push(`- Label: ${run.label}`);
        if (run.title) lines.push(`- Title: ${run.title}`);
        if (run.summary) lines.push('', run.summary);
        if (run.plan && !run.planApproved) {
          lines.push('', '### Proposed plan (awaiting your approval)', '', run.plan.slice(0, 8000));
        }
        if (run.state === 'completed') {
          lines.push(
            '',
            `Report: ${run.reportChars} chars (~${Math.ceil(run.reportChars / 4)} estimated tokens) · ${run.sourceCount} cited sources.`,
            'Read it with `research_read { runId }` — outline first; it is far too large to return inline.',
          );
        }
        if (run.error) lines.push('', `**Error:** ${run.error}`);
        return lines.join('\n');
      }

      if (args.refresh) await runner.tick();
      const active = await store.activeRuns();
      const budget = await runner.budget();
      if (active.length === 0) {
        return `No runs in flight. Budget: $${budget.committedUsd.toFixed(2)} of $${budget.budgetUsd.toFixed(2)} committed in the last ${budget.windowHours}h.`;
      }
      return [
        `${active.length} run(s) in flight (max ${budget.maxConcurrent}):`,
        '',
        ...active.map((r) => `- ${describeRun(r)}${r.label ? ` — ${r.label}` : ''}`),
        '',
        `Budget: $${budget.committedUsd.toFixed(2)} of $${budget.budgetUsd.toFixed(2)} committed in the last ${budget.windowHours}h.`,
      ].join('\n');
    },
  });

  // ───────────────────────────────────────────────────────────────── tail ────
  server.addTool({
    name: 'research_tail',
    description:
      'Replay a run’s durable progress journal from a cursor — pass the returned cursor next time to get only what is new. A client that disconnected at minute 3 of a 45-minute run loses nothing. Note the timing: while a run is in flight the API reports no intermediate steps, so mid-run you see lifecycle events only (created, plan, progress, stalled); the researcher’s reasoning summaries all land in one batch when it completes. For reasoning as it happens you would need the SSE stream, which this server does not yet consume.',
    annotations: { title: 'Tail research progress', readOnlyHint: true, openWorldHint: true },
    parameters: z.object({
      runId: z.string().max(64),
      sinceSeq: z.number().int().min(-1).default(-1).describe('Return events after this sequence number. -1 for everything.'),
      limit: z.number().int().min(1).max(200).default(50),
      refresh: z.boolean().default(true),
    }),
    execute: async (args) => {
      await requireRun(deps, args.runId);
      if (args.refresh) await runner.refresh(args.runId);
      const events = await store.readJournal(args.runId, args.sinceSeq);
      const page = events.slice(0, args.limit);
      const run = await requireRun(deps, args.runId);
      if (page.length === 0) {
        return `No new events for \`${args.runId}\` after seq ${args.sinceSeq}. State: ${run.state}. Cursor unchanged.`;
      }
      const cursor = page.at(-1)?.seq ?? args.sinceSeq;
      return [
        `### \`${args.runId}\` — ${run.state} · ${page.length} event(s)`,
        '',
        ...page.map((e) => `**[${e.seq}] ${e.at} ${e.kind}** — ${e.message.slice(0, 2000)}`),
        '',
        `Next cursor: \`sinceSeq: ${cursor}\`${events.length > page.length ? ` (${events.length - page.length} more buffered)` : ''}`,
      ].join('\n');
    },
  });

  // ───────────────────────────────────────────────────────────────── read ────
  server.addTool({
    name: 'research_read',
    description:
      'Read a completed report WITHOUT blowing up your context. Defaults to an outline with per-section token estimates; pull individual sections by index or title, grep for a term, or take the full text under an explicit token budget. A Deep Research report is ~60k tokens — returning one inline is how a session dies.',
    annotations: { title: 'Read a research report', readOnlyHint: true, openWorldHint: false },
    parameters: z.object({
      runId: z.string().max(64),
      mode: z
        .enum(['outline', 'section', 'grep', 'summary', 'full'])
        .default('outline')
        .describe('outline = table of contents (default). section = one section. grep = search. summary = title + abstract. full = everything, capped by maxTokens.'),
      section: z.string().max(200).optional().describe('For mode "section": a 1-based index or a heading substring.'),
      pattern: z.string().max(500).optional().describe('For mode "grep": the search term.'),
      regex: z.boolean().default(false).describe('For mode "grep": treat the pattern as a regular expression.'),
      maxTokens: z.number().int().min(200).max(120_000).default(6_000).describe('Hard cap on the returned text. Truncation is always marked explicitly.'),
    }),
    execute: async (args) => {
      const run = await requireRun(deps, args.runId);
      const markdown = await store.readReport(args.runId);
      if (!markdown) {
        throw new UserError(
          `No report for \`${args.runId}\` yet (state: ${run.state}). ${stateHint(run.state)}`,
        );
      }

      switch (args.mode) {
        case 'summary': {
          const outline = outlineReport(markdown);
          const exec = outline.find((s) => /executive summary/i.test(s.title));
          const body = exec ? readSection(markdown, exec) : markdown.slice(0, 4000);
          return [
            run.title ? `# ${run.title}` : `# Report ${run.id}`,
            run.summary ? `\n${run.summary}\n` : '',
            `_${run.sourceCount} cited sources · ~${estimateTokens(markdown)} estimated tokens · ${outline.length} sections_`,
            '',
            clampToTokens(body, args.maxTokens).text,
          ].join('\n');
        }
        case 'outline':
          return renderOutline(markdown);
        case 'section': {
          if (!args.section) throw new UserError('mode "section" needs a `section` (index or heading substring).');
          const found = findSection(markdown, args.section);
          if (!found) {
            throw new UserError(
              `No section matching "${args.section}".\n\n${renderOutline(markdown)}`,
            );
          }
          const body = readSection(markdown, found);
          const clamped = clampToTokens(body, args.maxTokens);
          return `_Section ${found.index}/${outlineReport(markdown).length} · ~${found.estimatedTokens} estimated tokens_\n\n${clamped.text}`;
        }
        case 'grep': {
          if (!args.pattern) throw new UserError('mode "grep" needs a `pattern`.');
          const hits = grepReport(markdown, args.pattern, { regex: args.regex, maxHits: 60 });
          if (hits.length === 0) return `No matches for "${args.pattern}" in \`${run.id}\`.`;
          return [
            `${hits.length} match(es) for "${args.pattern}":`,
            '',
            ...hits.map((h) => `- **L${h.line}** _(${h.section})_ — ${h.text}`),
            '',
            'Read a whole section with `research_read { mode: "section", section: "<heading>" }`.',
          ].join('\n');
        }
        case 'full': {
          const clamped = clampToTokens(markdown, args.maxTokens);
          return clamped.truncated
            ? `${clamped.text}\n\n_Tip: \`mode: "outline"\` then \`mode: "section"\` reads the whole report without a single oversized response._`
            : clamped.text;
        }
        default: {
          const _exhaustive: never = args.mode;
          return _exhaustive;
        }
      }
    },
  });

  // ────────────────────────────────────────────────── verify citations ────
  server.addTool({
    name: 'research_verify_citations',
    description:
      'Dereference every URL the report cites and return a per-citation verdict (live / not_found / blocked / unreachable / invalid_url) plus a scorecard. A confidently fabricated citation is the failure that survives into production because nobody clicks. Note the honest limit: "live" means the URL resolves, not that the source supports the claim.',
    annotations: { title: 'Verify report citations', readOnlyHint: true, openWorldHint: true },
    parameters: z.object({
      runId: z.string().max(64),
      maxUrls: z.number().int().min(1).max(500).default(150),
      onlyProblems: z.boolean().default(true).describe('List only citations that failed to resolve.'),
    }),
    execute: async (args, { reportProgress, log }) => {
      const run = await requireRun(deps, args.runId);
      const markdown = await store.readReport(args.runId);
      if (!markdown) throw new UserError(`No report for \`${args.runId}\` (state: ${run.state}).`);

      await reportProgress({ progress: 0, total: 100 });
      log.info('Verifying citations', { runId: args.runId });
      const { verdicts, totalFound, checked } = await verifyCitations(markdown, {
        maxUrls: args.maxUrls,
      });
      await reportProgress({ progress: 100, total: 100 });

      const card = scoreCitations(verdicts);
      await store.saveRun({
        ...run,
        citations: verdicts,
        citationsCheckedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const problems = verdicts.filter((v) => v.verdict !== 'live');
      const shown = args.onlyProblems ? problems : verdicts;

      return [
        renderScorecard(card),
        totalFound > checked ? `\n(${totalFound} citations found; checked the first ${checked}.)` : '',
        '',
        shown.length === 0
          ? 'Every citation resolved.'
          : [
              `${args.onlyProblems ? 'Citations that did not resolve' : 'All citations'}:`,
              '',
              ...shown.map(
                (v) => `- **${v.verdict}**${v.httpStatus ? ` (${v.httpStatus})` : ''} — ${v.url}${v.note ? ` _(${v.note})_` : ''}`,
              ),
            ].join('\n'),
      ]
        .filter(Boolean)
        .join('\n');
    },
  });

  // ───────────────────────────────────────────────────────────── follow-up ────
  server.addTool({
    name: 'research_followup',
    description:
      'Ask a follow-up question against a completed report. Runs as a cheap single model turn continuing the original interaction — it does NOT start a new research run and does not re-search the web. Use it instead of re-reading a whole report into context.',
    annotations: { title: 'Ask a follow-up', readOnlyHint: true, openWorldHint: true },
    parameters: z.object({
      runId: z.string().max(64),
      question: z.string().min(3).max(4000),
    }),
    execute: async (args) => {
      const run = await requireRun(deps, args.runId);
      if (run.state !== 'completed') {
        throw new UserError(`\`${run.id}\` is ${run.state}, not completed. ${stateHint(run.state)}`);
      }

      // Continuing the original interaction keeps the researcher's own gathered
      // context; falling back to the stored markdown covers a run whose
      // interaction has aged out server-side.
      if (deps.client && run.interactionId) {
        const answer = await deps.client
          .followUp({
            question: args.question,
            previousInteractionId: run.interactionId,
            model: config.utilityModel,
          })
          .catch(() => null);
        if (answer) return answer;
      }

      const markdown = await store.readReport(args.runId);
      if (!markdown) throw new UserError(`No stored report for \`${args.runId}\`.`);
      if (!deps.utility) {
        throw new UserError(
          'Follow-up needs either a live interaction or a utility model. Set GEMINI_API_KEY, or read the report directly with `research_read`.',
        );
      }
      const answer = await deps.utility.answer(args.question, markdown);
      if (!answer.ok) {
        throw new UserError(
          `The follow-up model call failed: ${answer.error}. Read the report directly with \`research_read\`.`,
        );
      }
      return answer.value;
    },
  });

  // ───────────────────────────────────────────────────────────── claims ────
  server.addTool({
    name: 'research_claims',
    description:
      'Extract the report’s load-bearing claims as portable cards — claim, confidence qualifier, source URL. Small enough to pass between agents or into a downstream tool, where a whole report is not. Confidence is copied from the report, never re-assessed.',
    annotations: { title: 'Extract claim cards', readOnlyHint: true, openWorldHint: true },
    parameters: z.object({
      runId: z.string().max(64),
      limit: z.number().int().min(1).max(60).default(20),
    }),
    outputSchema: z.object({
      runId: z.string(),
      title: z.string().optional(),
      claims: z.array(
        z.object({
          claim: z.string(),
          confidence: z.enum(['high', 'medium', 'low']),
          sourceUrl: z.string().optional(),
          evidence: z.string().optional(),
        }),
      ),
    }),
    execute: async (args) => {
      const run = await requireRun(deps, args.runId);
      const markdown = await store.readReport(args.runId);
      if (!markdown) throw new UserError(`No report for \`${args.runId}\` (state: ${run.state}).`);
      if (!deps.utility) {
        throw new UserError(
          'Claim extraction needs a utility model (GEMINI_API_KEY). Read the Evidence Table instead: `research_read { mode: "section", section: "Evidence Table" }`.',
        );
      }
      const extracted = await deps.utility.extractClaims(markdown, args.limit);
      if (!extracted.ok) {
        throw new UserError(
          `Claim extraction failed: ${extracted.error}. The report is unaffected — read its Evidence Table instead: \`research_read { mode: "section", section: "Evidence Table" }\`.`,
        );
      }
      return {
        runId: run.id,
        ...(run.title ? { title: run.title } : {}),
        claims: extracted.value.claims.slice(0, args.limit),
      };
    },
  });

  // ─────────────────────────────────────────────────────── list / cancel ────
  server.addTool({
    name: 'research_list',
    description: 'List research runs, newest first, with state, tier, cost and title. Cheap — it reads the local store, not the API.',
    annotations: { title: 'List research runs', readOnlyHint: true, openWorldHint: false },
    parameters: z.object({
      state: z.enum(RUN_STATES).optional().describe('Filter by state.'),
      tag: z.string().max(60).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    execute: async (args) => {
      let runs = await store.listRuns();
      if (args.state) runs = runs.filter((r) => r.state === args.state);
      if (args.tag) runs = runs.filter((r) => r.tags.includes(args.tag as string));
      const page = runs.slice(0, args.limit);
      if (page.length === 0) return 'No runs match.';
      return [
        `${page.length} of ${runs.length} run(s):`,
        '',
        ...page.map((r) =>
          [
            `- \`${r.id}\` **${r.state}** · ${r.tier}/${r.archetype} · ~$${r.estimatedCostUsd.toFixed(2)}`,
            r.title ? `\n    ${r.title}` : r.label ? `\n    ${r.label}` : `\n    ${r.question.slice(0, 120)}`,
          ].join(''),
        ),
      ].join('\n');
    },
  });

  server.addTool({
    name: 'research_cancel',
    description: 'Cancel an in-flight run. The estimated cost already committed to the ledger is not refunded — Google bills for work already done.',
    annotations: { title: 'Cancel a research run', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    parameters: z.object({ runId: z.string().max(64) }),
    execute: async (args) => {
      const run = await requireRun(deps, args.runId);
      const cancelled = await runner.cancel(args.runId);
      if (!cancelled) throw new UserError(`Run \`${args.runId}\` disappeared.`);
      return cancelled.state === 'cancelled'
        ? `Cancelled \`${cancelled.id}\`. Committed spend (~$${cancelled.estimatedCostUsd.toFixed(2)}) stays on the ledger.`
        : `\`${run.id}\` was already ${cancelled.state}; nothing to cancel.`;
    },
  });

  // ───────────────────────────────────────────────────────────── budget ────
  server.addTool({
    name: 'research_budget',
    description:
      'Report the spend position: committed dollars in the rolling window, remaining headroom, runs in flight, and the top spenders. Read this before starting an expensive run — the gate refuses a run that would cross the ceiling, and this is how you see the wall before you hit it.',
    annotations: { title: 'Check the research budget', readOnlyHint: true, openWorldHint: false },
    parameters: z.object({}),
    execute: async () => {
      const snapshot = await runner.budget();
      const since = new Date(Date.now() - snapshot.windowHours * 3_600_000).toISOString();
      const entries = await store.readLedger(since);
      const top = [...entries].sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd).slice(0, 5);
      return [
        `### Spend, last ${snapshot.windowHours}h`,
        '',
        `- Committed: **$${snapshot.committedUsd.toFixed(2)}** of $${snapshot.budgetUsd.toFixed(2)}`,
        `- Remaining: **$${snapshot.remainingUsd.toFixed(2)}**`,
        `- Runs in window: ${snapshot.runsInWindow} · in flight now: ${snapshot.activeRuns}/${snapshot.maxConcurrent}`,
        snapshot.budgetUsd === 0 ? '- ⚠ The budget gate is DISABLED (DOSSIER_BUDGET_USD=0).' : '',
        '',
        top.length > 0 ? '**Largest commitments:**' : '',
        ...top.map((e) => `- $${e.estimatedCostUsd.toFixed(2)} · ${e.tier} · \`${e.runId}\`${e.label ? ` — ${e.label}` : ''}`),
        '',
        '_Costs are Google’s published per-task estimate bands, committed at start. They are a spend guardrail, not an invoice — reconcile against your Google billing for actuals._',
      ]
        .filter(Boolean)
        .join('\n');
    },
  });

  registerCorpusTools(server, deps);
  registerAgentTools(server, deps);
  registerResources(server, deps);
  registerPrompts(server);

  return server;
}

// ───────────────────────────────────────────────────── corpus (private docs) ────
function registerCorpusTools(server: FastMCP, deps: ServerDeps): void {
  function requireCorpus(): CorpusClient {
    if (!deps.corpus) {
      throw new UserError(
        'Corpus grounding needs a Gemini Developer API key (GEMINI_API_KEY). File Search stores are not available on Vertex.',
      );
    }
    return deps.corpus;
  }

  server.addTool({
    name: 'corpus_list',
    description: 'List the File Search stores available to ground research runs in your own documents.',
    annotations: { title: 'List corpus stores', readOnlyHint: true, openWorldHint: true },
    parameters: z.object({}),
    execute: async () => {
      const stores = await requireCorpus().listStores();
      if (stores.length === 0) {
        return 'No corpus stores. Create one with `corpus_create`, then add documents with `corpus_add_file`.';
      }
      return [
        `${stores.length} corpus store(s):`,
        '',
        ...stores.map(
          (s) =>
            `- \`${s.name}\`${s.displayName ? ` — ${s.displayName}` : ''} · ${s.activeDocuments ?? 0} active${s.pendingDocuments ? `, ${s.pendingDocuments} pending` : ''}`,
        ),
        '',
        'Pass a store name in `corpusStores` on `research_plan` / `research_start` to ground a run in it.',
      ].join('\n');
    },
  });

  server.addTool({
    name: 'corpus_create',
    description: 'Create a File Search store to hold private documents a research run can search alongside the public web.',
    annotations: { title: 'Create a corpus store', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    parameters: z.object({ displayName: z.string().min(1).max(200) }),
    execute: async (args) => {
      const store = await requireCorpus().createStore(args.displayName);
      return `Created \`${store.name}\`. Add documents with \`corpus_add_file { storeName: "${store.name}", filePath }\`.`;
    },
  });

  server.addTool({
    name: 'corpus_add_file',
    description:
      'UPLOAD a local file to a File Search store so research runs can search it. This sends the file’s contents to Google — it leaves your machine. Only add documents you are willing to disclose to a third-party API.',
    annotations: { title: 'Upload a document to a corpus (sends data to Google)', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    parameters: z.object({
      storeName: z.string().max(300).describe('fileSearchStores/… from `corpus_list`.'),
      filePath: z.string().max(2000).describe('Absolute path to a local file (max 100 MB).'),
      displayName: z.string().max(200).optional(),
      mimeType: z.string().max(120).optional(),
    }),
    execute: async (args) => {
      const result = await requireCorpus().uploadFile({
        storeName: args.storeName,
        filePath: args.filePath,
        ...(args.displayName ? { displayName: args.displayName } : {}),
        ...(args.mimeType ? { mimeType: args.mimeType } : {}),
      });
      return `Uploaded "${result.displayName}" to \`${args.storeName}\`. Indexing may take a moment; \`corpus_list\` shows the pending count.`;
    },
  });

  server.addTool({
    name: 'corpus_delete',
    description: 'Delete a File Search store and every document in it. Irreversible.',
    annotations: { title: 'Delete a corpus store', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    parameters: z.object({ storeName: z.string().max(300) }),
    execute: async (args) => {
      await requireCorpus().deleteStore(args.storeName);
      return `Deleted \`${args.storeName}\` and its documents.`;
    },
  });
}

// ──────────────────────────────────────────── managed agents (the other API) ────
function registerAgentTools(server: FastMCP, deps: ServerDeps): void {
  function requireAgents(): AgentsClient {
    if (!deps.agents) {
      throw new UserError(
        `Managed Agents need Gemini credentials (${describeAuth(deps.config)}). Set GEMINI_API_KEY or VERTEX_PROJECT.`,
      );
    }
    return deps.agents;
  }

  server.addTool({
    name: 'agent_create',
    description:
      'Create a PERSISTED custom research agent (the Managed Agents API — the other Gemini research surface). Unlike a Deep Research run, this gives you a reusable agent with a Linux sandbox that can run code, write files, and carry your house methodology across every run. Constraint worth knowing: at preview the only base agent is Antigravity — you cannot derive a custom agent from deep-research-*. See docs/deep-research-api-vs-agent.md for which surface fits your job.',
    annotations: { title: 'Create a managed research agent', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    parameters: z.object({
      id: z.string().min(1).max(63).describe('Lowercase id, unique in your project. Cannot start with a Google-reserved prefix (gemini-, google-, antigravity-, …).'),
      description: z.string().max(500).optional(),
      systemInstruction: z
        .string()
        .max(20_000)
        .optional()
        .describe('Persona and method. Omit to use this server’s research instruction (source discipline, confidence qualifiers, inline citation, epistemic bounding).'),
      model: z.string().max(100).optional().describe('e.g. gemini-3.6-flash. Fixed once the agent exists.'),
      instructionsFile: z
        .string()
        .max(20_000)
        .optional()
        .describe('Contents mounted at .agents/AGENTS.md — additive with systemInstruction.'),
      skillsRepository: z
        .string()
        .max(500)
        .optional()
        .describe('Git URL cloned to .agents/skills, auto-discovered as skills by the harness.'),
      networkAllowlist: z
        .array(z.string().max(200))
        .max(30)
        .optional()
        .describe('Restrict the sandbox’s outbound domains. Omit for unrestricted (the default).'),
    }),
    execute: async (args) => {
      const sources = [
        ...(args.instructionsFile
          ? [{ type: 'inline' as const, target: '.agents/AGENTS.md', content: args.instructionsFile }]
          : []),
        ...(args.skillsRepository
          ? [{ type: 'repository' as const, target: '.agents/skills', source: args.skillsRepository }]
          : []),
      ];
      const agent = await requireAgents().create({
        id: args.id,
        systemInstruction: args.systemInstruction ?? RESEARCH_AGENT_INSTRUCTION,
        ...(args.description ? { description: args.description } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(sources.length > 0 ? { sources } : {}),
        ...(args.networkAllowlist
          ? { networkAllowlist: args.networkAllowlist.map((domain) => ({ domain })) }
          : {}),
      });
      return [
        `Created managed agent \`${agent.id}\` (base: ${DEFAULT_BASE_AGENT}).`,
        '',
        `Run it with \`agent_run { agentId: "${agent.id}", input }\`. Every run forks the base environment, so each starts clean unless you pass a prior \`environmentId\`.`,
      ].join('\n');
    },
  });

  server.addTool({
    name: 'agent_list',
    description: 'List the managed agents in your project.',
    annotations: { title: 'List managed agents', readOnlyHint: true, openWorldHint: true },
    parameters: z.object({}),
    execute: async () => {
      const agents = await requireAgents().list();
      if (agents.length === 0) return 'No managed agents. Create one with `agent_create`.';
      return [`${agents.length} managed agent(s):`, '', ...agents.map((a) => `- \`${a.id}\`${a.description ? ` — ${a.description}` : ''}`)].join('\n');
    },
  });

  server.addTool({
    name: 'agent_run',
    description:
      'Run a task on a managed agent in its Linux sandbox. Synchronous — it blocks until the agent finishes (default 5 min cap), unlike Deep Research which is always background. Use this when the job has to produce FILES or run code over data; use `research_start` when you want a cited research report.',
    annotations: { title: 'Run a managed agent (spends money)', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    parameters: z.object({
      agentId: z.string().max(63),
      input: z.string().min(1).max(50_000),
      environmentId: z
        .string()
        .max(200)
        .optional()
        .describe('Resume a prior sandbox (keeps files and installed packages). Omit for a fresh one.'),
      previousInteractionId: z.string().max(200).optional().describe('Carry conversation history forward.'),
      timeoutSeconds: z.number().int().min(30).max(900).default(300),
    }),
    execute: async (args, { log }) => {
      log.info('Running managed agent', { agentId: args.agentId });
      const result = await requireAgents().run({
        agentId: args.agentId,
        input: args.input,
        timeoutMs: args.timeoutSeconds * 1000,
        ...(args.environmentId ? { environment: args.environmentId } : {}),
        ...(args.previousInteractionId ? { previousInteractionId: args.previousInteractionId } : {}),
      });
      return [
        result.outputText || '(the agent returned no text output)',
        '',
        '---',
        `_interactionId: \`${result.interactionId}\` · environmentId: \`${result.environmentId}\` — pass either back to continue._`,
      ].join('\n');
    },
  });

  server.addTool({
    name: 'agent_delete',
    description: 'Delete a managed agent’s configuration. Past interactions and environments survive.',
    annotations: { title: 'Delete a managed agent', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    parameters: z.object({ agentId: z.string().max(63) }),
    execute: async (args) => {
      await requireAgents().remove(args.agentId);
      return `Deleted managed agent \`${args.agentId}\`. Its environments and past interactions are untouched.`;
    },
  });
}

// ───────────────────────────────────────────────────────────────── resources ────
function registerResources(server: FastMCP, deps: ServerDeps): void {
  const { config, store, runner } = deps;

  server.addResource({
    uri: 'research://capabilities',
    name: 'Server capabilities',
    mimeType: 'application/json',
    async load() {
      const budget = await runner.budget();
      return {
        text: JSON.stringify(
          {
            version,
            auth: describeAuth(config),
            degraded: !deps.client,
            tiers: RESEARCH_TIERS.map((tier) => ({
              tier,
              agent: AGENT_BY_TIER[tier],
              cost: estimateCost(tier),
              duration: estimateDuration(tier),
            })),
            archetypes: ARCHETYPE_NAMES.map((name) => ({
              name,
              useWhen: ARCHETYPE_OVERRIDES[name].useWhen,
            })),
            features: {
              corpusGrounding: Boolean(deps.corpus),
              managedAgents: Boolean(deps.agents),
              utilityModel: Boolean(deps.utility),
              contractRequired: config.requireContract,
            },
            budget,
            storeDir: config.storeDir,
          },
          null,
          2,
        ),
      };
    },
  });

  server.addResource({
    uri: 'research://budget',
    name: 'Spend ledger',
    mimeType: 'application/json',
    async load() {
      const snapshot = await runner.budget();
      const since = new Date(Date.now() - snapshot.windowHours * 3_600_000).toISOString();
      return { text: JSON.stringify({ ...snapshot, entries: await store.readLedger(since) }, null, 2) };
    },
  });

  server.addResource({
    uri: 'research://runs',
    name: 'Research runs index',
    mimeType: 'application/json',
    async load() {
      const runs = await store.listRuns();
      return {
        text: JSON.stringify(
          runs.map((r) => ({
            id: r.id,
            state: r.state,
            tier: r.tier,
            archetype: r.archetype,
            title: r.title ?? r.label ?? r.question.slice(0, 120),
            createdAt: r.createdAt,
            estimatedCostUsd: r.estimatedCostUsd,
            sourceCount: r.sourceCount,
          })),
          null,
          2,
        ),
      };
    },
  });

  server.addResourceTemplate({
    uriTemplate: 'research://run/{runId}',
    name: 'Research run record',
    mimeType: 'application/json',
    arguments: [{ name: 'runId', description: 'The run handle', required: true }],
    async load({ runId }) {
      const run = await store.getRun(runId);
      if (!run) return { text: JSON.stringify({ error: `No run ${runId}` }) };
      // The engineered prompt can be 6k characters — the record stays scannable.
      const { prompt, ...rest } = run;
      return { text: JSON.stringify({ ...rest, promptChars: prompt.length }, null, 2) };
    },
  });

  server.addResourceTemplate({
    uriTemplate: 'research://run/{runId}/report',
    name: 'Research report (markdown)',
    mimeType: 'text/markdown',
    arguments: [{ name: 'runId', description: 'The run handle', required: true }],
    async load({ runId }) {
      const markdown = await store.readReport(runId);
      return { text: markdown ?? `# No report\n\nRun \`${runId}\` has not produced a report.` };
    },
  });

  server.addResourceTemplate({
    uriTemplate: 'research://run/{runId}/citations',
    name: 'Citation scorecard',
    mimeType: 'application/json',
    arguments: [{ name: 'runId', description: 'The run handle', required: true }],
    async load({ runId }) {
      const run = await store.getRun(runId);
      if (!run?.citations) {
        return {
          text: JSON.stringify({
            runId,
            checked: false,
            hint: 'Run `research_verify_citations` first.',
          }),
        };
      }
      return {
        text: JSON.stringify(
          {
            runId,
            checkedAt: run.citationsCheckedAt,
            scorecard: scoreCitations(run.citations),
            verdicts: run.citations,
          },
          null,
          2,
        ),
      };
    },
  });
}

// ─────────────────────────────────────────────────────────────────── prompts ────
function registerPrompts(server: FastMCP): void {
  server.addPrompt({
    name: 'deep-research-brief',
    description:
      'Turn a vague research need into a fully engineered Deep Research brief, using the bundled prompt-architect framework (pseudo-XML scaffold, archetype overrides, epistemic bounding, inline citation protocol). Paste the result straight into `research_start`.',
    arguments: [
      { name: 'need', description: 'The research need, however loosely stated', required: true },
      {
        name: 'archetype',
        description: 'technical | competitive | regulatory | academic | forecasting (omit to auto-select)',
        required: false,
        enum: [...ARCHETYPE_NAMES],
      },
      { name: 'decisionContext', description: 'What you will do with the findings', required: false },
      { name: 'jurisdiction', description: 'Jurisdiction or geography', required: false },
      { name: 'timeHorizon', description: 'Time window and forward outlook', required: false },
    ],
    load: async (args) => {
      const archetype = ARCHETYPE_NAMES.find((a) => a === args.archetype);
      const built = buildPrompt({
        question: args.need ?? '',
        ...(archetype ? { archetype } : {}),
        scope: {
          ...(args.decisionContext ? { decisionContext: args.decisionContext } : {}),
          ...(args.jurisdiction ? { jurisdiction: args.jurisdiction } : {}),
          ...(args.timeHorizon ? { timeHorizon: args.timeHorizon } : {}),
        },
      });
      const notes = operatorNotes({
        archetype: built.archetype,
        tier: 'fast',
        collaborativePlanning: true,
        hasCorpus: false,
        questionLength: (args.need ?? '').length,
      });
      return [
        `Here is an engineered Deep Research brief (archetype: **${built.archetype}**).`,
        '',
        'Before running it, check three things: is the core directive the question you actually want answered; does the scope exclude what you do not want; and is the decision context specific enough to drive the analysis lens. Then run it with `research_start`.',
        '',
        '```',
        built.prompt,
        '```',
        '',
        '**Operator notes**',
        ...notes.map((n) => `- ${n}`),
      ].join('\n');
    },
  });

  server.addPrompt({
    name: 'research-red-team',
    description:
      'Adversarially audit a completed report. Secondary-model validation catches the failure modes the producing model cannot see in itself — stripped sources, aggregator reliance, confidence inflation.',
    arguments: [{ name: 'runId', description: 'The completed run handle', required: true }],
    load: async (args) => {
      return [
        `Red-team the report from run \`${args.runId}\`.`,
        '',
        'Work in this order, and do not summarise the report — audit it:',
        '',
        '1. `research_verify_citations { runId, onlyProblems: true }`. Any `not_found` or `invalid_url` verdict on a citation attached to a quantitative claim invalidates that claim until it is re-sourced.',
        '2. `research_read { runId, mode: "section", section: "Evidence Table" }`. Every major claim should appear here with a specific source and date. Claims in the prose that are absent from the table are unsupported — list them.',
        '3. `research_read { runId, mode: "grep", pattern: "High Confidence" }`. For each, ask whether the cited evidence actually supports that confidence level, or whether a single secondary source has been dressed up as consensus.',
        '4. `research_read { runId, mode: "section", section: "Knowledge Gaps" }`. A report with no acknowledged gaps has hidden them, not avoided them. Name what is missing that the gaps section does not.',
        '5. Check for aggregator reliance: `research_read { runId, mode: "grep", pattern: "SECONDARY" }` and scan cited domains for listicles, content farms, and vendor comparison pages presented as evidence.',
        '',
        'Report: claims you would act on, claims you would not, and the specific re-sourcing each rejected claim needs.',
      ].join('\n');
    },
  });

  server.addPrompt({
    name: 'research-triage',
    description: 'Decide whether a question warrants a Deep Research run at all, and at which tier — before spending $1-7 and up to an hour.',
    arguments: [{ name: 'question', description: 'The question you are considering researching', required: true }],
    load: async (args) => {
      const question = args.question ?? '';
      return [
        `Triage this before spending anything: "${question}"`,
        '',
        'Deep Research costs $1-7 and takes 4-60 minutes. Answer these in order and state the verdict plainly:',
        '',
        '1. **Would a single model call answer it?** Definitions, known APIs, settled facts, anything in your training data — answer it directly and stop. Most questions land here.',
        '2. **Would one web search answer it?** A current price, a version number, a single document — search, do not research.',
        '3. **Does it need synthesis across many sources, with citations someone will act on?** That is the actual case for Deep Research.',
        '4. **Tier**: `fast` for a scoped question with a handful of sub-questions. `max` only when breadth genuinely warrants roughly double the searches and double the cost.',
        '5. **Scope check**: is this one archetype (technical / competitive / regulatory / academic / forecasting), or two? Two is a decomposition trigger — split it into separate runs rather than widening one prompt.',
        '',
        `Then either answer directly, or call \`research_plan { question: "${question.slice(0, 200).replace(/"/g, "'")}" }\` and review the cost band before starting.`,
      ].join('\n');
    },
  });
}

/** Assemble every dependency from the environment. */
export async function buildDeps(config: Config = loadConfig()): Promise<ServerDeps> {
  const store = new Store(config.storeDir);
  await store.init();

  const client = resolveClient(config);
  const utility = createUtilityModel(config);

  const runner = new Runner(store, config, client, async (run, markdown) => {
    if (!utility) return;
    const summary = await utility.summarise(markdown);
    const current = await store.getRun(run.id);
    if (!current) return;
    if (!summary.ok) {
      // Non-fatal by design, but recorded: the report is already safe on disk,
      // and the journal is where someone will look when a title is missing.
      await store.appendJournal(run.id, 'note', `Title/summary generation failed: ${summary.error}`);
      return;
    }
    await store.saveRun({ ...current, title: summary.value.title, summary: summary.value.summary });
  });

  return {
    config,
    store,
    runner,
    client,
    corpus: resolveCorpusClient(config),
    agents: resolveAgentsClient(config),
    utility,
  };
}
