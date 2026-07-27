import { timingSafeEqual } from 'node:crypto';
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { createUtilityModel, type UtilityModel } from './ai/utility.js';
import { backendLimitations, describeAuth, loadConfig, type Config } from './config.js';
import { assertStoreName, resolveCorpusClient, type CorpusClient } from './corpus/files.js';
import { LocalCorpus } from './corpus/local.js';
import { probeAllBrowserTools, renderBrowserTools } from './local/browser.js';
import {
  CLI_ADAPTERS,
  checkAllHeadlessArgv,
  probeAllClis,
  probeCliModel,
  type CliArgvCheck,
  type CliId,
} from './local/cli.js';
import { describeProbeAge, readModelCache, writeModelCache } from './local/model-cache.js';
import {
  DEFAULT_BASE_AGENT,
  RESEARCH_AGENT_INSTRUCTION,
  resolveAgentsClient,
  type AgentsClient,
} from './gemini/agents.js';
import { resolveClient, type DeepResearchClient, type ResearchToolSpec } from './gemini/client.js';
import { ProviderRegistry, type PanelDecision } from './providers/registry.js';
import { describeShaping, shapeRequest } from './providers/options.js';
import { PROVIDER_IDS, type ProviderId, type Shape } from './providers/types.js';
import { estimateCost, estimateDuration, formatCostBand, formatDuration } from './gemini/cost.js';
import type { CostBand } from './gemini/cost.js';
import { describeSignals, profileQuestion } from './research/profile.js';
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
import { readCoverage, readLedgerFor, recordRead, renderReadCoverage } from './research/reading.js';
import {
  canonicaliseUrl,
  type ConvergenceCandidate,
  crossCheck,
  findConvergence,
  type ProviderClaimSet,
} from './research/corroborate.js';
import { decompose, renderDispatch, renderTasks } from './research/decompose.js';
import { describeOverlap, mergeEvidence, renderMergedRegistry, type RunEvidence } from './research/synthesise.js';
import {
  assessCapabilities,
  coverageFailed,
  FindingSchema,
  freezeRegistry,
  HostCapabilitiesSchema,
  LoopModeSchema,
  mergeFindings,
  renderBlackBox,
  renderCapabilities,
  renderCoverageFailures,
  renderDeepNotes,
  renderRefusals,
  renderRegistry,
  renderStaleness,
  SessionSchema,
  TaskOutcomeSchema,
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
import { failureTag } from './research/failure.js';
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
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

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
  'Research archetype. Omit to auto-select from the question. Exactly one is applied, mixing two is a decomposition trigger, not a prompt expansion.',
);

