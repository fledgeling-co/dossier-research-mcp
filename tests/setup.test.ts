import { describe, expect, it } from 'vitest';
import { BROWSER_DRIVERS, CLI_GUIDE, PROVIDER_GUIDE, SETTINGS } from '../src/setup/catalog.js';
import { registrationArgs, registrationDisplay } from '../src/setup/wizard.js';
import { CLI_IDS } from '../src/local/cli.js';

const answers = (over: Partial<Parameters<typeof registrationArgs>[0]> = {}) => ({
  clis: [] as string[],
  providers: [] as string[],
  keys: {} as Record<string, string>,
  settings: {} as Record<string, string>,
  browser: null,
  ...over,
});

describe('the registration command', () => {
  it('is an argument list, never a shell string', () => {
    // The arguments carry API keys. A key is opaque text from a provider, and
    // it is not this code's place to assume it contains nothing a shell would
    // act on: the cost of being wrong is command execution with the user's own
    // credentials sitting in the argument.
    const args = registrationArgs(answers({ keys: { GEMINI_API_KEY: "x'; rm -rf ~; echo '" } }));
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain("GEMINI_API_KEY=x'; rm -rf ~; echo '");
    // The dangerous text is one argv entry, not something a shell ever parses.
    expect(args.filter((a) => a.includes('rm -rf'))).toHaveLength(1);
  });

  it('never prints a key', () => {
    const display = registrationDisplay(answers({ keys: { GEMINI_API_KEY: 'AIzaSecretValue123456' } }));
    expect(display).not.toContain('AIzaSecretValue123456');
    expect(display).toContain('GEMINI_API_KEY=<your GEMINI_API_KEY>');
  });

  it('still shows non-secret settings in full, since those are the point', () => {
    const display = registrationDisplay(answers({ settings: { DOSSIER_BUDGET_USD: '25' } }));
    expect(display).toContain('DOSSIER_BUDGET_USD=25');
  });

  it('names the CLI so a free backend can be chosen at all', () => {
    // A $0 backend never wins a cost tie-break on its own, by design, so
    // picking a subscription in the wizard has to opt it in explicitly.
    const args = registrationArgs(answers({ clis: ['claude'], providers: ['gemini'] }));
    expect(args).toContain('DOSSIER_PROVIDERS=gemini,local');
    expect(args).toContain('DOSSIER_LOCAL_CLI=claude');
  });

  it('leaves provider selection alone when no subscription was chosen', () => {
    const args = registrationArgs(answers({ providers: ['gemini'] }));
    expect(args.some((a) => a.startsWith('DOSSIER_PROVIDERS='))).toBe(false);
  });
});

describe('the catalog tells the truth', () => {
  it('only claims subscription coverage where it is confirmed', () => {
    for (const c of CLI_GUIDE) {
      if (c.coverage === 'unconfirmed') {
        expect(c.coverageNote, c.headline).toMatch(/unconfirmed|not (state|say)|corroboration/i);
      } else {
        // A confirmed claim carries the date it was confirmed, because these
        // facts rot: Gemini CLI's consumer tier was withdrawn while its own
        // README still advertised it.
        expect(c.coverageNote, c.headline).toMatch(/\d{4}/);
      }
    }
  });

  it('offers only CLIs the server can actually drive', () => {
    for (const c of CLI_GUIDE) expect(CLI_IDS, c.headline).toContain(c.id);
  });

  it('gives every provider a cost, a console, and what only it can do', () => {
    for (const g of PROVIDER_GUIDE) {
      expect(g.costPerRun, g.label).toMatch(/\$|cent/);
      expect(g.console, g.label).toMatch(/^https:\/\//);
      expect(g.onlyThisOne.length, g.label).toBeGreaterThan(20);
      expect(g.beforeItWorks.length, g.label).toBeGreaterThan(0);
    }
  });

  it('warns that a consumer subscription is not API credit', () => {
    // The most expensive misunderstanding available here: three of the four
    // providers sell a subscription that does not include the API at all.
    for (const id of ['perplexity', 'openai', 'xai'] as const) {
      const g = PROVIDER_GUIDE.find((x) => x.id === id);
      expect(g?.beforeItWorks.join(' '), id).toMatch(/does NOT include|separate/i);
    }
  });

  it('recognises the keys each provider actually issues', () => {
    const samples: Record<string, string> = {
      gemini: 'AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7',
      perplexity: 'pplx-abcdefghijklmnopqrstuvwxyz012345',
      openai: `sk-proj-${'a'.repeat(60)}`,
      xai: `xai-${'b'.repeat(40)}`,
    };
    for (const g of PROVIDER_GUIDE) {
      expect(g.looksRight(samples[g.id] ?? ''), `${g.label} should accept its own key format`).toBe(true);
      expect(g.looksRight('not-a-key'), `${g.label} should reject nonsense`).toBe(false);
    }
  });

  it('only offers browser drivers that reach a session you are already in', () => {
    // The isolated-profile alternatives do not merely inconvenience you with
    // Google, they fail: Google blocks sign-in from browsers flagged as
    // automated. Offering one would waste a non-technical user's afternoon.
    expect(BROWSER_DRIVERS.map((d) => d.id).sort()).toEqual(['chrome-devtools', 'claude-in-chrome', 'playwright']);
  });

  it('explains every setting rather than just naming the variable', () => {
    for (const s of SETTINGS) {
      expect(s.help.length, s.env).toBeGreaterThan(40);
      expect(s.question, s.env).not.toContain('DOSSIER_');
    }
  });
});
