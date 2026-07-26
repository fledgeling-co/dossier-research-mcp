# Browser sessions

> [!WARNING]
> **Status: shipped as a prompt, not as automation.** Dossier is a stdio MCP server with no browser of its own, and every driver that can reach a signed-in Google session is a capability of your *client* rather than something this server can invoke. So the portable form of this feature is method: the `gemini-web-session` prompt hands over the brief, the controls, the failure states and the terms-of-service position, and `research_import` takes the result back. That also puts the decision where it belongs, since the exposure of automating a disallowed path is your Google account rather than an error message.

Everything else in this folder costs money per run. This page is about the path that doesn't: using a subscription you already pay for, by driving the web app in a browser you're already signed into.

It's the most-requested capability and the one with the most caveats. Both get stated here at the same size.

---

## Why bother

Three things only a browser can do:

1. **Spend a subscription instead of an API balance.** A Google AI Pro plan includes Deep Research. The API bills separately. If you're already paying for one, paying twice is annoying.
2. **Reach content behind your own login.** A journal you subscribe to, an internal wiki, a paywalled report. No research API can see these.
3. **Use a web-only feature.** Some things simply have no API surface.

---

## Two modes, and the safe one is the default

> [!IMPORTANT]
> **`gemini.google.com/robots.txt` disallows `/app/` and `/chat/`.** Google's Terms of Service prohibit "using automated means to access content from any of our services" where that violates machine-readable instructions on Google's pages, and the clause names robots.txt as its example. The Gemini web app lives at `/app`. Driving that UI with an agent is, on a plain reading, the thing that clause describes, and the exposure is account suspension rather than a policy footnote.
>
> The counterweight, honestly: robots.txt is a crawler convention, and an agent acting inside your own signed-in session at your direction is arguably not crawling. Google has published no carve-out either way and there's no enforcement precedent I could find. It's untested, not settled.
>
> That's your call to make, so it's on this page rather than in a footnote.

**`/share/` is not disallowed.** That single fact shapes the whole design.

### Mode A: share-link import (default, no automation)

```
1. Ask Dossier to compile the brief          research_plan(question: "...")
2. Paste it into Gemini yourself, run it
3. When it finishes: Share & export → Share Canvas → copy link
4. Hand the link back                        research_import(url: "https://gemini.google.com/share/...")
5. Dossier normalises, stores, and verifies every citation
```

Dossier does the parts it's good at: compiling a properly scaffolded brief, normalising the result into the same format as every other run, verifying that every cited URL resolves, storing it durably, and making it greppable by section. You do about ten seconds of clicking.

This touches no disallowed path, needs no browser automation, and cannot break when Google renames a button. It is also, unglamorously, **more reliable than Mode B will ever be**.

### Mode B: full drive (opt-in, off by default)

```bash
DOSSIER_BROWSER_PROVIDER=1
DOSSIER_BROWSER_DRIVER=claude-in-chrome   # or chrome-devtools-mcp, playwright
```

Dossier attaches to a browser you're already signed into and drives the whole flow. Slower, brittler, and carries the risk above. Available because some people want it, having read this far.

---

## Picking a driver

The only property that matters: can it reach a page behind your existing Google login, without anyone typing a password into an agent?

| Driver | Existing login | Setup |
|---|---|---|
| **Claude in Chrome** | ✅ by default | Install extension, `claude --chrome` |
| **chrome-devtools-mcp** `--autoConnect` | ✅ Chrome 144+ | Approve once at `chrome://inspect/#remote-debugging` |
| **Playwright MCP** `--extension` | ✅ | Install the Playwright extension, pick the tab |
| **chrome-devtools-mcp** default | ❌ | Fresh profile; your logins aren't in it |
| **agent-browser** | ❌ | Own profile; persist with `state save` |
| **Safari MCP** (Apple) | ❌ | Automation windows are isolated from your session |

> [!CAUTION]
> **The isolated-profile options don't just inconvenience you with Google, they fail.** Google actively blocks sign-in from browsers flagged as automated, which is the stated reason `--autoConnect` exists. Logging in manually inside an automation window will most likely fail too. For Google-authenticated work, use one of the top three.

```bash
# Claude in Chrome
claude --chrome

# chrome-devtools-mcp, attached to your signed-in Chrome
claude mcp add chrome-devtools --scope user -- npx chrome-devtools-mcp@latest --autoConnect

# Playwright MCP, attached via extension
claude mcp add playwright -- npx @playwright/mcp@latest --extension
```

Apple's Safari MCP is real and official: a `--mcp` flag on `safaridriver`, 17 tools, announced on the WebKit blog on 1 July 2026, shipping in Safari 27 beta and Safari Technology Preview 247+. It's a fine web-developer tool and the wrong tool for this job, because its automation windows are isolated from your normal browsing with no access to session state. Useful for general local research; not for spending your subscription.

> [!WARNING]
> **Dossier will never type a password.** Sign-in is always a manual, one-time, human action, and Dossier attaches to a session that already exists. This is a hard rule in the design, not a preference.

---

## What Dossier can see, and what that does not mean

`research_doctor` reports which of these tools are on your machine, and the setup wizard stops offering you an install for one you already have. Both come from the same probe, in `src/local/browser.ts`.

**Detection is not permission.** Finding a driver changes nothing about what runs. Mode B stays behind `DOSSIER_BROWSER_PROVIDER`, every reported entry says so, and no probe starts a browser, attaches to one, or moves a run any closer to being automated.

