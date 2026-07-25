import { timingSafeEqual } from 'node:crypto';
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { createUtilityModel, type UtilityModel } from './ai/utility.js';
import { backendLimitations, describeAuth, loadConfig, type Config } from './config.js';
import { assertStoreName, resolveCorpusClient, type CorpusClient } from './corpus/files.js';
import { LocalCorpus } from './corpus/local.js';
import { probeAllClis } from './local/cli.js';
import {
  DEFAULT_BASE_AGENT,
  RESEARCH_AGENT_INSTRUCTION,
  resolveAgentsClient,
  type AgentsClient,
} from './gemini/agents.js';
import { resolveClient, type DeepResearchClient, type ResearchToolSpec } from './gemini/client.js';
import { ProviderRegistry } from './providers/registry.js';
import { describeShaping, shapeRequest } from './providers/options.js';
import { PROVIDER_IDS, type ProviderId, type Shape } from './providers/types.js';
import { estimateCost, estimateDuration, formatCostBand, formatDuration } from './gemini/cost.js';
import { AGENT_BY_TIER, RESEARCH_TIERS } from './gemini/types.js';
import { ARCHETYPE_NAMES, ARCHETYPE_OVERRIDES, selectArchetype, type Archetype } from './research/archetypes.js';
import { renderScorecard, scoreCitations, verifyCitations } from './research/citations.js';
import { safeFetch } from './net/safe-fetch.js';
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
import { canonicaliseUrl, crossCheck, type ProviderClaimSet } from './research/corroborate.js';
import { decompose, renderTasks } from './research/decompose.js';
import {
  FindingSchema,
  freezeRegistry,
  mergeFindings,
  renderRegistry,
  SessionSchema,
  validateDraft,
  type Session,
} from './research/local-loop.js';
import {
  buildRegistry,
  classifySource,
  profileEvidence,
  renderProfile,
  renderTrace,
} from './research/evidence.js';
import { describeRun, Runner, stateHint } from './research/runner.js';
import {
  buildWidePrompt,
  DEFAULT_WINDOW,
  parseWideTable,
  renderWideTable,
  validateWide,
  WideSpecSchema,
  WINDOWS,
  type Window,
} from './research/shapes.js';
import { Store } from './store/store.js';
import { RUN_STATES, type RunRecord } from './store/types.js';
import { version } from './version.js';

/**
 * The public library surface.
 *
 * `dossier-research-mcp/server` is the documented import path, and until now it
 * exposed only `createServer` and `buildDeps` while the README told people to
 * import `buildPrompt` from it. Re-exported here so the documented API is the
 * real one; a consumer wanting the prompt architect, the report reader or the
 * citation verifier should not have to reach past `exports` to get them.
 */
export {
  buildPrompt,
  extractCoreDirective,
  isPreEngineered,
  operatorNotes,
  type BuildPromptArgs,
  type BuiltPrompt,
  type ResearchScope,
} from './research/prompt.js';
export {
  ARCHETYPE_NAMES,
  ARCHETYPE_OVERRIDES,
  selectArchetype,
  type Archetype,
} from './research/archetypes.js';
export {
  clampToTokens,
  estimateTokens,
  extractCitedUrls,
  findSection,
  grepReport,
  normaliseCitations,
  outlineReport,
  readSection,
  renderOutline,
  type ReportSection,
} from './research/report.js';
export {
  renderScorecard,
  scoreCitations,
  verifyCitations,
  type CitationScorecard,
} from './research/citations.js';
export { extractPlan, type ExtractedPlan } from './research/plan.js';
export {
  estimateCost,
  estimateDuration,
  formatCostBand,
  formatDuration,
  type CostBand,
  type DurationEstimate,
} from './gemini/cost.js';
export { AGENT_BY_TIER, RESEARCH_TIERS, type ResearchTier } from './gemini/types.js';
export { backendLimitations, describeAuth, loadConfig, type Config } from './config.js';

