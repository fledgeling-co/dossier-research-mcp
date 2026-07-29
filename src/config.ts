import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { BROWSER_TOOL_IDS } from './local/browser.js';
import { CLI_IDS } from './local/cli.js';

/**
 * Environment is a trust boundary: every value is Zod-parsed once, at startup,
 * and the rest of the server reads the typed result (CP §1, BP §13). An invalid
 * value fails fast with a readable message rather than surfacing as a mystery
 * mid-run.
 *
 * `||` rather than `??` for defaults on purpose: a committed `.env.example` key
 * is commonly present-but-empty, and `''` must fall through to the default
 * (CP §6.8).
 */

/** A number that may arrive as an empty string (unset key in a .env file). */
const numeric = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? Number(v) : fallback))
    .pipe(z.number().finite().min(min).max(max));

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

/**
 * A boolean that refuses to guess.
 *
 * The old version treated anything unrecognised as `false`, so a typo silently
 * flipped a safety flag: `DOSSIER_HERMETIC=treu` disabled hermetic mode and let
 * the test suite reach the network, and `DOSSIER_REQUIRE_CONTRACT=treu`
 * disabled the spend handshake. Both fail in the unsafe direction, which is the
 * one direction a typo must never take. Unrecognised values now fail startup.
 */
const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      const s = (v ?? '').trim().toLowerCase();
      if (!s) return fallback;
      if (TRUTHY.has(s)) return true;
      if (FALSY.has(s)) return false;
      ctx.addIssue({
        code: 'custom',
        message: `expected one of ${[...TRUTHY, ...FALSY].join('/')}, got ${JSON.stringify(v)}`,
      });
      return z.NEVER;
    });

