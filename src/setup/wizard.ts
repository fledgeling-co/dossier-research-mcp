import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { probeAllBrowserTools } from '../local/browser.js';
import { probeAllClis, type CliStatus } from '../local/cli.js';
import {
  BROWSER_DRIVERS,
  CLI_GUIDE,
  GEMINI_CLI_NOTE,
  PROVIDER_GUIDE,
  SETTINGS,
  type ProviderEntry,
} from './catalog.js';

/**
 * The guided setup, for somebody who has never heard of MCP.
 *
 * Three rules it holds to, because the audience cannot check the work:
 *
 * 1. **Nothing is installed, signed into, or charged without an explicit yes.**
 *    Every command that changes the machine is printed before it runs.
 * 2. **No claim without a date.** "Your plan covers this" is only said where
 *    the vendor documents it; everywhere else it says so.
 * 3. **The free path is offered first.** The cheapest useful setup is a
 *    subscription you already pay for plus no API key at all, and a wizard that
 *    walks somebody into four paid accounts before mentioning that is selling,
 *    not helping.
 */

type Answers = {
  clis: string[];
  providers: string[];
  keys: Record<string, string>;
  settings: Record<string, string>;
  browser: string | null;
};

const isWindows = platform() === 'win32';

/** Run a command the user has just agreed to, showing them what it prints. */
async function runVisible(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: 'inherit' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/** Open a URL in the user's browser, and never mind if we cannot. */
async function openUrl(url: string): Promise<void> {
  const cmd = isWindows ? `start "" "${url}"` : platform() === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  await new Promise<void>((resolve) => {
    const child = spawn(cmd, { shell: true, stdio: 'ignore' });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

/** Run a command as an argument list, with no shell between us and the process. */
async function runArgs(command: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: 'inherit' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/**
 * Write the real command to a file only the user can read.
 *
 * Printing it instead would put their API keys on screen and, the moment they
 * copy it, into their shell history. A 0600 file they can `source` or paste
 * from is the same convenience without that.
 */
async function saveCommand(answers: Answers): Promise<string> {
  const path = join(homedir(), '.dossier-setup-command.sh');
  const quoted = registrationArgs(answers).map((a) => `'${a.replaceAll("'", String.raw`'\''`)}'`);
  await writeFile(path, `#!/bin/sh\n# Registers Dossier. Contains your API keys; delete it when you are done.\nclaude ${quoted.join(' ')}\n`, { mode: 0o600 });
  return path;
}

function cancelled(value: unknown): boolean {
  if (p.isCancel(value)) {
    p.cancel('Stopped. Nothing was installed or changed.');
    return true;
  }
  return false;
}

/** Step 1: what is already here. Nobody should be asked to install what they have. */
async function reportExisting(): Promise<CliStatus[]> {
  const s = p.spinner();
  s.start('Looking at what you already have');
  const found = await probeAllClis(6_000);
  s.stop('Had a look');

  const ready = found.filter((c) => c.state === 'ready');
  const unauthed = found.filter((c) => c.state === 'present-unauthed');
  const ambiguous = found.filter((c) => c.state === 'ambiguous');

  const lines: string[] = [];
  for (const c of ready) lines.push(`✓ ${c.label}, installed and signed in`);
  for (const c of unauthed) lines.push(`• ${c.label}, installed, but not signed in yet`);
  for (const c of ambiguous) lines.push(`? ${c.label}, ${c.detail}`);
  if (lines.length === 0) lines.push('Nothing found yet. That is fine, we will sort it out.');

  p.note(lines.join('\n'), 'On this machine');
  return found;
}

/** Step 2: the tools whose subscriptions do research for free. */
async function chooseClis(found: readonly CliStatus[]): Promise<string[] | null> {
  p.note(
    [
      'These do the research using a subscription you may already pay for,',
      'rather than an API key that bills per run.',
      '',
      'Pick any you already subscribe to. You can pick none.',
    ].join('\n'),
    'Step 1 of 4, subscriptions you already have',
  );

  const options = CLI_GUIDE.map((c) => {
    const status = found.find((f) => f.id === c.id);
    const state =
      status?.state === 'ready' ? ' (installed, signed in)'
      : status?.state === 'present-unauthed' ? ' (installed, needs sign-in)'
      : '';
    const confidence = c.coverage === 'confirmed' ? '' : ' [coverage unconfirmed]';
    return { value: c.id, label: `${c.headline}${state}`, hint: `${c.subscriptions}${confidence}` };
  });

  const picked = await p.multiselect({
    message: 'Which of these do you have a subscription for?',
    options,
    required: false,
  });
  if (cancelled(picked)) return null;
  return picked as string[];
}

/** Install and sign in, one CLI at a time, asking before each. */
async function setUpClis(ids: readonly string[], found: readonly CliStatus[]): Promise<void> {
  for (const id of ids) {
    const guide = CLI_GUIDE.find((c) => c.id === id);
    const status = found.find((f) => f.id === id);
    if (!guide) continue;

    const facts = [
      `Plans: ${guide.subscriptions}`,
      guide.coverage === 'confirmed'
        ? `Coverage: ${guide.coverageNote}`
        : `Coverage: NOT CONFIRMED. ${guide.coverageNote}`,
      ...(guide.researchNote ? ['', guide.researchNote] : []),
      ...(guide.gotcha ? ['', `Worth knowing: ${guide.gotcha}`] : []),
    ];
    p.note(facts.join('\n'), guide.headline);

    if (status?.state !== 'ready' && status?.state !== 'present-unauthed') {
      const command = isWindows ? guide.installWindows : guide.install;
      if (!command) {
        p.log.warn(`No install command for ${guide.headline} on this platform. See ${guide.docs}`);
        continue;
      }
      const go = await p.confirm({ message: `Install it? This runs:  ${command}`, initialValue: true });
      if (cancelled(go)) return;
      if (go) {
        p.log.step(`Running: ${command}`);
        const ok = await runVisible(command);
        p.log[ok ? 'success' : 'error'](ok ? `${guide.headline} installed.` : `That did not work. Try it yourself: ${guide.docs}`);
      }
    }

    // Sign-in is always the human's own action, in their own browser. We never
    // automate a login and never handle a password.
    const signIn = await p.confirm({
      message: `Sign in to ${guide.headline} now? This opens "${guide.signIn}" and hands you the keyboard.`,
      initialValue: status?.state !== 'ready',
    });
    if (cancelled(signIn)) return;
    if (signIn) {
      p.log.step(`Starting ${guide.signIn}. Sign in, then quit it to come back here.`);
      await runVisible(guide.signIn);
    }
  }

  const after = await probeAllClis(6_000);
  const ready = after.filter((c) => ids.includes(c.id) && c.state === 'ready');
  const notReady = after.filter((c) => ids.includes(c.id) && c.state !== 'ready');
  p.note(
    [
      ...ready.map((c) => `✓ ${c.label}, ready`),
      ...notReady.map((c) => `• ${c.label}, ${c.detail}`),
    ].join('\n') || 'Nothing to confirm.',
    'Where those got to',
  );
}

/** Step 3: the money question, asked once and plainly. */
async function chooseProviders(): Promise<string[] | null> {
  const strategy = await p.select({
    message: 'How much do you want to spend on research?',
    options: [
      {
        value: 'one',
        label: 'One paid backend, plus whatever subscriptions you just set up',
        hint: 'recommended, cheapest useful setup',
      },
      { value: 'none', label: 'Nothing at all', hint: 'subscriptions and page-reading only; no API bill, ever' },
      { value: 'all', label: 'Every backend I can, for the widest coverage', hint: 'most expensive; each run bills separately' },
    ],
    initialValue: 'one',
  });
  if (cancelled(strategy)) return null;

  if (strategy === 'none') {
    p.note(
      [
        'Nothing will bill. You get the research loop your assistant drives with',
        'its own web search, the ability to bring in a report you ran on a',
        'subscription elsewhere, and every checking tool.',
        '',
        'The one thing you give up is a long investigation that runs unattended',
        'while your laptop is shut. That needs a paid backend.',
      ].join('\n'),
      'No API keys',
    );
    return [];
  }

  if (strategy === 'one') {
    p.note(
      [
        'Gemini is the one to pick if you are unsure.',
        '',
        PROVIDER_GUIDE[0]?.onlyThisOne ?? '',
        `Cost: ${PROVIDER_GUIDE[0]?.costPerRun ?? ''}.`,
      ].join('\n'),
      'Recommended',
    );
    const which = await p.select({
      message: 'Which one?',
      options: PROVIDER_GUIDE.map((g) => ({
        value: g.id,
        label: `${g.label}, ${g.costPerRun}`,
        hint: g.onlyThisOne,
      })),
      initialValue: 'gemini',
    });
    if (cancelled(which)) return null;
    return [which as string];
  }

  const picked = await p.multiselect({
    message: 'Which backends? Each one you add is a separate account and a separate bill.',
    options: PROVIDER_GUIDE.map((g) => ({
      value: g.id,
      label: `${g.label}, ${g.costPerRun}`,
      hint: g.onlyThisOne,
    })),
    initialValues: ['gemini'],
    required: false,
  });
  if (cancelled(picked)) return null;
  return picked as string[];
}

/** Walk one provider from "no account" to "key in hand". */
async function collectKey(guide: ProviderEntry, existing: string | undefined): Promise<string | null | undefined> {
  if (existing) {
    const keep = await p.confirm({
      message: `Found a ${guide.label} key already set. Use it?`,
      initialValue: true,
    });
    if (cancelled(keep)) return null;
    if (keep) return existing;
  }

  p.note(
    [
      guide.onlyThisOne,
      `Cost: ${guide.costPerRun}.`,
      '',
      'Before a key will work:',
      ...guide.beforeItWorks.map((s, i) => `  ${String(i + 1)}. ${s}`),
    ].join('\n'),
    guide.label,
  );

  const open = await p.confirm({ message: `Open ${guide.console} in your browser?`, initialValue: true });
  if (cancelled(open)) return null;
  if (open) await openUrl(guide.console);

  const key = await p.password({
    message: `Paste your ${guide.label} key (or leave empty to skip)`,
    validate: (v) => {
      if (!v) return undefined;
      if (!guide.looksRight(v)) return `That does not look like a ${guide.label} key. Check you copied all of it.`;
      return undefined;
    },
  });
  if (cancelled(key)) return null;
  const trimmed = String(key ?? '').trim();
  return trimmed || undefined;
}

/** Step 4: the settings that decide how much can go wrong. */
async function chooseSettings(): Promise<Record<string, string> | null> {
  const settings: Record<string, string> = {};
  for (const s of SETTINGS) {
    p.log.info(s.help);
    if (s.kind === 'boolean') {
      const v = await p.confirm({ message: s.question, initialValue: s.fallback === 'true' });
      if (cancelled(v)) return null;
      settings[s.env] = v ? 'true' : 'false';
    } else {
      const v = await p.text({
        message: s.question,
        initialValue: s.fallback,
        validate: (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? undefined : 'Needs to be a number above zero.'),
      });
      if (cancelled(v)) return null;
      settings[s.env] = String(v);
    }
  }
  return settings;
}

/** Optional: reading pages that need a login. Offered honestly. */
async function chooseBrowser(): Promise<string | null | undefined> {
  // Probed before the question, not after, so nobody is offered an install for
  // something already sitting on their disk. Offline, and it starts nothing:
  // presence on disk for the MCP servers, and no browser is touched at all.
  const present = new Set(
    (await probeAllBrowserTools()).filter((t) => t.state === 'present').map((t) => t.id),
  );
  const already = BROWSER_DRIVERS.filter((d) => d.detectAs && present.has(d.detectAs));

  p.note(
    [
      'Dossier reads public pages on its own, so you do not need anything extra',
      'for ordinary research.',
      '',
      'These only matter if you want it to read pages that need you to be logged',
      'in. They work by attaching to a browser you are already signed into.',
      '',
      'Dossier will never type a password. Signing in is always something you do',
      'yourself, once, by hand.',
      ...(already.length === 0
        ? []
        : [
            '',
            `Already on this machine: ${already.map((d) => d.id).join(', ')}.`,
            'Installed is not connected: you still choose it here, and Dossier still',
            'drives nothing unless DOSSIER_BROWSER_PROVIDER is set.',
          ]),
    ].join('\n'),
    'Optional, pages behind a login',
  );

  const want = await p.confirm({ message: 'Set one of these up?', initialValue: false });
  if (cancelled(want)) return null;
  if (!want) return undefined;

  const driver = await p.select({
    message: 'Which one?',
    options: BROWSER_DRIVERS.map((d) => ({
      value: d.id,
      label: d.label,
      hint: d.detectAs && present.has(d.detectAs) ? `already installed · ${d.note}` : d.note,
    })),
  });
  if (cancelled(driver)) return null;

  const chosen = BROWSER_DRIVERS.find((d) => d.id === driver);
  if (!chosen) return undefined;
  const go = await p.confirm({ message: `Run:  ${chosen.install}`, initialValue: true });
  if (cancelled(go)) return null;
  if (go) await runVisible(chosen.install);
  return chosen.id;
}

/** What this will cost, before anything is registered. */
function costSummary(answers: Answers): string {
  const lines: string[] = [];
  if (answers.clis.length > 0) {
    lines.push('Subscriptions you already pay for:');
    for (const id of answers.clis) {
      const g = CLI_GUIDE.find((c) => c.id === id);
      if (g) lines.push(`  ${g.headline}, no extra cost per run`);
    }
    lines.push('');
  }

  const paid = PROVIDER_GUIDE.filter((g) => answers.providers.includes(g.id) && answers.keys[g.envVar]);
  if (paid.length === 0) {
    lines.push('Paid backends: none. Nothing here can bill you.');
  } else {
    lines.push('Paid backends, per research run:');
    for (const g of paid) lines.push(`  ${g.label}, ${g.costPerRun}`);
    lines.push('');
    lines.push(`Daily ceiling across all of them: $${answers.settings['DOSSIER_BUDGET_USD'] ?? '100'}.`);
    lines.push('Runs reserve their worst case before starting, so the ceiling refuses early.');
    if (answers.settings['DOSSIER_REQUIRE_CONTRACT'] === 'true') {
      lines.push('You will be shown the price and asked before anything spends.');
    }
  }
  lines.push('');
  lines.push('These are estimate bands from the providers, not quotes.');
  return lines.join('\n');
}

/**
 * The registration, as an argument list.
 *
 * A list rather than a string, and run without a shell, because these arguments
 * carry API keys. A key is opaque text from a provider: it is not this code's
 * place to assume it contains nothing a shell would act on, and the cost of
 * being wrong is arbitrary command execution with the user's own credentials in
 * the argument.
 */
export function registrationArgs(answers: Answers): string[] {
  const env: string[] = [];
  for (const [k, v] of Object.entries(answers.keys)) if (v) env.push('-e', `${k}=${v}`);
  for (const [k, v] of Object.entries(answers.settings)) env.push('-e', `${k}=${v}`);
  if (answers.clis.length > 0) {
    // Naming the CLI pins which backends exist at all. Since 0.5.1 a signed-in
    // CLI is preferred automatically for jobs it can do, so this line is no
    // longer what makes it reachable; it is the operator's record of the set
    // they chose.
    env.push('-e', `DOSSIER_PROVIDERS=${[...answers.providers, 'local'].join(',')}`);
    // `DOSSIER_LOCAL_CLI` restricts the free lane to one CLI, so it is written
    // only when the operator picked exactly one. Writing the first of several
    // would silently narrow the lane to that one and leave the other
    // subscriptions they just told us about unused on every run, which is the
    // waste the panel exists to end.
    if (answers.clis.length === 1) env.push('-e', `DOSSIER_LOCAL_CLI=${answers.clis[0] ?? ''}`);
  }
  return ['mcp', 'add', 'dossier', '--scope', 'user', ...env, '--', 'npx', '-y', 'dossier-research-mcp@latest'];
}

/** The same command, safe to print: every secret replaced by its variable name. */
export function registrationDisplay(answers: Answers): string {
  const secret = new Set(Object.keys(answers.keys));
  const shown = registrationArgs(answers).map((a) => {
    const eq = a.indexOf('=');
    if (eq === -1) return a;
    const name = a.slice(0, eq);
    return secret.has(name) ? `${name}=<your ${name}>` : a;
  });
  return `claude ${shown.join(' ')}`;
}

export async function runWizard(): Promise<number> {
  // Some terminals report a width of zero: `script`, a few CI shells, the odd
  // multiplexer. Prompt rendering divides by that width, so zero draws one
  // character per line and the wizard is unusable rather than merely ugly.
  // Anyone hitting this is on SSH or an unusual terminal, which is exactly the
  // person least able to work out what went wrong.
  if (!process.stdout.columns || process.stdout.columns < 40) {
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  }

  p.intro('Dossier, research setup');
  p.log.message(
    [
      'This sets up proper research for your AI assistant.',
      '',
      'Nothing gets installed, signed into, or charged without you saying yes',
      'first, and every command is shown before it runs.',
    ].join('\n'),
  );

  const found = await reportExisting();

  const clis = await chooseClis(found);
  if (clis === null) return 1;
  if (clis.length > 0) await setUpClis(clis, found);
  else p.log.info(GEMINI_CLI_NOTE);

  const providers = await chooseProviders();
  if (providers === null) return 1;

  const keys: Record<string, string> = {};
  for (const id of providers) {
    const guide = PROVIDER_GUIDE.find((g) => g.id === id);
    if (!guide) continue;
    const key = await collectKey(guide, process.env[guide.envVar]);
    if (key === null) return 1;
    if (key) keys[guide.envVar] = key;
  }

  const settings = await chooseSettings();
  if (settings === null) return 1;

  // Per-provider ceilings, so one backend cannot eat the whole day's budget.
  for (const id of providers) {
    const guide = PROVIDER_GUIDE.find((g) => g.id === id);
    if (guide && keys[guide.envVar]) settings[guide.budgetEnv] = guide.suggestedCap;
  }

  const browser = await chooseBrowser();
  if (browser === null) return 1;

  const answers: Answers = { clis, providers, keys, settings, browser: browser ?? null };
  p.note(costSummary(answers), 'What this will cost');

  const register = await p.confirm({
    message: 'Register Dossier with Claude Code now?',
    initialValue: true,
  });
  if (cancelled(register)) return 1;

  if (register) {
    const ok = await runArgs('claude', registrationArgs(answers));
    if (ok) p.log.success('Registered. Restart Claude Code and ask it to research something.');
    else {
      p.log.error('That did not work. The command has been saved so you can run it yourself:');
      p.log.message(await saveCommand(answers));
    }
  } else {
    p.note(
      [registrationDisplay(answers), '', `Saved with your keys filled in: ${await saveCommand(answers)}`].join('\n'),
      'Run this when you are ready',
    );
  }

  p.outro(
    keys['GEMINI_API_KEY'] || Object.keys(keys).length > 0
      ? 'Done. Ask your assistant to research something, and it will show you the price first.'
      : 'Done. Nothing here can bill you. Ask your assistant to research something.',
  );
  return 0;
}