/** Everything the tools need, assembled once at start-up. */
export interface ServerDeps {
  readonly config: Config;
  readonly store: Store;
  readonly runner: Runner;
  readonly client: DeepResearchClient | null;
  readonly corpus: CorpusClient | null;
  readonly agents: AgentsClient | null;
  readonly utility: UtilityModel | null;
  /** Every backend Dossier knows about, and which are usable. */
  readonly providers: ProviderRegistry;
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

/**
 * Every follow-up answer carries this.
 *
 * A follow-up conditions on a finished report, so an error in the report
 * becomes a premise of the answer, and the answer then reads as independent
 * corroboration of the error. Iterative refinement amplifying an initial
 * inaccuracy is a documented failure of interactive research workflows, and it
 * is invisible precisely because the second answer sounds like a second
 * opinion. Marking every follow-up as inference over one report is the honest
 * floor: cheap, always true, and it stops a restated claim from reading as a
 * confirmed one.
 */
export const FOLLOWUP_CAVEAT =
  '---\n\n_**synthesised** — this is inference over one existing report, not new research. It inherits that report’s errors and cannot raise a claim’s confidence: a finding that was single-source there is still single-source here, however confidently it is restated._';

/**
 * The context a follow-up answers from: the report, plus the frozen registry.
 *
 * Exported so the tool and its test share one implementation rather than one
 * behaviour and one description of it.
 */
export function followUpContext(markdown: string): string {
  const registry = buildRegistry(markdown);
  if (registry.length === 0) return markdown;
  return `${markdown}\n\n---\n\nCitation registry (cite ONLY from this list; do not introduce a source that is not on it):\n${registry
    .map((e) => `${String(e.n)}. ${e.url}`)
    .join('\n')}`;
}

/**
 * Check the credentials of the backend that will run, not Gemini's.
 *
 * `requireClient` asks whether Gemini is configured, which is the wrong
 * question for every other provider and produced the worst possible answer: a
 * caller who had deliberately configured OpenAI was told they had no Gemini
 * credentials.
 */
function requireProviderClient(deps: ServerDeps, id: ProviderId): void {
  const provider = deps.providers.get(id);
  if (!provider) {
    throw new UserError(`Unknown provider "${id}". Run \`research_doctor\` to see what is configured.`);
  }
  const status = provider.detect();
  if (status.state === 'not-configured') {
    throw new UserError(
      `No usable credentials for ${provider.label}: ${status.detail}.${status.fix ? ` ${status.fix}.` : ''} ` +
        'Run `research_doctor` to see which backends are configured and what each one would need.',
    );
  }
}

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
}): { prompt: string; archetype: Archetype; preEngineered: boolean; warnings?: readonly string[] } {
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
  return {
    prompt,
    archetype: built.archetype,
    preEngineered: built.preEngineered,
    ...(built.warnings ? { warnings: built.warnings } : {}),
  };
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
    // The scheme is required, not optional. An Authorization header without
    // one is malformed per RFC 7235, and accepting a bare token means a
    // client sending the wrong header shape still authenticates, which hides
    // the mistake until something else depends on the shape.
    const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
    const presented = Buffer.from(match?.[1] ?? '');
    const ok =
      presented.length > 0 &&
      expected.some(
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
      provider: z
        .enum(PROVIDER_IDS)
        .optional()
        .describe('Plan for a specific backend. Omit to see which one routing would pick.'),
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
        .describe('Multimodal inputs the run will read. Part of the contract: a document added after planning changes the purchase.'),
    }),
    execute: async (args) => {
      const resolved = resolvePrompt({
        question: args.question,
        ...(args.archetype ? { archetype: args.archetype } : {}),
        ...(args.scope ? { scope: args.scope } : {}),
        ...(args.corpusStores ? { corpusStores: args.corpusStores } : {}),
      });
      const tools = buildTools(args.corpusStores);
      const routingForPlan = deps.providers.route({
        shape: 'deep',
        corpus: (args.corpusStores?.length ?? 0) > 0,
        planReview: args.collaborativePlanning,
        estimateInput: { tier: args.tier, tools: tools.map((x) => x.type) },
      });
      // The contract binds the backend too. A plan that priced Gemini and a
      // start that ran OpenAI are different purchases, and the handshake exists
      // to stop exactly that kind of substitution going unnoticed.
      const plannedProvider = args.provider ?? routingForPlan.provider?.id;
      const fp = runner.fingerprintFor({
        prompt: resolved.prompt,
        tier: args.tier,
        tools,
        collaborativePlanning: args.collaborativePlanning,
        ...(plannedProvider ? { provider: plannedProvider } : {}),
        ...(args.attachments ? { attachments: args.attachments } : {}),
      });
      const estimateInput = {
        tier: args.tier,
        tools: tools.map((t) => t.type),
        collaborativePlanning: args.collaborativePlanning,
      };
      const band = estimateCost(estimateInput);
      const duration = estimateDuration(estimateInput);
      const budget = await runner.budget();
      const routing = deps.providers.route({
        shape: 'deep',
        corpus: (args.corpusStores?.length ?? 0) > 0,
        planReview: args.collaborativePlanning,
        estimateInput: estimateInput,
      });
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
        `- **Estimated duration**: ${formatDuration(duration)}.`,
        `- **Sources it will consult**: ${duration.sources.join(' · ')}`,
        `- **What drives that estimate**: ${duration.factors.join('; ')}`,
        `- **Tools**: ${tools.map((t) => t.type).join(', ')}`,
        `- **Plan review**: ${args.collaborativePlanning ? 'ON — you will approve a plan before the run executes' : 'OFF — the run executes autonomously'}`,
        `- **Budget**: $${budget.committedUsd.toFixed(2)} committed of $${budget.budgetUsd.toFixed(2)} in the last ${budget.windowHours}h; $${budget.remainingUsd.toFixed(2)} remaining.`,
        `- **Backend**: ${routing.provider ? routing.provider.label : 'none available'} — ${routing.reason}`,
        ...(routing.runnerUp ? [`- **Runner-up**: ${routing.runnerUp.label}`] : []),
        ...(routing.rejected.length > 0
          ? [`- **Not eligible**: ${routing.rejected.map((r) => `${r.id} (${r.why})`).join('; ')}`]
          : []),
        `- **Contract fingerprint**: \`${fp}\``,
        ...(resolved.warnings ?? []).map((w: string) => `\n> [!WARNING]\n> ${w}`),
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
      provider: z
        .enum(PROVIDER_IDS)
        .optional()
        .describe(
          'Which backend runs this. Omit to let Dossier route on capability (a hard requirement like a date window or an editable plan eliminates backends that cannot do it, then cost breaks the tie). Run `research_doctor` to see what is configured.',
        ),
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
      // Validate the request before checking credentials. Both are guards, but
      // only one is the caller's actual problem when the arguments are wrong,
      // and reporting "no credentials" for a contract mismatch hides the bug
      // the handshake exists to catch. Cheap local checks first (CP §6.1).
      const resolved = resolvePrompt({
        question: args.question,
        ...(args.archetype ? { archetype: args.archetype } : {}),
        ...(args.scope ? { scope: args.scope } : {}),
        ...(args.corpusStores ? { corpusStores: args.corpusStores } : {}),
      });
      const tools = buildTools(args.corpusStores);
      // Resolve the backend the same way planning did, so the fingerprint
      // matches and the credential check is against the provider that will
      // actually run. Checking Gemini's credentials for an OpenAI run reported
      // "no Gemini credentials" to somebody who had deliberately configured
      // OpenAI, and omitting `provider` silently started Gemini even when
      // planning had recommended something else.
      const routing = deps.providers.route({
        shape: 'deep',
        corpus: (args.corpusStores?.length ?? 0) > 0,
        planReview: args.collaborativePlanning,
        estimateInput: { tier: args.tier, tools: tools.map((x) => x.type) },
      });
      const chosen = args.provider ?? routing.provider?.id ?? 'gemini';
      const expected = runner.fingerprintFor({
        prompt: resolved.prompt,
        tier: args.tier,
        tools,
        collaborativePlanning: args.collaborativePlanning,
        provider: chosen,
        ...(args.attachments ? { attachments: args.attachments } : {}),
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

      requireProviderClient(deps, chosen);
      log.info('Starting deep research run', { tier: args.tier, archetype: resolved.archetype, provider: chosen });

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
        provider: chosen,
        ...(args.label ? { label: args.label } : {}),
        ...(args.tags ? { tags: args.tags } : {}),
        ...(args.attachments ? { attachments: args.attachments } : {}),
      });

      const startEstimate = {
        tier: run.tier,
        tools: tools.map((x) => x.type),
        attachments: args.attachments?.length ?? 0,
        collaborativePlanning: run.state === 'planning',
      };
      const backend = deps.providers.get(chosen);
      const estimated = backend?.estimate(startEstimate);
      const band = estimated?.cost ?? estimateCost(startEstimate);
      const duration = estimated?.duration ?? estimateDuration(startEstimate);
      const budgetAfter = await runner.budget();

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
        `- Backend: ${backend?.label ?? chosen}`,
        `- Tier: ${run.tier} · archetype: ${run.archetype}`,
        `- **Estimated cost**: ${formatCostBand(band)} — ${band.basis}. Reserved at the top of that band against your daily ceiling; an estimate, never a quote.`,
        `- **Budget after this run**: $${budgetAfter.remainingUsd.toFixed(2)} of $${budgetAfter.budgetUsd.toFixed(2)} left in the next ${budgetAfter.windowHours}h.`,
        `- **Estimated duration**: ${formatDuration(duration)}.`,
        `- Consulting: ${duration.sources.join(' · ')}`,
        `- Worth checking again after **${new Date(Date.now() + duration.lowMinutes * 60_000).toISOString().slice(11, 16)} UTC**; treat anything past ${duration.highMinutes} minutes as slow.`,
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
      // Local preconditions first. Checking credentials before these means a
      // caller whose run simply has no plan yet is told about credentials,
      // which is true but is not their problem.
      const run = await requireRun(deps, args.runId);
      if (run.planApproved) return `Run \`${run.id}\` is already approved (state: ${run.state}).`;
      if (!run.plan) {
        throw new UserError(
          `Run \`${run.id}\` has no plan yet (state: ${run.state}). Poll \`research_status\` until a plan appears.`,
        );
      }
      requireClient(deps);
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
        const live: string[] = [];
        if (run.reasoningSteps > 0) live.push(`${run.reasoningSteps} reasoning steps`);
        if (run.streamedChars > 0) live.push(`${run.streamedChars} chars of report streamed`);
        // Deep Research emits no tool-call deltas, so these stay at zero for a
        // research run. Kept because managed agents share the event vocabulary.
        if (run.searches > 0) live.push(`${run.searches} searches`);
        if (run.corpusQueries > 0) live.push(`${run.corpusQueries} corpus queries`);
        if (live.length > 0) lines.push(`- Live progress: ${live.join(' · ')}`);
        if (run.streamAbandoned) {
          lines.push(
            '- Live progress stream dropped and could not be re-established; the run continues on polling, so these counters have stopped moving.',
          );
        }
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
    // Not read-only: a follow-up invokes the utility model, which bills.
    annotations: { title: 'Ask a follow-up', readOnlyHint: false, openWorldHint: true },
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
      //
      // Two things this used to get wrong. It always used `deps.client`, which
      // is Gemini, so a Perplexity run's interaction id was sent to Google:
      // guaranteed to fail, and the failure was swallowed. And a *successful*
      // native follow-up never touched the ledger, so the one path that
      // reliably bills was the one path that never recorded it.
      const backend = deps.providers.get(run.provider);
      const nativeFollowUp = backend?.capabilities.followUp === true;
      if (nativeFollowUp && run.interactionId) {
        const client = (() => {
          try {
            return backend?.client() ?? null;
          } catch {
            return null;
          }
        })();
        if (client) {
          // Reserve BEFORE the call, like every other billed path. A reservation
          // after the fact is a record, not a gate.
          await deps.runner.reserveUtilitySpend(`followup:${args.runId}`);
          const answer = await client
            .followUp({
              question: args.question,
              previousInteractionId: run.interactionId,
              model: config.utilityModel,
            })
            .catch(() => null);
          if (answer) return `${answer}\n\n${FOLLOWUP_CAVEAT}`;
          // The call may have reached the provider and billed, so the fallback
          // below reserves separately rather than assuming this one was free.
        }
      }

      const markdown = await store.readReport(args.runId);
      if (!markdown) throw new UserError(`No stored report for \`${args.runId}\`.`);
      if (!deps.utility) {
        throw new UserError(
          'Follow-up needs either a live interaction or a utility model. Set GEMINI_API_KEY, or read the report directly with `research_read`.',
        );
      }
      // Billed. Reserve against the same ceiling as everything else before calling.
      await deps.runner.reserveUtilitySpend(`followup:${args.runId}`);
      // The registry rides along with the report. A follow-up conditions on the
      // report, so an error in the report becomes a premise of the answer and
      // the answer then reads as independent corroboration of the error;
      // pointing the model at the numbered sources is the cheap mitigation.
      const answer = await deps.utility.answer(args.question, followUpContext(markdown));
      if (!answer.ok) {
        throw new UserError(
          `The follow-up model call failed: ${answer.error}. Read the report directly with \`research_read\`.`,
        );
      }
      return `${answer.value}\n\n${FOLLOWUP_CAVEAT}`;
    },
  });

  // ───────────────────────────────────────────────────────────── claims ────
  server.addTool({
    name: 'research_claims',
    description:
      'Extract the report’s load-bearing claims as portable cards — claim, confidence qualifier, source URL. Small enough to pass between agents or into a downstream tool, where a whole report is not. Confidence is copied from the report, never re-assessed.',
    // Not read-only: this invokes the utility model, which bills. The old
    // `readOnlyHint: true` told callers a paid call was free to retry.
    annotations: { title: 'Extract claim cards', readOnlyHint: false, openWorldHint: true },
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
      await deps.runner.reserveUtilitySpend(`claims:${args.runId}`);
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
      const before = await requireRun(deps, args.runId);
      // Capture the prior state: `cancel` is a no-op on a terminal run and
      // returns it unchanged, so keying the message off the RESULT alone
      // reports "Cancelled" for a run that was already cancelled.
      const wasTerminal =
        before.state === 'completed' || before.state === 'failed' || before.state === 'cancelled';
      const cancelled = await runner.cancel(args.runId);
      if (!cancelled) throw new UserError(`Run \`${args.runId}\` disappeared.`);
      if (wasTerminal) {
        return `\`${before.id}\` was already ${before.state}; nothing to cancel.`;
      }
      return `Cancelled \`${cancelled.id}\`. Committed spend (~$${cancelled.estimatedCostUsd.toFixed(2)}) stays on the ledger.`;
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

  registerShapeTools(server, deps);
  registerEvidenceTools(server, deps);
  registerLoopTools(server, deps);
  registerLocalCorpusTools(server, deps);
  registerCorpusTools(server, deps);
  registerAgentTools(server, deps);
  registerResources(server, deps);
  registerPrompts(server);

  return server;
}

// ─────────────────────────────────────────────── shapes: wide / recent / compare ────

/**
 * The three shapes that are not "one question, one essay".
 *
 * Every one of them starts a normal durable run, which is the point: the
 * lifecycle, the spend gate, the journal and the outline-first read are shape
 * agnostic, so a wide run is read, tailed, cancelled and budgeted exactly like a
 * deep one. What differs is the brief, the backend it routes to, and what the
 * response has to admit about how much of the request was actually enforced.
 */
function registerShapeTools(server: FastMCP, deps: ServerDeps): void {
  const { store, runner } = deps;

  /** Route, shape the request, and start it. Shared by wide and recent. */
  async function startShaped(args: {
    shape: Shape;
    question: string;
    prompt: string;
    archetype: Archetype;
    tier: 'fast' | 'max';
    window: Window;
    domains?: readonly string[];
    searchMode?: 'web' | 'academic' | 'sec';
    searchX?: boolean;
    maxToolCalls?: number;
    provider?: ProviderId;
    label?: string;
    wideSpec?: string;
    /** True only when the CALLER supplied an already-engineered brief. */
    preEngineered?: boolean;
  }): Promise<{ text: string[]; runId: string }> {
    const estimateInput = {
      tier: args.tier,
      shape: args.shape,
      tools: ['google_search'],
    };
    const routing = deps.providers.route({
      shape: args.shape,
      dateWindow: args.window !== 'all',
      ...(args.domains?.length ? { domains: args.domains.length } : {}),
      ...(args.searchX ? { social: ['x'] } : {}),
      estimateInput,
    });
    const chosen = args.provider ? deps.providers.get(args.provider) : routing.provider;
    if (!chosen) {
      throw new UserError(
        `${routing.reason}\n\n${routing.rejected.map((r) => `- ${r.id}: ${r.why}`).join('\n')}\n\nRun \`research_doctor\` to see what is configured.`,
      );
    }
    const shaped = shapeRequest(chosen.id, args.prompt, {
      window: args.window,
      shape: args.shape,
      ...(args.domains?.length ? { domains: args.domains } : {}),
      ...(args.searchMode ? { searchMode: args.searchMode } : {}),
      ...(args.searchX ? { searchX: true } : {}),
      ...(args.maxToolCalls ? { maxToolCalls: args.maxToolCalls } : {}),
    });

    const { run, deduped } = await runner.start({
      question: args.question,
      prompt: shaped.prompt,
      archetype: args.archetype,
      tier: args.tier,
      tools: buildTools(undefined),
      collaborativePlanning: false,
      thinkingSummaries: true,
      visualization: false,
      preEngineered: args.preEngineered === true,
      provider: chosen.id,
      shape: args.shape,
      window: args.window,
      ...(args.wideSpec ? { wideSpec: args.wideSpec } : {}),
      ...(args.label ? { label: args.label } : {}),
    });

    const estimate = chosen.estimate(estimateInput);
    const schemaEnforced = chosen.capabilities.shapes.includes(args.shape);
    return {
      runId: run.id,
      text: [
        deduped
          ? `**De-duplicated onto an existing run — nothing new was charged.** Handle: \`${run.id}\``
          : `**Run started.** Handle: \`${run.id}\``,
        '',
        `- Backend: **${chosen.label}** — ${args.provider ? 'you named it explicitly' : routing.reason}`,
        `- Estimated cost: ${formatCostBand(estimate.cost)} — ${estimate.cost.basis}. A guardrail estimate, never a quote.`,
        `- Estimated duration: ${formatDuration(estimate.duration)}`,
        ...describeShaping(shaped).map((l) => `- ${l}`),
        schemaEnforced
          ? `- Shape: **${args.shape}**, native on this backend.`
          : `- Shape: **${args.shape}**, asked for in the prompt only. ${chosen.label} has no native ${args.shape} mode, so the structure is not schema-enforced and may come back as prose.`,
        '',
        `Read it with \`research_read { runId: "${run.id}" }\` once it completes. Check progress with \`research_status\`.`,
      ],
    };
  }

  server.addTool({
    name: 'research_wide',
    description:
      'Research a MATRIX rather than a narrative: N entities across M fields, every cell filled, cited, or explicitly marked uncertain. THIS SPENDS MONEY. Use this when the answer is a table — "which of these tools support X, and what do they claim about Y" — because asking a deep-research backend for a table in prose is how you get five pages of essay and no table. Call it again with `runId` once the run completes to validate the returned matrix against what you asked for.',
    annotations: {
      title: 'Wide research: entities × fields (spends money)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      runId: z
        .string()
        .max(64)
        .optional()
        .describe('Validate and re-render a finished wide run. Supply this OR a spec, never both.'),
      topic: z.string().min(3).max(500).optional().describe('What the matrix is about.'),
      entities: z
        .array(z.string().min(1).max(200))
        .min(1)
        .max(200)
        .optional()
        .describe('The rows. Supply them when you know them; discovering them is a separate, more expensive job.'),
      fields: z
        .array(
          z.object({
            name: z.string().min(1).max(80).describe('Column name, e.g. `claimed_memory_10m_vectors`. Machine-ish names extract better than prose questions.'),
            detail: z.enum(['brief', 'moderate', 'detailed']).default('brief'),
            description: z.string().max(400).optional().describe('What counts as an answer, when the name is not enough.'),
          }),
        )
        .min(1)
        .max(40)
        .optional()
        .describe('The columns.'),
      window: z.enum(WINDOWS).default(DEFAULT_WINDOW).describe('How far back evidence may come from. Defaults to a year; most research questions are not news.'),
      tier: TierSchema.default('fast'),
      domains: z.array(z.string().max(200)).max(100).optional().describe('Restrict to these domains where the backend supports it. Prefix with `-` to exclude.'),
      provider: z.enum(PROVIDER_IDS).optional().describe('Force a backend. Omit to route on capability.'),
      label: z.string().max(200).optional(),
    }),
    execute: async (args) => {
      // Validation mode: the completion gate over a finished run.
      if (args.runId) {
        if (args.topic ?? args.entities ?? args.fields) {
          throw new UserError('Pass `runId` to validate a finished run, or a spec to start one. Not both.');
        }
        const run = await requireRun(deps, args.runId);
        if (!run.wideSpec) {
          throw new UserError(
            `\`${run.id}\` is a ${run.shape} run, not a wide one. There is no matrix spec to check it against.`,
          );
        }
        const markdown = await store.readReport(run.id);
        if (!markdown) throw new UserError(`No report for \`${run.id}\` yet (state: ${run.state}). ${stateHint(run.state)}`);
        // The store is a trust boundary like any other: a hand-edited record
        // must be rejected with a message, not thrown out of a JSON parser.
        const parsed = WideSpecSchema.safeParse(
          ((): unknown => {
            try {
              return JSON.parse(run.wideSpec) as unknown;
            } catch {
              return null;
            }
          })(),
        );
        if (!parsed.success) {
          throw new UserError(
            `The stored matrix spec for \`${run.id}\` is unreadable, so there is nothing to check the report against. Read it directly with \`research_read\`.`,
          );
        }
        const rows = parseWideTable(parsed.data, markdown);
        const problems = validateWide(parsed.data, rows);
        return [
          renderWideTable(parsed.data, rows),
          '',
          '### Completion gate',
          '',
          problems.length === 0
            ? `Every requested cell is either filled or explicitly marked uncertain across all ${String(parsed.data.entities.length)} rows.`
            : [
                `${String(problems.length)} gap(s). A missing cell is a silent omission, which is the failure this check exists for:`,
                '',
                ...problems.slice(0, 60).map((p) => `- ${p}`),
                problems.length > 60 ? `- …and ${String(problems.length - 60)} more.` : '',
              ]
                .filter(Boolean)
                .join('\n'),
          '',
          rows.length === 0
            ? '_No table was found in the report. Read it directly with `research_read` — the backend answered in prose, which is exactly the failure mode wide research exists to avoid._'
            : `_Parsed ${String(rows.length)} row(s) from the report’s first markdown table. Read the full report with \`research_read { runId: "${run.id}" }\`._`,
        ].join('\n');
      }

      if (!args.topic || !args.entities || !args.fields) {
        throw new UserError('A wide run needs `topic`, `entities` and `fields`. Pass `runId` instead to check a finished one.');
      }
      const spec = WideSpecSchema.parse({ topic: args.topic, entities: args.entities, fields: args.fields });
      const prompt = buildWidePrompt(spec, args.window);
      const started = await startShaped({
        shape: 'wide',
        question: `Matrix: ${spec.topic} (${String(spec.entities.length)} rows × ${String(spec.fields.length)} fields)`,
        prompt,
        archetype: 'competitive',
        tier: args.tier,
        window: args.window,
        wideSpec: JSON.stringify(spec),
        ...(args.domains ? { domains: args.domains } : {}),
        ...(args.provider ? { provider: args.provider } : {}),
        ...(args.label ? { label: args.label } : {}),
      });
      return [
        ...started.text,
        '',
        `Then run \`research_wide { runId: "${started.runId}" }\` to check every requested cell actually came back.`,
      ].join('\n');
    },
  });

  server.addTool({
    name: 'research_recent',
    description:
      'Time-boxed research: what happened on a topic inside a window, weighted toward primary and recent sources. THIS SPENDS MONEY. Different from `research_start` in one way that matters: the window is passed to the backend as a real filter where the backend has one, and the response tells you which of the two you got. Windows go up to 5 years; the default is 1 year, because most questions are not news.',
    annotations: {
      title: 'Recent research inside a time window (spends money)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      question: z.string().min(3).max(20_000).describe('What you want to know about recently.'),
      window: z.enum(WINDOWS).default('30d').describe('How far back to look. `research_recent` defaults to 30 days; widen it deliberately.'),
      tier: TierSchema.default('fast'),
      archetype: ArchetypeSchema.optional(),
      scope: ScopeSchema,
      domains: z.array(z.string().max(200)).max(100).optional().describe('Restrict to these domains where the backend supports it. Prefix with `-` to exclude.'),
      searchMode: z.enum(['web', 'academic', 'sec']).optional().describe('Perplexity only: search a specialised index instead of the open web.'),
      includeX: z.boolean().default(false).describe('Search X as well. Only xAI can do this; nothing else reaches it at any price.'),
      provider: z.enum(PROVIDER_IDS).optional(),
      label: z.string().max(200).optional(),
    }),
    execute: async (args) => {
      const resolved = resolvePrompt({
        question: args.question,
        ...(args.archetype ? { archetype: args.archetype } : {}),
        ...(args.scope ? { scope: args.scope } : {}),
      });
      const started = await startShaped({
        shape: 'recent',
        question: args.question,
        prompt: resolved.prompt,
        archetype: resolved.archetype,
        preEngineered: resolved.preEngineered,
        tier: args.tier,
        window: args.window,
        ...(args.domains ? { domains: args.domains } : {}),
        ...(args.searchMode ? { searchMode: args.searchMode } : {}),
        ...(args.includeX ? { searchX: true } : {}),
        ...(args.provider ? { provider: args.provider } : {}),
        ...(args.label ? { label: args.label } : {}),
      });
      return started.text.join('\n');
    },
  });

  server.addTool({
    name: 'research_compare',
    description:
      'Run the SAME brief on two or more backends and diff what they claim. THIS SPENDS MONEY ONCE PER BACKEND — two providers is two full research runs. Worth it when a number is load-bearing: the disagreements are the output, and they are the one thing a single-provider tool can never show you. Call it again with `runIds` once the runs finish to get the diff.',
    annotations: {
      title: 'Compare backends on one brief (spends money per backend)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      question: z.string().min(3).max(20_000).optional().describe('The brief to run on every backend. Supply this OR runIds.'),
      providers: z
        .array(z.enum(PROVIDER_IDS))
        .min(2)
        .max(4)
        .optional()
        .describe('Which backends to run it on. Each one costs a full run. Omit to use every configured backend.'),
      runIds: z
        .array(z.string().max(64))
        .min(2)
        .max(4)
        .optional()
        .describe('Finished runs to diff. Supply this OR question.'),
      tier: TierSchema.default('fast'),
      window: z.enum(WINDOWS).default(DEFAULT_WINDOW),
      claimLimit: z.number().int().min(4).max(60).default(20).describe('Claims to extract per run for the diff.'),
      label: z.string().max(200).optional(),
    }),
    execute: async (args) => {
      if ((args.question && args.runIds) || (!args.question && !args.runIds)) {
        throw new UserError('Pass `question` to start a comparison, or `runIds` to diff finished runs. Exactly one.');
      }

      // ── Diff mode: read finished runs and corroborate across them ──
      if (args.runIds) {
        if (!deps.utility) {
          throw new UserError(
            'Diffing needs a utility model to extract claims (GEMINI_API_KEY). Without one, read both reports with `research_read` and compare them yourself.',
          );
        }
        const sets: ProviderClaimSet[] = [];
        for (const id of args.runIds) {
          const run = await requireRun(deps, id);
          const markdown = await store.readReport(id);
          if (!markdown) throw new UserError(`No report for \`${id}\` yet (state: ${run.state}). ${stateHint(run.state)}`);
          await runner.reserveUtilitySpend(`compare:${id}`);
          const extracted = await deps.utility.extractClaims(markdown, args.claimLimit);
          if (!extracted.ok) throw new UserError(`Claim extraction failed for \`${id}\`: ${extracted.error}`);
          sets.push({
            provider: `${run.provider}:${run.id}`,
            claims: extracted.value.claims.map((c) => ({
              provider: `${run.provider}:${run.id}`,
              text: c.claim,
              urls: c.sourceUrl ? [c.sourceUrl] : [],
            })),
          });
        }

        const { shared, unique } = crossCheck(sets);
        const corroborated = shared.filter((s) => s.support === 'corroborated');
        const sameSource = shared.filter((s) => s.support === 'single-source');
        return [
          `## Cross-backend comparison of ${String(sets.length)} run(s)`,
          '',
          `- Claims more than one backend made: **${String(shared.length)}**`,
          `- Of those, backed by 3+ independent domains: **${String(corroborated.length)}**`,
          `- Of those, agreeing while citing ONE domain: **${String(sameSource.length)}** — agreement here is not evidence.`,
          '',
          '### Agreed claims',
          '',
          shared.length === 0
            ? '_No claim was made by more than one backend. That is itself a finding: these reports do not overlap._'
            : shared
                .slice(0, 40)
                .map(
                  (s) =>
                    `- **${s.support}** (${String(s.independentDomains)} domain(s)) — ${s.claim}${s.note ? `\n    _${s.note}_` : ''}`,
                )
                .join('\n'),
          '',
          '### Found by one backend only',
          '',
          '_Usually a coverage difference rather than an error. It is not corroboration either way._',
          '',
          ...unique.map((u) =>
            u.claims.length === 0
              ? `- **${u.provider}**: nothing unique.`
              : `- **${u.provider}**:\n${u.claims.slice(0, 12).map((c) => `    - ${c.text}`).join('\n')}`,
          ),
          '',
          '_Claims were matched on wording, so a real disagreement about the same fact can appear as two unique claims rather than a conflict. Read the sections themselves before acting on a number._',
        ].join('\n');
      }

      // ── Start mode: one run per backend ──
      const question = args.question as string;
      const wanted = args.providers ?? deps.providers.available().map((p) => p.id);
      const usable = wanted.filter((id) => deps.providers.get(id)?.detect().state !== 'not-configured');
      if (usable.length < 2) {
        throw new UserError(
          `Comparison needs at least two configured backends; ${String(usable.length)} available. Run \`research_doctor\` to see what could be enabled.`,
        );
      }

      const resolved = resolvePrompt({ question });
      const started: string[] = [];
      const failed: string[] = [];
      for (const id of usable) {
        try {
          const out = await startShaped({
            shape: 'deep',
            question,
            prompt: resolved.prompt,
            archetype: resolved.archetype,
            preEngineered: resolved.preEngineered,
            tier: args.tier,
            window: args.window,
            provider: id,
            ...(args.label ? { label: `${args.label} (${id})` } : { label: `compare: ${id}` }),
          });
          started.push(out.runId);
        } catch (e: unknown) {
          // One backend refusing must not strand the ones that already started
          // and are already being billed. Report and continue.
          failed.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (started.length < 2) {
        return [
          `**Started ${String(started.length)} of ${String(usable.length)} run(s), which is not enough to compare.**`,
          ...started.map((id) => `- \`${id}\` is running and IS being billed. Cancel it with \`research_cancel\` if you do not want it.`),
          ...failed.map((f) => `- failed to start — ${f}`),
        ].join('\n');
      }

      return [
        `**Comparison started: ${String(started.length)} independent runs, each billed separately.**`,
        '',
        ...started.map((id) => `- \`${id}\``),
        ...failed.map((f) => `- ⚠ did not start — ${f}`),
        '',
        `Poll them with \`research_status\`. When they have all completed, diff them with:`,
        '```',
        `research_compare { runIds: ${JSON.stringify(started)} }`,
        '```',
        '',
        'Reminder on reading the result: two backends agreeing while citing the same page is one source, not two. The diff says so explicitly.',
      ].join('\n');
    },
  });
}