const EnvSchema = z.object({
  GEMINI_API_KEY: z.string().trim().max(500).optional(),
  GOOGLE_API_KEY: z.string().trim().max(500).optional(),
  VERTEX_PROJECT: z.string().trim().max(200).optional(),
  PERPLEXITY_API_KEY: z.string().trim().max(500).optional(),
  OPENAI_API_KEY: z.string().trim().max(500).optional(),
  XAI_API_KEY: z.string().trim().max(500).optional(),
  DOSSIER_PROVIDERS: z.string().trim().max(200).optional(),
  VERTEX_LOCATION: z.string().trim().max(100).optional(),

  DOSSIER_STORE_DIR: z.string().trim().max(1000).optional(),
  /**
   * Set by Dossier on a CLI it spawns, never by a user.
   *
   * A stdio MCP server is a child of its client, so a Dossier started by a CLI
   * that Dossier started inherits this and stamps it on everything it runs.
   * Validated like any other input because it arrives through the environment
   * and reaches a stored record.
   */
  DOSSIER_SPAWNED_BY: z.string().trim().max(200).optional(),

  DOSSIER_BUDGET_USD: numeric(100, 0, 1_000_000),
  DOSSIER_BUDGET_WINDOW_HOURS: numeric(24, 1, 24 * 365),
  // Documented per-provider sub-ceilings. Zod stripped these, so a guardrail
  // the docs promised silently did nothing and any backend could consume the
  // whole global ceiling.
  DOSSIER_BUDGET_USD_GEMINI: numeric(0, 0, 1_000_000),
  DOSSIER_BUDGET_USD_PERPLEXITY: numeric(0, 0, 1_000_000),
  DOSSIER_BUDGET_USD_OPENAI: numeric(0, 0, 1_000_000),
  /**
   * How many runs may be in flight on ONE backend at once. 0 disables the cap.
   *
   * Separate from `DOSSIER_MAX_CONCURRENT` because a backend's real limit is
   * not always a slot count. OpenAI deep research is metered in tokens per
   * minute against the whole account, and two runs contending for one
   * 1,000,000-token budget kill each other regardless of how many global slots
   * are free.
   */
  // Defaults to 1, and it is the only backend that does. Measured, not
  // guessed: six runs in this repo's own ledger died with "Limit 1000000, Used
  // 993157" — an account at 99.3% of its minute budget, killed by a request for
  // 53,211 more. Deep research accumulates context as it searches, so the
  // second concurrent run is what breaks the first. Set it to 0 to disable.
  DOSSIER_CONCURRENCY_OPENAI: numeric(1, 0, 1_000_000),
  DOSSIER_CONCURRENCY_GEMINI: numeric(0, 0, 1_000_000),
  DOSSIER_CONCURRENCY_PERPLEXITY: numeric(0, 0, 1_000_000),
  DOSSIER_CONCURRENCY_XAI: numeric(0, 0, 1_000_000),
  DOSSIER_BUDGET_USD_XAI: numeric(0, 0, 1_000_000),
  /**
   * How many runs may be in flight at once, across every backend.
   *
   * This bounds concurrent *work*, not spend. Spend is bounded by the budget
   * ceiling, which reserves a panel in full before any member of it starts, so
   * this number does not need to be small to be safe. It needs to be large
   * enough that the ordinary panel is not refused: three or four signed-in CLIs
   * in the free lane plus two or three paid backends is now the common shape,
   * and a panel wider than the cap is refused whole rather than trimmed. Ten
   * admits that with headroom and still refuses a runaway.
   */
  /**
   * How many signed-in CLIs the free lane runs. 0 runs every one available.
   *
   * Defaults to two. A second model is the cheapest check there is on an
   * invented finding — a claim only one backend found is visibly weaker than
   * one both found — while a third and fourth mostly widen web coverage rather
   * than verifying anything, and every one spends subscription quota Dossier
   * cannot see or meter. The ones held back are named as tie-breakers rather
   * than discarded.
   */
  DOSSIER_FREE_LANE_MAX: numeric(2, 0, 16),
  DOSSIER_MAX_CONCURRENT: numeric(10, 1, 64),
  DOSSIER_REQUIRE_CONTRACT: boolish(false),
  DOSSIER_DEDUPE_TTL_MINUTES: numeric(1440, 0, 60 * 24 * 90),

  DOSSIER_POLL_SECONDS: numeric(20, 5, 600),
  DOSSIER_STALL_MINUTES: numeric(12, 1, 120),
  DOSSIER_UTILITY_MODEL: z.string().trim().max(200).optional(),

  DOSSIER_HTTP_PORT: numeric(8787, 1, 65535),
  DOSSIER_HTTP_TOKENS: z.string().max(4000).optional(),
  DOSSIER_HTTP_ALLOW_ANONYMOUS: boolish(false),

  DOSSIER_HERMETIC: boolish(false),

  /**
   * Directories a research run may read locally. Operator-set, never
   * agent-set: see `localCorpusDirs` on Config for why that boundary matters.
   */
  DOSSIER_LOCAL_CORPUS_DIRS: z.string().max(4000).optional(),
  /**
   * Restricts the free lane to one CLI. Derived from `CLI_IDS` so the adapter
   * table stays the single place a CLI is declared.
   */
  /**
   * Which model a given CLI should run, where it accepts one.
   *
   * Every shipped CLI takes a model flag and Dossier passed none, so each ran
   * its own default. Cursor's default is `composer-2.5`, a CODING model, doing
   * research — while `cursor-agent --list-models` on the same account offers
   * `cursor-grok-4.5-high`, `claude-opus-5-thinking-high` and
   * `gpt-5.6-sol-xhigh`. One subscription can serve several of the panel's
   * models and the operator could not say which.
   *
   * Bounded because the value reaches argv. Operator-set only, never
   * agent-set: the same boundary as DOSSIER_LOCAL_CLI.
   */
  DOSSIER_LOCAL_MODEL_CLAUDE: z.string().trim().max(120).optional(),
  DOSSIER_LOCAL_MODEL_CODEX: z.string().trim().max(120).optional(),
  DOSSIER_LOCAL_MODEL_GROK: z.string().trim().max(120).optional(),
  DOSSIER_LOCAL_MODEL_CURSOR: z.string().trim().max(120).optional(),

  /**
   * Which browser driver you will drive, when a question needs one.
   *
   * Four places already told operators to set this and NOTHING read it: the
   * schema never declared it, so `DOSSIER_BROWSER_PROVIDER=playwright-mcp` was
   * silently discarded and the advice was false. The same defect class as a
   * rate-limit message naming a variable that did not exist.
   *
   * It selects, it does not activate. Dossier still drives no browser — the
   * boundary in `src/local/browser.ts` is deliberate, and detection is not
   * permission. What this changes is the SPECIFICITY of what Dossier hands
   * back: unset, a crawl recommendation can only say "use browser tooling";
   * set, it names your driver and the invocation that reaches your logged-in
   * session, which is the difference between advice and instructions.
   */
  DOSSIER_BROWSER_PROVIDER: z.enum(BROWSER_TOOL_IDS).optional(),

  DOSSIER_LOCAL_CLI: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v, ctx) => {
      const raw = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const bad = raw.filter((s) => !(CLI_IDS as readonly string[]).includes(s));
      if (bad.length > 0) {
        // Refused rather than ignored. A typo that silently widens the lane back
        // to every CLI is the failure that costs subscription quota nobody
        // asked to spend, and quota is the one cost Dossier cannot meter.
        ctx.addIssue({
          code: 'custom',
          message: `unknown CLI ${bad.map((b) => JSON.stringify(b)).join(', ')}; expected ${CLI_IDS.join(', ')}`,
        });
        return z.NEVER;
      }
      return raw;
    }),
});