The four tools get two different probes, because they are two different kinds of thing.

| Tool | Probe | Why that one |
|---|---|---|
| **playwright** | binary on `PATH` | A real executable. Resolve the absolute path, `realpath` it, ask `--version`, and confirm identity by the version string or by npm-namespace provenance in the resolved directory. Unidentified means `ambiguous`, never a guess |
| **browser-use** | binary on `PATH` | Same, with a longer timeout, because a Python console script pays import cost before it can answer. A timeout reports `ambiguous` and runs nothing further |
| **chrome-devtools-mcp** | package on disk | Presence only |
| **@playwright/mcp** | package on disk | Presence only |

Two rules make the package probe look weaker than it could be, and both are deliberate.

**`npx` is never invoked.** `npx chrome-devtools-mcp@latest --version` on a machine that does not have the package downloads it from the registry and executes it. A detector that fetches and runs third-party code to find out whether that code is present has answered its own question by making it true. So presence is established by looking for the package directory where npm would have put it, and that directory is never opened.

**Your client's MCP config is never read.** Whether a server is actually wired into Claude Code, Cursor or VS Code lives in that client's own configuration file, next to every other server's `env` block, and those blocks routinely hold API keys. Reading them to answer a cosmetic question would mean reading your other tools' credentials. So registration is reported `unknown`, permanently, and you are pointed at your client to check.

**Nothing reports whether you are signed in.** A coding CLI keeps a sign-in file of its own, so `src/local/cli.ts` can check that one exists without opening it. A browser driver has no equivalent: the session that matters belongs to Chrome, and finding it would mean walking a browser profile and its cookie store. The "Existing login" column in the table above is a documented property of each driver, not something measured on your machine.

---

## The Gemini flow, as verified

For anyone implementing or debugging Mode B. Controls read directly off the live DOM:

| Control | Accessible name | Type |
|---|---|---|
| Prompt input | `Enter a prompt for Gemini` | `textbox` |
| Tools menu | `Upload & tools` | `button` |
| Deep Research toggle | `Deep research` | **`menuitemcheckbox`** |
| Model picker | `Open mode picker, currently <name>` | `button` |
| Model options | `3.6 Flash All-around help`, `3.1 Pro Advanced math & code` | `menuitem` |

And the sequence, from Google's support documentation:

```
open gemini.google.com  →  tools menu  →  Deep research
   →  (optional) Sources: Gmail, Drive, uploaded files, NotebookLM
   →  type prompt  →  Submit
   →  research plan appears
   →  [Edit plan] to revise, or [Start research] to approve
   →  ~5-10 minutes
   →  [Open]  →  report is in the Canvas panel on the right
   →  Share & export → Share Canvas / Export to Docs / Copy Contents
```

Two traps worth knowing:

- **Deep Research is a checkbox, not a button.** Read its state before clicking. Clicking a checked box turns it off, and a run without it looks superficially normal and produces a completely different artefact.
- **The parent button's label keeps changing.** Google's own docs still call it "Add Files", a third-party walkthrough describes a globe icon, the live DOM says "Upload & tools". The `menuitemcheckbox "Deep research"` child has been stable throughout. Anchor on the child, resolve the parent by role.

Also note: **Google Search is a source by default** and must be deselected if you want to exclude it, and the report lands in the **Canvas panel**, not the chat, so extraction has to target Canvas.

> [!NOTE]
> The steps from plan approval onward are documented rather than tested here. I mapped the controls against the live signed-out DOM and cross-checked the flow against Google's support docs, but I did not sign in to anyone's account to verify it end to end. Treat it as a specification to confirm, not a description of proven behaviour.

---

## Limits and states you'll actually hit

Two are documented product states, not bugs, and code that doesn't distinguish them will report a broken locator instead of the truth.

**Workspace admins can turn the Gemini app off entirely.** Admin console → Generative AI → Gemini app → Service status, scoped by organisational unit or group, up to 24 hours to propagate. On additional-service editions it's off until an admin enables it.

**Free accounts can find Deep Research unavailable during high demand.**

Beyond that, the tiers differ in shape, not just size:

| Account | Deep Research allowance |
|---|---|
| Personal (all plans) | Compute-based since 17 May 2026: refreshes every 5 hours against a weekly cap. Deep Research draws it down faster than normal chat. **No per-run number is published** |
| Workspace additional-service | 5 reports / month |
| Workspace core standard | 20 reports / day |
| Workspace core Pro | 30 reports / day, Pro model metered per **4 hours** |
| Workspace AI Expanded | 120 reports / day |

Any specific free-tier number you see quoted elsewhere is third-party; Google doesn't publish one.

Model access also differs. All users can run Deep Research with **Thinking**; Google AI Pro and Ultra add **Pro**. Business accounts see different naming again, which is why model selection must match on tier prefix and **fail loudly** rather than silently proceeding. A forty-minute investigation that quietly ran on the wrong model is a bad failure.

**Share links on Workspace accounts** are unavailable unless an admin has opted in (that setting arrived in March 2026 and is off by default). So Mode A may simply not be available on a work account.

---

## One more thing worth avoiding

Google's Terms also prohibit using AI-generated output from their services to develop machine learning models or related AI technology. If Deep Research output would feed model training or evaluation, that's a separate and independent problem from the robots.txt question, and no amount of care about *how* you fetched it helps.

---

**Next:** [Using subscriptions](subscriptions.md) · [The plan](../plan/multi-provider-research.md#8b-browser-sessions) · [Security](../security.md)
