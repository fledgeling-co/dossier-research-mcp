# Using subscriptions you already pay for

> [!WARNING]
> **Status: mostly shipped.** The CLI path is implemented: `research_doctor` identifies and verifies the coding CLIs on your machine, and `provider: "local"` runs one as a research backend with no API bill. The share-link path is implemented as `research_import` plus the `gemini-web-session` prompt. What is **not** built is browser automation of the Gemini web app; see [browser sessions](browser-sessions.md) for why that is a prompt rather than a feature.

Most people reading this already pay for at least one AI subscription. This page is about getting research out of those, instead of setting up a second billing relationship for the same work.

> [!IMPORTANT]
> **Subscriptions and API keys are almost always separate products.** ChatGPT Plus does not include OpenAI API credits. Perplexity Pro does not include Perplexity API credits. X Premium+ does not include xAI API credits. This surprises people constantly and it is worth checking before you assume you're covered.
>
> Verified July 2026. Subscription terms move faster than anything else on this site; treat every claim here as dated rather than permanent.

---

## The short version

| What you pay for | Gets you research | How |
|---|---|---|
| **Claude Pro / Max / Team** | ✅ yes | Bundled **`/deep-research`**, plus web search driving Dossier's local loop |
| **ChatGPT Plus / Pro** | ✅ yes | Codex CLI signs in with ChatGPT; web search on by default |
| **Google AI Pro / Ultra** | ✅ yes | Deep Research in the web app via share link; **`agy` CLI** on a 5-hourly quota |
| **Google account (free)** | ✅ yes | **`agy` CLI** on a weekly quota, including Claude Sonnet and Opus 4.6 at $0 |
| **Cursor** | ✅ yes | Cursor CLI (`agent`) runs on your plan pools |
| **X Premium+ / SuperGrok** | ⚠️ maybe | Grok Build CLI's browser login, **unconfirmed by xAI**. The REST API is credits-only |
| **Perplexity Pro** | ❌ no | API access is a separate purchase |

---

## Claude Pro, Max, Team or Enterprise

The cleanest path, because Claude Code is where most people are already running Dossier.

Claude Code usage on a subscription draws from a per-seat allowance on a rolling five-hour window plus a weekly window, shared with Claude chat. No API key, no per-token billing.

That matters more than it sounds, because of what the benchmarks say about agent loops. On AIMultiple's April 2026 evaluation, **Claude Code driving plain web search scored 97.0%**, tying the best purpose-built deep-research API and beating every other one, at $1.54 of equivalent API cost and the fastest time per task.

So Dossier's local agent loop, running inside a Claude Code session you're already paying for, is not a downgrade. On factual multi-hop questions it is the strong option.

```bash
# No research API key needed. Dossier orchestrates; Claude Code does the searching.
claude mcp add dossier -- npx -y dossier-research-mcp
```

Then ask for research as normal. With no provider keys present, Dossier routes to the local loop and says so.

### There is also a bundled `/deep-research`

Worth knowing before you reach for a paid API, because it overlaps with what Dossier does and it costs nothing extra. Claude Code ships a built-in workflow that, in their own words:

> Fans out web searches on a question across several angles, fetches and cross-checks the sources it finds, votes on each claim, and returns a cited report with claims that didn't survive cross-checking filtered out.

Requires Claude Code v2.1.154 or later, available on all paid plans, and **on Pro you have to turn on Dynamic workflows in `/config`** first. Caps are 16 concurrent agents and 1,000 agents per run. Since v2.1.196, a claim the verifiers couldn't check is reported as *unverified* rather than counted as refuted, which is the right call and a distinction most tools don't make.

Use `/deep-research` when the question is self-contained and you want an answer now. Use Dossier when you want the run to survive a restart, the spend to be gated across providers, the report stored and greppable by section, the citations dereferenced, or a second provider's answer to compare against.

### The billing trap worth knowing

> [!WARNING]
> **`ANTHROPIC_API_KEY` in your environment outranks your subscription.** In non-interactive mode (`claude -p`) it's used unconditionally with no prompt. If it's exported in your shell, every call bills per token instead of drawing your plan allowance, silently. Check with `/status`.

Check what you have left with `/usage`. Long research runs are context-heavy, so `/clear` between unrelated investigations is worth the habit. Note also that cache lifetime is an hour on a subscription and drops to five minutes on API-key auth, which is a real cost difference on a long session.