export type AuthMode = 'api-key' | 'vertex' | 'none';

export interface Config {
  readonly auth:
    | { readonly mode: 'api-key'; readonly apiKey: string }
    | { readonly mode: 'vertex'; readonly project: string; readonly location: string }
    | { readonly mode: 'none' };
  /** Present-and-shaped credentials for the non-Gemini providers. */
  readonly perplexityApiKey: string;
  readonly openaiApiKey: string;
  readonly xaiApiKey: string;
  /** Explicit provider allow-list; empty means "everything detected". */
  readonly enabledProviders: readonly string[];
  readonly storeDir: string;
  /**
   * The Dossier interaction whose CLI spawned this server, if one did.
   *
   * Empty for an ordinary launch. Set when Dossier is running as a child of a
   * CLI that Dossier itself started, which is how a panel member comes to be
   * able to call `research_start`: a stdio MCP server is a child of its client,
   * so the variable Dossier put in the CLI's environment arrives here.
   *
   * Everything this server then starts is stamped with it, so a run authored by
   * a panel member is identifiable rather than indistinguishable from one the
   * user asked for.
   */
  readonly spawnedBy: string;
  readonly budgetUsd: number;
  readonly budgetWindowHours: number;
  /** Optional per-provider sub-ceilings. Zero means "only the global one". */
  readonly providerBudgetsUsd: Readonly<Record<string, number>>;
  /** Runs allowed in flight per backend. Zero means only the global cap applies. */
  readonly providerConcurrency: Readonly<Record<string, number>>;
  /** CLIs the free lane runs at once. Zero means every signed-in one. */
  readonly freeLaneMax: number;
  readonly maxConcurrent: number;
  readonly requireContract: boolean;
  readonly dedupeTtlMinutes: number;
  readonly pollSeconds: number;
  readonly stallMinutes: number;
  readonly utilityModel: string;
  readonly httpPort: number;
  readonly httpTokens: readonly string[];
  /** Deliberate opt-in to an unauthenticated HTTP listener. */
  readonly httpAllowAnonymous: boolean;
  /**
   * Absolute directories the local corpus may read, granted by the operator.
   *
   * There is deliberately **no tool that adds one**. A tool that reads
   * arbitrary local files and returns snippets is an exfiltration primitive:
   * an agent following instructions it found in a fetched web page could
   * register `/` and search it for credentials. Making the grant an
   * environment variable puts it where the human is and keeps it out of reach
   * of anything the model reads. Empty by default; the feature is off until
   * somebody sets it.
   */
  readonly localCorpusDirs: readonly string[];
  /**
   * Restricts the free lane to one CLI.
   *
   * Empty, the default, means every capable signed-in CLI joins the panel. Set
   * to a CLI id it means that one and no other, even when the others are
   * installed and signed in. It restricts; it no longer selects, because with
   * one backend per CLI there is nothing left to select between.
   */
  /**
   * CLIs the free lane may use, in the order given. Empty means every one that
   * is installed and signed in.
   *
   * A list rather than a single id, because the useful answer is often neither
   * "one" nor "all". Two distinct models give a cross-model check — a claim only
   * one of them found is visibly weaker than one both found, which is the single
   * most useful signal for catching an invented finding — while a third and
   * fourth mostly widen web coverage rather than adding checks, and every one of
   * them spends subscription quota Dossier cannot see.
   */
  readonly localCli: readonly string[];
  /** The browser driver the operator says they will drive. Empty when unset. */
  readonly browserProvider: string;
  /** Model to request per CLI id, where the CLI accepts one. */
  readonly localModels: Readonly<Record<string, string>>;
  readonly hermetic: boolean;
}