const ScopeSchema = z
  .object({
    jurisdiction: z.string().max(300).optional().describe('Jurisdiction or geography, load-bearing for regulatory and market work.'),
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
  '---\n\n_**synthesised**, this is inference over one existing report, not new research. It inherits that report’s errors and cannot raise a claim’s confidence: a finding that was single-source there is still single-source here, however confidently it is restated._';

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

/**
 * How a panel is written into the contract fingerprint.
 *
 * The handshake binds the backend because a plan that priced Gemini and a start
 * that ran OpenAI are different purchases. A panel is the same argument at
 * larger scale: a plan that priced two members and a start that ran five is a
 * different bill, so the whole membership goes into the key. Sorted, because the
 * order the lanes happened to produce is not part of what was bought.
 */
export function panelContractId(members: readonly ProviderId[]): string {
  return `panel:${[...members].sort().join('+')}`;
}

/**
 * Print a panel the way the money is actually spent: lane by lane, member by
 * member, with a cost each and a total, before any fingerprint is issued.
 *
 * The free lane is shown separately from the paid one on purpose. Without that
 * split the reader cannot see what the money is buying over and above what their
 * subscriptions already cover, which is the whole question a panel raises.
 */
export function renderPanel(panel: PanelDecision): string[] {
  const money = (band: CostBand): string => (band.highUsd === 0 ? '$0.00' : formatCostBand(band));
  const lines: string[] = [];

  if (panel.members.length === 0) {
    lines.push('- **Panel**: empty. No configured backend belongs on this question.');
  } else {
    lines.push(
      `- **Panel**: ${String(panel.members.length)} backend${panel.members.length === 1 ? '' : 's'}` +
        ` (${String(panel.free.length)} free, ${String(panel.paid.length)} paid): ` +
        `${money(panel.total)} in total. Reserved in full at the top of that band before any member starts.`,
    );
  }

  if (panel.free.length > 0) {
    lines.push('  - *Free lane* (subscription quota already paid for, which Dossier cannot meter):');
    for (const m of panel.free) lines.push(`    - **${m.provider.label}**, ${money(m.cost)}. ${m.reason}`);
  }
  if (panel.paid.length > 0) {
    lines.push('  - *Paid lane* (billed to an API key, on this question profile):');
    for (const m of panel.paid) lines.push(`    - **${m.provider.label}**, ${money(m.cost)}. ${m.reason}`);
  }
  if (panel.members.length > 0) {
    lines.push(`  - **Total worst case**: $${panel.total.highUsd.toFixed(2)}. An estimate band, never a quote.`);
  }

  lines.push(`- **Question profile**: ${describeSignals(panel.profile)} (archetype: ${panel.profile.archetype}).`);
  if (panel.crawl) {
    lines.push(
      `- **Crawl lane**: recommended, not enabled. ${panel.crawl.why}` +
        (panel.crawl.sites.length > 0 ? ` Sites named: ${panel.crawl.sites.join(', ')}.` : '') +
        ' Dossier drives no browser; set DOSSIER_BROWSER_PROVIDER and drive it yourself if you want those pages read.',
    );
  }
  if (panel.rejected.length > 0) {
    lines.push(`- **Not on the panel**: ${panel.rejected.map((r) => `${r.id} (${r.why})`).join('; ')}`);
  }
  for (const note of panel.notes) lines.push(`\n> [!NOTE]\n> ${note}`);
  return lines;
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
      '1. `research_plan`, free. Returns the engineered prompt, a cost band, and a contract fingerprint.',
      '2. `research_start`, spends money. Returns a HANDLE immediately; the run continues for 4-60 minutes with or without you.',
      '3. `research_status` / `research_tail`, check on it. Runs survive your disconnect and this server restarting.',
      '4. `research_read`, read the report by OUTLINE first, then by section. It never returns a ~60k-token report inline.',
      '5. `research_verify_citations`, dereference every cited URL before anyone acts on the findings.',
      '',
      'Costs are real: roughly $1-3 per fast run and $3-7 per max run, charged whether or not you read the result. There is a budget gate and identical requests de-duplicate onto one run.',
      '',
      'If you already have an engineered Deep Research brief (from the bundled deep-research-prompt-creator skill, say), pass it as `question`, it is detected and sent verbatim rather than re-wrapped.',
    ].join('\n'),
    health: { enabled: true, path: '/health' },
  });

  // ───────────────────────────────────────────────────────── plan (free) ────
  server.addTool({
    name: 'research_plan',
    description:
      'Plan a Deep Research run WITHOUT spending anything. Returns the fully engineered prompt, the selected archetype, a cost and duration band, and a contract fingerprint you pass to `research_start`. Always call this first for anything non-trivial, it is free, and it is where you catch a badly-scoped question before it costs $7.',
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
      // The panel this question would assemble. Read from the question itself,
      // free, and shown before a fingerprint exists, which is the whole safety
      // story for paid backends joining automatically.
      const panel = deps.providers.assemblePanel({
        shape: 'deep',
        corpus: (args.corpusStores?.length ?? 0) > 0,
        planReview: args.collaborativePlanning,
        estimateInput: { tier: args.tier, tools: tools.map((x) => x.type) },
        profile: profileQuestion(args.question),
      });
      // The contract binds the backend too. A plan that priced Gemini and a
      // start that ran OpenAI are different purchases, and the handshake exists
      // to stop exactly that kind of substitution going unnoticed. A panel binds
      // the whole membership for the same reason.
      const plannedProvider = args.provider
        ? args.provider
        : panel.members.length > 0
          ? panelContractId(panel.members.map((m) => m.provider.id))
          : routingForPlan.provider?.id;
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

      // The plan exists to show what the run will actually do. `research_start`
      // honours an explicit `provider`, so a plan that reports the routed
      // backend instead is lying about the thing it was called to confirm.
      // This shipped: asking for Gemini and being shown xAI made the argument
      // look ignored when only the display was wrong.
      const overridden = Boolean(args.provider) && args.provider === plannedProvider;

      const existing = await store.findByFingerprint(fp, config.dedupeTtlMinutes);

      return [
        `## Research plan (nothing spent)`,
        '',
        `- **Archetype**: ${resolved.archetype}${resolved.preEngineered ? ' (your brief was already engineered, it will be sent verbatim)' : ''}`,
        `- **Tier**: ${args.tier} (\`${AGENT_BY_TIER[args.tier]}\`)`,
        `- **Estimated cost**: ${formatCostBand(band)}, ${band.basis}. This is a guardrail estimate, not a quote.`,
        `- **Estimated duration**: ${formatDuration(duration)}.`,
        `- **Sources it will consult**: ${duration.sources.join(' · ')}`,
        `- **What drives that estimate**: ${duration.factors.join('; ')}`,
        `- **Tools**: ${tools.map((t) => t.type).join(', ')}`,
        `- **Plan review**: ${args.collaborativePlanning ? 'ON, you will approve a plan before the run executes' : 'OFF, the run executes autonomously'}`,
        `- **Budget**: $${budget.committedUsd.toFixed(2)} committed of $${budget.budgetUsd.toFixed(2)} in the last ${budget.windowHours}h; $${budget.remainingUsd.toFixed(2)} remaining.`,
        `- **Backend**: ${overridden && args.provider ? `${deps.providers.get(args.provider)?.label ?? args.provider}, you asked for this one, so routing was not consulted` : routing.provider ? `${routing.provider.label}, ${routing.reason}` : 'none available'}`,
        ...(overridden || !routing.runnerUp ? [] : [`- **Runner-up**: ${routing.runnerUp.label}`]),
        ...(!overridden && routing.rejected.length > 0
          ? [`- **Not eligible**: ${routing.rejected.map((r) => `${r.id} (${r.why})`).join('; ')}`]
          : []),
        // Naming a provider is an instruction, so the panel it describes is that
        // one backend. Assembling and printing a wider one would advertise a
        // purchase `research_start` is not going to make.
        ...(overridden ? [] : renderPanel(panel)),
        `- **Contract fingerprint**: \`${fp}\``,
        ...(resolved.warnings ?? []).map((w: string) => `\n> [!WARNING]\n> ${w}`),
        '',
        existing
          ? `⚠ **An identical run already exists** (${describeRun(existing)}). Calling \`research_start\` with this fingerprint returns that run instead of paying again.`
          : `Start it with \`research_start { question, tier: "${args.tier}", contractFingerprint: "${fp}" }\`, pass the same question, tier, scope and corpusStores or the fingerprint will not match.`,
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
      'Start a Deep Research run. THIS SPENDS MONEY (~$1-3 fast, ~$3-7 max) and cannot be undone once the agent begins searching. Returns a run handle immediately, the run then proceeds in the background for 4-60 minutes and survives your disconnect. Identical requests inside the dedupe window return the existing run instead of paying twice. Without an explicit `provider` this assembles a PANEL: every capable CLI you already pay for, plus any API backend whose distinctive strength the question calls for. The whole panel is reserved before any member starts, `research_plan` prints it member by member with a cost each, and each member is its own run handle. Name a `provider` to run exactly one backend.',
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
          'Run exactly ONE backend, named. Omit it to assemble a panel instead: capability is filtered first (a date window or an editable plan eliminates backends that cannot enforce it), then every capable CLI you already pay for joins free, then an API backend joins when the question calls for what it is distinctively good at. Run `research_doctor` to see what is configured.',
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
      // Naming a provider is still an instruction and still produces exactly one
      // run, on exactly the path it always took. Everything else assembles a
      // panel, which is a panel of one whenever only one backend belongs.
      const panel = args.provider
        ? null
        : deps.providers.assemblePanel({
            shape: 'deep',
            corpus: (args.corpusStores?.length ?? 0) > 0,
            planReview: args.collaborativePlanning,
            estimateInput: { tier: args.tier, tools: tools.map((x) => x.type) },
            profile: profileQuestion(args.question),
          });
      const members = panel?.members.map((m) => m.provider.id) ?? [];
      const chosen = args.provider ?? (members.length > 0 ? members[0]! : (routing.provider?.id ?? 'gemini'));
      const expected = runner.fingerprintFor({
        prompt: resolved.prompt,
        tier: args.tier,
        tools,
        collaborativePlanning: args.collaborativePlanning,
        provider: members.length > 0 ? panelContractId(members) : chosen,
        ...(args.attachments ? { attachments: args.attachments } : {}),
      });

      if (config.requireContract && !args.contractFingerprint) {
        throw new UserError(
          `This server requires the plan→start handshake. Call \`research_plan\` first and pass its contractFingerprint. (Expected for these arguments: ${expected})`,
        );
      }
      if (args.contractFingerprint && !fingerprintMatches(args.contractFingerprint, expected)) {
        throw new UserError(
          `Contract mismatch, the arguments changed since \`research_plan\`. Expected ${expected}, got ${args.contractFingerprint}. Re-plan, or drop contractFingerprint to start from these arguments.`,
        );
      }

      if (panel && members.length > 0) {
        // Every member's credentials are checked before anything is reserved.
        // A panel that finds out at member four that member five has no key has
        // already spent money it cannot take back.
        for (const id of members) requireProviderClient(deps, id);
        log.info('Starting a research panel', {
          tier: args.tier,
          archetype: resolved.archetype,
          members: members.join('+'),
        });
        const result = await runner.startPanel({
          question: args.question,
          prompt: resolved.prompt,
          archetype: resolved.archetype,
          tier: args.tier,
          tools,
          collaborativePlanning: args.collaborativePlanning,
          thinkingSummaries: true,
          visualization: true,
          preEngineered: resolved.preEngineered,
          members,
          ...(args.label ? { label: args.label } : {}),
          ...(args.tags ? { tags: args.tags } : {}),
          ...(args.attachments ? { attachments: args.attachments } : {}),
        });
        const budgetAfter = await runner.budget();
        const fresh = result.started.filter((s) => !s.deduped);
        const reused = result.started.filter((s) => s.deduped);
        return [
          members.length === 1
            ? `**Panel of one started.** ${panel.members[0]?.provider.label ?? members[0]} is the only backend that belongs on this question, which is a result and not a fallback.`
            : `**Panel of ${String(members.length)} started.** One brief, ${String(members.length)} backends, each run separately.`,
          '',
          `- Panel: \`${result.panelId}\``,
          ...result.started.map(
            (s) =>
              `- \`${s.run.id}\`: ${deps.providers.get(s.run.provider)?.label ?? s.run.provider}, ` +
              `$${s.run.estimatedCostUsd.toFixed(2)} worst case, ${s.run.state}` +
              (s.deduped ? ' (de-duplicated onto an existing run; nothing new was charged for it)' : ''),
          ),
          ...result.failed.map((f) => `- ${f.provider} did not start: ${f.error}`),
          '',
          `- **Reserved**: $${result.reservedUsd.toFixed(2)} for ${String(fresh.length)} new run${fresh.length === 1 ? '' : 's'}` +
            (reused.length > 0 ? ` (${String(reused.length)} de-duplicated, and not charged again)` : '') +
            '. The whole panel was reserved at the top of its band before any member started; an estimate, never a quote.',
          `- **Budget after this panel**: $${budgetAfter.remainingUsd.toFixed(2)} of $${budgetAfter.budgetUsd.toFixed(2)} left in the next ${String(budgetAfter.windowHours)}h.`,
          ...(result.failed.length > 0
            ? [
                '',
                `> [!WARNING]\n> ${String(result.failed.length)} member${result.failed.length === 1 ? '' : 's'} did not start. The rest are running and are already being billed; re-running this question will de-duplicate onto them and pay only for the missing ones.`,
              ]
            : []),
          '',
          members.length > 1
            ? 'Do NOT block on this. Each member is its own run: `research_status { runId }` and `research_read { runId }` work per member. When every member finishes, the panel is merged automatically and the overlap warning is written to each member\'s journal. Read it with `research_tail { runId }`. Agreement between members is not corroboration; support is counted in independent registrable domains.'
            : 'Do NOT block on this. Check back with `research_status { runId }`, or replay progress with `research_tail { runId }`. The run continues if you disconnect and if this server restarts.',
        ].join('\n');
      }

      requireProviderClient(deps, chosen);
      if (args.collaborativePlanning && deps.providers.get(chosen)?.capabilities.planReview !== true) {
        // Otherwise the backend's first full report is stored as a "plan", and
        // approving it buys a second full run with no second reservation. Two
        // reports, one reservation, and the first one silently relabelled.
        throw new UserError(
          `${deps.providers.get(chosen)?.label ?? chosen} has no editable plan before spending, so \`collaborativePlanning\` cannot be honoured there. ` +
            'Drop it, or use Gemini, which is the only backend that offers one.',
        );
      }
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
          `**De-duplicated onto an existing run, nothing new was charged.**`,
          '',
          `- Handle: \`${run.id}\``,
          `- ${describeRun(run)}`,
          `- ${stateHint(run.state)}`,
        ].join('\n');
      }

      return [
        `**Run started.** Handle: \`${run.id}\``,
        '',
        `- State: ${run.state}, ${stateHint(run.state)}`,
        `- Backend: ${backend?.label ?? chosen}`,
        `- Tier: ${run.tier} · archetype: ${run.archetype}`,
        `- **Estimated cost**: ${formatCostBand(band)}, ${band.basis}. Reserved at the top of that band against your daily ceiling; an estimate, never a quote.`,
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
      'Approve (optionally amending) the research plan a collaborative-planning run proposed, releasing it to execute. Editing the plan here, pruning tangential branches, injecting missing angles, narrowing broad definitions, is the highest-leverage intervention available on a Deep Research run.',
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
      'Check one run, or all in-flight runs. Reports liveness separately from status: a run with no forward progress inside the watchdog window is marked `stalled`, which is a state you can branch on, `in_progress` alone cannot distinguish a thinking run from a dead one.',
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
          `### \`${run.id}\`, ${run.state}${run.failureKind ? ` · **${failureTag(run.failureKind)}**` : ''}`,
          '',
          `- ${stateHint(run.state, run.failureKind, run.failureStatus)}`,
          `- Tier ${run.tier} · archetype ${run.archetype} · started ${run.createdAt}`,
          `- Last forward progress: ${idleMinutes} minute(s) ago`,
          run.budgetReleased
            ? `- Committed cost: **$0.00**, the $${run.estimatedCostUsd.toFixed(2)} reservation was released because the provider refused the request and created nothing.`
            : `- Committed cost: ~$${run.estimatedCostUsd.toFixed(2)}`,
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
            'Read it with `research_read { runId }`, outline first; it is far too large to return inline.',
          );
        }
        // The provider's own words, in full, where a person looking at a failed
        // run will see them. The text was always on the record and never shown
        // here, so a quota problem, an entitlement problem and a malformed
        // request all read as the same unexplained failure.
        if (run.error) {
          lines.push(
            '',
            `**Upstream error${run.failureStatus === undefined ? '' : ` (HTTP ${String(run.failureStatus)})`}:**`,
            '',
            '```',
            run.error.slice(0, 2000),
            '```',
          );
        }
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
        ...active.map((r) => `- ${describeRun(r)}${r.label ? `, ${r.label}` : ''}`),
        '',
        `Budget: $${budget.committedUsd.toFixed(2)} of $${budget.budgetUsd.toFixed(2)} committed in the last ${budget.windowHours}h.`,
      ].join('\n');
    },
  });

  // ───────────────────────────────────────────────────────────────── tail ────
  server.addTool({
    name: 'research_tail',
    description:
      'Replay a run’s durable progress journal from a cursor: pass the returned cursor next time to get only what is new. A client that disconnected at minute 3 of a 45-minute run loses nothing. Note the timing: while a run is in flight the API reports no intermediate steps, so mid-run you see lifecycle events only (created, plan, progress, stalled); the researcher’s reasoning summaries all land in one batch when it completes. For reasoning as it happens you would need the SSE stream, which this server does not yet consume.',
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
        `### \`${args.runId}\`, ${run.state} · ${page.length} event(s)`,
        '',
        ...page.map((e) => `**[${e.seq}] ${e.at} ${e.kind}**, ${e.message.slice(0, 2000)}`),
        '',
        `Next cursor: \`sinceSeq: ${cursor}\`${events.length > page.length ? ` (${events.length - page.length} more buffered)` : ''}`,
      ].join('\n');
    },
  });

  // ───────────────────────────────────────────────────────────────── read ────
  server.addTool({
    name: 'research_read',
    description:
      'Read a completed report WITHOUT blowing up your context. Defaults to an outline with per-section token estimates; pull individual sections by index or title, grep for a term, or take the full text under an explicit token budget. A Deep Research report is ~60k tokens, returning one inline is how a session dies.',
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

      // Where the full report actually lives, and what produced it. Both were
      // recorded from the first release and neither was ever shown, so a caller
      // could read an outline of a 48,000-character report without learning
      // that the report was on disk or which model wrote it.
      const provenance = describeProvenance(run, store.reportPath(run.id));

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
            '',
            provenance,
          ].join('\n');
        }
        case 'outline':
          await recordRead(store, args.runId, { mode: 'outline', sections: [], chars: 0, at: new Date().toISOString() });
          return `${renderOutline(markdown)}\n\n${provenance}`;
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
          await recordRead(store, args.runId, {
            mode: 'section',
            sections: [found.index],
            chars: clamped.text.length,
            at: new Date().toISOString(),
          });
          return `_Section ${found.index}/${outlineReport(markdown).length} · ~${found.estimatedTokens} estimated tokens_\n\n${clamped.text}\n\n${provenance}`;
        }
        case 'grep': {
          if (!args.pattern) throw new UserError('mode "grep" needs a `pattern`.');
          const hits = grepReport(markdown, args.pattern, { regex: args.regex, maxHits: 60 });
          if (hits.length === 0) return `No matches for "${args.pattern}" in \`${run.id}\`.`;
          return [
            `${hits.length} match(es) for "${args.pattern}":`,
            '',
            ...hits.map((h) => `- **L${h.line}** _(${h.section})_: ${h.text}`),
            '',
            'Read a whole section with `research_read { mode: "section", section: "<heading>" }`.',
            '',
            provenance,
          ].join('\n');
        }
        case 'full': {
          const clamped = clampToTokens(markdown, args.maxTokens);
          return clamped.truncated
            ? `${clamped.text}\n\n_Tip: \`mode: "outline"\` then \`mode: "section"\` reads the whole report without a single oversized response._\n\n${provenance}`
            : `${clamped.text}\n\n${provenance}`;
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
    name: 'research_export',
    description:
      'Copy a finished report OUT of the server\'s store and into a directory you name, so it lives in the project rather than in `~/.dossier-research-mcp`. Writes the FULL markdown (not the outline, not a summary) plus, optionally, its numbered source registry as a second file. Free, local, no model call. Use it whenever the research should end up in the repo alongside the work it informs.',
    annotations: {
      title: 'Export a report into your project',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    parameters: z.object({
      runId: z.string().max(64),
      dir: z
        .string()
        .max(1000)
        .default('.')
        .describe('Directory to write into, relative to the working directory or absolute. Created if missing.'),
      filename: z
        .string()
        .max(200)
        .optional()
        .describe('Base filename without extension. Defaults to the date plus a slug of the report title.'),
      sources: z
        .boolean()
        .default(true)
        .describe('Also write `<name>.sources.md`, the numbered registry with every cited URL.'),
    }),
    execute: async (args) => {
      const run = await requireRun(deps, args.runId);
      const markdown = await store.readReport(args.runId);
      if (!markdown) throw new UserError(`No report for \`${run.id}\` (state: ${run.state}). ${stateHint(run.state)}`);

      const base = args.filename ?? defaultExportName(run);
      const dir = resolve(args.dir);
      await mkdir(dir, { recursive: true });

      // A report is the artefact; the front matter is what makes it findable
      // again in six months, when "which model, which day, what did it cost"
      // is the whole question.
      const front = [
        '---',
        `title: ${JSON.stringify(run.title ?? run.question.slice(0, 120))}`,
        `run_id: ${run.id}`,
        `question: ${JSON.stringify(run.question)}`,
        `provider: ${run.provider}`,
        ...(run.model ? [`model: ${run.model}`] : []),
        `tier: ${run.tier}`,
        ...(run.archetype ? [`archetype: ${run.archetype}`] : []),
        `sources: ${String(run.sourceCount)}`,
        ...(run.toolsUsed.length > 0 ? [`tools: [${run.toolsUsed.join(', ')}]`] : []),
        ...(typeof run.estimatedCostUsd === 'number' ? [`estimated_cost_usd: ${run.estimatedCostUsd.toFixed(2)}`] : []),
        `completed: ${run.completedAt ?? run.updatedAt}`,
        '---',
        '',
      ].join('\n');

      const reportFile = join(dir, `${base}.md`);
      await writeFile(reportFile, front + markdown, 'utf8');
      const written = [`${reportFile} (${markdown.length.toLocaleString()} chars)`];

      if (args.sources) {
        const registry = buildRegistry(markdown);
        if (registry.length > 0) {
          const sourcesFile = join(dir, `${base}.sources.md`);
          await writeFile(
            sourcesFile,
            [`# Sources for ${run.title ?? run.id}`, '', renderRegistryList(registry), ''].join('\n'),
            'utf8',
          );
          written.push(`${sourcesFile} (${String(registry.length)} source(s))`);
        }
      }

      return [
        `## Exported \`${run.id}\``,
        '',
        ...written.map((w) => `- ${w}`),
        '',
        'The markdown is the complete report with a front-matter block recording which backend and model produced it, what it cost, and when. That header is what makes the file attributable later; keep it if you commit the file.',
      ].join('\n');
    },
  });

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
                (v) => `- **${v.verdict}**${v.httpStatus ? ` (${v.httpStatus})` : ''}, ${v.url}${v.note ? ` _(${v.note})_` : ''}`,
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
      'Ask a follow-up question against a completed report. Runs as a cheap single model turn continuing the original interaction, it does NOT start a new research run and does not re-search the web. Use it instead of re-reading a whole report into context.',
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
      'Extract the report’s load-bearing claims as portable cards, claim, confidence qualifier, source URL. Small enough to pass between agents or into a downstream tool, where a whole report is not. Confidence is copied from the report, never re-assessed.',
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
          `Claim extraction failed: ${extracted.error}. The report is unaffected, read its Evidence Table instead: \`research_read { mode: "section", section: "Evidence Table" }\`.`,
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
    description: 'List research runs, newest first, with state, tier, cost and title. Cheap, it reads the local store, not the API.',
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
      // A broken adapter has to be obvious from the listing alone. Every
      // failure used to render as the bare word `failed`, so an adapter that
      // could never have worked sat beside a genuinely hard question looking
      // identical, and the upstream reason was not shown at all.
      const broken = page.filter((r) => r.failureKind === 'adapter-rejected');
      return [
        `${page.length} of ${runs.length} run(s):`,
        '',
        ...page.map((r) =>
          [
            `- \`${r.id}\` **${r.state}${r.failureKind ? `: ${failureTag(r.failureKind)}` : ''}** · ${r.tier}/${r.archetype} · ` +
              (r.budgetReleased ? `~$0.00 ($${r.estimatedCostUsd.toFixed(2)} released)` : `~$${r.estimatedCostUsd.toFixed(2)}`),
            r.title ? `\n    ${r.title}` : r.label ? `\n    ${r.label}` : `\n    ${r.question.slice(0, 120)}`,
            r.error ? `\n    ↳ ${(r.error.split('\n')[0] ?? '').slice(0, 200)}` : '',
          ].join(''),
        ),
        ...(broken.length > 0
          ? [
              '',
              `> [!WARNING]\n> ${String(broken.length)} run(s) failed because the backend REFUSED the invocation Dossier built, not because the research was hard. ` +
                'That is a defect in Dossier, and every run on that backend will fail the same way until it is fixed. ' +
                'Run `research_doctor` to see the argv self-test.',
            ]
          : []),
      ].join('\n');
    },
  });

  server.addTool({
    name: 'research_cancel',
    description: 'Cancel an in-flight run. The estimated cost already committed to the ledger is not refunded, Google bills for work already done.',
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
      'Report the spend position: committed dollars in the rolling window, remaining headroom, runs in flight, and the top spenders. Read this before starting an expensive run, the gate refuses a run that would cross the ceiling, and this is how you see the wall before you hit it.',
    annotations: { title: 'Check the research budget', readOnlyHint: true, openWorldHint: false },
    parameters: z.object({}),
    execute: async () => {
      const snapshot = await runner.budget();
      const since = new Date(Date.now() - snapshot.windowHours * 3_600_000).toISOString();
      const entries = await store.readLedger(since);
      // Reservations only in the "largest" list. A release is a correction to a
      // reservation already listed, and rendering it identically would show a
      // refunded $9 as a $9 commitment.
      const released = entries.filter((e) => e.kind === 'release');
      const top = entries
        .filter((e) => e.kind !== 'release')
        .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd)
        .slice(0, 5);
      const releasedUsd = released.reduce((sum, e) => sum + e.estimatedCostUsd, 0);
      return [
        `### Spend, last ${snapshot.windowHours}h`,
        '',
        `- Committed: **$${snapshot.committedUsd.toFixed(2)}** of $${snapshot.budgetUsd.toFixed(2)}`,
        `- Remaining: **$${snapshot.remainingUsd.toFixed(2)}**`,
        `- Runs in window: ${snapshot.runsInWindow} · in flight now: ${snapshot.activeRuns}/${snapshot.maxConcurrent}`,
        released.length > 0
          ? `- Released: **$${releasedUsd.toFixed(2)}** across ${String(released.length)} request(s) the provider refused outright, so nothing was created and nothing was charged. The reservations stay on the ledger, compensated rather than deleted.`
          : '',
        snapshot.budgetUsd === 0 ? '- ⚠ The budget gate is DISABLED (DOSSIER_BUDGET_USD=0).' : '',
        '',
        top.length > 0 ? '**Largest commitments:**' : '',
        ...top.map((e) => `- $${e.estimatedCostUsd.toFixed(2)} · ${e.tier} · \`${e.runId}\`${e.label ? `, ${e.label}` : ''}`),
        '',
        '_Costs are Google’s published per-task estimate bands, committed at start. They are a spend guardrail, not an invoice, reconcile against your Google billing for actuals._',
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
          ? `**De-duplicated onto an existing run, nothing new was charged.** Handle: \`${run.id}\``
          : `**Run started.** Handle: \`${run.id}\``,
        '',
        `- Backend: **${chosen.label}**, ${args.provider ? 'you named it explicitly' : routing.reason}`,
        `- Estimated cost: ${formatCostBand(estimate.cost)}, ${estimate.cost.basis}. A guardrail estimate, never a quote.`,
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
      'Research a MATRIX rather than a narrative: N entities across M fields, every cell filled, cited, or explicitly marked uncertain. THIS SPENDS MONEY. Use this when the answer is a table, "which of these tools support X, and what do they claim about Y", because asking a deep-research backend for a table in prose is how you get five pages of essay and no table. Call it again with `runId` once the run completes to validate the returned matrix against what you asked for.',
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
        // Reported separately from the completion gate: an uncited cell is a
        // weaker finding rather than a missing one, and a matrix that cites in
        // its own column is not wrong.
        const uncited = validateWide(parsed.data, rows, { requireSources: true }).filter(
          (p) => p.includes('no source'),
        );
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
          uncited.length > 0
            ? [
                '',
                '### Cells asserting a fact with no source',
                '',
                `${String(uncited.length)} cell(s). Not a gate failure: a matrix may cite in its own column rather than in every cell. It is worth checking before you act on one of these numbers.`,
                ...uncited.slice(0, 20).map((p) => `- ${p}`),
              ].join('\n')
            : '',
          rows.length === 0
            ? '_No table was found in the report. Read it directly with `research_read`, the backend answered in prose, which is exactly the failure mode wide research exists to avoid._'
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
      'Run the SAME brief on two or more backends and diff what they claim. THIS SPENDS MONEY ONCE PER BACKEND, two providers is two full research runs. Worth it when a number is load-bearing: the disagreements are the output, and they are the one thing a single-provider tool can never show you. Call it again with `runIds` once the runs finish to get the diff.',
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
        // Wording-matching finds almost nothing and its zero used to be rendered
        // as "these reports do not overlap", which is a confident negative from
        // a test with no power to find a positive.
        const convergent = findConvergence(sets);
        const corroborated = shared.filter((s) => s.support === 'corroborated');
        const sameSource = shared.filter((s) => s.support === 'single-source');
        return [
          `## Cross-backend comparison of ${String(sets.length)} run(s)`,
          '',
          `- Claims worded near-identically by more than one backend: **${String(shared.length)}**`,
          `- Of those, backed by 3+ independent domains: **${String(corroborated.length)}**`,
          `- Of those, agreeing while citing ONE domain: **${String(sameSource.length)}**, agreement here is not evidence.`,
          `- Claims that look like the same claim written differently: **${String(convergent.length)}**`,
          '',
          convergent.length > 0
            ? [
                '### Claims several backends appear to have made',
                '',
                'Matched on what each claim is *about*, not on how it is written, so this is a candidate list rather than a verdict. The overlap score and the shared terms are both shown; discount any pairing you disagree with.',
                '',
                ...convergent.slice(0, 20).map(
                  (c: ConvergenceCandidate) =>
                    `- **${c.providers.join(' + ')}** (overlap ${c.overlap.toFixed(2)}, shared: ${c.sharedTokens.slice(0, 6).join(', ')})\n    ${c.claims[0]?.text.slice(0, 300) ?? ''}`,
                ),
                '',
              ].join('\n')
            : '',
          '### Claims worded the same way',
          '',
          shared.length === 0
            ? `_Nothing matched on wording. That is close to meaningless on its own: this check needs two backends to phrase a claim near-identically, which almost never happens, so a zero here is the usual result and is not evidence that the reports disagree.${convergent.length > 0 ? ` The ${String(convergent.length)} candidate(s) above are what convergence looks like when matched on subject instead._` : ' Nothing matched on subject either, which is the finding worth reading._'}`
            : shared
                .slice(0, 40)
                .map(
                  (s) =>
                    `- **${s.support}** (${String(s.independentDomains)} domain(s)), ${s.claim}${s.note ? `\n    _${s.note}_` : ''}`,
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
          ...failed.map((f) => `- failed to start: ${f}`),
        ].join('\n');
      }

      return [
        `**Comparison started: ${String(started.length)} independent runs, each billed separately.**`,
        '',
        ...started.map((id) => `- \`${id}\``),
        ...failed.map((f) => `- ⚠ did not start: ${f}`),
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

/**
 * The four lenses. Each is a separate pass, and each is told to refute.
 *
 * **Deliberate divergence, kept on purpose.** The daymade `deep-research` skill
 * (`github.com/daymade/claude-code-skills`), whose task-group and output-contract
 * thinking Dossier borrowed elsewhere in the loop, requires counter-review to
 * surface at least three issues and to run again if it finds none. Dossier
 * rejects that and `docs/plan/multi-provider-research.md` explains why: an issue
 * quota pays a reviewer to invent objections until the number is reached, which
 * is the same defect as a citation quota, one layer up. What Dossier requires
 * instead is *coverage*: every lens must state what it examined, and four lenses
 * that all examined something and all found nothing is reported as a **failed**
 * review rather than a clean bill of health. Do not "fix" this into a minimum.
 */
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
    name: 'research_synthesise',
    description:
      'Merge several completed runs into ONE evidence base and distil a single comprehensive report. Different from `research_compare`, which diffs what backends claim and leaves you two reports: this produces one, with every claim carrying the backend(s) behind it. Free, it merges reports you have already paid for, and makes no research call. Pass `runIds` of 2+ completed runs. The merge is deterministic (deduplicate by canonical URL, count INDEPENDENT DOMAINS, profile the sources); the distillation is done by a model if one is configured, otherwise handed to you with the frozen registry to write yourself. To fan out in the first place, use `research_compare { question }`, which starts one run per backend and bills each.',
    annotations: {
      title: 'Merge several runs into one report',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    parameters: z.object({
      runIds: z
        .array(z.string().max(64))
        .min(2)
        .max(6)
        .describe('Completed runs to merge. Two or more; they should answer the same question.'),
      distil: z
        .enum(['auto', 'model', 'caller'])
        .default('auto')
        .describe('Who writes the merged report. auto = a model if one is configured, otherwise you. caller = always you, and always free.'),
    }),
    execute: async (args) => {
      const runs: RunEvidence[] = [];
      const missing: string[] = [];
      for (const id of args.runIds) {
        const run = await store.getRun(id);
        if (!run) {
          missing.push(`\`${id}\`, no such run`);
          continue;
        }
        const markdown = await store.readReport(id);
        if (!markdown) {
          missing.push(`\`${id}\`, no report (state: ${run.state})`);
          continue;
        }
        runs.push({ runId: id, provider: run.provider, model: run.model, markdown });
      }

      if (runs.length < 2) {
        throw new UserError(
          [
            `Need at least two completed runs to merge; got ${String(runs.length)}.`,
            ...missing.map((m) => `- ${m}`),
            '',
            'Start a fan-out with `research_compare { question: "..." }`, wait for the runs to finish, then merge them here.',
          ].join('\n'),
        );
      }

      const merged = mergeEvidence(runs);

      // How much of each report has actually been read, at the TOP of the merge.
      // The caveat that failed in the real session was accurate and buried, and
      // where a caveat sits decides whether it is read.
      const coverageRows = await Promise.all(
        runs.map(async (r) => ({
          runId: r.runId,
          label: r.provider,
          coverage: readCoverage(
            await readLedgerFor(store, r.runId),
            outlineReport(r.markdown).length,
            r.markdown.length,
          ),
        })),
      );
      const coverage = renderReadCoverage(coverageRows);

      const header = [
        ...(coverage ? [coverage, ''] : []),
        `## Merged evidence from ${String(runs.length)} run(s)`,
        '',
        ...merged.runs.map(
          (r) => `- \`${r.runId}\`, **${r.provider}**${r.model ? ` (\`${r.model}\`)` : ''}, ${String(r.sourceCount)} cited source(s)`,
        ),
        ...missing.map((m) => `- ⚠ skipped: ${m}`),
        '',
        describeOverlap(merged),
        '',
        renderProfile(merged.profile),
      ].join('\n');

      const wantsCaller = args.distil === 'caller' || (args.distil === 'auto' && !deps.utility);
      if (wantsCaller) {
        return [
          header,
          '',
          '---',
          '',
          '## Now write the merged report',
          '',
          'The evidence is merged; the synthesis is yours. Read each source report with `research_read { runId, mode: "section" }`, the full text of each is on disk, and the paths are in that tool\'s output.',
          '',
          '**The rules that make a merged report worth more than the reports it came from:**',
          '',
          '1. **Every claim names its backing.** A merged report where you cannot tell which backend produced which claim is worse than the separate reports, because it launders a weak finding into a strong-looking one.',
          '2. **Count support in independent domains, never in backends.** Two backends citing the same page is one source. The registry below records who found what.',
          '3. **A claim only one backend made is uncorroborated, not wrong.** Say which, and say it is single-sourced.',
          '4. **Where they disagree, that is the finding.** Do not average two numbers into a third that nobody reported. State both, with who said what, and which evidence is stronger.',
          '5. **Mark what you inferred.** A conclusion you drew by combining sources is `synthesised`, not `sourced`, even when every input was cited. The 2026 failure mode is correct facts assembled into a wrong conclusion, and it is invisible unless the joins are labelled.',
          '',
          '**Cite only from this registry.** It is frozen; a source that is not on it did not come from these runs.',
          '',
          renderMergedRegistry(merged),
        ].join('\n');
      }

      const utility = requireUtility('Synthesis');
      const sets: ProviderClaimSet[] = [];
      for (const run of runs) {
        await runner.reserveUtilitySpend(`synthesise-extract:${run.runId}`);
        const extracted = await utility.extractClaims(run.markdown, 20);
        if (!extracted.ok) continue;
        sets.push({
          provider: run.provider,
          claims: extracted.value.claims.map((c) => ({
            text: c.claim,
            provider: run.provider,
            urls: c.sourceUrl ? [c.sourceUrl] : [],
          })),
        });
      }

      const checked = crossCheck(sets);
      return [
        header,
        '',
        '---',
        '',
        `## ${String(checked.shared.length)} claim(s) more than one backend made`,
        '',
        ...checked.shared.map((v) => {
          const icon = v.support === 'corroborated' ? '✅' : v.support === 'weakly-supported' ? '🟡' : '⚠️';
          return `- ${icon} **${v.support}** (${String(v.independentDomains)} independent domain(s)), ${v.claim.slice(0, 300)}`;
        }),
        '',
        '## Claims only one backend made',
        '',
        ...checked.unique.flatMap((u) =>
          u.claims.length === 0
            ? []
            : [`**${u.provider}** alone:`, ...u.claims.slice(0, 12).map((c) => `- ${c.text.slice(0, 260)}`), ''],
        ),
        '> [!IMPORTANT]',
        '> A claim only one backend made is a **coverage difference**, not an error, and it is also **not corroborated**. The verdicts above count independent domains, never how many backends agreed, because backends reading the same page agree for free.',
        '',
        'Cite only from the merged registry:',
        '',
        renderMergedRegistry(merged),
      ].join('\n');
    },
  });

  server.addTool({
    name: 'research_verify_claims',
    description:
      'Test whether each cited source ACTUALLY contains the claim attached to it. Different from `research_verify_citations` in the way that matters: that one proves a link resolves, this one tests whether the page says what the report says it says. Two ways to run it. **You do the judging** (free): pass `claims`, get back the fetched page text for each, then pass `verdicts`. **Or a model does it** (spends money, one small call per claim): pass `sample` and it runs end to end, which needs GEMINI_API_KEY. Either way the fetching, the sampling and the tally happen here, so a verdict cannot be recorded for a claim that was never checked.',
    annotations: {
      title: 'Verify claims against their sources',
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
        .describe('Model mode: how many claims to check. Each is a fetch plus a model call, so this is the cost dial.'),
      claims: z
        .array(
          z.object({
            claim: z.string().min(5).max(2000).describe('The claim as the report states it.'),
            url: z.string().url().max(2000).describe('The source the report cites for it.'),
          }),
        )
        .min(1)
        .max(25)
        .optional()
        .describe('Caller mode, step 1: claims you extracted from the report. Returns each cited page’s text for you to judge.'),
      verdicts: z
        .array(
          z.object({
            n: z.number().int().min(1).describe('The number from step 1.'),
            verdict: z.enum(['supports', 'partially_supports', 'contradicts', 'not_addressed', 'unreadable']),
            quote: z.string().max(1000).optional().describe('The sentence from the page that decides it, verbatim.'),
            note: z.string().max(600).optional(),
          }),
        )
        .min(1)
        .max(25)
        .optional()
        .describe('Caller mode, step 2: your verdicts on the pages returned by step 1.'),
    }),
    execute: async (args, { reportProgress }) => {
      const run = await requireRun(deps, args.runId);
      const markdown = await store.readReport(args.runId);
      if (!markdown) throw new UserError(`No report for \`${run.id}\` (state: ${run.state}). ${stateHint(run.state)}`);

      // ── Caller mode, step 2: tally the verdicts against the held sample ──
      if (args.verdicts) {
        const held = ClaimSampleSchema.safeParse(await store.readSession(`${run.id}-claims`));
        if (!held.success) {
          throw new UserError(
            `No claim sample is held for \`${run.id}\`. Call this with \`claims\` first: the sample is kept here so a verdict cannot be recorded against a claim that was never fetched.`,
          );
        }
        return renderClaimVerdicts(run.id, held.data, args.verdicts);
      }

      // ── Caller mode, step 1: fetch the pages and hand them over ──
      if (args.claims || !deps.utility) {
        if (!args.claims) {
          return [
            `## Claim checking for \`${run.id}\`, without a key`,
            '',
            'No utility model is configured, so you do the judging. That is the better division of labour anyway: fetching safely and holding the sample is what this server is for, and reading a page is what you are for.',
            '',
            `1. Read the report: \`research_read { runId: "${run.id}" }\`, then pull the sections that carry its load-bearing claims.`,
            '2. Call this again with the claims and the URL each one cites:',
            '',
            '```',
            `research_verify_claims { runId: "${run.id}", claims: [{ claim: "...", url: "https://..." }] }`,
            '```',
            '',
            'You get each page’s text back, numbered. Judge them, then send `verdicts`. A source that is *about* the right topic without containing the specific claim is `not_addressed`, and it is the verdict that earns its keep: link-checking cannot see it, because the link resolves perfectly.',
          ].join('\n');
        }

        const fetched: { n: number; claim: string; url: string; text: string; error?: string }[] = [];
        for (const [i, c] of args.claims.entries()) {
          await reportProgress({ progress: i, total: args.claims.length });
          try {
            const res = await safeFetch(c.url, { method: 'GET', timeoutMs: 15_000, maxBytes: 512 * 1024 });
            fetched.push({ n: i + 1, claim: c.claim, url: c.url, text: stripToText(res.body).slice(0, 6000) });
          } catch (e: unknown) {
            fetched.push({
              n: i + 1, claim: c.claim, url: c.url, text: '',
              error: e instanceof Error ? e.message.slice(0, 200) : 'fetch failed',
            });
          }
        }
        await reportProgress({ progress: args.claims.length, total: args.claims.length });
        await store.saveSession(`${run.id}-claims`, {
          runId: run.id,
          at: new Date().toISOString(),
          claims: fetched.map((f) => ({ n: f.n, claim: f.claim, url: f.url, fetched: !f.error })),
        });

        return [
          `## ${String(fetched.length)} page(s) fetched for \`${run.id}\``,
          '',
          'Judge each one **from the page text alone**. What you already know about the topic is irrelevant here and using it defeats the check.',
          '',
          ...fetched.flatMap((f) => [
            `### ${String(f.n)}. ${f.claim.slice(0, 300)}`,
            `Source: ${f.url}`,
            f.error ? `**Could not fetch:** ${f.error}` : '',
            f.error ? '' : '```',
            f.error ? '' : f.text || '(the page returned no readable text)',
            f.error ? '' : '```',
            '',
          ].filter((x) => x !== '')),
          '',
          'Then send your verdicts:',
          '',
          '```',
          `research_verify_claims { runId: "${run.id}", verdicts: [{ n: 1, verdict: "not_addressed", quote: "..." }] }`,
          '```',
          '',
          '`supports` · `partially_supports` (a weaker or narrower version) · `contradicts` · `not_addressed` (readable, but the claim is not in it) · `unreadable` (a cookie wall, a login page, an empty body).',
        ].join('\n');
      }

      // ── Model mode: unchanged, and it bills ──
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
            `- ⚫ **could not fetch**, ${claim.claim.slice(0, 200)}\n    ${url}\n    _${e instanceof Error ? e.message.slice(0, 200) : 'fetch failed'}_`,
          );
          continue;
        }
        await runner.reserveUtilitySpend(`verify-claims:${run.id}:${String(i)}`);
        const judged = await utility.judgeSupport(claim.claim, text);
        if (!judged.ok) {
          tally.fetch_failed += 1;
          results.push(`- ⚫ **could not judge**, ${claim.claim.slice(0, 200)}\n    _${judged.error.slice(0, 200)}_`);
          continue;
        }
        const v = judged.value;
        tally[v.verdict] += 1;
        const icon = { supports: '✅', partially_supports: '🟡', contradicts: '❌', not_addressed: '⚠️', unreadable: '⚫' }[v.verdict];
        results.push(
          [
            `- ${icon} **${v.verdict}**, ${claim.claim.slice(0, 300)}`,
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
        '> This is a sample, judged by a model reading one page. It catches a source that does not contain the claim attached to it, which link-checking cannot. It does not catch a report whose facts are each correct and whose conclusion does not follow, for that, read the reasoning yourself, or run `research_counter_review`.',
      ].join('\n');
    },
  });

  server.addTool({
    name: 'research_counter_review',
    description:
      'Adversarial review of a finished report through four independent lenses: claim validation, source diversity, recency, and internal contradiction. Each lens REFUTES rather than summarises, because a reviewer not told to argue agrees with fluent prose. Two ways to run it. **You do the reviewing** (free): call it, get the four lens briefs, then send `findings`. **Or a model does it** (spends money, one small call per lens), which needs GEMINI_API_KEY. Either way the coverage rule is enforced here: four lenses finding nothing is reported as a FAILED review, not a clean bill of health.',
    annotations: {
      title: 'Counter-review a report',
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
        .describe('Which lenses to run. Omit for all four.'),
      findings: z
        .array(
          z.object({
            lens: z.enum(['claim validator', 'source diversity', 'recency', 'contradiction']),
            checked: z
              .string()
              .min(10)
              .max(2000)
              .describe('What you actually examined. Required even when you found nothing: "checked, found nothing" is a real answer and an unexamined lens is not.'),
            issues: z
              .array(
                z.object({
                  severity: z.enum(['high', 'medium', 'low']),
                  where: z.string().max(300).describe('The section or claim this is about.'),
                  problem: z.string().max(1200),
                }),
              )
              .max(20),
          }),
        )
        .min(1)
        .max(4)
        .optional()
        .describe('Caller mode: your results, one entry per lens you ran.'),
    }),
    execute: async (args, { reportProgress }) => {
      const run = await requireRun(deps, args.runId);
      const markdown = await store.readReport(args.runId);
      if (!markdown) throw new UserError(`No report for \`${run.id}\` (state: ${run.state}). ${stateHint(run.state)}`);

      // ── Caller mode, step 2: apply the coverage rule to what came back ──
      if (args.findings) {
        return renderCounterReview(
          run.id,
          args.findings.map((f) => ({ name: f.lens, checked: f.checked, issues: f.issues })),
          args.findings.length,
        );
      }

      // ── Caller mode, step 1: hand over the lens briefs ──
      if (!deps.utility) {
        const chosenLenses = args.lenses ? LENSES.filter((l) => args.lenses?.includes(l.name)) : LENSES;
        return [
          `## Counter-review of \`${run.id}\`, without a key`,
          '',
          'No utility model is configured, so you run the lenses. Read the report first with `research_read`; you cannot refute what you have not read.',
          '',
          '**Each lens is a separate pass, and each one is trying to REFUTE.** Not to summarise, and not to agree: a reviewer who is not told to argue agrees with fluent prose, which is the whole reason this exists.',
          '',
          ...chosenLenses.flatMap((l) => [`### ${l.name}`, '', `**${l.question}**`, '', l.instruction, '']),
          '**Report what you checked on every lens, including where you found nothing.** "Checked, found nothing" is a real answer; an unexamined lens is not, and padding the issue list to look thorough is worse than either.',
          '',
          'Then send it back:',
          '',
          '```',
          `research_counter_review { runId: "${run.id}", findings: [{ lens: "recency", checked: "...", issues: [] }] }`,
          '```',
        ].join('\n');
      }

      // ── Model mode: unchanged, and it bills ──
      const utility = requireUtility('Counter-review');

      const chosen = args.lenses ? LENSES.filter((l) => args.lenses?.includes(l.name)) : LENSES;
      const gathered: LensResult[] = [];
      for (const [i, lens] of chosen.entries()) {
        await reportProgress({ progress: i, total: chosen.length });
        await runner.reserveUtilitySpend(`counter-review:${run.id}:${lens.name}`);
        const result = await utility.review(lens, markdown);
        if (!result.ok) {
          gathered.push({ name: lens.name, failed: result.error.slice(0, 300) });
          continue;
        }
        gathered.push({ name: lens.name, checked: result.value.checked, issues: result.value.issues });
      }
      await reportProgress({ progress: chosen.length, total: chosen.length });
      return renderCounterReview(run.id, gathered, chosen.length);
    },
  });

  server.addTool({
    name: 'research_evidence',
    description:
      'Profile the sources a report actually used: what kind they are, how concentrated they are, and how they measure against advisory quality floors. Free, it reads the stored report and classifies URLs, with no fetching and no model call. Also returns the numbered citation registry, which is the list a follow-up should cite from rather than from the report’s prose.',
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

/**
 * The claim sample, held between the two caller-driven steps.
 *
 * Kept server-side for one reason: without it a caller could report a verdict
 * on a claim that was never fetched, which is the same defect as a report
 * citing a source it never read. The tally is only meaningful over a sample
 * somebody else fixed.
 */
const ClaimSampleSchema = z.object({
  runId: z.string(),
  at: z.string(),
  claims: z.array(
    z.object({ n: z.number().int(), claim: z.string(), url: z.string(), fetched: z.boolean() }),
  ),
});
type ClaimSample = z.infer<typeof ClaimSampleSchema>;

/** Tally caller-supplied verdicts against the held sample and render them. */
function renderClaimVerdicts(
  runId: string,
  held: ClaimSample,
  verdicts: readonly { n: number; verdict: string; quote?: string | undefined; note?: string | undefined }[],
): string {
  const byN = new Map(held.claims.map((c) => [c.n, c]));
  const tally: Record<string, number> = {
    supports: 0, partially_supports: 0, contradicts: 0, not_addressed: 0, unreadable: 0,
  };
  const lines: string[] = [];
  const unknown: number[] = [];

  for (const v of verdicts) {
    const claim = byN.get(v.n);
    if (!claim) {
      unknown.push(v.n);
      continue;
    }
    tally[v.verdict] = (tally[v.verdict] ?? 0) + 1;
    const icon = { supports: '✅', partially_supports: '🟡', contradicts: '❌', not_addressed: '⚠️', unreadable: '⚫' }[
      v.verdict as 'supports'
    ] ?? '·';
    lines.push(
      [
        `- ${icon} **${v.verdict}**, ${claim.claim.slice(0, 300)}`,
        `    ${claim.url}`,
        v.quote ? `    > ${v.quote.slice(0, 300)}` : '',
        v.note ? `    _${v.note.slice(0, 250)}_` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  const unjudged = held.claims.filter((c) => !verdicts.some((v) => v.n === c.n));
  return [
    `## Claim-to-source check for \`${runId}\``,
    '',
    `Judged **${String(verdicts.length - unknown.length)}** of ${String(held.claims.length)} fetched claim(s).`,
    '',
    `- ✅ supports: **${String(tally['supports'] ?? 0)}**`,
    `- 🟡 partially supports: **${String(tally['partially_supports'] ?? 0)}**`,
    `- ❌ contradicts: **${String(tally['contradicts'] ?? 0)}**`,
    `- ⚠️ source does not address the claim: **${String(tally['not_addressed'] ?? 0)}**`,
    `- ⚫ unreadable: **${String(tally['unreadable'] ?? 0)}**`,
    '',
    ...lines,
    '',
    unknown.length > 0
      ? `> [!WARNING]\n> ${String(unknown.length)} verdict(s) referenced a claim number that was never fetched (${unknown.join(', ')}), and were discarded. A verdict on a page nobody opened is not a check.`
      : '',
    unjudged.length > 0
      ? `_${String(unjudged.length)} fetched claim(s) went unjudged: ${unjudged.map((c) => c.n).join(', ')}. Silence is not a pass._`
      : '',
    '',
    '> [!IMPORTANT]',
    '> This is a sample. It catches a source that does not contain the claim attached to it, which link-checking cannot. It does not catch a report whose facts are each correct and whose conclusion does not follow; for that, run `research_counter_review`.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** One lens's result, however it was produced. */
interface LensResult {
  readonly name: string;
  readonly checked?: string;
  readonly issues?: readonly { severity: 'high' | 'medium' | 'low'; where: string; problem: string }[];
  readonly failed?: string;
}

/**
 * Render a counter-review, and enforce the rule that makes it worth running.
 *
 * Shared by both modes deliberately. The coverage rule is the whole product
 * here, and a rule implemented twice is a rule that will eventually mean two
 * different things.
 */
function renderCounterReview(runId: string, results: readonly LensResult[], expected: number): string {
  const ran = results.filter((r) => !r.failed);
  const issues = ran.reduce((n, r) => n + (r.issues?.length ?? 0), 0);
  const sections = results.map((r) =>
    r.failed
      ? `### ${r.name}\n\n_This lens did not run: ${r.failed}_`
      : [
          `### ${r.name}`,
          '',
          `**Checked:** ${r.checked ?? '(not stated)'}`,
          '',
          (r.issues?.length ?? 0) === 0
            ? '_Nothing found on this lens._'
            : [...(r.issues ?? [])]
                .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
                .map((x) => `- **${x.severity}** · ${x.where}, ${x.problem}`)
                .join('\n'),
        ].join('\n'),
  );

  const missing = LENSES.map((l) => l.name).filter((n) => !results.some((r) => r.name === n));
  return [
    `## Counter-review of \`${runId}\``,
    '',
    `${String(ran.length)} of ${String(expected)} lens(es) ran. **${String(issues)} issue(s)** raised.`,
    '',
    ...sections,
    '',
    missing.length > 0 && results.length < LENSES.length
      ? `_Not run: ${missing.join(', ')}. A lens that was never applied is not a lens that found nothing._`
      : '',
    ran.length > 0 && issues === 0
      ? '> [!WARNING]\n> Every lens returned nothing. Treat that as a **failed review rather than a clean report**: four adversarial passes finding zero problems in a long research report is more often a sign the review did not bite than a sign the report is flawless. Re-run it, or read the reasoning yourself.'
      : '_Issues here are a reviewer’s objections, not established errors. Check them against the report before acting on either._',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * What produced this report, and where the full text is.
 *
 * Every field here was already being recorded and none of it was ever shown.
 * A caller reading an outline could not tell which backend ran, which model,
 * how many sources it actually opened, or that a 48,000-character report was
 * sitting on disk — so it distilled a short answer from a short outline and
 * the real work stayed in a directory nobody had been told about.
 */
function describeProvenance(run: RunRecord, absolutePath: string): string {
  const bits: string[] = [`**${run.provider}**`];
  if (run.model) bits.push(`\`${run.model}\``);
  bits.push(`${run.tier} tier`);
  if (run.archetype) bits.push(`${run.archetype} archetype`);

  const work: string[] = [];
  if (run.sourceCount) work.push(`${String(run.sourceCount)} cited source(s)`);
  if (run.toolsUsed.length > 0) work.push(`tools: ${run.toolsUsed.join(', ')}`);
  if (run.searches) work.push(`${String(run.searches)} search(es)`);
  if (run.urlsFetched) work.push(`${String(run.urlsFetched)} page(s) fetched`);
  if (run.corpusQueries) work.push(`${String(run.corpusQueries)} corpus quer(ies)`);
  if (typeof run.estimatedCostUsd === 'number') work.push(`~$${run.estimatedCostUsd.toFixed(2)} estimated`);

  return [
    '---',
    `_Produced by ${bits.join(' · ')}._`,
    work.length > 0 ? `_${work.join(' · ')}._` : '',
    '',
    `**Full report:** \`${absolutePath}\`${run.reportChars ? ` (${run.reportChars.toLocaleString()} chars)` : ''}`,
    '',
    'That file is the complete text, not this excerpt. Copy it into the project with `research_export`, or read it directly.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** A filename that sorts by date and still says what the report is about. */
function defaultExportName(run: RunRecord): string {
  const date = (run.completedAt ?? run.updatedAt ?? run.createdAt).slice(0, 10);
  const slug = (run.title ?? run.question)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `${date}-${slug || run.id}`;
}

/** The numbered registry, as a file someone can actually read. */
function renderRegistryList(registry: readonly { n: number; url: string; domain: string }[]): string {
  return registry.map((e) => `${String(e.n)}. ${e.url}  \n   _${e.domain}_`).join('\n');
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
      mode: LoopModeSchema.default('standard').describe(
        'How much evidence to hold this run to. `light` lowers the advisory floors to 6 sources across 3 domains for a single-entity question; `standard` expects 12 across 5. Pick `light` for a narrow factual question rather than failing the gates for being proportionate.',
      ),
      asOf: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('The date every claim should be current as of, YYYY-MM-DD. Defaults to today. Sources older than their horizon are flagged at draft time.'),
      have: HostCapabilitiesSchema.optional().describe(
        'What YOU can actually do. Say so when anything is missing: a loop that degrades silently produces a thin report for reasons nobody can see.',
      ),
      label: z.string().max(200).optional(),
    }),
    execute: async (args) => {
      // The gate runs before anything is opened or written. A halted run should
      // not leave a session behind for someone to find later and wonder about.
      const caps = assessCapabilities(args.have ?? HostCapabilitiesSchema.parse({}));
      if (caps.halt) return renderCapabilities(caps);

      const archetype = args.archetype ?? selectArchetype(args.question);
      const tasks = decompose(args.question, {
        archetype,
        maxTasks: args.maxTasks,
        // A forced scan beats the caller's `deep`. A worker told to read pages in
        // full on a host with no fetch tool does it by reading snippets and
        // calling them full reads, which is the one degradation nobody can see.
        deep: args.deep,
        scanOnly: caps.forceScan,
        reconcile: args.mode === 'standard',
      });
      const record = await runner.openLoop({
        question: args.question,
        archetype,
        ...(args.label ? { label: args.label } : {}),
      });
      const asOf = args.asOf ?? new Date().toISOString().slice(0, 10);
      const session: Session = {
        runId: record.id,
        question: args.question,
        createdAt: new Date().toISOString(),
        asOf,
        mode: args.mode,
        tasks: tasks.map((t) => ({
          id: t.id,
          sourceClass: t.sourceClass,
          depth: caps.forceScan ? 'scan' : t.depth,
          objective: t.objective,
          group: t.group,
          dependsOn: [...t.dependsOn],
          reported: false,
          findings: 0,
          outcome: 'ok' as const,
        })),
        registry: [],
        rejectedAfterFreeze: [],
      };
      await store.saveSession(record.id, session);

      return [
        `**Local research session open.** Handle: \`${record.id}\` · archetype: ${archetype} · mode: ${args.mode} · as of ${asOf}`,
        '',
        `Nothing has been charged and nothing will be: you do the searching, with whatever web search you already have.`,
        '',
        renderCapabilities(caps),
        '',
        '## How to run this',
        '',
        'You are the lead. **Do not read raw search results yourself.** Dispatch one worker per task, let each worker do its own searching, and take back only its distilled note. Raw result pages are the bulk of what a search returns and almost none of it is evidence; a lead that reads them spends its context on listings and has none left for the report. If you cannot dispatch workers, adopt each role in turn and discard the raw results as you go.',
        '',
        renderDispatch(tasks),
        '',
        '## The tasks',
        '',
        renderTasks(tasks),
        '',
        '## What each worker sends back',
        '',
        '```',
        `research_local_note { runId: "${record.id}", taskId: "t1", findings: [{ claim, url, quote, published }], gaps: "..." }`,
        '```',
        '',
        '- **At most ten findings**, one sentence each. The cap is the point: a worker that returns everything it saw has moved the sifting to the lead, which is the job it was dispatched to do.',
        '- **The URL you actually read**, and the sentence that supports the claim. Findings are deduplicated by URL into one numbered registry, so the same page found by three tasks stays one source rather than becoming three.',
        '- **`published`** wherever the source states it. A source with no date cannot be assessed for recency, and undated is not the same as current.',
        '- **`gaps`**: what you searched for and did **not** find. This is not filler. A task that establishes there is nothing there has produced a real result, and without the gaps line it is indistinguishable from a task that gave up.',
        '',
        `When every task has reported, call \`research_local_draft { runId: "${record.id}" }\`. That freezes the registry: after it, no new source can be added, including by you.`,
      ]
        .filter((l, i, all) => !(l === '' && all[i - 1] === ''))
        .join('\n');
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
    parameters: z
      .object({
        runId: z.string().max(64),
        taskId: z.string().max(16),
        findings: z
          .array(FindingSchema)
          .max(10)
          .describe(
            'At most ten, one sentence each. The cap is the contract: a worker that returns everything it saw has handed the sifting back to the lead, which is the job it was dispatched to do. May be empty when `gaps` says what was searched and not found.',
          ),
        gaps: z
          .string()
          .max(4000)
          .optional()
          .describe(
            'What you searched for and did NOT find. Required when you report no findings, because a task that establishes there is nothing there has produced a real result and must not read as one that gave up.',
          ),
        deepReadNotes: z
          .string()
          .max(20_000)
          .optional()
          .describe(
            'For a deep task: what the pages you opened actually argued, including the caveats. The lead drafts from this and never sees your search results.',
          ),
        outcome: TaskOutcomeSchema.default('ok').describe(
          'What actually happened when you searched. `no-results` means the search RAN and the index had nothing, which is a real finding. Use `rate-limited`, `blocked` (login, paywall or bot check) or `tool-failed` when the search did not complete: an empty result then proves nothing, and reporting it as `no-results` makes the report claim there is no public record of something nobody managed to look for.',
        ),
      })
      // An empty report is legitimate and a silent one is not. Without this the
      // only way to say "I searched and there is nothing" would be to send no
      // note at all, which is indistinguishable from a worker that crashed.
      .refine((v) => v.findings.length > 0 || (v.gaps !== undefined && v.gaps.trim().length > 0), {
        message: 'Reporting no findings requires `gaps`: say what you searched for and did not find.',
        path: ['gaps'],
      })
      // `no-results` is a claim about the index, and handing over findings
      // contradicts it. Caught here rather than silently preferring one, because
      // whichever was meant, the other is wrong and only the worker knows which.
      .refine((v) => !(v.outcome === 'no-results' && v.findings.length > 0), {
        message:
          '`no-results` says the search found nothing, so it cannot come with findings. Use `ok` if the search completed, or a failure outcome if it did not.',
        path: ['outcome'],
      }),
    execute: async (args) => {
      // Read, merge and write under one lock. Parallel workers are the whole
      // point of the fan-out, and two of them reporting at once both read the
      // same session and the second write dropped the first's evidence. A loop
      // that loses findings silently is worse than one that runs serially.
      const result = await store.admissionLock().run(async () => {
        const session = await requireSession(args.runId);
        const task = session.tasks.find((t) => t.id === args.taskId);
        if (!task) {
          throw new UserError(
            `No task \`${args.taskId}\` in this session. Its tasks are: ${session.tasks.map((t) => t.id).join(', ')}.`,
          );
        }
        const waitingOn = task.dependsOn.filter(
          (d) => !(session.tasks.find((t) => t.id === d)?.reported ?? false),
        );
        if (waitingOn.length > 0) {
          throw new UserError(
            `\`${args.taskId}\` depends on ${waitingOn.join(', ')}, which have not reported. It reconciles what the first wave found, so running it early searches the topic again instead of the disagreements.`,
          );
        }
        const merged = mergeFindings(session, args.taskId, args.findings, {
          ...(args.gaps ? { gaps: args.gaps } : {}),
          ...(args.deepReadNotes ? { notes: args.deepReadNotes } : {}),
          outcome: args.outcome,
        });
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
      // A group B task reconciles what group A found, so it needs the registry
      // to work against. Handing it over the moment the last of group A reports
      // is what lets the lead dispatch it without reading a search result.
      const ready = result.session.tasks.filter(
        (t) => !t.reported && t.dependsOn.every((d) => result.session.tasks.find((x) => x.id === d)?.reported),
      );
      const unblocked = ready.filter((t) => t.dependsOn.length > 0);

      return [
        coverageFailed(args.outcome)
          ? `\`${args.taskId}\` reported **${args.outcome}**, so its source class is **unchecked rather than empty**. It will be named that way at draft time and must not be written up as an established negative. Rerun it if the answer turns on what it would have covered.`
          : args.findings.length === 0
            ? `\`${args.taskId}\` reported **nothing found**, with the search recorded. That is a result about the public record, not a gap in the run, and it will be reported as one.`
            : `Recorded ${String(args.findings.length)} finding(s) from \`${args.taskId}\`: **${String(result.added)} new source(s)**, ${String(result.merged)} already in the registry.`,
        '',
        `Registry now holds **${String(result.session.registry.length)} source(s)** across ${String(new Set(result.session.registry.map((e) => e.domain)).size)} domain(s).`,
        '',
        unblocked.length > 0
          ? [
              `**Group A is in. Dispatch ${unblocked.map((t) => `\`${t.id}\``).join(', ')} now**, against what it found:`,
              '',
              renderRegistry(result.session),
              '',
              'Its job is the disagreements, not the topic. Search the contested claims themselves; a contradiction that stays open is a finding worth reporting.',
            ].join('\n')
          : outstanding.length === 0
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

      // Nothing public exists and the searching was real. Drafting rules would be
      // the wrong output: there is nothing to draft from, and the useful answer is
      // the refusal with its failed checks shown.
      if (frozen.blackBox) return renderBlackBox(frozen);

      return [
        `## Registry frozen for \`${args.runId}\``,
        '',
        `**${String(frozen.session.registry.length)} source(s).** No source can be added from here.`,
        '',
        frozen.silentTasks.length > 0
          ? `> [!WARNING]\n> These tasks never reported: ${frozen.silentTasks.join(', ')}. Their source classes are simply missing from this report, which is a coverage gap rather than an absence of evidence. Say so in the Knowledge Gaps section.`
          : '_Every task reported._',
        '',
        frozen.nothingFoundTasks.length > 0
          ? `_Searched and found nothing: ${frozen.nothingFoundTasks.join(', ')}. Different from the line above: these ran. Report each as an established negative rather than as missing coverage._`
          : '',
        '',
        renderCoverageFailures(frozen),
        '',
        renderRefusals(frozen.session),
        '',
        renderStaleness(frozen),
        '',
        renderProfile(frozen.profile),
        '',
        renderDeepNotes(frozen.session),
        '',
        '## The registry, cite ONLY from this',
        '',
        renderRegistry(frozen.session),
        '',
        '## Drafting rules',
        '',
        '1. **Cite only from the registry above, by URL.** A source that is not on the list cannot appear in the draft, and the submit step checks. This is the rule that stops a plausible reference being reached for mid-sentence to support something already written.',
        '2. **Draft from your notes, not from memory of the pages.** If a claim is not in a finding you reported, it is not established.',
        '3. **Mark what you inferred.** Wrap any conclusion you assembled rather than read in `<INFERENCE from="...">…</INFERENCE>`, naming the sources it rests on. Three correct facts multiplied into a wrong number is the failure this catches, and every input to it is sourced.',
        '4. **Not citing a source is fine.** Sources that turned out not to bear on the question should be dropped. A draft citing all of them is padding, not thoroughness.',
        `5. **Downgrade anything resting on a source flagged above as stale or undated**, and say in the sentence that you did. A claim is only current as of ${frozen.session.asOf || 'the date you ran this'}, and a report that reads as present tense on a four-year-old page is wrong in the way nobody checks.`,
        '6. Structure: Executive Summary (confidence-qualified bullets) · Detailed Findings · Evidence Table · Knowledge Gaps · Recommended Next Steps.',
        '',
        `Then submit it: \`research_local_submit { runId: "${args.runId}", markdown: "..." }\`.`,
      ]
        .filter((l, i, all) => !(l === '' && all[i - 1] === ''))
        .join('\n');
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
          `The registry for \`${args.runId}\` has not been frozen. Call \`research_local_draft\` first, a draft checked against a registry that was still growing is not checked at all.`,
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
        `- \`research_counter_review { runId: "${record.id}" }\`, four adversarial lenses`,
        `- \`research_verify_citations { runId: "${record.id}" }\`, dereference every URL`,
        `- \`research_evidence { runId: "${record.id}" }\`, the source profile`,
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
            ? `- \`${r.root}\`, ${String(r.files)} readable file(s)`
            : `- \`${r.root}\`, ⚠ missing or not a directory`,
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
            `- \`${s.name}\`${s.displayName ? `, ${s.displayName}` : ''} · ${s.activeDocuments ?? 0} active${s.pendingDocuments ? `, ${s.pendingDocuments} pending` : ''}`,
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
      'UPLOAD a local file to a File Search store so research runs can search it. This sends the file’s contents to Google, it leaves your machine. Only add documents you are willing to disclose to a third-party API.',
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
      'Create a PERSISTED custom research agent (the Managed Agents API, the other Gemini research surface). Unlike a Deep Research run, this gives you a reusable agent with a Linux sandbox that can run code, write files, and carry your house methodology across every run. Constraint worth knowing: at preview the only base agent is Antigravity, you cannot derive a custom agent from deep-research-*. See docs/deep-research-api-vs-agent.md for which surface fits your job.',
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
        .describe('Contents mounted at .agents/AGENTS.md, additive with systemInstruction.'),
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
      return [`${agents.length} managed agent(s):`, '', ...agents.map((a) => `- \`${a.id}\`${a.description ? `, ${a.description}` : ''}`)].join('\n');
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
        `_interactionId: \`${result.interactionId}\` · environmentId: \`${result.environmentId}\`, pass either back to continue._`,
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

/**
 * Does each adapter's real invocation parse against the binary it will run?
 *
 * The check `research_doctor` did not have, and the reason a broken adapter
 * could sit in the tree reporting 🟡 CONFIGURED, UNVERIFIED. A `--version`
 * probe and a sign-in file prove a binary exists and someone logged into it;
 * neither touches the argv that actually carries the brief, and Codex's
 * `--search` lived in that gap: valid on `codex`, invalid on `codex exec`, and
 * fatal on every single run.
 *
 * **On the default path, under the existing `probeLocal` flag rather than
 * behind a new one.** It does spawn a process per identified CLI, which is the
 * argument for a flag, and the argument loses. `probeLocal` already spawns
 * `--version` on every one of them, so this is one more short-lived local
 * process each, offline, free, and finished in milliseconds. Against that: this
 * is the only check in the whole audit that would have caught a defect which
 * broke every run on a backend for months. Putting the one check that finds the
 * bug behind an option nobody sets is how the bug survived the first time.
 */
export function renderArgvSelfTest(checks: readonly CliArgvCheck[]): string[] {
  const lines: string[] = ['## Does each adapter’s invocation actually parse?', ''];
  lines.push(
    '_A binary answering `--version` proves nothing about the argv that carries your brief. This runs the REAL headless ' +
      'invocation with an inert prompt and `--help` appended, so the flags are parsed and the process exits without ' +
      'reaching a model. Offline, free, and it exercises argument parsing only: a value the binary accepts as an argument ' +
      'and rejects later while loading config would still pass this._',
    '',
  );

  const shown = checks.filter((c) => c.state !== 'skipped');
  if (shown.length === 0) {
    lines.push('- No installed, identified CLI to test.');
    return lines;
  }

  for (const check of shown) {
    const icon = { accepted: '✅ ACCEPTED', rejected: '❌ REJECTED', inconclusive: '❓ INCONCLUSIVE', skipped: '' }[
      check.state
    ];
    lines.push(`- ${icon} **${check.label}**: \`${check.argv.join(' ')}\``);
    lines.push(`  - ${check.detail}`);
  }

  const rejected = shown.filter((c) => c.state === 'rejected');
  lines.push(
    '',
    rejected.length > 0
      ? `> [!CAUTION]\n> ${String(rejected.length)} adapter(s) build an invocation the binary REFUSES. Every run on ${rejected.length === 1 ? 'that backend' : 'those backends'} ` +
          'will die at argument parsing before any research happens, and because a CLI run is ledgered at $0 it costs nothing visible while consuming a panel seat. ' +
          'This is a defect in Dossier, not in your setup. Set `DOSSIER_PROVIDERS` to exclude ' +
          `${rejected.map((r) => `\`local-${r.id}\``).join(', ')} until it is fixed, and please report it._`
      : '_Every installed adapter’s invocation parses. That is not a promise the research will succeed, only that it will start._',
  );
  return lines;
}

/**
 * Which model is behind each CLI, and how old that answer is.
 *
 * Split out of the doctor tool because it is the one section that can spend
 * something. `probeNow` is the whole difference: false renders whatever is
 * already cached and asks for nothing, true spawns each signed-in CLI with a
 * one-line question and caches what comes back.
 *
 * Every reading carries its age. A model identity is a fact about a
 * configuration the user can change whenever they like, so an answer printed
 * without a date invites being trusted for longer than it has earned.
 */
async function renderCliModels(storeDir: string, probeNow: boolean, ready: readonly CliId[]): Promise<string[]> {
  const lines: string[] = ['## Which model each CLI serves', ''];
  lines.push(
    '_A product name is not a model. Two CLIs serving the same model read the same web, so seating both on a panel buys ' +
      'one perspective and reports two. Dossier only ever drops a CLI on an answer the CLI actually gave; it never infers a ' +
      'model from a binary’s name._',
    '',
  );

  if (probeNow && ready.length > 0) {
    // Filtered from the adapter table rather than looked up per id, so there is
    // no `find(...)!` to be wrong about if the two lists ever drift.
    const targets = CLI_ADAPTERS.filter((a) => ready.includes(a.id));
    const answers = await Promise.all(targets.map((a) => probeCliModel(a)));
    const probed = new Map<CliId, string>();
    for (const a of answers) if (a.state === 'probed' && a.model) probed.set(a.id, a.model);
    await writeModelCache(storeDir, probed);
    for (const a of answers) {
      if (a.state !== 'probed') lines.push(`- ⚠ **${a.label}**: ${a.detail}`);
    }
  }

  const cached = readModelCache(storeDir);
  for (const adapter of CLI_ADAPTERS) {
    const entry = cached.get(adapter.id);
    if (entry) {
      lines.push(`- ✅ **${adapter.label}**: \`${entry.model}\`, probed ${describeProbeAge(entry.probedAt)}`);
    } else if (ready.includes(adapter.id)) {
      lines.push(`- ⚪ **${adapter.label}**: signed in, never probed`);
    }
  }

  const unprobed = ready.filter((id) => !cached.has(id));
  if (cached.size === 0 && unprobed.length === 0) {
    lines.push('- No signed-in CLI to ask.');
  }
  lines.push(
    '',
    probeNow
      ? '_Cached on disk, so nothing here is asked again until you ask for it. Re-run with `probeModels: true` after you change a CLI’s model._'
      : unprobed.length > 0
        ? `_${String(unprobed.length)} signed-in CLI(s) have never been asked. Until they are, a panel keeps all of them and warns that the free lane may hold the same model twice. Run this again with \`probeModels: true\` to ask; it costs one short model round trip on each of those subscriptions._`
        : '_Run again with `probeModels: true` to refresh these readings._',
  );
  return lines;
}

// ───────────────────────────────────────────────────────────────── resources ────
function registerResources(server: FastMCP, deps: ServerDeps): void {
  const { config, store, runner } = deps;


  // ───────────────────────────────────────────────────────────── doctor ────
  server.addTool({
    name: 'research_doctor',
    description:
      'Audit every research backend Dossier knows about: what is working, what is configured but unproven, what is broken, and what COULD be on but is not. Spends no API money and makes no network calls of its own. The "could be on" rows are the point: without them you cannot tell that a capability is missing, only that you never used it. Set `probeModels: true` to additionally ASK each signed-in coding CLI which model it serves; that one costs a short model round trip on each CLI subscription, and the answer is cached so the panel can stop seating two CLIs that turn out to be the same model.',
    // `readOnlyHint: false` because of `probeModels`. The default call reads and
    // spawns nothing but `--version`, but the annotation describes the tool and
    // not one argument value, and a tool that CAN invoke a model is not
    // read-only. `research_synthesise` carries the same annotation for the same
    // reason, and mislabelling it the other way tells a caller a paid operation
    // is free to retry.
    annotations: { title: 'Audit research backends', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    parameters: z.object({
      probeLocal: z
        .boolean()
        .default(true)
        .describe(
          'Also probe the coding CLIs and browser tooling on this machine. Local, offline and free: it runs `--version` on each binary and checks for a sign-in file by existence, never reading a credential, never invoking `npx`, and never starting a browser.',
        ),
      probeModels: z
        .boolean()
        .default(false)
        .describe(
          'Ask each identified, signed-in CLI which model it actually serves, and cache the answer on disk. Off by default because it SPENDS a short model round trip against each of those subscriptions and takes a few seconds per CLI, where ordinary detection is offline and instant. Worth doing once: the panel uses it to stop seating two CLIs that serve the same model, which would buy one perspective and report two. Without it the free lane keeps every CLI and says it may hold duplicates.',
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

      // `probeModels` implies `probeLocal`. Asking which model a CLI serves
      // requires knowing which CLIs are identified and signed in, so honouring
      // one flag while ignoring the other would silently do nothing and say
      // nothing about why.
      if ((args.probeLocal || args.probeModels) && !deps.config.hermetic) {
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
            : `_${String(ready.length)} CLI(s) ready, and **every one of them joins the free lane of a panel** for any deep run it can do. You pay for those subscriptions already, so ${ready.length === 1 ? 'it answers' : 'they each answer'} rather than one being chosen and the rest sitting idle. That spends your subscription quota rather than an API balance, and Dossier cannot meter that quota. Capability still comes first: a date window, a domain filter, X or an editable plan routes to the API backend that can enforce it. Set \`DOSSIER_LOCAL_CLI\` to restrict the lane to one CLI, or list only API providers in \`DOSSIER_PROVIDERS\` to keep the CLIs out of automatic selection entirely._`,
        );
        if (ambiguous.length > 0) {
          lines.push(
            '',
            `_${String(ambiguous.length)} binary(ies) could not be identified. Several vendors ship executables called \`agent\` and \`grok\`; an unidentified one is never run, because handing your brief to a different vendor's tool is a different bill._`,
          );
        }

        lines.push('', ...renderArgvSelfTest(await checkAllHeadlessArgv(10_000, clis)));

        lines.push(
          '',
          ...(await renderCliModels(
            deps.config.storeDir,
            args.probeModels,
            ready.map((c) => c.id),
          )),
        );

        // Inventory only. This section exists because Mode A, importing a
        // share link, needs no automation at all, and someone deciding whether
        // Mode B is even worth considering should not have to guess what they
        // already have. Nothing here is started, and the renderer says so.
        lines.push('', renderBrowserTools(await probeAllBrowserTools()));
      }
      return lines.join('\n');
    },
  });

  // ───────────────────────────────────────────────────────────── import ────
  server.addTool({
    name: 'research_import',
    description:
      'Import a research report that was produced somewhere else, a Gemini or ChatGPT share link, or markdown you paste in, and store it as a normal Dossier run. Spends nothing on research. This is how you use a SUBSCRIPTION you already pay for instead of an API balance: you run the report in the web app yourself, share it, and paste the link here. Once imported it reads, greps, profiles and citation-verifies exactly like an API-sourced run.',
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
              `Could not fetch that link: ${e instanceof Error ? e.message : String(e)}. If it needs your login it cannot be fetched from here, open it yourself and paste the text as \`markdown\`.`,
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
      'Adversarially audit a completed report. Secondary-model validation catches the failure modes the producing model cannot see in itself, stripped sources, aggregator reliance, confidence inflation.',
    arguments: [{ name: 'runId', description: 'The completed run handle', required: true }],
    load: async (args) => {
      return [
        `Red-team the report from run \`${args.runId}\`.`,
        '',
        'Work in this order, and do not summarise the report, audit it:',
        '',
        '1. `research_verify_citations { runId, onlyProblems: true }`. Any `not_found` or `invalid_url` verdict on a citation attached to a quantitative claim invalidates that claim until it is re-sourced.',
        '2. `research_read { runId, mode: "section", section: "Evidence Table" }`. Every major claim should appear here with a specific source and date. Claims in the prose that are absent from the table are unsupported, list them.',
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
        '> **Read this before automating anything.** `gemini.google.com/robots.txt` disallows `/app/` and `/chat/`, and Google\'s Terms of Service prohibit "using automated means to access content from any of our services" where that violates machine-readable instructions on their pages, naming robots.txt as the example. The Gemini web app is at `/app`. On a plain reading, driving that UI with an agent is the thing the clause describes, and the practical exposure is **suspension of your Google account**, not a policy footnote.',
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
    description: 'Decide whether a question warrants a Deep Research run at all, and at which tier, before spending $1-7 and up to an hour.',
    arguments: [{ name: 'question', description: 'The question you are considering researching', required: true }],
    load: async (args) => {
      const question = args.question ?? '';
      return [
        `Triage this before spending anything: "${question}"`,
        '',
        'Deep Research costs $1-7 and takes 4-60 minutes. Answer these in order and state the verdict plainly:',
        '',
        '1. **Would a single model call answer it?** Definitions, known APIs, settled facts, anything in your training data, answer it directly and stop. Most questions land here.',
        '2. **Would one web search answer it?** A current price, a version number, a single document, search, do not research.',
        '3. **Does it need synthesis across many sources, with citations someone will act on?** That is the actual case for Deep Research.',
        '4. **Tier**: `fast` for a scoped question with a handful of sub-questions. `max` only when breadth genuinely warrants roughly double the searches and double the cost.',
        '5. **Scope check**: is this one archetype (technical / competitive / regulatory / academic / forecasting), or two? Two is a decomposition trigger, split it into separate runs rather than widening one prompt.',
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
  // The model that will actually produce the report, recorded on the run so a
  // finished report can be attributed to something more specific than "gemini".
  (id, tier) => providers.get(id)?.modelFor?.(tier) ?? null,
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
