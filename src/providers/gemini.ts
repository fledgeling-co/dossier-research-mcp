import { AGENT_BY_TIER } from '../gemini/types.js';
import type { ResearchTier } from '../gemini/types.js';
import type { Config } from '../config.js';
import { backendLimitations } from '../config.js';
import type { DeepResearchClient } from '../gemini/client.js';
import { estimateCost, estimateDuration } from '../gemini/cost.js';
import type { DurationOptions } from '../gemini/cost.js';
import type {
  Capabilities,
  CredentialStatus,
  ProviderEstimate,
  ResearchProvider,
} from './types.js';

/**
 * Gemini as a provider.
 *
 * The first implementation and, deliberately, a thin one: the client it returns
 * is the same `DeepResearchClient` the runner has always used. If wrapping the
 * existing backend had required changing its behaviour, the abstraction would
 * have been wrong.
 *
 * It stays the default when its key is present, because the editable plan is
 * the single highest-leverage control a user has over output quality and no
 * other backend offers one through an API.
 */
export function geminiProvider(
  config: Config,
  resolveClient: () => DeepResearchClient | null,
): ResearchProvider {
  const vertex = config.auth.mode === 'vertex';

  const capabilities: Capabilities = {
    shapes: vertex ? ['deep'] : ['deep', 'corpus'],
    background: true,
    // The one thing nothing else has.
    planReview: true,
    followUp: !vertex,
    dateFilter: 'none',
    domainFilter: 0,
    corpus: vertex ? 'none' : 'file-search',
    socialSources: [],
    structuredOutput: false,
    fileOutput: false,
    maxWallClockMinutes: 60,
    billedTo: 'api-balance',
    limitations: [
      'No date filter: a time window is a request in the prompt, not an enforced constraint.',
      'No domain filter: SEO aggregators cannot be excluded.',
      'Mid-run progress is buffered upstream; a 7.1-minute run reported nothing until it finished.',
      ...backendLimitations(config),
    ],
  };

  return {
    id: 'gemini',
    label: 'Google Gemini Deep Research',
    capabilities,

    detect(): CredentialStatus {
      if (config.hermetic) {
        return { state: 'not-configured', detail: 'hermetic mode: no network calls are permitted' };
      }
      switch (config.auth.mode) {
        case 'api-key':
          return { state: 'configured-unverified', detail: 'GEMINI_API_KEY is set' };
        case 'vertex':
          return {
            state: 'configured-unverified',
            detail: `Vertex project ${config.auth.project} (${config.auth.location})`,
          };
        default:
          return {
            state: 'not-configured',
            detail: 'no Gemini credentials',
            fix: 'Set GEMINI_API_KEY from https://aistudio.google.com/apikey',
          };
      }
    },

    estimate(input: DurationOptions): ProviderEstimate {
      return { cost: estimateCost(input), duration: estimateDuration(input) };
    },
    modelFor(tier: ResearchTier): string {
      return AGENT_BY_TIER[tier];
    },

    client(): DeepResearchClient {
      const c = resolveClient();
      if (!c) {
        throw new Error(
          'No Gemini client available. Set GEMINI_API_KEY or VERTEX_PROJECT (and unset DOSSIER_HERMETIC).',
        );
      }
      return c;
    },
  };
}