export const DEFAULT_UTILITY_MODEL = 'gemini-3.1-pro-preview';

/**
 * Resolve config from the process environment (or an injected record, for tests).
 * Vertex wins when `VERTEX_PROJECT` is present — an operator who has configured a
 * GCP project means it, and silently preferring a stray API key would bill the
 * wrong account.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${detail}`);
  }
  const e = parsed.data;

  const apiKey = e.GEMINI_API_KEY || e.GOOGLE_API_KEY || '';
  const project = e.VERTEX_PROJECT || '';

  const auth: Config['auth'] = project
    ? { mode: 'vertex', project, location: e.VERTEX_LOCATION || 'global' }
    : apiKey
      ? { mode: 'api-key', apiKey }
      : { mode: 'none' };

  return {
    auth,
    perplexityApiKey: e.PERPLEXITY_API_KEY || '',
    openaiApiKey: e.OPENAI_API_KEY || '',
    xaiApiKey: e.XAI_API_KEY || '',
    enabledProviders: (e.DOSSIER_PROVIDERS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    storeDir: e.DOSSIER_STORE_DIR || join(homedir(), '.dossier-research-mcp'),
    spawnedBy: e.DOSSIER_SPAWNED_BY ?? '',
    budgetUsd: e.DOSSIER_BUDGET_USD,
    budgetWindowHours: e.DOSSIER_BUDGET_WINDOW_HOURS,
    providerBudgetsUsd: {
      gemini: e.DOSSIER_BUDGET_USD_GEMINI,
      perplexity: e.DOSSIER_BUDGET_USD_PERPLEXITY,
      openai: e.DOSSIER_BUDGET_USD_OPENAI,
      xai: e.DOSSIER_BUDGET_USD_XAI,
    },
    providerConcurrency: {
      gemini: e.DOSSIER_CONCURRENCY_GEMINI,
      perplexity: e.DOSSIER_CONCURRENCY_PERPLEXITY,
      // Read straight through, so an explicit 0 really does disable the cap.
      // The first version remapped 0 to 1 here, which made the documented
      // "0 disables" false for the one backend that needed it — caught by a
      // test that set it to 0 and was still refused a slot.
      openai: e.DOSSIER_CONCURRENCY_OPENAI,
      xai: e.DOSSIER_CONCURRENCY_XAI,
    },
    freeLaneMax: e.DOSSIER_FREE_LANE_MAX,
    maxConcurrent: e.DOSSIER_MAX_CONCURRENT,
    requireContract: e.DOSSIER_REQUIRE_CONTRACT,
    dedupeTtlMinutes: e.DOSSIER_DEDUPE_TTL_MINUTES,
    pollSeconds: e.DOSSIER_POLL_SECONDS,
    stallMinutes: e.DOSSIER_STALL_MINUTES,
    utilityModel: e.DOSSIER_UTILITY_MODEL || DEFAULT_UTILITY_MODEL,
    httpPort: e.DOSSIER_HTTP_PORT,
    httpTokens: assertStrongTokens(
      (e.DOSSIER_HTTP_TOKENS || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    ),
    httpAllowAnonymous: e.DOSSIER_HTTP_ALLOW_ANONYMOUS,
    localCorpusDirs: (e.DOSSIER_LOCAL_CORPUS_DIRS || '')
      .split(/[:,]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => resolve(s.startsWith('~') ? join(homedir(), s.slice(1)) : s)),
    localCli: e.DOSSIER_LOCAL_CLI ?? [],
    browserProvider: e.DOSSIER_BROWSER_PROVIDER ?? '',
    localModels: {
      ...(e.DOSSIER_LOCAL_MODEL_CLAUDE ? { claude: e.DOSSIER_LOCAL_MODEL_CLAUDE } : {}),
      ...(e.DOSSIER_LOCAL_MODEL_CODEX ? { codex: e.DOSSIER_LOCAL_MODEL_CODEX } : {}),
      ...(e.DOSSIER_LOCAL_MODEL_GROK ? { grok: e.DOSSIER_LOCAL_MODEL_GROK } : {}),
      ...(e.DOSSIER_LOCAL_MODEL_CURSOR ? { cursor: e.DOSSIER_LOCAL_MODEL_CURSOR } : {}),
    },
    hermetic: e.DOSSIER_HERMETIC,
  };
}

/**
 * What a given backend cannot do.
 *
 * Vertex is not simply "the API key plus enterprise controls": measured
 * against the docs, the Interactions API on Vertex serves managed agents and
 * specialised media models but NOT standard Gemini models, and File Search is
 * Developer-API-only. So a Vertex deployment loses follow-ups, corpus
 * grounding, and every utility-model feature built on them. Naming that here
 * once means the server can say it at start-up, in `research://capabilities`,
 * and in the tool that would otherwise fail confusingly.
 */