// ────────────────────────────────────────────────────────── evidence governance ────

/** The four lenses. Each is a separate pass, and each is told to refute. */
const LENSES = [
  {
    name: 'claim validator',
    question: 'Is each load-bearing claim actually supported by the source it cites?',
    instruction:
      'Look for claims whose citation is about the right topic but does not contain the specific assertion, numbers that appear without a source, and figures that changed between the body and the summary.',
  },
  {
    name: 'source diversity',
    question: 'Is any conclusion resting on one domain wearing several hats?',
    instruction:
      'Look for a single organisation cited through its blog, its press release and a syndicated write-up of the same press release, counted as three sources.',
  },
  {
    name: 'recency',
    question: 'Has anything here been superseded?',
    instruction:
      'Look for claims stated in the present tense from dated sources, superseded versions, prices and limits that move often, and any figure whose age is not stated.',
  },
  {
    name: 'contradiction',
    question: 'Does the report disagree with itself?',
    instruction:
      'Look for a number in the summary that differs from the body, a caveat stated once and dropped later, and a conclusion stronger than the evidence section supporting it.',
  },
] as const;

function registerEvidenceTools(server: FastMCP, deps: ServerDeps): void {
  const { store, runner } = deps;

  function requireUtility(what: string): UtilityModel {
    if (!deps.utility) {
      throw new UserError(
        `${what} needs a utility model (set GEMINI_API_KEY). Nothing else in the server depends on it; reports still read normally with \`research_read\`.`,
      );
    }
    return deps.utility;
  }

  server.addTool({
    name: 'research_verify_claims',
    description:
      'Fetch the sources a report cites and ask a model whether each one ACTUALLY supports the claim attached to it. THIS SPENDS MONEY (one small model call per sampled claim) and it SENDS THE TEXT OF EACH FETCHED PAGE to the utility model. Different from `research_verify_citations` in the way that matters: that one proves a link resolves, this one tests whether the page says what the report says it says. The failure it targets is the one 2026 reviews converge on, where every fact is right and the conclusion is wrong.',
    annotations: {
      title: 'Verify claims against their sources (spends money)',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    parameters: z.object({
      runId: z.string().max(64),
      sample: z
        .number()
        .int()
        .min(1)
        .max(25)
        .default(8)
        .describe('How many claims to check. Each is a fetch plus a model call, so this is the cost dial.'),
    }),
    execute: async (args, { reportProgress }) => {
      const run = await requireRun(deps, args.runId);
      const markdown = await store.readReport(args.runId);
      if (!markdown) throw new UserError(`No report for \`${run.id}\` (state: ${run.state}). ${stateHint(run.state)}`);
      const utility = requireUtility('Claim verification');

      await runner.reserveUtilitySpend(`verify-claims-extract:${run.id}`);
      const extracted = await utility.extractClaims(markdown, args.sample * 2);
      if (!extracted.ok) throw new UserError(`Could not extract claims to check: ${extracted.error}`);

      // Only claims that actually carry a source can be checked against one.
      // A claim with no citation is already a finding, and it is reported as
      // such rather than quietly dropped from the denominator.
      const withSource = extracted.value.claims.filter((c) => c.sourceUrl);
      const unsourced = extracted.value.claims.length - withSource.length;
      const sampled = withSource.slice(0, args.sample);
      if (sampled.length === 0) {
        return [
          `No checkable claims in \`${run.id}\`: ${String(extracted.value.claims.length)} claim(s) extracted, none carrying a source URL.`,
          '',
          'That is itself the finding. A report whose claims have no citations cannot be verified against anything.',
        ].join('\n');
      }

      const results: string[] = [];
      const tally = { supports: 0, partially_supports: 0, contradicts: 0, not_addressed: 0, unreadable: 0, fetch_failed: 0 };
      for (const [i, claim] of sampled.entries()) {
        await reportProgress({ progress: i, total: sampled.length });
        const url = claim.sourceUrl ?? '';
        let text: string;
        try {
          const fetched = await safeFetch(url, { method: 'GET', timeoutMs: 15_000, maxBytes: 512 * 1024 });
          text = stripToText(fetched.body);
        } catch (e: unknown) {
          tally.fetch_failed += 1;
          results.push(
            `- ⚫ **could not fetch** — ${claim.claim.slice(0, 200)}\n    ${url}\n    _${e instanceof Error ? e.message.slice(0, 200) : 'fetch failed'}_`,
          );
          continue;
        }
        await runner.reserveUtilitySpend(`verify-claims:${run.id}:${String(i)}`);
        const judged = await utility.judgeSupport(claim.claim, text);
        if (!judged.ok) {
          tally.fetch_failed += 1;
          results.push(`- ⚫ **could not judge** — ${claim.claim.slice(0, 200)}\n    _${judged.error.slice(0, 200)}_`);
          continue;
        }
        const v = judged.value;
        tally[v.verdict] += 1;
        const icon = { supports: '✅', partially_supports: '🟡', contradicts: '❌', not_addressed: '⚠️', unreadable: '⚫' }[v.verdict];
        results.push(
          [
            `- ${icon} **${v.verdict}** — ${claim.claim.slice(0, 300)}`,
            `    ${url}`,
            v.quote ? `    > ${v.quote.slice(0, 300)}` : '',
            v.note ? `    _${v.note.slice(0, 250)}_` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }
      await reportProgress({ progress: sampled.length, total: sampled.length });

      const clean = tally.supports;
      return [
        `## Claim-to-source check for \`${run.id}\``,
        '',
        `Checked **${String(sampled.length)}** of ${String(withSource.length)} sourced claim(s).${unsourced > 0 ? ` ${String(unsourced)} extracted claim(s) carried no source at all.` : ''}`,
        '',
        `- ✅ supports: **${String(clean)}**`,
        `- 🟡 partially supports: **${String(tally.partially_supports)}**`,
        `- ❌ contradicts: **${String(tally.contradicts)}**`,
        `- ⚠️ source does not address the claim: **${String(tally.not_addressed)}**`,
        `- ⚫ unreadable or unfetchable: **${String(tally.unreadable + tally.fetch_failed)}**`,
        '',
        ...results,
        '',
        '> [!IMPORTANT]',
        '> This is a sample, judged by a model reading one page. It catches a source that does not contain the claim attached to it, which link-checking cannot. It does not catch a report whose facts are each correct and whose conclusion does not follow — for that, read the reasoning yourself, or run `research_counter_review`.',
      ].join('\n');
    },
  });

  server.addTool({
    name: 'research_counter_review',
    description:
      'Adversarial review of a finished report through four independent lenses: claim validation, source diversity, recency, and internal contradiction. THIS SPENDS MONEY (one small model call per lens). Each lens is prompted to REFUTE rather than summarise, because reviewers who are not told to argue agree with fluent prose. A review that finds nothing on every lens is reported as a failed review, not as a clean bill of health.',
    annotations: {
      title: 'Counter-review a report (spends money)',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    parameters: z.object({
      runId: z.string().max(64),
      lenses: z
        .array(z.enum(['claim validator', 'source diversity', 'recency', 'contradiction']))
        .min(1)
        .max(4)
        .optional()
        .describe('Which lenses to run. Omit for all four; each one costs a model call.'),
    }),
    execute: async (args, { reportProgress }) => {
      const run = await requireRun(deps, args.runId);
      const markdown = await store.readReport(args.runId);
      if (!markdown) throw new UserError(`No report for \`${run.id}\` (state: ${run.state}). ${stateHint(run.state)}`);
      const utility = requireUtility('Counter-review');

      const chosen = args.lenses ? LENSES.filter((l) => args.lenses?.includes(l.name)) : LENSES;
      const sections: string[] = [];
      let issues = 0;
      let ran = 0;

      for (const [i, lens] of chosen.entries()) {
        await reportProgress({ progress: i, total: chosen.length });
        await runner.reserveUtilitySpend(`counter-review:${run.id}:${lens.name}`);
        const result = await utility.review(lens, markdown);
        if (!result.ok) {
          sections.push(`### ${lens.name}\n\n_This lens did not run: ${result.error.slice(0, 300)}_`);
          continue;
        }
        ran += 1;
        issues += result.value.issues.length;
        sections.push(
          [
            `### ${lens.name}`,
            '',
            `**Checked:** ${result.value.checked}`,
            '',
            result.value.issues.length === 0
              ? '_Nothing found on this lens._'
              : result.value.issues
                  .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
                  .map((x) => `- **${x.severity}** · ${x.where} — ${x.problem}`)
                  .join('\n'),
          ].join('\n'),
        );
      }
      await reportProgress({ progress: chosen.length, total: chosen.length });

      return [
        `## Counter-review of \`${run.id}\``,
        '',
        `${String(ran)} of ${String(chosen.length)} lens(es) ran. **${String(issues)} issue(s)** raised.`,
        '',
        ...sections,
        '',
        ran > 0 && issues === 0
          ? '> [!WARNING]\n> Every lens returned nothing. Treat that as a **failed review rather than a clean report**: four adversarial passes finding zero problems in a long research report is more often a sign the review did not bite than a sign the report is flawless. Re-run it, or read the reasoning yourself.'
          : '_Issues here are a reviewer’s objections, not established errors. Check them against the report before acting on either._',
      ].join('\n');
    },
  });

  server.addTool({
    name: 'research_evidence',
    description:
      'Profile the sources a report actually used: what kind they are, how concentrated they are, and how they measure against advisory quality floors. Free — it reads the stored report and classifies URLs, with no fetching and no model call. Also returns the numbered citation registry, which is the list a follow-up should cite from rather than from the report’s prose.',
    annotations: { title: 'Profile a report’s evidence', readOnlyHint: true, openWorldHint: false },
    parameters: z.object({
      runId: z.string().max(64),
      level: z
        .enum(['standard', 'light'])
        .default('standard')
        .describe('Which advisory floors to measure against. `light` suits a quick scan; neither refuses anything.'),
      registry: z.boolean().default(false).describe('Include the full numbered source registry.'),
    }),
    execute: async (args) => {
      const run = await requireRun(deps, args.runId);
      const markdown = await store.readReport(args.runId);
      if (!markdown) throw new UserError(`No report for \`${run.id}\` (state: ${run.state}). ${stateHint(run.state)}`);

      const entries = buildRegistry(markdown);
      // Reuse the stored citation verdicts where a verification pass has
      // already run: a 403 is what tells us a source is paywalled rather than
      // public, and re-fetching to rediscover that would cost time for nothing.
      const verdicts = new Map((run.citations ?? []).map((c) => [canonicaliseUrl(c.url), c.verdict]));
      const corpusRun = run.corpusStores.length > 0;
      const sources = entries.map((e) => {
        const verdict = verdicts.get(e.url);
        return classifySource(e.url, verdict ? { verdict } : {});
      });
      const profile = profileEvidence(sources, args.level);

      const trace = renderTrace({
        provider: run.provider,
        tier: run.tier,
        shape: run.shape,
        ...(run.window ? { window: run.window } : {}),
        enforced: [],
        requested: [],
        asOf: run.completedAt ?? run.updatedAt,
        urls: entries.map((e) => e.url),
      });

      return [
        `## Evidence profile for \`${run.id}\``,
        '',
        renderProfile(profile),
        '',
        corpusRun
          ? '> [!NOTE]\n> This run was grounded in your own corpus. Your documents are valid **primary** evidence about your own position and never independent corroboration of an external fact; citing your own file back to you proves nothing about the world.'
          : '',
        '',
        trace,
        '',
        args.registry
          ? ['### Citation registry', '', ...entries.map((e) => `${String(e.n)}. ${e.url}`)].join('\n')
          : `_${String(entries.length)} source(s) in the registry. Pass \`registry: true\` for the numbered list._`,
      ]
        .filter(Boolean)
        .join('\n');
    },
  });
}

function severityRank(s: 'high' | 'medium' | 'low'): number {
  return { high: 0, medium: 1, low: 2 }[s];
}

/**
 * Turn a fetched share page into something readable, keeping the structure
 * that `research_read` depends on.
 *
 * Headings and links are the two things worth preserving: the outline reader
 * slices on `#` headings, and citation verification needs the URLs. Everything
 * else is stripped. This is not a general HTML converter and does not try to
 * be — most share pages render client-side and return an empty shell anyway,
 * which is why the import path checks the result is actually a report and tells
 * the caller to paste the text when it is not.
 */
function htmlToMarkdown(html: string): string {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  return (
    body
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, text: string) => {
        return `\n\n${'#'.repeat(Number(level))} ${strip(text)}\n\n`;
      })
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, text: string) => `\n- ${strip(text)}`)
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
        const label = strip(text);
        return label ? `[${label}](${href})` : href;
      })
      .replace(/<\/(p|div|section|article|tr|br)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Collapse runs of blank lines, but keep paragraph breaks.
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

function strip(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reduce a fetched page to something a model can judge.
 *
 * Crude by design: this feeds a support check, not a renderer. Script and style
 * bodies are dropped because they are the bulk of a modern page and none of its
 * meaning, and the result is capped so one enormous page cannot dominate the
 * cost of a whole verification pass.
 */
function stripToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60_000);
}