---

## ChatGPT Plus or Pro

**Codex CLI signs in with your ChatGPT account** rather than an API key. On first run you choose "Sign in with ChatGPT".

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
cd your-project
codex                 # choose "Sign in with ChatGPT"
codex --search        # switch a run to live web search
```

Codex has web search (`codex --search`) and can connect MCP servers (`codex mcp`), so it can run Dossier's local loop the same way Claude Code does. It scored 93.9% at the lowest cost of any tool on the April 2026 bench, so this is a genuinely good path.

> [!NOTE]
> **Unconfirmed:** which subscription tiers qualify for Codex CLI, and what the usage limits are on ChatGPT auth versus an API key. OpenAI's CLI docs point at separate auth and pricing pages for both and don't state it inline. Check before relying on it for volume.

Two things a ChatGPT subscription does **not** get you. There is **no deep-research mode in Codex CLI** on any auth path, and OpenAI staff have declined to add one. And the API route to it changed anyway: the dedicated deep-research models reached end of access on **23 July 2026**, replaced by `gpt-5.6-sol`, which is API-key-billed.

ChatGPT's own Deep Research feature *is* included in your plan, and generously:

| Plan | Deep Research queries |
|---|---|
| Free | **5 / month** |
| Plus, Team, Enterprise, Edu | **25 / month** |
| Pro | **250 / month** |

Exhaust the full version and queries automatically fall back to a lightweight o4-mini-powered version rather than stopping. Allowances reset 30 days from first use.

It lives in the web app, so it's the same share-and-import pattern as Gemini rather than something Dossier calls directly. But the product genuinely beats the API here: it shows you an **editable research plan before spending**, lets you **interrupt mid-run** to change focus or sources, supports **domain restriction**, connects to authenticated sources like FactSet and PitchBook, and exports to Markdown, Word and PDF. Since February 2026 it can also connect to **any MCP server**, so Dossier can serve it as a source directly.

---

## Google AI Pro or Ultra

Your subscription includes Deep Research in the Gemini web app, with the Pro model on Pro and Ultra plans. The API bills separately.

The supported path is share-link import: you run it, Dossier imports it.

```
1. research_plan(question: "...")     Dossier compiles a proper brief
2. Paste into gemini.google.com, toggle Deep research, submit
3. Approve the research plan (or edit it first)
4. Share & export → Share Canvas → copy the link
5. research_import(url: "...")        Dossier normalises, stores, verifies citations
```

This is deliberately not full browser automation, and [browser-sessions.md](browser-sessions.md) explains why in detail. The short version: `gemini.google.com/robots.txt` disallows `/app/`, Google's terms name robots.txt explicitly, and `/share/` is not disallowed. The human-clicks pattern avoids the question entirely and happens to be more reliable.

Allowances differ by account type, and business accounts differ in shape rather than just size:

| Account | Deep Research |
|---|---|
| Personal, any plan | Compute-based since 17 May 2026: refreshes every 5 hours against a weekly cap. **No per-run figure is published** |
| Workspace additional-service | 5 reports / month |
| Workspace core standard | 20 reports / day |
| Workspace core Pro | 30 reports / day |
| Workspace AI Expanded | 120 reports / day |

Two things that will look like bugs and aren't. **Workspace admins can turn the Gemini app off**, and on additional-service editions it's off until they turn it on. **Free accounts can find Deep Research unavailable during high demand.** Also, Workspace accounts can't create public share links unless an admin has opted in, which arrived in March 2026 and is off by default, so the import path may simply be unavailable on a work account.

---

## Gemini CLI: consumer access was withdrawn

> [!CAUTION]
> **As of 18 June 2026, Gemini CLI no longer works with "Login with Google".** Google's deprecation notice states that Gemini Code Assist IDE extensions "stopped serving requests for the Gemini Code Assist for individuals, Google AI Pro, and Google AI Ultra tiers", and that this "also applies to usage of Gemini CLI". Affected users are pointed at Antigravity.
>
> **The `google-gemini/gemini-cli` README is stale** and still advertises the old 60-requests-per-minute, 1,000-per-day OAuth free tier. The Google Cloud deprecation page is authoritative.

What still works:

| Path | Status |
|---|---|
| Gemini Code Assist **Standard / Enterprise** seat | ✅ unchanged |
| `GEMINI_API_KEY` | ✅ but that's API billing, not a subscription |
| Vertex AI | ✅ enterprise billing |
| "Login with Google" on a personal, Pro or Ultra account | ❌ withdrawn |

So if you want a free Google-account CLI in 2026, the answer is **`agy`**, not `gemini`. That's not a workaround, it's Google's own stated migration path.

Gemini CLI never exposed Deep Research anyway; it was a coding and reasoning agent with Google Search grounding.

---

## Antigravity and the `agy` CLI

Google's Antigravity ships a CLI called **`agy`**, and it's the most interesting subscription path here, because the quota is tied to your Google AI plan and **there is a working tier with no subscription at all**.

```bash
# macOS / Linux, installs to ~/.local/bin/agy
curl -fsSL https://antigravity.google/cli/install.sh | bash

