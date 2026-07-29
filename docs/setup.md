# Setup

## The short way

```bash
npx -y dossier-research-mcp@latest setup
```

A guided setup that does everything on this page for you. It checks what is already installed, offers each coding CLI by the subscription that pays for it, signs you in, walks you through getting an API key only if you need one, sets the spend ceilings, and registers the server.

Three things it holds to, because it is talking to someone who cannot check the work: nothing is installed, signed into or charged without an explicit yes; every command is printed before it runs; and it never types a password, so signing in is always handed back to you.

Your keys go straight into the client's own config. If registration fails it writes the command to `~/.dossier-setup-command.sh` with owner-only permissions rather than printing your keys to the screen, where copying them would put them in your shell history.

The rest of this page is the same setup done by hand.


Everything needed to get Dossier running, from having nothing to a first research report. Already have a Gemini API key? Skip to [Install](#install).

### 1. Get a Gemini API key

Every Gemini API key belongs to a Google Cloud project. If you have never used Cloud, AI Studio makes one for you; if you have, you import an existing one.

1. Go to **[aistudio.google.com/apikey](https://aistudio.google.com/apikey)** and sign in.
2. Click **Create API key**. A brand-new account gets a default Cloud project made for it once you accept the terms; the key is created against that.
3. Copy the key. It is shown once.

Already a Cloud user and want a specific project? Open **Dashboard → [Projects](https://aistudio.google.com/projects) → Import projects**, pick it, then create the key from **API Keys**.

If **Create API key** is greyed out you lack permission on that project. You need a role covering `apikeys.keys.create` and `serviceusage.services.enable` (Project Editor covers it), or make a fresh project outside your organisation.

### 2. Decide free or paid

The free tier works and needs no card, but it has rate limits and, per Google, free-tier prompts and responses may be used to improve their products. Paid tier excludes that.

To go paid: on **[API keys](https://aistudio.google.com/api-keys)** or **[Projects](https://aistudio.google.com/projects)**, find the project and click **Set up billing** in the *Billing Tier* column. Expect a $10 minimum prepay.

> [!IMPORTANT]
> Deep Research is **not on the free tier** in any useful sense. A single run is $1-7 of metered spend, so a free-tier key will rate-limit or refuse rather than run. Budget for paid before you plan around this server.

### 3. Set a spend cap at Google's end

Do this before your first run, not after your first invoice.

| Where | What it does |
|---|---|
| **[aistudio.google.com/spend](https://aistudio.google.com/spend)** → *Monthly spend cap* → **Edit spend cap** | Per-project monthly cap. Marked experimental by Google. Needs editor, owner or admin on the project |
| **[Billing](https://aistudio.google.com/billing)** → *Manage auto-reload* → **Monthly Limit** | Prepay only. Stops auto top-ups for the cycle once reached |
| Automatic, per billing account | Tier 1 $250 · Tier 2 $2,000 · Tier 3 $20,000-$100,000. Hitting it pauses every project on that billing account until the next cycle |

Watch spend at **[Dashboard → Usage](https://aistudio.google.com/usage)**.

> [!CAUTION]
> **Google's cap is not hard, and Deep Research is the exact case where it leaks.** Their billing pipeline lags around ten minutes, and their own docs say long-running work "like batch mode and agents may incur overages beyond your project spend cap". A Deep Research run is a long-running agent.
>
> This is why Dossier keeps its own ceiling. It reserves the worst-case cost *before* the call is made rather than reconciling after, so it refuses early where Google's cap discovers the overage late. Use both: Google's as the backstop, `DOSSIER_BUDGET_USD` as the thing that actually stops a runaway agent.

### 4. Point the server at it

```bash
export GEMINI_API_KEY=your-key-here          # zsh: add to ~/.zshrc, then `source ~/.zshrc`
export DOSSIER_BUDGET_USD=100                # your daily ceiling. This is the default
claude mcp add dossier -e GEMINI_API_KEY=$GEMINI_API_KEY -- npx -y dossier-research-mcp
```

Check it took:

```
research_budget          # should report $0.00 of $100.00 committed
```

### Using Vertex AI instead

Only if compliance requires it. **Read the [Vertex trade-off](#auth) first**, because you lose corpus grounding, follow-ups, titles, summaries and claim extraction.

```bash
gcloud auth application-default login
gcloud config set project my-project
gcloud services enable aiplatform.googleapis.com
export VERTEX_PROJECT=my-project
export VERTEX_LOCATION=global
```

The account needs `aiplatform.interactions.create` (`roles/aiplatform.user` covers it). Vertex takes precedence if `GEMINI_API_KEY` is also set, and the server prints what you have lost at start-up.

---

---

## Install

<details open>
<summary><b>Claude Code</b></summary>

<br>

```bash
claude mcp add dossier -e GEMINI_API_KEY=your-key -- npx -y dossier-research-mcp
```

</details>

<details>
<summary><b>From source</b></summary>

<br>

```bash
git clone https://github.com/fledgeling-co/dossier-research-mcp.git
cd dossier-research-mcp && npm install && npm run build

# then point any MCP client at it
claude mcp add dossier -e GEMINI_API_KEY=your-key -- node "$PWD/dist/index.js"
```

</details>

<details>
<summary><b>Claude Desktop, or any <code>mcpServers</code> config</b></summary>

<br>

```json
{
  "mcpServers": {
    "dossier": {
      "command": "npx",
      "args": ["-y", "dossier-research-mcp"],
      "env": {
        "GEMINI_API_KEY": "your-key-here",
        "DOSSIER_BUDGET_USD": "25"
      }
    }
  }
}
```

</details>

<details>
<summary><b>HTTP transport</b> (remote or shared)</summary>

<br>

```bash
DOSSIER_HTTP_TOKENS=$(openssl rand -hex 32) \
  npx dossier-research-mcp --transport http --port 8787
```

Streamable HTTP on `/mcp`, SSE on `/sse`, health on `/health`. Bearer tokens are compared in constant time.

> [!WARNING]
> Bind to loopback unless you've set `DOSSIER_HTTP_TOKENS`. The server warns you on start-up if you haven't.

</details>

### Auth

Either backend works. **Vertex wins if you've set both.**

```bash
# A. Google AI Studio: https://aistudio.google.com/apikey
export GEMINI_API_KEY=...

# B. Vertex AI, via Application Default Credentials
export VERTEX_PROJECT=my-project
export VERTEX_LOCATION=global
gcloud auth application-default login
```

> [!IMPORTANT]
> **An API key is the fuller backend, not the lesser one.** Vertex adds enterprise controls (VPC-SC, CMEK, data residency, IAM) and loses capability, which is the opposite of what most people expect. On Vertex you don't get:
>
> - **Corpus grounding.** File Search stores are a Gemini Developer API feature.
> - **`research_followup`.** The Interactions API on Vertex serves agents and specialised media models, not the standard Gemini models a follow-up turn needs.
> - **AI titles, summaries and `research_claims`.** Same reason; they run on standard models.
>
> Deep Research runs and managed agents are expected to work there, but I haven't verified that against a live Vertex project. The server prints these limitations at start-up and lists them in `research://capabilities`, so pick Vertex when compliance requires it, not by default.

With no credentials the server still starts and every read-only tool works. You just can't start a run.

---

---

## Every environment variable

<details>
<summary><b>Every environment variable</b></summary>

<br>

Every value is Zod-validated once at start-up, so an invalid one fails fast with a readable message rather than surfacing as a mystery mid-run. An empty string counts as unset, because a committed `.env.example` key is very often present-but-empty.

**Credentials.** Set one of the two Gemini options. Vertex wins if you set both.

| Variable | Default | What it does |
|---|---|---|
| `GEMINI_API_KEY` | | Google AI Studio key. The full-capability backend |
| `GOOGLE_API_KEY` | | Accepted as an alias if `GEMINI_API_KEY` is unset |
| `VERTEX_PROJECT` | | GCP project id. Setting it switches to Vertex and **disables corpus grounding, follow-ups, titles, summaries and claim extraction** |
| `VERTEX_LOCATION` | `global` | Vertex region. Only read when `VERTEX_PROJECT` is set |

**Other backends.** Presence enables; nothing else is required. See [Providers](providers/README.md).

| Variable | Default | What it does |
|---|---|---|
| `PERPLEXITY_API_KEY` | | Enables Perplexity: enforced date and domain filters, and native wide research |
| `OPENAI_API_KEY` | | Enables OpenAI: a 100-domain filter and vector-store grounding |
| `XAI_API_KEY` | | Enables xAI, which is the only backend that reaches X |
| `DOSSIER_PROVIDERS` | | Explicit allow-list, comma separated. **Overrides detection in both directions**: a key present in your environment for some other tool should not silently become a place Dossier can spend money, and a backend named here joins even when the question profile would have left it out. Takes `gemini`, `perplexity`, `openai`, `xai`, an individual CLI as `local-claude`, `local-codex`, `local-agy`, `local-cursor`, `local-grok` or `local-gemini`, and `local` as an umbrella for every one of them |

**Spend control.** The reason this server exists in the shape it does.

| Variable | Default | What it does |
|---|---|---|
| `DOSSIER_BUDGET_USD` | `100` | Hard ceiling per rolling window, in USD. A run reserves its **worst-case** cost against this before the call is made, so the gate refuses early rather than discovering an overage. `0` disables it, which the budget tool then says out loud |
| `DOSSIER_BUDGET_WINDOW_HOURS` | `24` | The rolling window. With the default budget that is $100/day |
| `DOSSIER_BUDGET_USD_GEMINI` | `0` | Optional sub-ceiling for one backend, inside the global one. `0` means only the global ceiling applies. Evaluated under the same lock, so one backend cannot quietly consume the lot |
| `DOSSIER_BUDGET_USD_PERPLEXITY` | `0` | As above |
| `DOSSIER_BUDGET_USD_OPENAI` | `0` | As above |
| `DOSSIER_BUDGET_USD_XAI` | `0` | As above |
| `DOSSIER_MAX_CONCURRENT` | `10` | Runs in flight at once. Checked inside the same lock as the budget, so parallel calls cannot slip past it. This bounds concurrent **work**, not spend: the budget ceiling bounds spend, and a panel reserves its whole worst case before any member starts. A panel is now commonly three or four signed-in CLIs plus two or three API backends, and a panel wider than this cap is refused whole, so the default leaves headroom for that and still refuses a runaway |
| `DOSSIER_REQUIRE_CONTRACT` | `false` | Makes `research_plan` → `research_start` mandatory. **Turn this on for any server an autonomous agent can reach**: without the fingerprint from a plan, a looping agent makes free no-ops instead of $7 mistakes |
| `DOSSIER_DEDUPE_TTL_MINUTES` | `1440` | How long an identical request collapses onto the existing run instead of paying again. Set `0` to disable, which you almost never want |

**Runtime.**

| Variable | Default | What it does |
|---|---|---|
| `DOSSIER_STORE_DIR` | `~/.dossier-research-mcp` | Where runs, journals, reports and the ledger live. Point two servers at one directory and they share history but keep separate spend locks, so prefer one server per store |
| `DOSSIER_POLL_SECONDS` | `20` | How often in-flight runs are polled. Lower is more responsive and more API calls; polling itself is not billed, but there is no reason to go below ~10 |
| `DOSSIER_STALL_MINUTES` | `12` | Silence before a run is marked `stalled`. Raise it if you use `max` tier a lot, since a long synthesis phase is quiet by nature |
| `DOSSIER_UTILITY_MODEL` | `gemini-3.1-pro-preview` | The cheap model behind titles, summaries and claim extraction. See [The utility model](how-it-works.md#the-utility-model) |
| `DOSSIER_LOCAL_CORPUS_DIRS` | | Absolute directories `corpus_local_search` may read, colon or comma separated. Files are read and matched on this machine and never sent anywhere. **There is no tool that adds a directory**, deliberately: a file reader an agent can point anywhere is an exfiltration primitive, so the grant lives with you |
| `DOSSIER_LOCAL_CLI` | | Which CLIs the free lane may use, comma separated, **in preference order**: `claude`, `codex`, `agy`, `cursor`, `grok`, `gemini`. It orders as well as restricts, so `claude,grok,codex,cursor` runs the first two and leaves the rest as tie-breakers, while `claude,grok` runs those two with nothing held back. Unset, every capable signed-in CLI is offered. An unrecognised id fails startup rather than being ignored, because a typo that silently widens the lane spends quota nobody asked to spend. `research_doctor` shows what is installed, identified and signed in |
| `DOSSIER_FREE_LANE_MAX` | `2` | How many signed-in CLIs actually run. A second model is the cheapest check on an invented finding: a claim only one backend found is visibly weaker than one both found, and it costs nothing extra in dollars. A third mostly widens web coverage rather than verifying, since corroboration is counted in independent registrable domains and not in backends — and every CLI spends subscription quota Dossier cannot see or meter. The ones held back are named as tie-breakers rather than discarded, and the plan says which to reach for when the two disagree. `0` runs every signed-in CLI |
| `DOSSIER_LOCAL_MODEL_CLAUDE`<br>`DOSSIER_LOCAL_MODEL_CODEX`<br>`DOSSIER_LOCAL_MODEL_GROK`<br>`DOSSIER_LOCAL_MODEL_CURSOR` | | Which model that CLI should run. Unset, each uses its own default — which is not neutral: Cursor's is `composer-2.5`, a **coding** model. Cursor is a multiplexer, and `cursor-agent --list-models` on your account will name others, such as `cursor-grok-4.5-high` or `claude-opus-5-thinking-high`. Two members set to the same model still both run, because a different harness reads different parts of the web, but the panel says their agreement is one voice repeated rather than two concurring |
| `DOSSIER_CONCURRENCY_OPENAI` | `1` | Runs in flight on one backend. Separate from `DOSSIER_MAX_CONCURRENT` because a backend's real limit is not always a slot count: OpenAI deep research accumulates context as it searches and is metered in tokens per minute against the whole account, so two runs contend for one budget and the second kills the first. Raise it if your account's TPM allows — the error names the numbers, and a run's own diagnosis works out how many that budget supports. `0` disables the cap |
| `DOSSIER_BROWSER_PROVIDER` | | The browser driver **you** will drive: `chrome-devtools-mcp`, `playwright-mcp`, `playwright-cli` or `browser-use`. It selects; it does not activate. Dossier still drives no browser — detection is not permission — but a crawl recommendation stops saying "use browser tooling" and starts naming your tool and how it reaches the session you are already logged into. Four places advertised this before it was declared, so setting it did nothing at all; `research_doctor` lists which drivers are on this machine |
| `DOSSIER_SPAWNED_BY` | | **Set by Dossier, never by you.** Dossier puts it in the environment of every CLI it spawns, so a Dossier that CLI then launches inherits it and stamps every run it starts. That is how a run authored by a panel member is told apart from one you asked for: such a run is charged to your budget and would otherwise be counted as an independent voice. Setting it by hand marks your own runs as derivative and excludes them from corroboration |
| `DOSSIER_CONCURRENCY_GEMINI`<br>`DOSSIER_CONCURRENCY_PERPLEXITY`<br>`DOSSIER_CONCURRENCY_XAI` | `0` | The same cap for the other paid backends. Off by default: none of them has shown the account-wide contention that OpenAI does |

**HTTP transport.** Only read with `--transport http`.

| Variable | Default | What it does |
|---|---|---|
| `DOSSIER_HTTP_PORT` | `8787` | Port to listen on |
| `DOSSIER_HTTP_TOKENS` | | Comma-separated bearer tokens. Compared in constant time, and the `Bearer` scheme is required. **Minimum 24 characters**: this guards a surface that spends money, and comparing a short token in constant time does not make it harder to guess. `openssl rand -base64 32` |
| `DOSSIER_HTTP_ALLOW_ANONYMOUS` | `false` | Required to start an HTTP listener with no tokens. Without it the server exits rather than serving a money-spending tool surface to anything that can reach the port |

**Testing.**

| Variable | Default | What it does |
|---|---|---|
| `DOSSIER_HERMETIC` | `false` | Refuses to construct a live client at all, so no call can reach the network. Set by `vitest.config.ts`; you should not need it by hand |
| `DOSSIER_PAID_TESTS` | `false` | Opt in to the paid test project. Needs a real key too |
| `DOSSIER_PAID_MAX` | `false` | Additionally run the `max`-tier paid case, which is $3-7 on its own |

</details>

---
