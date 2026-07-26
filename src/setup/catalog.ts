import type { BrowserToolId } from '../local/browser.js';
import type { CliId } from '../local/cli.js';

/**
 * What the setup wizard tells a stranger about the outside world.
 *
 * Data only, so every claim can be checked against its source without reading
 * control flow. Detection is not here: `src/local/cli.ts` already resolves,
 * identifies and auth-checks every CLI, and it does it properly, including the
 * part where two vendors ship a binary called `agent` and the name proves
 * nothing.
 *
 * The rule this file follows: **never print a subscription claim that is not
 * either confirmed with a date or labelled unconfirmed.** Telling somebody
 * their plan covers a tool costs them a subscription when it does not.
 *
 * These facts rot. Gemini CLI's consumer tier was withdrawn on 18 June 2026 and
 * its own README still advertises it. Everything below carries the date it was
 * checked; re-verify anything older than a quarter.
 */

export interface CliEntry {
  readonly id: CliId;
  /** The tool, then the plans that pay for it. Both, because people ask "do I already have this?" */
  readonly headline: string;
  readonly subscriptions: string;
  readonly coverage: 'confirmed' | 'unconfirmed';
  readonly coverageNote: string;
  /** macOS and Linux. Windows is given as a separate line because it is a different shell. */
  readonly install?: string;
  readonly installWindows?: string;
  readonly signIn: string;
  readonly docs: string;
  /** The thing that will bite them. Shown before install, not after. */
  readonly gotcha?: string;
  /** Whether this CLI can do research at all, as opposed to just existing. */
  readonly researchNote?: string;
}

export const CLI_GUIDE: readonly CliEntry[] = [
  {
    id: 'claude',
    headline: 'Claude Code',
    subscriptions: 'Claude Pro, Max, Team or Enterprise',
    coverage: 'confirmed',
    coverageNote: 'Confirmed 25 July 2026. The free Claude.ai plan does not include it.',
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
    installWindows: 'irm https://claude.ai/install.ps1 | iex',
    signIn: 'claude',
    docs: 'https://code.claude.com/docs/en/setup',
    gotcha:
      'If ANTHROPIC_API_KEY is set in your environment, Claude Code uses it and bills per token, silently, instead of using your subscription. Unset it if you want the subscription to pay.',
    researchNote:
      'The strongest option here. It ships a deep-research mode that fans out searches and cross-checks claims, and it scored highest of six tools on an April 2026 benchmark at a fraction of the cost. Needs v2.1.154+, and on Pro you must switch on Dynamic workflows in /config first.',
  },
  {
    id: 'agy',
    headline: 'Antigravity CLI (agy)',
    subscriptions: 'Google AI Ultra, Pro, or the free tier at $0 a month',
    coverage: 'confirmed',
    coverageNote:
      'Confirmed 25 July 2026. The free tier includes Claude Sonnet and Opus as agent models, quoted from Google\'s own pricing page.',
    install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    installWindows: 'irm https://antigravity.google/cli/install.ps1 | iex',
    signIn: 'agy',
    docs: 'https://antigravity.google',
    gotcha:
      'Overage billing is off by default and you should leave it off; that gives you a hard stop at your plan quota rather than a bill.',
    researchNote:
      'The strongest option that costs nothing. It has no dedicated deep-research mode, so it works as a general research agent driving web search.',
  },
  {
    id: 'codex',
    headline: 'Codex CLI',
    subscriptions: 'ChatGPT Plus or Pro',
    coverage: 'unconfirmed',
    coverageNote:
      'Signing in with ChatGPT is documented, but OpenAI does not publish which tiers qualify or what the limits are. Unconfirmed as of 25 July 2026.',
    install: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    signIn: 'codex',
    docs: 'https://learn.chatgpt.com/docs/codex/cli',
    researchNote:
      'No deep-research mode on any sign-in path, and OpenAI staff have declined to add one. Still a capable research agent driving web search; it placed second on the same April 2026 benchmark.',
  },
  {
    id: 'grok',
    headline: 'Grok CLI',
    subscriptions: 'SuperGrok or X Premium+',
    coverage: 'unconfirmed',
    coverageNote:
      'xAI does not say whether the CLI draws on a subscription. Two third-party integrations using the same sign-in report that it does, which is corroboration rather than confirmation. Checked 25 July 2026.',
    install: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    installWindows: 'irm https://x.ai/cli/install.ps1 | iex',
    signIn: 'grok',
    docs: 'https://docs.x.ai',
    gotcha:
      'Two different things install a binary called `grok`: xAI\'s and an unrelated npm package. Its installer also claims the name `agent`, which Cursor uses. Whichever you install last wins the name, so Dossier checks what a binary actually is before running it.',
  },
  {
    id: 'cursor',
    headline: 'Cursor CLI',
    subscriptions: 'any paid Cursor plan',
    coverage: 'confirmed',
    coverageNote: 'Confirmed 25 July 2026, from Cursor\'s launch post: the CLI works with any model as part of your subscription.',
    install: 'curl https://cursor.com/install -fsS | bash',
    installWindows: "irm 'https://cursor.com/install?win32=true' | iex",
    signIn: 'cursor-agent login',
    docs: 'https://cursor.com/docs/cli/installation',
    gotcha:
      'Installs as both `cursor-agent` and `agent`. Dossier uses `cursor-agent`, because `agent` is a name two vendors ship and the wrong one answering means a different bill.',
  },
];