/**
 * A bearer token guards a network surface that spends money, so it needs
 * entropy rather than merely a constant-time comparison.
 *
 * `DOSSIER_HTTP_TOKENS=a` was accepted, and comparing one character in constant
 * time does not make it any harder to guess. Refused at startup rather than
 * warned about, on the same principle as the boolean parser: a control that
 * fails open on a typo is not a control.
 */
const MIN_TOKEN_LENGTH = 24;

function assertStrongTokens(tokens: readonly string[]): readonly string[] {
  const weak = tokens.filter((t) => t.length < MIN_TOKEN_LENGTH);
  if (weak.length > 0) {
    throw new Error(
      `Invalid environment configuration: DOSSIER_HTTP_TOKENS contains ${String(weak.length)} token(s) shorter than ${String(MIN_TOKEN_LENGTH)} characters. ` +
        'This token authenticates a surface that can spend money; generate one with `openssl rand -base64 32`.',
    );
  }
  return tokens;
}

export function backendLimitations(config: Config): readonly string[] {
  if (config.auth.mode !== 'vertex') return [];
  return [
    'Corpus grounding is unavailable: File Search stores are a Gemini Developer API feature.',
    'research_followup is unavailable: the Interactions API on Vertex serves agents and media models, not the standard Gemini models a follow-up turn needs.',
    'AI titles, summaries and research_claims are unavailable: they run on the same standard models.',
    'Deep Research runs and managed agents are expected to work, but this path has not been verified against a live Vertex project.',
  ];
}

/** Human-readable auth description for the capabilities resource (never the key). */
export function describeAuth(config: Config): string {
  switch (config.auth.mode) {
    case 'api-key':
      return 'Google AI Studio API key (GEMINI_API_KEY)';
    case 'vertex':
      return `Vertex AI (project ${config.auth.project}, location ${config.auth.location})`;
    case 'none':
      return 'unconfigured: set GEMINI_API_KEY or VERTEX_PROJECT';
    default: {
      const _exhaustive: never = config.auth;
      return _exhaustive;
    }
  }
}