# Windows (PowerShell)
irm https://antigravity.google/cli/install.ps1 | iex
```

Then just run `agy`. Authentication is **account sign-in only**: it checks your OS keyring first (Apple Keychain, Linux Secret Service, Windows Credential Manager) and signs in silently if a token is there, otherwise it opens a browser. Over SSH it detects it can't open a browser and falls back to printing an authorisation URL for you to complete locally and paste a code back.

There is no documented API-key or Vertex path, and bring-your-own-key is explicitly not supported. This is a subscription product, not a metered one.

### The tiers

| Your Google AI plan | Quota |
|---|---|
| **Ultra** | Highest quota, refreshed **every 5 hours**, highest weekly rate limits |
| **Pro** | High quota, refreshed **every 5 hours** until the weekly limit, plus a flexible AI credit pool |
| **Free, $0/month** | "Basic weekly rate limits", unlimited tab completions and command requests |

> [!TIP]
> **The free tier's model list is the surprising part.** Verbatim from Google's pricing page: "Agent model: access to Gemini 3.5 Flash, Gemini 3.1 Pro, Gemini 3 Flash, **Claude Sonnet & Opus 4.6**, gpt-oss-120b."
>
> Third-party models are not gated behind a paid plan. What Pro and Ultra buy is throughput, not model selection. A free Google account gets Claude Opus as an agent model, which makes this the strongest zero-cost host for Dossier's local loop by a distance.

Every tier gets all product features **including the CLI and Scheduled Tasks**. Google publishes no numeric quotas and notes limits scale with how much work the agent actually does rather than how many prompts you send, so a simple task stretches much further than a complex one. Bring-your-own-key is explicitly unsupported on consumer plans; consumption-based pricing exists only via the Organization plan on Google Cloud.

Past the baseline, Pro and Ultra users can buy AI credits for overage at Gemini Enterprise Agent Platform consumption pricing. That's off unless you turn it on:

```json
// ~/.gemini/antigravity-cli/settings.json
{ "useG1Credits": true }
```

Or via `/config` → "Use G1 Credits". Leave it off if you want a hard stop at your plan quota rather than a fallback to billing. `/credits`, `/usage` and `/quota` show where you stand, and the statusline carries a running credit count.

### Adding Dossier

Both the Antigravity IDE and the `agy` CLI read the same MCP config files:

| Scope | Path |
|---|---|
| Global | `~/.gemini/config/mcp_config.json` |
| Workspace | `.agents/mcp_config.json` |

```json
{
  "mcpServers": {
    "dossier": {
      "command": "npx",
      "args": ["-y", "dossier-research-mcp"],
      "env": { "GEMINI_API_KEY": "optional-only-if-you-want-the-api-path" }
    }
  }
}
```

There is no `agy mcp add` command. Edit the file, or run `/mcp` in the prompt panel to open the MCP Manager overlay, which shows connection status and live logs and can reload configs.

> [!IMPORTANT]
> For a remote MCP server the key is **`serverUrl`**, not `url` or `httpUrl`. Those older key names are documented as unsupported and will fail silently if you carry a config over from another tool.

Unconfigured MCP tools default to "Ask" mode, so you approve each call until you set a policy. Patterns are `mcp(server/tool)`, `mcp(server/*)` and `mcp(*)`.

### What this gets you

`agy` is a general coding and reasoning agent, not a deep-research product; there's no Deep Research mode in it. What it is, for our purposes, is a **capable host for Dossier's local agent loop that a free Google account can run**. Given that a CLI agent with plain web search tied the best hosted deep-research system on the April 2026 benchmark, that's a genuinely good free path rather than a token one.

---

## Grok Build (xAI)

xAI's official CLI is **Grok Build**, and the binary is `grok`.

```bash
curl -fsSL https://x.ai/cli/install.sh | bash    # → ~/.grok/bin
irm https://x.ai/cli/install.ps1 | iex           # Windows
```

**It opens a browser on first launch.** xAI's docs describe the API key as the fallback "for non-browser environments":

```bash
export XAI_API_KEY="xai-..."    # CI, automation, headless
```

Credentials land in `~/.grok/auth.json`. Default model is `grok-4.5`; the coding model is `grok-build-0.1` (256k context). MCP support is first-class (`grok mcp add|list|remove|doctor`), and it reads `~/.claude.json` and `~/.cursor/mcp.json` for compatibility, so a Dossier entry you already have elsewhere may just work.

```bash
grok mcp add dossier -- npx -y dossier-research-mcp
```

> [!IMPORTANT]
> **The raw xAI REST API is credits-only.** X Premium and Premium+ give "higher limits on Grok" in the apps, not API access, and xAI's billing FAQ says web and app payments "are not affected" by API billing. So `XAI_API_KEY` always means prepaid credits.
>
> **The browser-OAuth CLI path is a different question, and xAI's own docs don't answer it.** Two third-party integrations that use the same OAuth flow state that a Grok or X Premium plan including Grok API access works without a separate key. That's corroboration, not confirmation. Check your own account before relying on it.

Two collisions worth knowing: xAI's installer puts a binary named **`agent`** on your PATH alongside `grok`, and Cursor's installer also provides `agent`. A third-party npm package (`grok-dev`, formerly `@vibe-kit/grok-cli`) claims the name `grok` and is explicitly **not** affiliated with xAI; it needs its own `GROK_API_KEY`. PATH order decides which you get.

## Cursor CLI

```bash
curl https://cursor.com/install -fsS | bash                  # → ~/.local/bin
irm 'https://cursor.com/install?win32=true' | iex            # Windows
```

The binary is **`agent`**, not `cursor-agent`. Add `~/.local/bin` to your PATH, then `agent --version` to verify.

**This one is clear-cut.** Cursor's own launch post states: "The CLI works with any model as part of your Cursor subscription." Usage draws the same plan pools as the editor, and `/usage` shows your meters and cycle reset.

Auth is `agent login` (browser; `NO_OPEN_BROWSER=1` prints the URL instead), or `CURSOR_API_KEY`. MCP uses the same `mcp.json` as the editor, with `agent mcp list|list-tools|enable|disable`.

Headless works properly, which makes it a decent host for scripted research:

```bash
agent -p "..." --output-format json --force
```

`--force` is required for the agent to write files in print mode.

---

## Perplexity Pro: the exception worth stating twice

Perplexity Pro is a good product and it does **not** include API access. Every documented configuration path for the official Perplexity MCP server sets `PERPLEXITY_API_KEY`, and the setup walkthrough starts by sending you to `console.perplexity.ai` to generate one. There is no subscription-authenticated path.

If you want Perplexity's deep research through Dossier or through their own MCP server, you're buying API credits on top of Pro. See [perplexity.md](perplexity.md).

---

## What this adds up to

You can run Dossier usefully for **zero additional spend**, in more than one way:

- **Nothing at all**: the local agent loop over whatever web search your session already has, hosted by `agy` or Gemini CLI on a free Google account.
- **A Claude, ChatGPT, or Google subscription**: the same loop, running on capacity you already bought.
- **Google AI Pro or Ultra**: real Gemini Deep Research, imported by share link, with Dossier doing the brief-writing, storage and citation verification around it.

Add a paid API key when you hit something those can't do: a date range, an allow-list, an X search, or an enumerated list with a source per row. The [provider index](README.md) says which is which.

---

**Next:** [Browser sessions](browser-sessions.md) · [Perplexity](perplexity.md) · [The plan](../plan/multi-provider-research.md#8d-cli-agents-and-subscriptions)