/** Gemini CLI is deliberately absent above. This says why, when someone asks. */
export const GEMINI_CLI_NOTE =
  'Gemini CLI is not on this list on purpose. Google withdrew its consumer sign-in on 18 June 2026, so it now needs an API key like any other paid backend, and it never offered deep research anyway. Its own README still advertises the old free tier and is out of date.';

export interface ProviderEntry {
  readonly id: 'gemini' | 'perplexity' | 'openai' | 'xai';
  readonly label: string;
  readonly envVar: string;
  readonly console: string;
  /** The thing only this one can do. The only honest reason to add a second key. */
  readonly onlyThisOne: string;
  readonly costPerRun: string;
  /** Everything between "I have an account" and "a run works". */
  readonly beforeItWorks: readonly string[];
  /** A shape check, never a promise the key is live. */
  readonly looksRight: (key: string) => boolean;
  readonly budgetEnv: string;
  readonly suggestedCap: string;
}

export const PROVIDER_GUIDE: readonly ProviderEntry[] = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    envVar: 'GEMINI_API_KEY',
    console: 'https://aistudio.google.com/apikey',
    onlyThisOne: 'The only one that lets you read and edit the research plan before it spends anything.',
    costPerRun: '$1-3 a normal run, $3-7 a thorough one',
    beforeItWorks: [
      'Create the key at aistudio.google.com/apikey. Every key belongs to a Google Cloud project; a new account gets one made for it.',
      'Set up billing on that project. Expect a $10 minimum prepay. Deep research is not usable on the free tier: one run is $1-7 of metered spend, so a free key rate-limits or refuses.',
      'Set a monthly spend cap at aistudio.google.com/spend. Google marks this experimental, and their own docs say long-running agents can overrun it, so treat it as a backstop rather than a wall.',
      'If Create API key is greyed out, your Google account lacks permission on that project. A fresh project outside your organisation is the quickest fix.',
    ],
    looksRight: (k) => /^(AIza[\w-]{30,}|AQ\.[\w-]{20,})$/.test(k),
    budgetEnv: 'DOSSIER_BUDGET_USD_GEMINI',
    suggestedCap: '50',
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    envVar: 'PERPLEXITY_API_KEY',
    console: 'https://console.perplexity.ai',
    onlyThisOne: 'Enforced date and domain filters, and the only native wide-research mode: seventy companies with a source for each.',
    costPerRun: 'about $0.29 on a real measured run',
    beforeItWorks: [
      'A Perplexity Pro subscription does NOT include API access. It is billed separately, pay as you go.',
      'Add a payment method under Billing, then generate the key under API Keys. Copy it immediately; it is shown once.',
      'Set a monthly spend cap before your first run. Perplexity bills per token AND per search.',
      'A started run cannot be cancelled. It finishes and it bills.',
    ],
    looksRight: (k) => k.startsWith('pplx-') && k.length > 20,
    budgetEnv: 'DOSSIER_BUDGET_USD_PERPLEXITY',
    suggestedCap: '25',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    console: 'https://platform.openai.com/api-keys',
    onlyThisOne: 'The largest domain filter of the four, up to a hundred sites, and the strongest on academic literature.',
    costPerRun: '$0.60-9 depending on the model',
    beforeItWorks: [
      'A ChatGPT Plus or Pro subscription does NOT include API usage. Add a payment method at platform.openai.com under Billing.',
      'Research-grade models need at least usage Tier 1, which means billing set up. They are not on the free tier.',
      'Model access is granted per PROJECT, separately from your organisation. If a run fails saying the project has no access to the model, fix it under Project then Limits, not in Billing.',
      'Set a hard monthly cap under Settings then Limits.',
    ],
    looksRight: (k) => k.startsWith('sk-') && k.length > 40,
    budgetEnv: 'DOSSIER_BUDGET_USD_OPENAI',
    suggestedCap: '25',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    envVar: 'XAI_API_KEY',
    console: 'https://console.x.ai',
    onlyThisOne: 'The only one that can search X. Nothing else reaches it, at any price.',
    costPerRun: 'about $0.20-1, the cheapest of the four',
    beforeItWorks: [
      'X Premium+ and SuperGrok are consumer subscriptions and do NOT include API credit. It is billed separately.',
      'Create or pick a team at console.x.ai, add billing, then create the key under API Keys.',
      'Set a monthly spend limit in the console. Grok decides its own number of searches, so a run\'s tool spend is harder to predict than the others.',
    ],
    looksRight: (k) => k.startsWith('xai-') && k.length > 20,
    budgetEnv: 'DOSSIER_BUDGET_USD_XAI',
    suggestedCap: '15',
  },
];

