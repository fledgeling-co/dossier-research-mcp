import { homedir } from 'node:os';
import { join } from 'node:path';
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

const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const s = (v ?? '').trim().toLowerCase();
      if (!s) return fallback;
      return s === '1' || s === 'true' || s === 'yes';
    });

const EnvSchema = z.object({
  GEMINI_API_KEY: z.string().trim().max(500).optional(),
  GOOGLE_API_KEY: z.string().trim().max(500).optional(),
  VERTEX_PROJECT: z.string().trim().max(200).optional(),
  VERTEX_LOCATION: z.string().trim().max(100).optional(),

  DEEP_RESEARCH_STORE_DIR: z.string().trim().max(1000).optional(),

  DEEP_RESEARCH_BUDGET_USD: numeric(25, 0, 1_000_000),
  DEEP_RESEARCH_BUDGET_WINDOW_HOURS: numeric(24, 1, 24 * 365),
  DEEP_RESEARCH_MAX_CONCURRENT: numeric(3, 1, 64),
  DEEP_RESEARCH_REQUIRE_CONTRACT: boolish(false),
  DEEP_RESEARCH_DEDUPE_TTL_MINUTES: numeric(1440, 0, 60 * 24 * 90),

  DEEP_RESEARCH_POLL_SECONDS: numeric(20, 5, 600),
  DEEP_RESEARCH_STALL_MINUTES: numeric(12, 1, 120),
  DEEP_RESEARCH_UTILITY_MODEL: z.string().trim().max(200).optional(),

  DEEP_RESEARCH_HTTP_PORT: numeric(8787, 1, 65535),
  DEEP_RESEARCH_HTTP_TOKENS: z.string().max(4000).optional(),

  DEEP_RESEARCH_HERMETIC: boolish(false),
});

export type AuthMode = 'api-key' | 'vertex' | 'none';

export interface Config {
  readonly auth:
    | { readonly mode: 'api-key'; readonly apiKey: string }
    | { readonly mode: 'vertex'; readonly project: string; readonly location: string }
    | { readonly mode: 'none' };
  readonly storeDir: string;
  readonly budgetUsd: number;
  readonly budgetWindowHours: number;
  readonly maxConcurrent: number;
  readonly requireContract: boolean;
  readonly dedupeTtlMinutes: number;
  readonly pollSeconds: number;
  readonly stallMinutes: number;
  readonly utilityModel: string;
  readonly httpPort: number;
  readonly httpTokens: readonly string[];
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
    storeDir: e.DEEP_RESEARCH_STORE_DIR || join(homedir(), '.deep-research-mcp'),
    budgetUsd: e.DEEP_RESEARCH_BUDGET_USD,
    budgetWindowHours: e.DEEP_RESEARCH_BUDGET_WINDOW_HOURS,
    maxConcurrent: e.DEEP_RESEARCH_MAX_CONCURRENT,
    requireContract: e.DEEP_RESEARCH_REQUIRE_CONTRACT,
    dedupeTtlMinutes: e.DEEP_RESEARCH_DEDUPE_TTL_MINUTES,
    pollSeconds: e.DEEP_RESEARCH_POLL_SECONDS,
    stallMinutes: e.DEEP_RESEARCH_STALL_MINUTES,
    utilityModel: e.DEEP_RESEARCH_UTILITY_MODEL || DEFAULT_UTILITY_MODEL,
    httpPort: e.DEEP_RESEARCH_HTTP_PORT,
    httpTokens: (e.DEEP_RESEARCH_HTTP_TOKENS || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    hermetic: e.DEEP_RESEARCH_HERMETIC,
  };
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