// ──────────────────────────────────────────────────────── the local loop ────

/**
 * Research that costs nothing, run by the host and disciplined by the server.
 *
 * The host has web search; Dossier does not, and cannot borrow one. So the loop
 * runs there. What runs *here* is the part that decides whether the output is
 * trustworthy: one numbered deduplicated registry, frozen before drafting, and
 * a draft that may cite only from it.
 *
 * That split is deliberate and it is the whole argument for doing this in an
 * MCP server rather than a skill. A skill can ask a model not to invent a
 * supporting reference mid-sentence. A server holding the frozen registry can
 * check, and reject the draft that did.
 */
function registerLoopTools(server: FastMCP, deps: ServerDeps): void {
  const { store, runner } = deps;

  async function requireSession(runId: string): Promise<Session> {
    const parsed = SessionSchema.safeParse(await store.readSession(runId));
    if (!parsed.success) {
      throw new UserError(
        `No local research session for \`${runId}\`. Start one with \`research_local_start\`.`,
      );
    }
    return parsed.data;
  }

  server.addTool({
    name: 'research_local_start',
    description:
      'Start a research loop that YOU run with your own web search: no API is called and nothing is charged. Returns a decomposed task list, one per source class, each with the query dialect that index actually expects. Searching an academic index the way you search an issue tracker finds nothing, which is the most common way a research loop quietly under-performs. Report findings back with `research_local_note`.',
    annotations: {
      title: 'Start a local research loop (free)',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    parameters: z.object({
      question: z.string().min(3).max(20_000),
      archetype: ArchetypeSchema.optional(),
      maxTasks: z.number().int().min(1).max(7).default(5).describe('How many parallel search tasks to plan.'),
      deep: z.boolean().default(false).describe('Force every task to open pages rather than read result listings.'),
      label: z.string().max(200).optional(),
    }),
    execute: async (args) => {
      const archetype = args.archetype ?? selectArchetype(args.question);
      const tasks = decompose(args.question, { archetype, maxTasks: args.maxTasks, deep: args.deep });
      const record = await runner.openLoop({
        question: args.question,
        archetype,
        ...(args.label ? { label: args.label } : {}),
      });
      const session: Session = {
        runId: record.id,
        question: args.question,
        createdAt: new Date().toISOString(),
        tasks: tasks.map((t) => ({
          id: t.id,
          sourceClass: t.sourceClass,
          depth: t.depth,
          objective: t.objective,
          reported: false,
          findings: 0,
        })),
        registry: [],
        rejectedAfterFreeze: [],
      };
      await store.saveSession(record.id, session);

      return [
        `**Local research session open.** Handle: \`${record.id}\` · archetype: ${archetype}`,
        '',
        `Nothing has been charged and nothing will be: you do the searching, with whatever web search you already have.`,
        '',
        '## Run these tasks',
        '',
        'Run them in parallel where you can. Each one is a different neighbourhood of the web, not the same search five times.',
        '',
        renderTasks(tasks),
        '',
        '## Then report back',
        '',
        'For each task, as you finish it:',
        '',
        '```',
        `research_local_note { runId: "${record.id}", taskId: "t1", findings: [{ claim, url, quote, published }] }`,
        '```',
        '',
        'Send the URL you actually read, and the sentence that supports the claim. Findings are deduplicated by URL into one numbered registry, so the same page found by three tasks stays one source rather than becoming three.',
        '',
        `When every task has reported, call \`research_local_draft { runId: "${record.id}" }\`. That freezes the registry: after it, no new source can be added, including by you.`,
      ].join('\n');
    },
  });

  server.addTool({
    name: 'research_local_note',
    description:
      'Report what one search task found. Findings are deduplicated by canonical URL into a single numbered registry, so one page found by three tasks stays one source instead of becoming three apparent corroborations. Free, and it makes no network call.',
    annotations: {
      title: 'Report findings to a local loop',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    parameters: z.object({
      runId: z.string().max(64),
      taskId: z.string().max(16),
      findings: z.array(FindingSchema).min(1).max(40),
    }),
    execute: async (args) => {
      // Read, merge and write under one lock. Parallel workers are the whole
      // point of the fan-out, and two of them reporting at once both read the
      // same session and the second write dropped the first's evidence. A loop
      // that loses findings silently is worse than one that runs serially.
      const result = await store.admissionLock().run(async () => {
        const session = await requireSession(args.runId);
        if (!session.tasks.some((t) => t.id === args.taskId)) {
          throw new UserError(
            `No task \`${args.taskId}\` in this session. Its tasks are: ${session.tasks.map((t) => t.id).join(', ')}.`,
          );
        }
        const merged = mergeFindings(session, args.taskId, args.findings);
        await store.saveSession(args.runId, merged.session);
        return merged;
      });

      const outstanding = result.session.tasks.filter((t) => !t.reported);
      if (result.refused.length > 0) {
        return [
          `⚠ **The registry was already frozen**, so ${String(result.refused.length)} finding(s) were refused rather than merged:`,
          '',
          ...result.refused.map((u) => `- ${u}`),
          '',
          'This is the rule working, not a bug. A source that appears once drafting has begun cannot be distinguished from one invented to support a sentence already written. Start a new session if these matter.',
        ].join('\n');
      }
      return [
        `Recorded ${String(args.findings.length)} finding(s) from \`${args.taskId}\`: **${String(result.added)} new source(s)**, ${String(result.merged)} already in the registry.`,
        '',
        `Registry now holds **${String(result.session.registry.length)} source(s)** across ${String(new Set(result.session.registry.map((e) => e.domain)).size)} domain(s).`,
        '',
        outstanding.length === 0
          ? `Every task has reported. Freeze and draft with \`research_local_draft { runId: "${args.runId}" }\`.`
          : `Still outstanding: ${outstanding.map((t) => `\`${t.id}\` (${t.sourceClass})`).join(', ')}.`,
      ].join('\n');
    },
  });

  server.addTool({
    name: 'research_local_draft',
    description:
      'Freeze the registry and return the drafting rules plus the numbered source list. After this NO new source can enter the run, including one you find later: that is what makes the draft checkable. Free. Reports the source profile and names any task that never reported, because a silent task is a coverage gap rather than a clean sweep.',
    annotations: { title: 'Freeze the registry and draft', readOnlyHint: false, openWorldHint: false },
    parameters: z.object({ runId: z.string().max(64) }),
    execute: async (args) => {
      // Under the same lock as `_note`, so a finding cannot race the freeze and
      // overwrite `frozenAt` after the registry was declared closed.
      const frozen = await store.admissionLock().run(async () => {
        const session = await requireSession(args.runId);
        const result = freezeRegistry(session);
        await store.saveSession(args.runId, result.session);
        return result;
      });

      return [
        `## Registry frozen for \`${args.runId}\``,
        '',
        `**${String(frozen.session.registry.length)} source(s).** No source can be added from here.`,
        '',
        frozen.silentTasks.length > 0
          ? `> [!WARNING]\n> These tasks never reported: ${frozen.silentTasks.join(', ')}. Their source classes are simply missing from this report, which is a coverage gap rather than an absence of evidence. Say so in the Knowledge Gaps section.`
          : '_Every task reported._',
        '',
        renderProfile(frozen.profile),
        '',
        '## The registry — cite ONLY from this',
        '',
        renderRegistry(frozen.session),
        '',
        '## Drafting rules',
        '',
        '1. **Cite only from the registry above, by URL.** A source that is not on the list cannot appear in the draft, and the submit step checks. This is the rule that stops a plausible reference being reached for mid-sentence to support something already written.',
        '2. **Draft from your notes, not from memory of the pages.** If a claim is not in a finding you reported, it is not established.',
        '3. **Mark what you inferred.** Wrap any conclusion you assembled rather than read in `<INFERENCE from="...">…</INFERENCE>`, naming the sources it rests on. Three correct facts multiplied into a wrong number is the failure this catches, and every input to it is sourced.',
        '4. **Not citing a source is fine.** Sources that turned out not to bear on the question should be dropped. A draft citing all of them is padding, not thoroughness.',
        '5. Structure: Executive Summary (confidence-qualified bullets) · Detailed Findings · Evidence Table · Knowledge Gaps · Recommended Next Steps.',
        '',
        `Then submit it: \`research_local_submit { runId: "${args.runId}", markdown: "..." }\`.`,
      ].join('\n');
    },
  });

  server.addTool({
    name: 'research_local_submit',
    description:
      'Submit the drafted report. Every cited URL is checked against the frozen registry and the draft is REFUSED if it cites anything that was not gathered. Free. Once accepted it becomes a normal run: outline-first reads, grep, citation verification and evidence profiling all work on it.',
    annotations: {
      title: 'Submit a local-loop report',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    parameters: z.object({
      runId: z.string().max(64),
      markdown: z.string().min(100).max(2_000_000),
    }),
    execute: async (args) => {
      const session = await requireSession(args.runId);
      if (!session.frozenAt) {
        throw new UserError(
          `The registry for \`${args.runId}\` has not been frozen. Call \`research_local_draft\` first — a draft checked against a registry that was still growing is not checked at all.`,
        );
      }
      const verdict = validateDraft(session, args.markdown);
      if (!verdict.ok) {
        return [
          `**Refused: the draft cites ${String(verdict.unregistered.length)} source(s) that are not in the frozen registry.**`,
          '',
          ...verdict.unregistered.map((u) => `- ${u}`),
          '',
          'A source that appears for the first time at drafting time cannot be told apart from one invented to support a sentence. Either cite the registry entry you actually read, or drop the claim.',
          '',
          `The registry is ${String(session.registry.length)} entries; re-read it with \`research_local_draft { runId: "${args.runId}" }\`.`,
        ].join('\n');
      }

      const record = await runner.closeLoop(args.runId, args.markdown);
      return [
        `**Accepted.** \`${record.id}\` is complete, and cost nothing.`,
        '',
        `- ${String(verdict.citedCount)} of ${String(session.registry.length)} registry sources cited`,
        verdict.unused.length > 0
          ? `- Unused entries: ${verdict.unused.join(', ')}. Not a problem; dropping what did not bear on the question is the honest move.`
          : '- Every gathered source was used.',
        verdict.marksInference
          ? '- The draft distinguishes what it read from what it inferred.'
          : '- ⚠ Nothing in the draft is marked as inference. If it draws any conclusion the sources do not state outright, mark it: a synthesised claim reads exactly like a sourced one, and that is how a wrong conclusion built from correct facts survives review.',
        '',
        'Next, and it is not optional on anything you will act on:',
        `- \`research_counter_review { runId: "${record.id}" }\` — four adversarial lenses`,
        `- \`research_verify_citations { runId: "${record.id}" }\` — dereference every URL`,
        `- \`research_evidence { runId: "${record.id}" }\` — the source profile`,
      ].join('\n');
    },
  });
}

// ─────────────────────────────────────────────── local corpus (never uploaded) ────
function registerLocalCorpusTools(server: FastMCP, deps: ServerDeps): void {
  const local = new LocalCorpus(deps.config.localCorpusDirs);

  const offMessage =
    'No local corpus is configured. The operator grants directories by setting `DOSSIER_LOCAL_CORPUS_DIRS` (colon or comma separated absolute paths) and restarting the server. ' +
    'There is deliberately no tool that grants one: a tool that reads arbitrary local files and returns their contents is an exfiltration primitive, so the grant lives where the human is.';

  server.addTool({
    name: 'corpus_local_list',
    description:
      'List the local directories this server may read. These are NEVER uploaded: files are read and matched on this machine, and no provider, reranker or model sees their contents. Free, and it makes no network call. Empty unless the operator granted directories via DOSSIER_LOCAL_CORPUS_DIRS.',
    annotations: { title: 'List local corpus directories', readOnlyHint: true, openWorldHint: false },
    parameters: z.object({}),
    execute: async () => {
      if (!local.configured) return offMessage;
      const rows = await local.describe();
      return [
        `${String(rows.length)} local corpus director${rows.length === 1 ? 'y' : 'ies'}:`,
        '',
        ...rows.map((r) =>
          r.exists
            ? `- \`${r.root}\` — ${String(r.files)} readable file(s)`
            : `- \`${r.root}\` — ⚠ missing or not a directory`,
        ),
        '',
        'Search them with `corpus_local_search`. Nothing here is sent anywhere.',
      ].join('\n');
    },
  });

  server.addTool({
    name: 'corpus_local_search',
    description:
      'Search the operator-granted local directories for a literal phrase, and return matching lines with their file and line number. Free, no network call, and nothing read here is ever sent to a provider. Use it to bring your own notes and documents alongside a research report WITHOUT uploading them. Matches are your own material: valid primary evidence about your own position, and never independent corroboration of an external fact.',
    annotations: { title: 'Search local files (never uploaded)', readOnlyHint: true, openWorldHint: false },
    parameters: z.object({
      query: z
        .string()
        .min(2)
        .max(200)
        .describe('A literal phrase. Not a regular expression: a caller-supplied pattern is a denial-of-service vector.'),
      limit: z.number().int().min(1).max(60).default(20),
    }),
    execute: async (args) => {
      if (!local.configured) return offMessage;
      const matches = await local.search(args.query, { maxMatches: args.limit });
      if (matches.length === 0) return `No local matches for "${args.query}".`;
      const byFile = new Map<string, typeof matches>();
      for (const m of matches) {
        const key = `${m.root}::${m.file}`;
        byFile.set(key, [...(byFile.get(key) ?? []), m]);
      }
      return [
        `### From your files (${String(matches.length)} match(es), nothing uploaded)`,
        '',
        ...[...byFile.entries()].flatMap(([key, hits]) => [
          `**${key.split('::')[1] ?? key}** _(in ${key.split('::')[0] ?? ''})_`,
          ...hits.map((h) => `- L${String(h.line)}: ${h.snippet}`),
          '',
        ]),
        '> [!IMPORTANT]',
        '> These are **your own documents**. They are the best evidence available about your own position, decisions and history, and they are never independent corroboration of a fact about the world. Citing your own file back as confirmation is circular: the report looks sourced and proves nothing.',
      ].join('\n');
    },
  });
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
    description:
      'List the managed agents saved in your project, with their ids and descriptions. Cheap and read-only. Use it to find an agentId for `agent_run`, or to check what already exists before `agent_create` (ids are unique per project, so creating a duplicate id fails).',
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
      'Run a task on a managed agent in its Linux sandbox. SPENDS MONEY, token-metered (Google documents 100k-3M tokens for a single interaction), and it draws on the same budget ceiling as a research run. Synchronous: it blocks until the agent finishes (default 5 min cap), unlike Deep Research which is always background. Use it when the job has to produce FILES or run code over data; use `research_start` when you want a cited research report.',
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
      const agents = requireAgents();
      // Same ceiling as a research run. This path was previously ungated.
      await deps.runner.reserveNonResearchSpend(`agent_run:${args.agentId}`);
      log.info('Running managed agent', { agentId: args.agentId });
      const result = await agents.run({
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


  // ───────────────────────────────────────────────────────────── doctor ────
  server.addTool({
    name: 'research_doctor',
    description:
      'Audit every research backend Dossier knows about: what is working, what is configured but unproven, what is broken, and what COULD be on but is not. Spends nothing and makes no network calls. The "could be on" rows are the point: without them you cannot tell that a capability is missing, only that you never used it.',
    annotations: { title: 'Audit research backends', readOnlyHint: true, openWorldHint: false },
    parameters: z.object({
      probeLocal: z
        .boolean()
        .default(true)
        .describe(
          'Also probe the coding CLIs on this machine. Local, offline and free: it runs `--version` on each and checks for a sign-in file, never reading a credential.',
        ),
    }),
    async execute(args) {
      const rows = deps.providers.list().map((p) => {
        const status = p.detect();
        const icon =
          status.state === 'ready'
            ? '✅ WORKING'
            : status.state === 'configured-unverified'
              ? '🟡 CONFIGURED, UNVERIFIED'
              : status.state === 'broken'
                ? '❌ NOT WORKING'
                : '⚪ COULD BE ON';
        return { p, status, icon };
      });

      const lines: string[] = ['## Research backends', ''];
      for (const { p, status, icon } of rows) {
        lines.push(`### ${icon} · ${p.label}`);
        lines.push(`- ${status.detail}`);
        if (status.fix) lines.push(`- **To enable**: ${status.fix}`);
        const c = p.capabilities;
        const can: string[] = [`shapes: ${c.shapes.join(', ')}`];
        if (c.planReview) can.push('**editable plan before spending**');
        if (c.dateFilter !== 'none') can.push(`date filter (${c.dateFilter})`);
        if (c.domainFilter > 0) can.push(`domain filter (max ${String(c.domainFilter)})`);
        if (c.corpus !== 'none') can.push(`corpus (${c.corpus})`);
        if (c.socialSources.length > 0) can.push(`social: ${c.socialSources.join(', ')}`);
        if (c.fileOutput) can.push('writes result files');
        lines.push(`- Capabilities: ${can.join(' · ')}`);
        if (c.limitations.length > 0) {
          lines.push(`- Limitations: ${c.limitations.map((l) => `\n  - ${l}`).join('')}`);
        }
        lines.push('');
      }

      const usable = rows.filter((r) => r.status.state !== 'not-configured');
      lines.push(
        usable.length === 0
          ? '**No backend is usable.** Set at least one provider key; `research_plan` still works and costs nothing.'
          : `**${String(usable.length)} of ${String(rows.length)} backends usable.** Nothing here was verified against a live API; that would cost money and is not done automatically.`,
      );

      if (args.probeLocal && !deps.config.hermetic) {
        const clis = await probeAllClis();
        lines.push('', '## Coding CLIs on this machine', '');
        lines.push(
          '_A CLI you already pay for is a research backend with no API bill. On the April 2026 agent bench, Claude Code driving plain web search scored 97.0% at $1.54, against 75.8% at $10.92 for a premium deep-research API on the same questions._',
          '',
        );
        for (const cli of clis) {
          const icon = {
            ready: '✅ READY',
            'present-unauthed': '🟡 INSTALLED, NOT SIGNED IN',
            ambiguous: '❓ AMBIGUOUS',
            absent: '⚪ NOT INSTALLED',
          }[cli.state];
          lines.push(`### ${icon} · ${cli.label}`);
          lines.push(`- ${cli.detail}`);
          if (cli.path) lines.push(`- Path: \`${cli.path}\``);
          lines.push(`- Billing: ${cli.billing}`);
          if (cli.caution) lines.push(`- ⚠ ${cli.caution}`);
          lines.push('');
        }
        const ready = clis.filter((c) => c.state === 'ready');
        const ambiguous = clis.filter((c) => c.state === 'ambiguous');
        lines.push(
          ready.length === 0
            ? '_No signed-in CLI found. Any of the above would give you a zero-API-cost research backend._'
            : `_${String(ready.length)} CLI(s) ready. Use one with \`research_start { provider: "local" }\`, or set \`DOSSIER_LOCAL_CLI\` to choose which. It is never selected automatically: it costs $0, so a cost tie-break would pick it every time, over a subscription quota Dossier cannot meter._`,
        );
        if (ambiguous.length > 0) {
          lines.push(
            '',
            `_${String(ambiguous.length)} binary(ies) could not be identified. Several vendors ship executables called \`agent\` and \`grok\`; an unidentified one is never run, because handing your brief to a different vendor's tool is a different bill._`,
          );
        }
      }
      return lines.join('\n');
    },
  });

  // ───────────────────────────────────────────────────────────── import ────
  server.addTool({
    name: 'research_import',
    description:
      'Import a research report that was produced somewhere else — a Gemini or ChatGPT share link, or markdown you paste in — and store it as a normal Dossier run. Spends nothing on research. This is how you use a SUBSCRIPTION you already pay for instead of an API balance: you run the report in the web app yourself, share it, and paste the link here. Once imported it reads, greps, profiles and citation-verifies exactly like an API-sourced run.',
    annotations: {
      title: 'Import a report from elsewhere',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    parameters: z.object({
      url: z
        .string()
        .url()
        .max(2000)
        .optional()
        .describe('A PUBLIC share link. Supply this or `markdown`, not both. A link that needs your login cannot be fetched from here.'),
      markdown: z
        .string()
        .min(50)
        .max(2_000_000)
        .optional()
        .describe('The report text itself, pasted. Always works, and needs nothing to be public.'),
      question: z.string().min(3).max(20_000).describe('The question this report answers. Recorded so the run reads like any other.'),
      label: z.string().max(200).optional(),
      tags: z.array(z.string().max(60)).max(20).optional(),
    }),
    execute: async (args) => {
      if ((args.url && args.markdown) || (!args.url && !args.markdown)) {
        throw new UserError('Pass `url` for a public share link, or `markdown` for the text itself. Exactly one.');
      }

      let markdown = args.markdown ?? '';
      let source = 'pasted text';
      if (args.url) {
        // Same SSRF-safe path as citation verification: a share link is a
        // caller-supplied URL, and this one is fetched rather than merely
        // checked, so it gets the same DNS and redirect validation.
        const fetched = await safeFetch(args.url, { method: 'GET', timeoutMs: 20_000, maxBytes: 4 * 1024 * 1024 }).catch(
          (e: unknown) => {
            throw new UserError(
              `Could not fetch that link: ${e instanceof Error ? e.message : String(e)}. If it needs your login it cannot be fetched from here — open it yourself and paste the text as \`markdown\`.`,
            );
          },
        );
        markdown = htmlToMarkdown(fetched.body);
        source = args.url;
        if (markdown.trim().length < 200) {
          throw new UserError(
            `That URL returned ${String(markdown.trim().length)} characters of text, which is not a report. Share links from most apps render client-side, so the server sends an empty shell. Open it and paste the text as \`markdown\` instead.`,
          );
        }
      }

      const record = await runner.importRun({
        question: args.question,
        markdown,
        source,
        ...(args.label ? { label: args.label } : {}),
        ...(args.tags ? { tags: args.tags } : {}),
      });

      const registry = buildRegistry(markdown);
      return [
        `**Imported.** Handle: \`${record.id}\``,
        '',
        `- Source: ${source}`,
        `- ${String(markdown.length)} characters · ~${String(estimateTokens(markdown))} estimated tokens · ${String(registry.length)} distinct source(s) cited`,
        `- Charged: **nothing**. Whatever produced this report was billed wherever it ran.`,
        '',
        'It behaves like any other run from here:',
        `- \`research_read { runId: "${record.id}" }\` reads it outline-first`,
        `- \`research_verify_citations { runId: "${record.id}" }\` dereferences every URL it cites`,
        `- \`research_evidence { runId: "${record.id}" }\` profiles the source mix`,
        '',
        registry.length === 0
          ? '> [!WARNING]\n> No citations were found in that text. An uncited report cannot be verified against anything, which is worth knowing before you rely on it.'
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  });

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
            limitations: backendLimitations(config),
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

  // ORDER IS LOAD-BEARING. FastMCP matches templates in registration order and
  // `{runId}` happily captures a slash, so registering the generic
  // `research://run/{runId}` first makes it swallow `/report` and `/citations`
  // (runId becomes "dr_x/report") and the specific templates never match at
  // all. The generic one is registered last, below.
  server.addResourceTemplate({
    uriTemplate: 'research://run/{runId}/report',
    name: 'Research report (markdown)',
    mimeType: 'text/markdown',
    arguments: [{ name: 'runId', description: 'The run handle', required: true }],
    async load({ runId }) {
      const markdown = await store.readReport(runId);
      if (!markdown) return { text: `# No report\n\nRun \`${runId}\` has not produced a report.` };
      // The tools default to an outline for a reason: a 60,000-token report in
      // one payload is a denial-of-service against the caller's own context.
      // The resource used to hand back the whole thing unbounded, which made
      // the discipline everywhere else optional.
      const LIMIT = 200_000; // characters, roughly 50k tokens
      if (markdown.length <= LIMIT) return { text: markdown };
      return {
        text:
          `${markdown.slice(0, LIMIT)}\n\n---\n\n` +
          `**Truncated at ${LIMIT.toLocaleString()} of ${markdown.length.toLocaleString()} characters.** ` +
          'Read the rest by section with `research_read { runId, mode: "section" }`, or search it with ' +
          '`research_read { runId, mode: "grep" }`. The full report is on disk and nothing was lost.',
      };
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
        '5. Check for aggregator reliance: `research_read { runId, mode: "grep", pattern: "SECONDARY" }` and scan cited domains for listicles, content farms, and vendor comparison pages presented as evidence. `research_evidence { runId }` does the domain-concentration arithmetic for you and costs nothing.',
        '',
        'Then run the four lenses, each as a separate pass and each of them trying to REFUTE rather than to summarise. Say what you checked on every lens, including where you found nothing; a lens that reports nothing checked is not the same as a lens that reports nothing found.',
        '',
        '- **Claim validator**: is each load-bearing claim actually supported by the source it cites? `research_verify_claims { runId }` fetches the pages and judges this directly, at the cost of one small model call per claim.',
        '- **Source diversity**: is any conclusion resting on one organisation cited through its blog, its press release and a syndicated write-up of that press release, counted as three sources?',
        '- **Recency**: has anything been superseded? Present-tense claims from dated sources are the usual offender.',
        '- **Contradiction**: does a number in the summary match the body, and is the conclusion stronger than the evidence section under it?',
        '',
        'Report: claims you would act on, claims you would not, and the specific re-sourcing each rejected claim needs.',
        '',
        'If all four lenses come back empty, say so as a **failed review** rather than a clean report. Four adversarial passes finding nothing in a long report usually means the passes did not bite.',
      ].join('\n');
    },
  });

  /**
   * The subscription path, as a prompt rather than as automation.
   *
   * Dossier is a stdio MCP server: it has no browser and cannot drive the
   * host's. The drivers that can reach a signed-in Google session are all
   * capabilities of the *client*, so the portable form of this feature is
   * method, not code — which is what MCP prompts are for.
   *
   * That happens to land on the right side of the risk too. Automating the
   * Gemini web app means driving a path its own robots.txt disallows, on the
   * user's own account, where the exposure is suspension rather than an error
   * message. So this hands over the procedure and the trade-off and lets a
   * person decide, instead of a server deciding quietly on their behalf.
   */
  server.addPrompt({
    name: 'gemini-web-session',
    description:
      'Run Deep Research on a Google AI Pro/Ultra SUBSCRIPTION instead of paying per run through the API, then import the result. Returns the exact procedure, the controls to look for, the failure states worth distinguishing, and the terms-of-service position, stated plainly.',
    arguments: [
      { name: 'question', description: 'What you want researched', required: true },
      {
        name: 'mode',
        description: '`assisted` (default): you drive the browser, Dossier writes the brief and imports the result. `automated`: guidance for a client that has browser tools.',
        required: false,
      },
    ],
    load: async (args) => {
      const built = buildPrompt({ question: args['question'] ?? '' });
      const automated = (args['mode'] ?? 'assisted').toLowerCase() === 'automated';
      const shared = [
        '## The controls, as they actually are',
        '',
        '| Control | Accessible name | Type |',
        '|---|---|---|',
        '| Prompt input | `Enter a prompt for Gemini` | textbox |',
        '| Tools menu | `Upload & tools` | button |',
        '| Deep Research toggle | `Deep research` | **menuitemcheckbox** |',
        '| Model picker | `Open mode picker, currently <name>` | button |',
        '',
        'Two traps worth knowing before you start:',
        '',
        '1. **Deep Research is a checkbox, not a button.** Read its state before clicking it; clicking a checked box turns it off, and the run then quietly proceeds as an ordinary chat.',
        '2. **The parent menu has been renamed at least twice.** Google\'s docs say "Add Files", a walkthrough calls it a globe icon, the live DOM says "Upload & tools". The `Deep research` child has been stable throughout, so anchor on the child.',
        '',
        'The sequence: type the brief, open the tools menu, enable Deep research, submit, wait for the **research plan**, approve with `Start research` (or revise with `Edit plan`), wait, then `Open`. The report lands in the **Canvas panel on the right**, not in the chat.',
        '',
        '## Two states that look like a broken locator and are not',
        '',
        '- **A Workspace admin can disable the Gemini app entirely** (Admin console → Generative AI → Gemini app → Service status), per organisational unit or group.',
        '- **Free accounts can find Deep Research unavailable during high demand.**',
        '',
        'Both present as a missing control. Neither is worth retrying.',
      ];

      const importStep = [
        '## Bring it back',
        '',
        'Use **Share & export → Share Canvas** to get a public link, then:',
        '',
        '```',
        `research_import { url: "<the share link>", question: ${JSON.stringify(args['question'] ?? '')} }`,
        '```',
        '',
        'If the link needs your login, or the page renders client-side and imports empty, use **Copy Contents** and pass the text as `markdown` instead. Either way it becomes a normal run: outline-first reads, grep, citation verification, evidence profiling.',
      ];

      if (!automated) {
        return [
          '# Run this on your subscription',
          '',
          'You have already paid for Deep Research if you have Google AI Pro or Ultra. This is how to spend that instead of an API balance. Dossier writes the brief and takes the result back; the ten seconds of clicking are yours.',
          '',
          '## 1. The brief to paste',
          '',
          '```',
          built.prompt,
          '```',
          '',
          ...shared,
          '',
          ...importStep,
          '',
          '> [!NOTE]',
          '> This route touches nothing Google disallows: you are using the app normally, and a published share link is a public URL. It is also more reliable than automating the same clicks will ever be, because it cannot break when a button is renamed.',
        ].join('\n');
      }

      return [
        '# Driving the Gemini web app directly',
        '',
        '> [!CAUTION]',
        '> **Read this before automating anything.** `gemini.google.com/robots.txt` disallows `/app/` and `/chat/`, and Google\'s Terms of Service prohibit "using automated means to access content from any of our services" where that violates machine-readable instructions on their pages — naming robots.txt as the example. The Gemini web app is at `/app`. On a plain reading, driving that UI with an agent is the thing the clause describes, and the practical exposure is **suspension of your Google account**, not a policy footnote.',
        '>',
        '> The honest counterweight: robots.txt is a crawler convention, and an agent acting inside your own signed-in session at your direction is arguably not crawling. Google has published no carve-out and there is no enforcement precedent either way. It is untested rather than settled, and the text is broad enough to cover it. That is your call to make, which is why this prompt states it rather than deciding for you.',
        '>',
        '> The assisted mode of this prompt does the same job with none of that exposure. Prefer it unless you have a reason not to.',
        '',
        '## The brief',
        '',
        '```',
        built.prompt,
        '```',
        '',
        ...shared,
        '',
        '## Rules for the automation itself',
        '',
        '- **Only a driver that attaches to your existing session will work.** Google blocks sign-in from browsers flagged as automated, so anything running its own profile (agent-browser, a plain Playwright launch, Safari\'s automation windows) will fail at the login, not at the research.',
        '- **Never type a password.** Attach to a session that already exists. If you are being asked for credentials, stop.',
        '- **Assert after every step.** If the plan card does not appear, say so and stop; do not wait forty minutes on a page that never started.',
        '- **Check the model before you commit.** A locator that missed and left Flash selected turns a forty-minute investigation into a fast wrong answer, silently.',
        '',
        ...importStep,
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
  const providers = new ProviderRegistry(config, () => client);
  const utility = createUtilityModel(config);

  const resolveProviderClient = (id: ProviderId): DeepResearchClient | null => {
    const provider = providers.get(id);
    if (!provider || provider.detect().state === 'not-configured') return null;
    try {
      return provider.client();
    } catch {
      return null;
    }
  };
  const runner = new Runner(store, config, resolveProviderClient, async (run, markdown) => {
    if (!utility) return;
    // Automatic titling fires on every completed run, so it is the most
    // frequent billed call in the server and was entirely outside the ledger.
    await runner.reserveUtilitySpend(`title:${run.id}`);
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
  },
  // The gate must reserve the band of the backend that will actually run.
  (id, input) => providers.get(id)?.estimate(input).cost ?? estimateCost(input),
  );

  return {
    config,
    store,
    runner,
    client,
    corpus: resolveCorpusClient(config),
    agents: resolveAgentsClient(config),
    utility,
    providers,

  };
}
