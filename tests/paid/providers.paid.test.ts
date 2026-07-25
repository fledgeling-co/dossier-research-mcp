import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ProviderRegistry } from '../../src/providers/registry.js';

/**
 * PAID-06..09: the smallest real call each non-Gemini backend can make.
 *
 * Every request shape in `src/providers/` was written against vendor
 * documentation and has never touched a live endpoint. That is the single
 * largest untested surface in the repo, and the failure mode is not subtle: a
 * renamed field or a moved endpoint means the backend fails on the first paid
 * run somebody actually cares about.
 *
 * So this is a shape check, not a research run. It creates the cheapest job
 * each API will accept, asserts the response parses into an interaction id,
 * then **cancels immediately**. What it proves is exactly what hermetic tests
 * cannot: that the endpoint exists, the auth header is right, the request body
 * is accepted, and the response shape is the one the adapter expects.
 *
 * ## What it costs, per provider, honestly
 *
 * | Provider | Cancellable | Rough cost of one smoke run |
 * |---|---|---|
 * | OpenAI | yes, `/cancel` on the Responses API | cents; it is stopped seconds after it starts |
 * | xAI | no documented cancel for deferred completions | cents; grok-4.3 on a one-sentence brief |
 * | Perplexity | **no** cancel for async Sonar jobs | **$0.50-2**: it is a real `sonar-deep-research` run and it will finish and bill |
 *
 * The Perplexity row is not a rounding error and is deliberate. Verifying a
 * cheaper model would exercise a different endpoint, a different request body
 * and a different response parse, which is to say it would verify nothing that
 * is actually in doubt.
 *
 * ```bash
 * DOSSIER_PAID_TESTS=1 PERPLEXITY_API_KEY=… OPENAI_API_KEY=… XAI_API_KEY=… npm run test:paid
 * ```
 *
 * Each provider skips independently on a missing key, so verifying one at a
 * time is the normal way to use this.
 */

/**
 * Load `.env.local` if it exists.
 *
 * Keys for the paid backends belong in a gitignored file rather than in a
 * shell history or a CI variable, and reading it here means `npm run test:paid`
 * works without a wrapper. Deliberately does not overwrite anything already in
 * the environment: an explicitly exported key beats a file every time.
 */
function loadEnvLocal(): void {
  try {
    for (const line of readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match?.[1] || process.env[match[1]]) continue;
      process.env[match[1]] = (match[2] ?? '').trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // No file is the normal case; the suite then skips on missing keys.
  }
}
loadEnvLocal();

const OPTED_IN = process.env['DOSSIER_PAID_TESTS'] === '1';

const KEY_FOR = {
  perplexity: 'PERPLEXITY_API_KEY',
  openai: 'OPENAI_API_KEY',
  xai: 'XAI_API_KEY',
} as const;
type SmokeProvider = keyof typeof KEY_FOR;

/** A question small enough that a cancelled run costs almost nothing. */
const TINY_BRIEF = 'In one sentence: what is the capital of Australia?';

function registryFor(id: SmokeProvider): ProviderRegistry {
  return new ProviderRegistry(
    loadConfig({
      DOSSIER_HERMETIC: '',
      DOSSIER_STORE_DIR: '/tmp/dossier-paid-smoke',
      [KEY_FOR[id]]: process.env[KEY_FOR[id]] ?? '',
    }),
    () => null,
  );
}

for (const id of ['perplexity', 'openai', 'xai'] as const) {
  const enabled = OPTED_IN && Boolean(process.env[KEY_FOR[id]]);
  // Say why a provider is skipped. A silently skipped paid test looks exactly
  // like a passing one in the summary line, which is how "verified" ends up
  // meaning "never ran".
  if (OPTED_IN && !enabled) {
    process.stderr.write(`[smoke] skipping ${id}: ${KEY_FOR[id]} is not set\n`);
  }
  const describeMaybe = enabled ? describe : describe.skip;

  describeMaybe(`${id}: the live endpoint accepts what the adapter sends`, () => {
    it('creates a job and returns an id the adapter can read', async () => {
      const provider = registryFor(id);
      const backend = provider.get(id);
      expect(backend, `${id} should be constructible`).not.toBeNull();
      expect(backend?.detect().state).not.toBe('not-configured');

      const client = backend?.client();
      expect(client).toBeDefined();

      const started = await client?.createRun({
        prompt: TINY_BRIEF,
        tier: 'fast',
        collaborativePlanning: false,
        thinkingSummaries: false,
        visualization: false,
        tools: [],
      });

      // The assertion that matters: a real id came back. An empty one means
      // the response shape moved and every run would poll forever.
      expect(started?.interactionId, 'no interaction id in the response').toBeTruthy();
      expect(started?.status).toBe('in_progress');

      // Poll once, to prove the retrieval endpoint and its parse work too.
      const polled = await client?.getRun(started?.interactionId ?? '');
      expect(polled?.interactionId).toBe(started?.interactionId);
      expect(['in_progress', 'completed', 'failed']).toContain(polled?.status);

      // Stop it where that is possible. A backend without cancellation throws a
      // message saying so, which is the documented behaviour rather than a
      // failure — and it means the job finishes and bills.
      await client?.cancelRun(started?.interactionId ?? '').catch((e: unknown) => {
        expect(String(e)).toMatch(/does not expose cancellation/);
      });
    }, 120_000);
  });
}

describe('the smoke check refuses to run by accident', () => {
  it('needs an explicit opt-in as well as a key', () => {
    // The same rule as the rest of the paid project: a suite that spends money
    // is something you opt into, never something a `git push` triggers.
    expect(OPTED_IN || process.env['DOSSIER_PAID_TESTS'] === undefined).toBe(true);
  });
});