/**
 * Reading pages behind a login.
 *
 * Named honestly. Dossier fetches public pages itself and has no browser, so
 * these are capabilities of your *client* that Dossier can then use. The three
 * listed are the only ones that reach a session you are already signed into;
 * the isolated-profile alternatives do not merely inconvenience you with
 * Google, they fail, because Google blocks sign-in from browsers flagged as
 * automated.
 *
 * Dossier will never type a password. That is a design rule, not a setting.
 */
export interface BrowserDriver {
  readonly id: string;
  readonly label: string;
  readonly install: string;
  readonly note: string;
  /**
   * The detectable artefact this driver installs, when there is one.
   *
   * Only the two npm-published MCP servers have one. Claude in Chrome is a
   * browser extension plus a flag on a CLI, and neither leaves anything on disk
   * that can be confirmed without reading a browser profile, so it stays
   * absent here rather than being guessed at.
   */
  readonly detectAs?: BrowserToolId;
}

export const BROWSER_DRIVERS: readonly BrowserDriver[] = [
  {
    id: 'claude-in-chrome',
    label: 'Claude in Chrome — uses the Chrome you are already signed into',
    install: 'claude --chrome',
    note: 'Needs the Claude Chrome extension. The simplest of the three if you already use Claude Code.',
  },
  {
    id: 'chrome-devtools',
    label: 'Chrome DevTools MCP — attaches to your signed-in Chrome',
    install: 'claude mcp add chrome-devtools --scope user -- npx chrome-devtools-mcp@latest --autoConnect',
    note: 'Chrome 144 or later. You approve the connection once at chrome://inspect.',
    detectAs: 'chrome-devtools-mcp',
  },
  {
    id: 'playwright',
    label: 'Playwright MCP — attaches through a browser extension',
    install: 'claude mcp add playwright --scope user -- npx @playwright/mcp@latest --extension',
    note: 'Needs the Playwright extension installed, and you pick which tab it may use.',
    detectAs: 'playwright-mcp',
  },
];

export interface SettingEntry {
  readonly env: string;
  readonly question: string;
  readonly help: string;
  readonly kind: 'number' | 'boolean';
  readonly fallback: string;
}

export const SETTINGS: readonly SettingEntry[] = [
  {
    env: 'DOSSIER_BUDGET_USD',
    question: 'Most you are willing to spend in a day, across everything',
    help: 'A hard ceiling. Every run reserves its worst case before the call, so this refuses early rather than discovering an overage afterwards.',
    kind: 'number',
    fallback: '100',
  },
  {
    env: 'DOSSIER_REQUIRE_CONTRACT',
    question: 'Show you the price and get approval before anything that spends?',
    help: 'Adds one step: the assistant has to plan first, which prints the cost, before it can start a paid run. Worth keeping on if it ever runs while you are not watching.',
    kind: 'boolean',
    fallback: 'true',
  },
  {
    env: 'DOSSIER_MAX_CONCURRENT',
    question: 'How many research runs may be going at once',
    help: 'Each one bills on its own, so this is a second limit on how fast money can leave.',
    kind: 'number',
    fallback: '3',
  },
];
