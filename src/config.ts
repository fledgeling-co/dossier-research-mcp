import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

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

  DOSSIER_BUDGET_USD: numeric(100, 0, 1_000_000),
  DOSSIER_BUDGET_WINDOW_HOURS: numeric(24, 1, 24 * 365),
  // Documented per-provider sub-ceilings. Zod stripped these, so a guardrail
  // the docs promised silently did nothing and any backend could consume the
  // whole global ceiling.
  DOSSIER_BUDGET_USD_GEMINI: numeric(0, 0, 1_000_000),
  DOSSIER_BUDGET_USD_PERPLEXITY: numeric(0, 0, 1_000_000),
  DOSSIER_BUDGET_USD_OPENAI: numeric(0, 0, 1_000_000),
  DOSSIER_BUDGET_USD_XAI: numeric(0, 0, 1_000_000),
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
  DOSSIER_LOCAL_CLI: z.enum(['claude', 'codex', 'agy', 'grok', 'cursor', 'gemini']).optional(),
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
  readonly budgetUsd: number;
  readonly budgetWindowHours: number;
  /** Optional per-provider sub-ceilings. Zero means "only the global one". */
  readonly providerBudgetsUsd: Readonly<Record<string, number>>;
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
  /** Which coding CLI backs the `local` provider. Empty means auto-detect. */
  readonly localCli: string;
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
    throw new Error(`Invalid environment configuration — ${detail}`);
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
    budgetUsd: e.DOSSIER_BUDGET_USD,
    budgetWindowHours: e.DOSSIER_BUDGET_WINDOW_HOURS,
    providerBudgetsUsd: {
      gemini: e.DOSSIER_BUDGET_USD_GEMINI,
      perplexity: e.DOSSIER_BUDGET_USD_PERPLEXITY,
      openai: e.DOSSIER_BUDGET_USD_OPENAI,
      xai: e.DOSSIER_BUDGET_USD_XAI,
    },
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
    localCli: e.DOSSIER_LOCAL_CLI ?? '',
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
      `Invalid environment configuration — DOSSIER_HTTP_TOKENS contains ${String(weak.length)} token(s) shorter than ${String(MIN_TOKEN_LENGTH)} characters. ` +
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
      return 'unconfigured — set GEMINI_API_KEY or VERTEX_PROJECT';
    default: {
      const _exhaustive: never = config.auth;
      return _exhaustive;
    }
  }
}
