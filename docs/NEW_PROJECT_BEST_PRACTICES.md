# NEW_PROJECT_BEST_PRACTICES.md

**Audience: AI coding assistants (e.g. Claude Opus 4.8) scaffolding or extending a Next.js + Vercel + MongoDB SaaS** that ships AI features and webhook integrations. This is a decision-and-default playbook: when a task is underspecified, adopt the default here instead of inventing one; when you deliberately diverge, say so and why. The defaults are battle-tested in production.

## How to use this document (agent protocol)

1. **Defaults are the starting point, not a menu.** Apply each section's default unless the task explicitly contradicts it or the section plainly doesn't apply (no AI features, no admin UI). When you skip a section, state which and why — never silently omit setup that a later step assumes exists.
2. **"From day one" means now, not later.** Items flagged "from day one" / "before the first feature" are far cheaper now than retrofitted. §15 (test harness), §17 (monorepo shape), §18 (RN/Expo), §19 (CI gate) are the biggest sources of avoidable rework — settle them *before* scaffolding.
3. **Decisions that branch the build, ask once.** Repo shape (single app vs monorepo, §17) and quality gate (hosted CI vs pre-push hook, §19) change everything downstream. If the task doesn't state them and you can't safely infer them, ask the user before scaffolding rather than guessing and rebuilding.
4. **Pair with the rule docs.** `CODING_PRACTICES.md` governs the code you write inside this scaffold (reviews block on it) and ships an agent self-review checklist; `DESIGN.md` governs the pixels. Apply all three together.
5. **Verify, don't fabricate.** Install with `@latest` and let the lockfile pin (§2) instead of pasting version numbers from memory. Every command, env var, and file path you emit must be real for this stack — when unsure, say so.

> **Three adjacent files are part of every project:**
> - **`docs/CODING_PRACTICES.md`** — TypeScript boundary safety, App Router rules, and an OWASP-aligned security checklist. Reviews block on it. This document (`NEW_PROJECT_BEST_PRACTICES.md`) lives beside it in `docs/`.
> - **`DESIGN.md`** — single source of truth for tokens, typography, components, voice. Generated from screenshots of a reference site (see `/design-md-from-screenshots`). Bootstrap it on day one.
> - **`CLAUDE.md`** — do NOT hand-author it. Copy **`CLAUDE-STARTER.md`** from the team-files repo to the project root as `CLAUDE.md`, fill every placeholder with *verified* project reality (real commands, real paths — never guesses), delete its instruction block, and create `AGENTS.md` as a symlink so non-Claude agents read the same text: `ln -s CLAUDE.md AGENTS.md`. The starter already wires in the CP/BP citation convention, the CP §7 self-review requirement, and the behaviour-under-ambiguity block.
>
> **Building a monorepo, an Expo/React-Native client, or picking your CI gate?** Read §17 (monorepo + pnpm/Turborepo), §18 (RN/Expo client), and §19 (quality gate / CI strategy) **before** scaffolding — these are the biggest sources of avoidable rework in a multi-app project and are easiest to get right on day one.
>
> **Standing up the local dev environment (proxy, Docker, design system)?** §20 (one shared Caddy fronting every repo), §21 (the Dockerized dev stack and its `node_modules` / file-watch / install gotchas), §22 (token single-source + the two-Storybook design system + mock-UI host scheme), and §23 (build + worktree hygiene for parallel agents) capture the hard-won setup that otherwise re-bites every contributor.
>
> **Shipping to multiple environments, or changing a security control?** §24 (the server is the single authority for env- and tenant-gated behaviour — flags, internal-user gating, the BFF boundary) and §25 (verify the whole request path after any auth/validation change; instrument boundaries before chasing error strings) are the operational rules that keep staging from emailing real customers and a security tweak from silently 403-ing a live feature.

---

## 1. Stack defaults

| Layer | Pick | Notes |
|---|---|---|
| Framework | **Next.js 16 App Router** | Server Components by default, `"use client"` only when needed |
| Language | **TypeScript 5.7+ strict** | `"strict": true`, `noUncheckedIndexedAccess: true` |
| Runtime | **Node.js LTS** (current: 24) | Never lock yourself to Edge runtime unless you've measured the cold-start win |
| Hosting | **Vercel** | Link the project on day one (`vercel link`); env vars live there, not in CI |
| Package mgr | **npm** (single app) · **pnpm** (monorepo) | One lockfile. For a monorepo, pnpm workspaces + Turborepo — see §17. Both work on Vercel |
| DB | **MongoDB Atlas + Mongoose** | Section 4 |
| Cache | **Redis (optional)** via `ioredis` | Section 5 — only if you actually need shared state |
| AI | **Vercel AI SDK** + **AI Gateway** | Section 6. Use **AI Elements** for chat UI |
| Storage | **Vercel Blob** | Client-upload pattern (Section 7) |
| Email | **Resend** | Section 8 |
| Auth | **JWT in httpOnly cookie + email-code sign-in** | Section 9 |
| Bot/messaging (opt) | **Vercel Chat SDK** + adapter | WhatsApp / Slack / Telegram / Discord behind one interface |
| Lint | **ESLint 9 flat config** | `next lint` was removed in Next 16; use `eslint-config-next` directly (a Next lint gate WITHOUT it is hollow — see CODING_PRACTICES §6.9) |
| Local dev proxy | **One shared Caddy** on `:80` + `<project>.local` | A single machine-wide proxy fronts every repo; real origins, no port collisions — see §20 |
| Local dev stack | **Docker Compose** (one service/app) behind Caddy | Source bind-mounts only; isolated `node_modules` volumes; polling file-watch — see §21 |
| Design system | **Two Storybooks (HTML ref ⇄ React host) + token single-source** | 1:1 parity; every token generated from one file — see §22 |
| Repo shape | **single app** → standalone · **multi-deployable** → monorepo | pnpm workspaces + Turborepo from day one — see §17 |
| Native client (opt) | **Expo / React Native** | In-monorepo conventions + a pure-`lib/` test gate — see §18 |

`tsconfig.json`: keep the path alias `"@/*": ["./*"]` and import everything cross-tree as `@/lib/foo`. Reduces churn on file moves.

---

## 2. Always use the latest npm versions

When adding any dependency, install with `@latest` and let lockfile-resolution pin the version. Don't paste version numbers from old project READMEs — they age out within months.

```bash
npm install next@latest react@latest react-dom@latest
npm install --save-dev typescript@latest @types/node@latest @types/react@latest
npm install ai@latest @ai-sdk/anthropic@latest        # AI SDK + provider
npm install mongoose@latest ioredis@latest             # data layer
npm install @vercel/blob@latest                        # storage
npm install resend@latest                              # email
npm install zod@latest jose@latest server-only@latest  # validation/JWT/boundary
```

For majors, run codemods first when available: `npx @next/codemod@latest upgrade latest`, `npx @ai-sdk/codemod@latest upgrade`. If peer-dep noise blocks an install, `npm install --save-dev @types/react@latest --legacy-peer-deps` as a one-off — never bake `--legacy-peer-deps` into install scripts (CODING_PRACTICES §4, A06). Read each major's release notes — App Router, AI SDK, and Mongoose all ship breaking changes regularly.

Keep `package.json` clean: don't pin to `~` or `^` arbitrarily — let `npm install` write `^` and trust the lockfile for reproducibility.

---

## 3. Project layout

```
app/
  page.tsx                 landing
  (marketing)/             grouped routes that share a marketing layout
  (app)/                   authenticated app shell
  [slug]/                  public pages
  api/
    <resource>/route.ts    Route Handlers — Promise<NextResponse>, Zod-validated
    webhooks/<provider>/   HMAC-verify-then-process
components/                shared client/server components
lib/
  db.ts, models.ts         data access + schemas (server-only)
  redis.ts                 cache + rate-limit helpers (server-only)
  storage.ts               Vercel Blob wrapper (server-only)
  ai.ts                    AI SDK wrapper (server-only)
  email.ts                 Resend wrapper (server-only)
  auth-server.ts           JWT mint/verify, cookie helpers (server-only)
  auth.ts                  thin client wrapper around /api/auth/me
  handlers/                long-form domain logic shared across entry points
scripts/                   tsx scripts: seed, invite, migrate
public/                    static assets, brand
```

**Server-only boundary:** every file in `lib/` that reads env secrets, hits the DB, or owns server-side handlers must `import 'server-only'` at the top. The package errors at build time if a Client Component imports it — your single best safeguard against accidental secret leaks.

`lib/auth.ts` is the only `lib/` file that's `"use client"`. Don't add `server-only` to it.

---

## 4. Database — MongoDB + Mongoose

- **Single connection cache**: in `lib/mongodb.ts`, cache the Mongoose connection on `globalThis` to survive Next.js dev hot reloads and serverless function reuse.
- **Models in one file**: `lib/models.ts`. Define schemas, indexes, and discriminators here; export typed model accessors from `lib/db.ts` so call sites never touch raw Mongoose.
- **Types in another**: `lib/types.ts` is the single source of truth for entity shapes — define the TS types there, derive Zod schemas from them at boundaries, mirror them in Mongoose schemas. Keep all three in sync in one edit.
- **Indexes are code**: declare every index in the schema file. Don't rely on the Atlas UI; it diverges from prod silently.
- **Lean reads**: use `.lean()` for read-only queries — returns POJOs, no Mongoose doc overhead.
- **Strict mode + strict queries**: `mongoose.set("strictQuery", true)` to fail loudly on unknown fields.
- **Migrations**: write one-shot scripts under `scripts/` invoked via `tsx --conditions=react-server scripts/migrate-*.ts` so they can import `server-only` modules.

Alternatives if MongoDB is wrong for the shape of your data: **Postgres via Neon** (Vercel Marketplace one-click) with **Drizzle** or **Prisma**. Neon's branching makes preview-deploy DBs trivial.

---

## 5. Cache — Redis (optional)

Only add Redis when you have a *concrete* need for cross-request shared state:
- **Rate limits** (per-IP, per-email)
- **Email codes / one-time tokens** with TTL
- **Webhook idempotency keys**
- **Chat SDK thread state**

If you only need request-scoped memoisation, use React's `cache()` instead — no infra. If you only need page-level caching, use Next 16 Cache Components (`"use cache"` + `cacheLife`/`cacheTag`).

When you do reach for Redis:
- **`ioredis`** for raw access. **`@upstash/redis`** if you want HTTP-only (works on Edge runtime).
- Wrap in `lib/redis.ts` with `import 'server-only'`. Expose a small `getKV()` helper plus typed helpers (`incr`, `expire`, `setEx`).
- **Provision on Vercel Marketplace** (Upstash Redis or Redis Cloud) — env var auto-injected, region picked for you.
- **Fail closed in prod**: if `REDIS_URL` is missing, throw on first call. Optional `ALLOW_MEMORY_KV_IN_PROD=true` opt-in for an in-memory fallback (only ever for local-only Vercel previews).

---

## 6. AI — Vercel AI SDK + AI Gateway + AI Elements

**Default to the AI SDK (`ai` package) over raw provider SDKs.** It's the only thing that gives you streaming, tool calling, structured output, multi-provider failover, and a stable API across model upgrades.

```ts
// lib/ai.ts
import 'server-only';
import { generateText, streamText, Output } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

// Pass model as "provider/model" string so AI Gateway routes it transparently
// when AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is set. Falls back to the
// direct provider for local dev with just ANTHROPIC_API_KEY. Gateway IDs use
// dots in the version ("claude-haiku-4.5"); the direct Anthropic API uses
// dashes ("claude-haiku-4-5") — normalise or the fallback 404s.
function resolveModel(id: string) {
  if (process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN) return id;
  return anthropic(id.replace(/^anthropic\//, '').replace(/\./g, '-'));
}

export async function summarise(input: string) {
  const { output } = await generateText({
    model: resolveModel('anthropic/claude-sonnet-5'),
    prompt: input,
    output: Output.object({
      schema: z.object({ tldr: z.string(), bullets: z.array(z.string()) }),
    }),
  });
  return output; // schema-validated object
}
```

- **AI Gateway** is the default routing layer. Configure once via `AI_GATEWAY_API_KEY` (or Vercel OIDC in prod) and you get multi-provider failover, cost tracking, and rate-limit insulation without touching call sites.
- **Structured output is non-negotiable**: enforce every LLM payload by passing `output: Output.object({ schema })` (a Zod schema) to `generateText`/`streamText` and reading the validated `output` from the result. No regex-based JSON salvage. (AI SDK ≤5 spelled this `experimental_output` — run the codemod when upgrading.)
- **Streaming**: with `output` set, `streamText` exposes `textStream` (typewriter effect) and `partialOutputStream` (the schema-shaped object as it forms — pair with the `useObject` hook client-side). Streaming errors arrive *in the stream*, not as thrown exceptions — handle them via the `onError` callback.
- **Models**: keep model IDs in *one* config object (`MODELS.captioner`, `MODELS.extractor`) so swaps are one-line. Default to **Claude Sonnet 5** (`anthropic/claude-sonnet-5`) for quality work and **Haiku 4.5** for high-volume / latency-sensitive paths; reach for **Opus 4.8** when a single hard task justifies the cost. Model IDs age out in months — verify against the live list (`curl -s https://ai-gateway.vercel.sh/v1/models`) instead of pasting from memory, per §2.
- **Tool calls need a stop condition.** When you give the model tools, set the loop/stop control (`stopWhen: stepCountIs(n)` in the AI SDK) — without it the run halts the instant a tool executes and never generates the final text, so you get a tool result and an *empty answer*. This is the single most common "the model returned nothing" bug with tools.
- **Pin provider routing so a fallback can't silently bill you.** When the Gateway routes by a preference list, pass it as both the allow-filter and the order (`only` + `order`) so a request can't quietly fall through to a provider you didn't mean to pay for. And some providers reject parts of a JSON schema others accept (e.g. Bedrock rejects `min`/`max`/`int` numeric constraints on structured-output schemas) — strip those from the *wire* schema and re-validate the result against your original Zod, rather than dropping the constraint everywhere.
- **Graceful degradation**: when no AI auth is present, return a sentinel object with a friendly "missing key" message — never crash the host page.

### AI Elements — when building chat or agent UIs

**Use [Vercel AI Elements](https://ai-sdk.dev/elements)** (the prebuilt React component library) instead of building chat bubbles, message lists, tool-call cards, code blocks, and reasoning panels from scratch. They're styled with shadcn/ui and integrate directly with the AI SDK's hooks.

```bash
npx ai-elements@latest add message conversation prompt-input
```

When **not** to use AI Elements:
- One-off "summarise this" / "generate a caption" features with no chat surface — plain components are simpler.
- Marketing copy generation that renders inside an existing form — use the form, not a chat shell.

If the product *is* a chat interface, AI Elements saves a week of UI plumbing and gives you a coherent design language out of the box.

---

## 7. File uploads — Vercel Blob client-upload

**Never POST file bytes through a Route Handler.** Vercel's Function body cap is 4.5 MB and you'll lose to it the first time a user uploads a phone photo.

Use the **client-upload pattern**:

```ts
// app/api/uploads/photo-token/route.ts (server)
import { handleUpload } from '@vercel/blob/client';
export async function POST(req: Request) {
  return handleUpload({
    request: req,
    body: await req.json(),
    onBeforeGenerateToken: async () => ({
      allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
      maximumSizeInBytes: 10 * 1024 * 1024,
      tokenPayload: JSON.stringify({ /* tenant scoping */ }),
    }),
    onUploadCompleted: async ({ blob, tokenPayload }) => { /* persist blob.url */ },
  });
}
```

Browser:

```ts
import { upload } from '@vercel/blob/client';
const blob = await upload(file.name, file, {
  access: 'public',
  handleUploadUrl: '/api/uploads/photo-token',
});
```

For server-side fetches (e.g. webhook media downloads from Meta, Slack, etc.), use `putBlob()` directly — no browser involved, no body cap.

---

## 8. Email — Resend

- **Resend** for transactional. React Email components for templates so designers can preview them. Do NOT inline-style HTML by hand.
- One env var (`RESEND_API_KEY`) plus a `RESEND_FROM_EMAIL` for the verified sender.
- Wrap in `lib/email.ts` with named exports per template (`sendWelcomeEmail`, `sendSignInCodeEmail`, etc.).
- All user-supplied content interpolated into HTML must be `escapeHtml()`-encoded; mailto/href interpolations need `encodeURIComponent`. Pull both helpers into `lib/html-escape.ts` and unit-test them.

For inbound email parsing, use **Resend Inbound** (or a webhook from Postmark/SES). Verify the signature before parsing — same rules as any other webhook.

---

## 9. Auth — self-signed JWT + email-code sign-in

The pattern that holds up for early-stage SaaS (`CODING_PRACTICES.md` §4 "Auth & sessions" and §6.1–§6.2 cover the full ruleset):

1. **Sign-in via email code.** `POST /api/auth/request-code { email }` — generate a 6-digit code with `crypto.randomInt`, store `HMAC-SHA256(code, JWT_SECRET)` in Redis under `signin:code:<email>` with a 10-min TTL, send via Resend. Rate-limit to **3 requests per email per hour**. Return success even when the account doesn't exist (no existence leak — OWASP A07).
2. **Verify with `crypto.timingSafeEqual`.** Cap **5 verify attempts per code** before purging. On success, mint a JWT and set the cookie.
3. **JWT pinned to HS256.** Always set `iss`, `aud`, `iat`, `exp`. Always pass `algorithms: [ALGORITHM]` to the verifier — prevents alg-confusion attacks.
4. **Cookie**: `httpOnly: true`, `secure: true` (in prod), `sameSite: 'strict'`, `path: '/'`, `maxAge: 30 days`. Strict SameSite gives you CSRF coverage on first-party POSTs for free.
5. **Distinct trust domains use distinct secrets.** If you have an admin UI, use a separate `ADMIN_JWT_SECRET` and pin a different `aud` claim. A salon-side key compromise must not mint admin tokens.
6. **No third-party auth provider until you need OAuth.** Adding Auth0/Clerk/NextAuth to a 50-user pilot is overkill — it's another vendor, another bill, another integration to debug. Reach for **Clerk** (Vercel Marketplace native) or **Auth.js** when you need social login or B2B SSO.
7. **When you have a token-refresh / re-auth round-trip (native OAuth, refresh tokens), classify the failure — don't retry a dead session forever.** A refresh that returns **401/403** means the token is expired/revoked: clear the session and drop to signed-out **once**. A **network error / 5xx / gateway timeout** is transient: keep the session and let the next request retry. Collapsing both into "transient" floods the logs with "refresh failed" and never recovers; collapsing both into "logout" signs people out on a blip. This depends on the response handler **preserving the HTTP status**: a failing serverless/proxied endpoint often returns a **non-JSON** error page (a platform "An error occurred" / gateway-timeout page — plain text, frequently starting with a stray character), so a handler that `JSON.parse`s the body *before* checking `res.ok` throws an opaque "invalid JSON" that **discards the status** — turning a classifiable 401/504 into an unclassifiable error and the infinite retry above. Read the body, branch on `res.ok` + content-type, and surface the status on the thrown error.

**IDOR is the #1 bug in App Router APIs.** Every Route Handler that mutates a resource must do an explicit `resource.tenantId === session.tenantId` ownership check before writing — Mongoose `findById` will happily return any document.

---

## 10. Route Handlers — conventions

Every `app/api/**/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/auth-server';

export const runtime = 'nodejs';   // Mongoose, ioredis, jose all need Node APIs

const bodySchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', issues: parsed.error.issues }, { status: 400 });
  }
  // ... ownership check, mutation, response
}
```

Rules:
- **Always** return `Promise<NextResponse>` with explicit type — TypeScript otherwise infers `any` from `NextResponse.json`.
- **Always** validate with Zod *before* reading. PATCH bodies use `.strict()` so an attacker can't slip in `{ accountId: '<other-tenant>' }`.
- **Always** call `getSession()` (or your equivalent) at the top when auth is required.
- **Never** rely on dynamic-route `params` shape — they're `Promise<{...}>` in Next 15+. Always `await` before reading.

For multipart uploads, use `formData.getAll('image')` — `Object.fromEntries(formData)` silently drops repeat keys.

---

## 11. Webhooks

- **Verify the signature BEFORE parsing the body.** Read raw bytes, HMAC them, *then* `JSON.parse`. Parsing untrusted JSON before verification is a free DoS vector.
- **Ack within the provider's timeout** (Meta: 5s, Slack: 3s, Stripe: 5s). Use `after()` from `next/server` to return immediately and finish the work in the background.
- **Idempotency**: stash the provider's event ID in Redis with a 24h TTL; bail if it's already processed. Providers retry on any non-2xx and on timeouts.
- For **chat platforms** (WhatsApp, Slack, Telegram, etc.) use **Vercel Chat SDK** — one abstraction over all of them, signature verification baked in.

---

## 12. Security

All of these live in `next.config.mjs` and `middleware.ts` from day one. Don't defer security headers to "after launch" — adding them later breaks every embed and inline script.

- **CSP**: nonce-based, no `'unsafe-inline'` in `script-src`. Generate the nonce in middleware, pipe it through to `<Script nonce={nonce}>`. `'unsafe-eval'` only in dev (React's dev-only `eval`).
- **HSTS**: `max-age=63072000; includeSubDomains; preload`.
- **X-Frame-Options: DENY** (or use CSP `frame-ancestors`).
- **X-Content-Type-Options: nosniff**.
- **Referrer-Policy: strict-origin-when-cross-origin**.
- **Permissions-Policy**: deny everything you don't use (`camera=()`, `microphone=()`, `geolocation=()`).

When you add a new external origin (image CDN, analytics, AI provider with a custom domain), add it to the relevant `*-src` directive — the CSP will block it otherwise.

**Audit log** any admin-initiated mutation: who, when, what changed (before/after). Persist it as part of the same DB transaction so you can't have a write succeed without the log entry.

---

## 13. Environment variables

- `.env.example` is the **canonical** list of required vars. Tracked in git. Every key documented with a one-line comment.
- `.env.local` is local-only. Gitignored via `.env.*` with an exception for `.env.example`.
- **Vercel env** is the source of truth for prod/preview. `vercel env pull .env.local` keeps local in sync.
- **Distinct secrets per trust domain**: `JWT_SECRET` for users, `ADMIN_JWT_SECRET` for admins, `CRON_SECRET` for scheduled jobs. Generate each with `openssl rand -base64 32`.

---

## 14. Scripts & tooling

- `scripts/*.ts` invoked via `tsx --conditions=react-server scripts/foo.ts` so they can import `server-only` modules.
- Add the `react-server` flag to every script entry in `package.json` — easy to forget, breaks the next person who copies a script.
- Wrap corporate-cert handling at the npm-script level: `NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem next dev`.
- **Use Caddy for local HTTPS and multi-service routing.** Commit a root `Caddyfile` from day one when the project has secure cookies, OAuth/webhooks, native clients, or any WebSocket/SSE sidecar. Use a product-owned host such as `<project>.local`, route local WebSocket/SSE paths through Caddy under the same origin where possible, and keep `allowedDevOrigins` (`next.config`), `.env.example` app URLs, and CSP `connect-src` in sync with the Caddy host in the same change. **The full proxy model (one shared machine-wide Caddy fronting every repo, the `conf.d/` mirror rule, and the host scheme for design surfaces) is §20 + §22.**

---

## 15. Testing

Default posture: most early-stage SaaS over-invests in unit tests and under-invests in end-to-end coverage. Bias the harness accordingly. Default stack:

- **Playwright** for end-to-end flows (sign-up, sign-in, the golden path of your product). Run them on every push via your quality gate (§19).
- **Vitest** only when you have pure logic worth isolating (date math, parsing, schema transforms). Don't unit-test thin wrappers.
- **No tests for AI calls.** Snapshot the prompt + schema; assert on the schema-validated shape, not the model's exact words.
- **Type checking *is* a test.** `tsc --noEmit` in the gate catches more bugs per minute than any test suite at <100 LOC scale. (Run it over test files too — `tsc` checks them even though Vitest skips type errors.) But a green typecheck is **not** a green build: a duplicate declaration / bad import can pass a noisy type-error baseline yet break the *bundle* so the app won't boot — run the built app (or a smoke E2E) before claiming a change works.
- **If a framework pins you to Jest (NestJS defaults to it), use `@swc/jest` as the transform — never `ts-jest`.** `ts-jest` type-checks every file on every worker, the main reason a Jest suite feels slow; type-checking is already the gate's job (above), so the runner only needs types *stripped* — SWC (Rust) does that ~10–20× faster. For NestJS the SWC config **must** emit decorator metadata or DI silently fails to resolve: `jsc.parser.decorators`, `jsc.transform.{legacyDecorator, decoratorMetadata}`, `keepClassNames`, `module.type: 'commonjs'`; pair it with `coverageProvider: 'v8'` (SWC emits no coverage instrumentation). On Jest 30 also set `testEnvironmentOptions.globalsCleanup: 'on'`, a `workerIdleMemoryLimit`, and gate coverage + `maxWorkers` to CI so local runs stay lean (a 16-core box shouldn't run 8 heavy workers interactively). **Keep the Jest config a plain `.js`/`.mjs` file, not `jest.config.ts`:** Jest loads a *TypeScript* config through `ts-node`, which it hardcodes — and it consumes ts-node as an *optional peer*, so nothing warns — so a `.ts` config silently keeps `ts-node` alive in the workspace even when every transform is already `@swc/jest`. A `.js` config needs no TS loader at all; test *files* still transform via SWC. *(Vitest — the default above — transforms via esbuild and needs none of this.)*
- **Boot the local dev server through the same compiler as the prod build.** For a *separately-compiled* API server whose prod image is built with **SWC** (NestJS/Fastify/Express — not Next.js, whose dev and build already share SWC/Turbopack), don't let local `dev` run it through a *different* transpiler (`ts-node`/`tsc`). They disagree on module-evaluation order and on how `emitDecoratorMetadata` emits references — enough that a **circular-import TDZ that crash-loops the SWC prod image can boot cleanly under `ts-node`** and ship undetected (`ReferenceError: Cannot access 'X' before initialization` at boot, then a restart loop). Run the dev server via the SWC register hook (`node -r @swc-node/register …`) so dev and prod share one transform and this class of boot crash reproduces locally. It's often the *only* pre-prod catch point: a persistent server with no HTTP health check can deploy "green" while crash-looping (§19). *(Fix the cycle itself per CODING_PRACTICES §2 "forwardRef and circular deps" — or, when a `forwardRef` must stay, make the import type-only and resolve the token lazily inside the thunk (`forwardRef(() => require('…').Service)`) so no eager top-level reference is emitted to trip the TDZ.)*
- **Assert real *data*, not just "it rendered."** A screen that paints fine while every value shows a placeholder (`—`, `N/A`, `Unknown`, a blank cell) passes a naive "page loads" test but hides a broken data pipeline. For a **known-good fixture** (a real entity the backend definitely has), assert the field renders a *value-shaped* string — a digit, a `$`, a `%`, a date — and explicitly **not** the placeholder. Catalogue every placeholder-fallback site so each gets a value-presence assertion; this is what catches a field silently dropped between the data source and the screen. (A formatter that emits `$0.00` for a `0` passes a naive `$` check — require a digit / non-zero where the real value can't be zero.) Keep the coverage doc honest, too: a flow-map that lists test files which don't exist on disk overstates reality and hides the gaps that matter — list only flows that exist.

For UI work, drive the actual feature in a browser before reporting it done — the project has the `playwright-cli` skill for exactly this.

### Scaffold the test harness on day one (don't backfill)

A common expensive failure mode is every app shipping untested and a later "add coverage everywhere" sweep — far more costly than test-as-you-go, and the sweep repeatedly *finds real bugs* (a proxy 500 on a malformed cookie, a `$set`-into-null first-write 500, an out-of-range date formatter rendering `"1 undefined 2026"`). Set up the harness before the first feature:

- **In-memory Mongo** (`mongodb-memory-server`) for handler / Server-Action / model tests; a Redis in-memory fallback; **jsdom + RTL** for UI.
- **A `server-only` no-op alias stub** in the vitest config — the real `server-only` package throws in a Node test env, blocking any direct unit test of App Router server/`lib/` modules.
- **Separate hermetic unit tests from server/DB-dependent integration tests** into distinct vitest configs and named scripts: `test` = hermetic unit only (explicit `tests/**` exclude); `test:integration` = black-box against a seeded server. The gate runs the hermetic suite; a default `test` must never accidentally require Docker.
- **Risk-weighted "done" bar:** the most security-sensitive app (admin/auth) gets the *strongest* coverage, not the weakest. Privileged/mutating Server Actions need a test asserting the authz gate denies unauthorized callers, the data invariant holds, and PII/secrets never reach audit logs. The proxy/middleware gate, queue happy-paths, and SSR hydration-sensitive UI must be covered before "done".
- **Tests are part of the feature:** every pure `lib/` helper gets a co-located unit test and every route handler / Server Action gets a handler test *when it is written* — not in a later module-by-module sweep.

---

## 16. Deployment

- **Link the project to Vercel before the first commit.** `vercel link` writes `.vercel/project.json` (gitignored). Preview deployments per PR are free productivity.
- **Promote to prod via merge to main.** Don't use the Vercel UI to promote; the Git history should be the source of truth for what's in prod.
- **Use Vercel Marketplace** for managed infra (Mongo Atlas, Neon, Upstash, Clerk, Resend) — env vars auto-provisioned, billing rolled into your Vercel invoice, no extra dashboards to log into.
- **Cron jobs**: Vercel Cron + a `CRON_SECRET` header check on the route handler. If part of your stack runs as a **persistent process** (a long-lived container, not a serverless function), schedule its jobs **in-process** there (e.g. a cron decorator) and reserve HTTP-triggered serverless cron for the serverless layer — don't add a `CRON_SECRET` HTTP endpoint for work the persistent process can run directly.
- **Background work**: `after()` from `next/server` for fire-and-forget. **Vercel Workflow DevKit** when you need durable, retry-able, multi-step orchestration (e.g. multi-stage AI pipelines, payment + provisioning flows).
- **Mind the function `maxDuration` vs cold-start bootstrap.** A server framework that connects to a DB/cache *during bootstrap* (NestJS/Fastify/Express wrapped in a serverless function) can exceed the function's `maxDuration` on a **cold** start — every cold request then 504s (`FUNCTION_INVOCATION_TIMEOUT`) while warm requests are fine, so it reads as "intermittent." Three compounding traps: **buffered logging** (logs flushed only after init completes) emits *nothing* when init hangs, hiding where it's stuck; a **warm-up cron** that hits the same cold-capped endpoint can't warm a function that can't bootstrap within the limit (chicken-and-egg); and an explicit low `maxDuration` in `vercel.json` caps it below the real bootstrap cost. Cache the connection/app **promise** across invocations (so two concurrent cold invocations don't both bootstrap), give bootstrap realistic headroom, and turn off log buffering while diagnosing.

---

## 17. Monorepo (pnpm workspaces + Turborepo)

If you anticipate more than one deployable (web API + operator console + native client, etc.), start as a **pnpm-workspaces + Turborepo monorepo on day one** — retrofitting standalone npm repos into one workspace is expensive (an app scaffolded standalone, with its own `git init` + `package-lock.json`, has to be unpicked and redone later).

**Layout**

```
apps/
  <web-api>/         Next.js → Vercel
  <admin>/           Next.js → Vercel
  <native>/          Expo / React Native (no Vercel project)
packages/
  contract/          shared wire DTO types (see §18 + CODING_PRACTICES §6.10)
docs/<project>/      durable per-project docs
CLAUDE.md            root entry point
apps/*/CLAUDE.md     per-app detail; root points at them
.gitignore           ONE consolidated root file (no per-app .gitignore)
pnpm-workspace.yaml  turbo.json  pnpm-lock.yaml
```

**Rules**

- **pnpm only, one lockfile.** Never run `npm install` inside an app; never commit `package-lock.json`. `pnpm install` at the root installs the whole workspace.
- **Run gates through Turborepo** (`pnpm turbo run lint typecheck test build`), not per-app npm scripts — caching makes the full gate cheap.
- **No nested `git init`.** One root repo, no submodules. Pick which repo's history to keep before merging; archive the rest.
- **One consolidated root `.gitignore`** — write per-tool / local-state patterns with a leading `**/` (e.g. `**/.env.local`, `**/.claude/settings.local.json`) so they reach inside every `apps/*`. A slash-anchored pattern matches only the repo root and once leaked an `apps/*` file into a commit. Anchor generated-dir patterns to root with a leading slash (`/coverage`) so a bare glob doesn't swallow a nested source file. Verify with `git check-ignore -v` on a nested path before the first commit.
- **Vercel: one project per deployable**, each with Root Directory = `apps/<name>` and a per-app `vercel.json` `"ignoreCommand": "npx turbo-ignore"` so a push touching one app doesn't redeploy the others. Native / App-Store apps get no Vercel project.
- **Docker:** one root Dockerfile using `turbo prune --docker` + Next.js `output: 'standalone'`, one image per app via a build-arg. Any Next app that must run in Docker (not just Vercel) needs `output: 'standalone'` from the start — Vercel ignores it, so it's safe everywhere. Use **exec-form** `CMD` (JSON array) so the process is PID 1 and receives SIGTERM for graceful shutdown.

### pnpm workspace mechanics (pnpm 10/11)

- **`overrides` and the native-build `allowBuilds` allowlist live in `pnpm-workspace.yaml`**, NOT in any `package.json` `pnpm.*` / `overrides` field. pnpm 11 ignores the package.json block and auto-writes an `allowBuilds:` stub — confusing churn.
- **pnpm 10+ blocks install/build scripts by default** (supply-chain safety). Pre-approve only the native binaries the toolchain genuinely needs (`esbuild`, `sharp`, `protobufjs`, `mongodb-memory-server`, native resolvers) in `allowBuilds`. Otherwise their builds silently no-op and you get cryptic runtime failures.
- **No phantom deps.** pnpm exposes only a package's *declared* dependencies (no flat hoisted `node_modules`). An unresolved import = an undeclared dependency: add it to that app's `package.json`. **Never** add `shamefully-hoist` to paper over it. Migrating from npm/yarn surfaces these; run the full gate with `--continue` to flush them all in one pass.
- **Never silence peer-dependency conflicts globally** (`legacy-peer-deps`, `shamefully-hoist`). Pin the specific offending transitive peer to the root version via a scoped `overrides` entry — a blanket setting masks *other* real conflicts that then surface only on re-resolve.

### Cross-app contracts are part of the gate

In a monorepo where the gate is a pre-push hook (no hosted CI) and apps are independently typed, **TypeScript can't catch a shape mismatch across two apps** — each side compiles green while the wire shape diverges. Scaffold the cross-app safety net *with the first cross-app feature*, not after a review finds drift:

- a shared `packages/contract` for wire DTOs (preferred), or
- twin key-set parity tests on producer and consumer, wired into the `test` gate.

Treat the wire-DTO parity test as part of a cross-app feature's definition of done. Full detail and the bidirectional-guard rule live in CODING_PRACTICES §6.10.

**If the wire contract is a GraphQL schema**, put codegen + a schema-drift check in the gate. A consumer whose generated types are hand-synced from the backend schema will 400 *every* query the moment the backend adds/renames a field its copy lacks (or a nullability diverges). Regenerate types from the live schema in the gate and fail on drift — the same role the parity test plays for REST DTOs.

---

## 18. React Native / Expo client (in a monorepo)

When a pnpm-workspace monorepo includes an Expo/RN app:

- **Set `node-linker=hoisted` in the root `.npmrc` from day one.** Metro and Expo autolinking expect a flat `node_modules`; pnpm's default symlinked store breaks resolution and native autolinking. Also set `strict-peer-dependencies=false` + `auto-install-peers=true` to mirror npm's lenient peer handling, and add `.npmrc` to Turborepo `globalDependencies` so changes bust the cache.
- **Make `metro.config.js` monorepo-aware**: watch the workspace root and add the monorepo `node_modules` to the resolver paths. Metro does not handle a pnpm symlinked layout out of the box.
- **Native / App-Store apps get no Vercel project**, but they still get a test gate — see below.
- **Give every sibling app a distinct identity — from day one.** When two native apps ship from one codebase (a fork, or a customer + operator variant), a shared **bundle/application id**, **URL scheme**, or **OAuth redirect** makes them *install over each other* on a device/simulator, share a keychain / secure-store namespace (one app reads the other's stored session — a real "logged in as the wrong app's user" bug), and race for the same deep link. Make each unique per app and change them **together**: the native id (`ios.bundleIdentifier` / `android.package`), the URL `scheme`, the OAuth/PKCE redirect URI, and the deep-link linking `prefixes`. Two coordination traps: the linking-config `prefixes` must include the **declared** scheme (a prefix that doesn't match the registered scheme is dead — incoming links never resolve), and any reminder/notification that emits a deep link must use that same scheme. Changing an id has **external** follow-ups the code can't do — add the new redirect URI to the OAuth app's allowed-callback list, and re-register the new id with the push/analytics provider (a new Firebase app + fresh `GoogleService-Info.plist` / `google-services.json`) — flag these explicitly, because the app silently loses sign-in / push until they're done.

### Test gate for an RN/Expo client

Run a **Node-env Vitest over the PURE, framework-free `lib/` helpers only** (ratings math, date/name formatting, adapters, country/city tables). Wire it into the Turborepo `test` gate alongside the web apps — even the first such tests tend to catch real bugs (e.g. an out-of-range month rendering `"1 undefined 2026"`).

- Keep those `lib/` modules free of *runtime* react-native / expo imports: use `import type` for RN types, never value-imports, and don't `require()` image assets in pure modules.
- Modules that touch the RN runtime, reanimated, or asset `require()`s are out of scope for the Node suite — device / E2E-test them. Mock the module that pulls assets rather than aliasing/stubbing image requires.
- Document this boundary in the app's `CLAUDE.md` so testers don't rediscover it per file.

### Device / E2E coverage for an RN/Expo client

The Node-`lib/` suite above is the cheap unit gate; the user-facing flows still need a device E2E pass (**Maestro** or **Detox**):

- **Test the return paths, not just the forward path.** Every pushed screen, modal, and sheet must expose a working Back / Close / dismiss affordance that lands the user where they came from — a screen with no reachable back control is a stranded dead-end. Assert the back/close on *every* pushed screen, including the **second** route inside a nested stack (its Back must pop one level, not jump to the root) and a modal **Close** (a different control from a header Back chevron).
- **Presence-guard data-dependent steps.** A flow that opens a list row / detail that only exists when the backend has data will flake. Wrap each such step in a "run only if the entry control is visible" guard so the flow exercises what's there and *skips* (not fails) what isn't — and surface what was skipped so a silent skip doesn't read as coverage.
- **Selector gotchas that silently break flows.** Text matchers in these runners are usually **anchored** (full-string), so `text: "Legal"` does **not** match a row rendered as "Legal & disclaimers" — use a substring/wildcard. A touchable with `accessible` set (the default for a `Pressable`/button) **collapses its child text into one combined accessibility label**, so an individual label isn't matchable on its own — match the combined label, or better, add a `testID`. Put stable `testID`s on the controls each flow taps and the data cells it asserts; matching on copy breaks every time the copy changes.
- **Drive the *built* app.** Boot the installed app and run at least one flow before claiming a change works — a bundling/integration error (duplicate declaration, bad import) that a noisy typecheck baseline misses fails the bundle outright.

### Finding the gaps systematically

When auditing E2E coverage for any non-trivial client, fan the analysis out across **independent dimensions** rather than one linear pass — input/forms, navigation + return paths, data-integrity (placeholder vs real value, §15), and error/empty/loading/auth-gate/deep-link states. Each dimension surfaces gaps the others miss, and the sweep reliably turns up *real bugs* alongside missing tests (a deep-link scheme that doesn't match the registered one, push routes pointing at screens that don't exist, a redirect to a route that was renamed). Catalogue both — gaps and bugs — and prioritise.

---

## 19. Quality gate / CI strategy (decide day one)

Decide and **write down** the quality-gate mechanism before any spec says the word "CI" — otherwise an agent reads "CI runs …" and scaffolds a GitHub Actions pipeline that then gets torn out. Left unstated, this churn repeats — sometimes within an hour — until the decision is recorded.

Two viable shapes:

| Gate | When | Cost |
|---|---|---|
| **Hosted CI** (GitHub Actions) | open-source, many contributors, required status checks | runner minutes, secrets in CI |
| **husky pre-push hook** | small trusted team, monorepo, want true Vercel parity locally | per-clone `vercel link` / `vercel pull`, no cloud feedback on PRs |

For a small trusted team, a strong gate is a **husky pre-push hook** running `turbo lint+typecheck+test` + a **real `vercel build`** (not a cheaper `next build` approximation — true parity catches `standalone` / CSP-nonce / build-time-env bugs the static gates miss), with `SKIP_VERCEL_BUILD=1` as the only bypass and no hosted CI at all.

- Install the hook automatically via the root `package.json` `prepare` / husky script so every clone is gated with no manual step.
- A real `vercel build` needs `vercel link` + `vercel pull` per clone and a gitignored `.vercel/`.
- Treat any spec phrase "CI runs X" as "the gate runs X". Record the decision in the monorepo / setup doc so it isn't re-litigated.

### Scope the gate to what the push changes

A monolithic gate that runs every app's typecheck + build + smoke on *every* push wastes minutes when a push touches only one app, the docs, or an npm-isolated native island (§18) the gate doesn't even cover. Make the hook **path-aware**: diff the push range (`@{upstream}...HEAD`) and run each area's checks only when that area — or shared code that all apps consume — is in the diff.

- **Map changed paths → affected gates.** `apps/<web>/**` → web typecheck + build; `apps/<api>/**` → api build + smoke; **`libs/**` / `packages/**` / lockfile / base `tsconfig` / workspace config → all of them** (cross-cutting code forces a full revalidate). A push that touches only a native island or `*.md` runs neither.
- **Fail safe, never skip on doubt.** If the diff can't be computed (new branch with no upstream, detached HEAD, shallow clone), run **everything**. Skipping is only ever for a change you can *prove* is out of scope.
- **Tier the broad-but-cheap checks.** A diff-scoped code review is worth running for any code change but can skip a docs-only push; type/build/smoke skip whenever their app isn't affected.
- **Give it an escape hatch.** `GATE_FULL=1 git push` forces the whole suite — for lockfile bumps, toolchain changes, or a belt-and-suspenders run.

---

## 20. Local dev proxy — one shared Caddy for the whole machine

Run **one machine-wide Caddy on `:80`** that fronts *every* repo on the dev machine — not Docker's port mapping, not a per-project nginx. Containers publish only high ports (`3010:3000`, `3020:3000`, …); Caddy host-routes `:80` to them by hostname. Every app gets a real, stable origin (cookies, OAuth redirects, CSP, WebSockets all behave like prod), and any number of repos coexist without port collisions.

**Two-file layout**
- **Machine config** (e.g. `/opt/homebrew/etc/Caddyfile` on macOS/Homebrew): the global options block **plus** `import conf.d/*.caddy`. It owns the one global block for the whole machine.
- **Per-repo route file** (`<caddy-etc>/conf.d/<repo>.caddy`): only the `http://<host> { reverse_proxy localhost:<port> }` route blocks for that repo.
- **Repo-local `Caddyfile`** (committed): the same routes **plus** a leading `{ auto_https off }` global, so a contributor can run the repo standalone with `caddy run --config Caddyfile`.

**Mirroring the repo `Caddyfile` into `conf.d/` is NOT a plain `cp`.** The machine `Caddyfile` already owns the global block, and Caddy requires globals to be **first** in the combined config — so an imported `conf.d/*.caddy` that carries its own `{ … }` global fails validation with *"server block without any key is global configuration, and if used, it must be first."* Strip the global block; mirror only the route blocks; `caddy validate --config <machine Caddyfile>` before reloading.

**Operating it**
- Each hostname needs an `/etc/hosts` line: `127.0.0.1 <host>`.
- Binding `:80` needs root: `sudo brew services start caddy`; after any route edit, `sudo caddy reload --config <machine Caddyfile>`.
- **A 502 from a proxied host = Caddy can't reach the upstream** — the container is down, or a stale proxy (old nginx) still holds `:80`. Check the container first.
- **Add another repo:** drop `conf.d/<repo>.caddy` + the `/etc/hosts` entries + reload. No other repo is touched.

---

## 21. Dockerized local dev stack

Run the whole stack — every app plus its infra (DB, Redis, a mock email server) — under **one `docker-compose.dev.yml`**, fronted by the shared Caddy (§20). Each gotcha below comes from a real "works on host, breaks in container" (or vice-versa) failure; they are the difference between a dev stack that boots clean and one that crash-loops into 502s.

**Never bind-mount `node_modules`.** Mount source only; give each app a **named volume** for `/app/node_modules` *and* for every nested `/app/apps/<x>/node_modules`. Two failures this prevents:
- The container's `pnpm install` writing into a host-bind-mounted `node_modules` **clobbers the host's** modules — the next host `tsc`/`build` fails with hundreds of "cannot find module". (If it happens, restore with a host `pnpm install --frozen-lockfile`.)
- macOS/Windows host modules mounted into a Linux container resolve to broken native binaries / symlinks.
Give **each service its own** isolated `node_modules` + pnpm-store volumes (not one shared store) so parallel services don't fight.

**File watching needs polling in Docker Desktop.** Docker Desktop (Mac/Windows) does not propagate bind-mount filesystem events into the container, so native watchers never fire — the app silently won't hot-reload (you'll restart it by hand and not know why). Force polling, **scoped to Docker only** so native/CI runs keep efficient event-based watching:
- nodemon / chokidar: `CHOKIDAR_USEPOLLING=true` (+ `CHOKIDAR_INTERVAL` matched to the rebuild cost — e.g. ~3s for a full-process restart like NestJS; polling faster just burns CPU).
- webpack / Next dev: `WATCHPACK_POLLING=true`.
- Vite **through the proxy**: env-gate `server.watch.usePolling`, `server.allowedHosts`, and the HMR `clientPort` = the proxy port (`80`), so the HMR websocket reconnects to `<host>` and not `localhost:5173`.
Add a watch **ignore list** (tests, `__fixtures__`/`__mocks__`, `*.d.ts`, boot-generated schema files, `.DS_Store`) so generated/churny files don't trigger spurious restarts or get polled.

**Mask heavy *unused* subtrees nested under a bind mount — on macOS they exhaust the host's *system-wide* file table and `ENFILE` unrelated apps.** A container that bind-mounts a parent dir (`./apps`) inherits **every** child under it — including apps it never imports (an npm-isolated native island excluded from the workspace, §18) and their giant generated trees: that island's own `node_modules` (100k+ files *each*) and CNG-generated native dirs (`ios/Pods`, `android/**/build` — tens of thousands of files). On **macOS**, Docker's file-sharing runs inside one VM process (`com.apple.Virtualization.VirtualMachine`) that holds an **open file descriptor per shared/watched file**; with the polling watchers above traversing those trees across several containers, that single process can accumulate **tens of thousands of FDs and exhaust the system-wide `kern.maxfiles`** (macOS default: a low **65536**) — *not* the per-process `ulimit`. The tell is **`ENFILE` / "too many open files in system" in a completely unrelated app** (a native build tool aborting, a browser unable to open tabs) while every per-process limit looks fine. Diagnose with `sysctl kern.num_files kern.maxfiles` (near-equal ⇒ exhausted) and `lsof -nP -p <vm-pid> | wc -l` to find the hog.

Fix: **mask each heavy/unused subtree with an empty anonymous volume** in *every* service that bind-mounts the parent — a container path with no host source tells Docker to shadow the host dir, so the VM never traverses it:

```yaml
volumes:
  - ./apps:/app/apps:cached                       # legit: the workspace apps THIS container builds
  # mask trees no container here needs — an isolated native island + its native build output:
  - /app/apps/<native-island>/node_modules
  - /app/apps/<native-island>/ios
  - /app/apps/<native-island>/android
```

It's the same mechanism as the per-app `node_modules` named volumes above (an empty mount shadowing a path *inside* a bind mount) generalised to **any** big subtree, not just `node_modules`. Restarting Docker reclaims the FDs instantly, but they re-accumulate until the masks are in place — the masks are the durable fix.

**Raise the macOS file ceiling as a safety net** so no single future leak can wedge the whole machine — the 65536 default is far too low for a box running Docker + a native/IDE toolchain + browsers at once:

```bash
sudo sysctl -w kern.maxfiles=524288 kern.maxfilesperproc=262144   # runtime
```

Persist it across reboots with a `/Library/LaunchDaemons/limit.maxfiles.plist` that runs `launchctl limit maxfiles 524288 524288` at load (`RunAtLoad`).

**Keep installs lean and lockfile-honest.**
- For a small static surface (a mock-UI app, a docs site), `pnpm install --filter <app>` (+ `--ignore-scripts` to skip native postinstalls it never needs) instead of a full workspace install — minutes → ~1 min startup.
- `--frozen-lockfile` validates the **entire** workspace even with `--filter`. A stale lockfile or out-of-date **workspace exclusions** (after a directory rename) then fail **every boot** with `ERR_PNPM_OUTDATED_LOCKFILE`. Keep package-manager exclusions in sync in **both** `pnpm-workspace.yaml` and the root `package.json` `workspaces`.
- If any dependency is patched (`pnpm.patchedDependencies`), the install reads the patch files — **mount/COPY `./patches`** into every install context (the dev container *and* `Dockerfile.base`), or the install ENOENTs. Use an optional glob (`patches[/]*`) in Dockerfiles so branches with no `patches/` dir still build.
- **Pin pnpm per island** when a standalone app ships an old lockfile (a v6 lockfile can't be read by pnpm 10) — that island runs `--ignore-workspace` and declares its own `packageManager`.

**Image / process gotchas.**
- `node:*-alpine` sets no `$SHELL`; `chokidar-cli` throws *"$SHELL environment variable is not set"* and (via `concurrently --kill-others`) takes the whole container down → 502. Set `SHELL=/bin/sh`.
- Healthchecks: probe **`127.0.0.1`**, not `localhost` — busybox `wget` resolves `localhost` to `::1`, but `sirv`/Vite bind IPv4 `0.0.0.0` only, so a `localhost` probe is refused and the service reads as falsely "unhealthy".
- Set per-service `mem_limit` and raise `ulimits.nofile` (polling watchers exhaust the default FD limit).
- Any Next app that must run in Docker needs `output: 'standalone'` and an **exec-form** `CMD` (JSON array) so it's PID 1 and receives SIGTERM (see §17).

---

## 22. Design system: token single-source, Storybook & mock-UI surfaces

A multi-surface product (web + native + marketing) drifts visually unless tokens have **one source** and components have **one catalogue**. Set both up before the second surface exists — retrofitting a token source across N hand-synced copies is exactly the rework this avoids.

**Tokens: one source, everything generated.** Keep design tokens in a single library (`libs/design-tokens/src/tokens.ts`) and **generate** every downstream copy — CSS custom properties, a Tailwind preset, a Chakra/shadcn fragment, React-Native token objects. A `tokens:sync` script writes them; a `tokens:check` script regenerates in memory and **fails CI on any drift**. Apps that can't import the lib (npm-isolated native islands, §18) get a **generated + committed** copy guarded by the same drift gate. **Never hand-edit a generated token file.**

**Two Storybooks in 1:1 parity.**
- **HTML-reference Storybook** — raw HTML/CSS using the exact tokens. The source of truth for *how it should look*. Organise as `foundation/` (tokens) → `primitives/` → `patterns/` (composed combinations) → `pages/` (full compositions) → `consistency/` (the do/don't + "one way" rules).
- **React host Storybook** — the production components with Controls. The source of truth for *how it's built*. It **composes the HTML reference via `refs`** (the ref iframe loads in the browser, so point it at the reference Storybook's **published port**, not a proxied top-level host).
- **Parity is the rule:** every HTML story has a React counterpart and vice-versa — no orphans. Converting an AI-designed HTML mock to React means matching its reference story exactly.

**Mock-UI preview app (optional, high-leverage for design handoff).** A lean standalone app that renders full-page mock-ups + a component gallery, with an `index.html` **hub** linking every design surface. Keep it dependency-light — an in-browser transform (`@babel/standalone`) + a static server (`sirv`) + a file watcher (`chokidar`) is enough; it needs *none* of the product's heavy deps, which is what makes its container install tiny (the lean filtered install in §21). Treat its built HTML as a build product — never hand-edit it; edit the `*.jsx` source and let the watcher rebuild.

**Serving scheme (ties §20 + §21 together).** Put the design surfaces on a predictable host map: a **hub** host plus, per system, `<system>` (interactive preview/flow) and `<system>-atlas` (its component catalogue / Storybook):

```
<project>.local                       → web app
api.<project>.local                   → API (dev convenience only; the BFF rule still applies)
mock.<project>.local                  → design-system HUB (landing page linking every surface below)
web.mock.<project>.local              → web preview / mock-UI app
web-atlas.mock.<project>.local        → web React Storybook
<native>.mock.<project>.local         → native flow (react-native-web)
<native>-atlas.mock.<project>.local   → native Storybook
```

- Use **dedicated `-atlas` subdomains, not `/atlas` sub-paths** — sub-path routing breaks Storybook's absolute asset URLs. `<system>` vs `<system>-atlas` is grep-able and lets every surface reload independently.
- The hostnames are a convention (`.local`/`.mock` resolve via `/etc/hosts`); keep the repo `Caddyfile` host map and the compose port map as the single readable index of what's where.

**Storybook in a monorepo:** scope `vite-tsconfig-paths` (or any tsconfig-path plugin) to **each app's own tsconfig** in `.storybook/main.ts`. Left unscoped it eagerly crawls *every* tsconfig in the workspace (sibling apps, agent worktrees) and aborts the build if any `extends` can't resolve.

---

## 23. Build & worktree hygiene (parallel-agent DX)

When many agents (or many feature branches) build in parallel, the toolchain itself becomes the bottleneck. Settle these once.

**Fast, crash-free typecheck.** Full `tsc` over a large monorepo can hit a V8 stack overflow (exit 134), and it's slow. Adopt **`tsgo` (`@typescript/native-preview`)** as the `typecheck` target (~10× faster, no stack-overflow) with a per-project `tsconfig.tsgo.json`; keep a `typecheck:tsc` fallback for anything tsgo can't yet handle. Run gates with the Nx/Turbo daemon disabled or bounded parallelism so N worktrees don't all spawn daemons at once.

**Git worktrees for parallel work — install, don't symlink.** Each worktree carries a **real** `node_modules` (pnpm copies, not hardlinks across worktrees), is watched by watchman, and can spawn its own Nx/Turbo daemon — so stale ones tax disk and idle CPU.
- **Do a real `pnpm install` in each worktree, not a `node_modules` symlink.** A symlink satisfies `tsc`, but Turbopack `next build` panics (*"symlink points out of filesystem root"*). A real install also recreates `.husky/_`, so the **pre-push gate actually runs** — a bare `git worktree add` leaves no `.husky/_` and the gate silently no-ops. Wrap worktree creation in a script that bootstraps husky.
- **Prune merged worktrees periodically.** A prune script should remove a worktree **only** when its tree is clean **and** its HEAD is an ancestor of `origin/main`/`origin/staging` (fully integrated — nothing is lost, git keeps the branch + history); stop that worktree's daemon before removal; default to a dry run, with `--apply` to act.
- Add a `.watchmanconfig` to bound the watch surface.

---

## 24. Environment- and tenant-correct behaviour

The server is the only thing that reliably knows *which environment* and *which tenant* a request belongs to. Push these decisions to the backend and have the client consume the answer.

- **The backend is the single authority for environment-dependent behaviour.** A client/SSR build often *can't* tell staging from production — many frameworks set `NODE_ENV=production` for **every** non-dev build, staging included — so any "do X in staging but not prod" decision made in the web/client build is wrong half the time. Resolve environment-gated behaviour (feature flags, test-only affordances, internal-user visibility) on the server/API by its **own runtime environment**, and have the client just read the resolved answer. Never branch on `NODE_ENV` / a public env var in client code for these.
- **Feature flags: env-targeted, evaluated server-side, for *complete* features only.** Persist them (DB) with a per-environment config and evaluate on the API by its runtime env; the client reads the resolved value. Flags are for rollout / A-B / kill-switch of **finished** features — never to hide incomplete, mocked, or fallback code.
- **Gate internal / test users — environment-aware, at the data source.** Staff/test accounts (e.g. everyone on your own email domain) must be hidden from customer-facing people-pickers / lists / counts **in production only** (kept visible in staging so the team can test assign/share/approve flows), and — critically — the **only** recipients of outbound email / push / notifications in **non-production** (a staging test run must never email or notify a real customer). Enforce both at the **backend data source and the outbound choke points** (the tenant-scoped finder, the email sender, the notification dispatcher), not in the client — per the single-authority rule. A separate service that owns its own outbound (e.g. a standalone push service) needs the same guard replicated, or staging push leaks to real devices.
- **The browser never calls the backend directly — go through your own API layer (BFF).** All client HTTP goes through your app's route handlers, which attach auth + tenant context server-side; the only exception is WebSocket/SSE (can't be proxied). Enforce it with a lint rule that blocks the public backend URL and `axios` in client code, so the boundary can't erode.
- **Multi-tenant context is server-authoritative.** The active tenant lives in an httpOnly cookie (the authority), forwarded as a header to the backend; any client-side copy (sessionStorage) is a non-authoritative cache — always populated *from* server responses, never the source of an access decision. Never hardcode a tenant fallback id (`'default-company'`); resolve it from the session or fail closed. Centralise session-validation and header-building in **one** shared helper each — don't let every route handler reinvent them (drift is how an auth check gets skipped).

---

## 25. Changing a security control safely + debugging the request path

Security tightening repeatedly ships *working-but-breaks-a-legit-flow*. Request layers fail **in order** and each failure **masks the next** (input sanitisation 400 → auth 401 → RBAC 403 → schema validation 400 → handler) — so after changing any one layer, exercise the affected endpoints **end-to-end with a real payload and the real auth mode**; don't conclude from the first error that there's only one bug. Each recurring failure below is a generalizable rule:

- **An internal secret-authed endpoint must be exempted from *every* global middleware at once** (sanitisation *and* auth/RBAC). Exempting one exposes the other as a "new" bug. Keep the path match **segment-anchored** so it can't leak to sibling routes, and confirm the endpoint's own secret check still rejects a missing/wrong secret.
- **Calibrate size/validation caps against the largest *real* payload, not a guess.** A `@MaxLength` / `.max()` set to a round number has rejected real production documents. The cap's job is to stop unbounded abuse, not to encode a guess about typical size.
- **Tighten a schema against what the *producer actually emits*, never by adding new required fields.** Requiring a field the producer doesn't always send rejects every valid payload. Tighten with `.optional()` fields, array/size caps, and removing `.passthrough()` — those reject malicious extras without rejecting valid existing data. Grep the producer (and a stored payload) before requiring anything.
- **`forbidNonWhitelisted` / strict shapes break clients that round-trip persisted objects** — edit forms re-send server-managed fields (`_id`, timestamps). Audit every caller and have them send only the whitelisted fields.
- **Never register a route permission no role actually grants** — it silently 403s every user of the feature. Confirm the permission string exists in some role's grant list, or let the route fall through to plain authentication.
- **Sign OAuth `state` and bind it to a nonce cookie.** For any OAuth connect/callback flow, HMAC-sign the `state` and bind it to a short-lived httpOnly nonce cookie — unsigned/base64-only state lets an attacker craft `{ userId: <victim> }` and graft their own token onto the victim's account. The signing secret is required at runtime; throw if it's unset.

**Debug the request path by instrumenting boundaries first — don't chase error strings.** In a multi-hop system (browser → BFF → backend), add logging at the boundary points (route handler, controller) to capture the *actual* status and body **before** searching the codebase for the error text. The reported string is often stale (a previous version), transformed by an intermediate layer, or a fallback message masking the real error. Two specific traps: a global **response interceptor that wraps handler returns** in `{ success, data, … }` means consumers must unwrap exactly one level — a double-wrap or a missing unwrap reads as a "shape" bug; and **don't assume JWT claims are populated** (in some local/impersonation setups `email`/`name` are empty) — look the user up from the DB rather than trusting the token fields.

---

## 26. Anti-patterns to avoid

- **Don't add features behind feature flags from day one.** Real users haven't validated anything yet. Ship straight to main, revert with git.
- **Don't write abstraction layers over a single use case.** "Repository pattern" over Mongoose, "Service layer" over a single Route Handler — premature. Three similar lines beats a premature abstraction.
- **Don't mock external services in tests.** Use real test accounts (Stripe test mode, Resend sandbox domain, MongoDB Atlas test cluster). Mocks pass while prod fails — see Resend's free tier.
- **Don't store secrets in `next.config.mjs` or anywhere bundled.** Even server-only files — keep secrets in env, not source.
- **Don't add `any` to silence the type checker.** Use `unknown` and narrow, or fix the upstream type. Every `any` is a future bug.
- **Don't skip the `import 'server-only'` line.** It's two seconds. It will save you a `BLOB_READ_WRITE_TOKEN` leak someday.
- **Don't ship features untested and plan a "coverage sweep" later.** Backfilling tests, contracts, a logging facade, and security headers across N apps is a top rework driver — and the sweep keeps finding real production bugs. Scaffold the harness (§15) and test-as-you-go.
- **Don't let a spec's word "CI" auto-summon GitHub Actions.** Decide the gate first (§19). A pipeline scaffolded on reflex, then torn out, is pure churn.
- **Don't cast untrusted input into a type.** `as`, `.passthrough()`, `as unknown as T` are not validation — parse with Zod at every boundary (`res.json()`, webhook bodies, queue messages, pagination cursors). See CODING_PRACTICES §1.
- **Don't bind-mount `node_modules` into a dev container.** The container's install clobbers the host's modules (or symlinks break across OSes). Mount source only; use named module volumes (§21).
- **Don't expect file-watching to work in Docker Desktop without polling.** Native FS events don't cross the bind mount; the app just won't reload and you'll chase a phantom. Turn on polling, scoped to Docker (§21).
- **Don't let a bind-mounted parent dir drag heavy *unused* subtrees into the macOS VM.** An isolated island's `node_modules` + native `ios`/`android` build dirs shared into every container can exhaust the host's system-wide `kern.maxfiles` and `ENFILE` *unrelated* apps (native build tools, browsers) — a baffling failure since per-process limits look fine. Mask them with empty anonymous volumes and raise `kern.maxfiles` (§21).
- **Don't route a Storybook / atlas under a sub-path.** Its absolute asset URLs break — give it its own subdomain (§22).
- **Don't hand-edit a generated token file or a built mock HTML.** Edit the source (`tokens.ts`, the `*.jsx`) and re-run the generator/watcher; the drift gate will catch you otherwise (§22).
- **Don't symlink `node_modules` into a worktree.** It satisfies `tsc` but Turbopack `next build` panics, and it skips husky so the pre-push gate silently no-ops. Real `pnpm install` per worktree (§23).
- **Don't boot local dev on a different transpiler than the prod build.** A separately-compiled SWC server (NestJS/etc.) run in dev via `ts-node`/`tsc` hides SWC-only boot crashes — a circular-import TDZ crash-loops prod while dev is fine. Share one compiler: `@swc-node/register` for the dev boot, and keep jest configs `.js` so nothing drags `ts-node` back in (§15).
- **Don't ship a fallback that masks a real failure.** Returning canned text / mock data / `null` when the real path errors (`if (!x) return "…generic message…"`) hides the bug and ships a broken feature as "working." Throw with context; if you can't implement it for real, say so and stop — don't paper over it. Mocks live only in tests.
- **Don't let a partial upstream object short-circuit field population.** A resolver/mapper that returns early on "the object exists" silently drops fields a richer source *has* but the partial lacks (a curated summary present, the live metrics null). Merge/backfill from the authoritative source — and gate an expensive backfill behind an "is this field actually requested" (selection-set) check so it doesn't fan out across a list query.
- **Don't `JSON.parse` a response before checking its status.** A failing serverless endpoint returns a non-JSON error page; parsing first throws an opaque error that discards the real HTTP status and (for auth refresh) drives an infinite retry (§9).
- **Don't ship two apps from one codebase under a shared bundle id / URL scheme.** They install over each other, share a keychain/secure-store namespace, and race for the same deep link. Distinct identity per app, changed together (§18).
- **Don't branch on `NODE_ENV` in client code to tell staging from prod** — it's `production` for both. Resolve env-gated behaviour (flags, test affordances, staff gating) on the server (§24).
- **Don't run the whole quality gate on every push regardless of scope.** Path-scope it (fail-safe), or a mobile/docs-only push pays for a full web+api build it can't affect (§19).
- **Don't change one security layer and ship.** Layered failures mask each other — exercise the affected endpoints end-to-end after any sanitisation / auth / RBAC / validation change (§25).

---

## 27. Day-one setup checklist

```
[ ] npx create-next-app@latest --typescript --eslint --app --turbopack
[ ] Add `import 'server-only'` package: npm install server-only
[ ] Set up tsconfig path alias @/* → ./*
[ ] vercel link
[ ] Provision DB (Mongo Atlas or Neon) via Vercel Marketplace
[ ] Provision Redis (Upstash) via Vercel Marketplace — only if needed
[ ] Copy CODING_PRACTICES.md + NEW_PROJECT_BEST_PRACTICES.md into docs/
[ ] Add DESIGN.md (run /design-md-from-screenshots against your reference site)
[ ] Copy CLAUDE-STARTER.md → CLAUDE.md (fill every placeholder with verified reality, delete the instruction block) and `ln -s CLAUDE.md AGENTS.md`
[ ] Configure security headers + CSP in next.config.mjs
[ ] Wire Vercel AI SDK + AI Gateway env vars
[ ] Wire Resend + verified sender domain
[ ] Set up email-code sign-in flow
[ ] Add JWT_SECRET, ADMIN_JWT_SECRET (openssl rand -base64 32)
[ ] Pick the local domain (`<project>.local`), add a root `Caddyfile`, document `/etc/hosts`, and set app/WebSocket env vars to the Caddy origin
[ ] First Playwright test: sign-up → sign-in → first authenticated page
[ ] Open a PR; confirm preview deploy URL works end-to-end

# If multi-app / monorepo / native (see §17–§23):
[ ] DECIDE repo shape: single app vs pnpm + Turborepo monorepo (§17) — retrofitting later is expensive
[ ] DECIDE quality gate: hosted CI vs husky pre-push hook, and write it down (§19)
[ ] Monorepo: pnpm-workspace.yaml + turbo.json + ONE root .gitignore; overrides/allowBuilds in the workspace file
[ ] Expo/RN app: node-linker=hoisted in root .npmrc + monorepo-aware metro.config.js (§18)
[ ] Cross-app wire shapes: shared packages/contract OR bidirectional parity tests wired into the gate (CODING_PRACTICES §6.10)
[ ] Scaffold the test harness (in-memory Mongo, server-only stub, hermetic vs integration split) BEFORE the first feature (§15)
[ ] Native: distinct bundle id / URL scheme / OAuth redirect / deep-link prefix per sibling app; flag the OAuth-callback + push-provider re-registration follow-ups (§18)
[ ] Native: device E2E (Maestro/Detox) covering return paths (back/close/dismiss) + testIDs on entry points and data cells (§18)
[ ] Gate: make the pre-push path-aware — run each app's checks only when it or shared code changed; fail-safe; force-all escape hatch (§19)
[ ] Resolve env-gated behaviour (flags, test affordances, staff visibility) on the server, not the client build; gate internal/test users + non-prod outbound at the data source (§24)
[ ] Separately-compiled API (NestJS/etc.): local dev boot uses the same SWC transform as the prod build (`node -r @swc-node/register`), jest configs are `.js` not `.ts`, and scripts use `tsx` — so nothing in the workspace needs `ts-node`; typecheck via `tsgo` (§15, §23)

# Local dev environment (see §20–§23):
[ ] One shared machine-wide Caddy on :80; per-repo conf.d/<repo>.caddy mirrors the repo Caddyfile route blocks (strip the global block) (§20)
[ ] docker-compose.dev.yml: one service per app + infra; source bind-mounts only; per-service node_modules + pnpm-store volumes (NEVER bind-mount node_modules) (§21)
[ ] Polling file-watch scoped to Docker (CHOKIDAR_USEPOLLING / WATCHPACK_POLLING / Vite usePolling + allowedHosts + HMR clientPort=80) (§21)
[ ] Mount ./patches into every install context; SHELL=/bin/sh on alpine; healthchecks probe 127.0.0.1; keep workspace exclusions in sync after renames (§21)
[ ] Mask heavy unused subtrees nested under a bind mount (isolated-island node_modules, native ios/android) with empty anonymous volumes; raise macOS kern.maxfiles to 524288 as a safety net (§21)
[ ] Design tokens: single libs/design-tokens source + tokens:sync / tokens:check drift gate; islands get a generated+committed copy (§22)
[ ] Storybook: HTML-reference ⇄ React-host in 1:1 parity (host composes reference via refs); -atlas subdomains, not /atlas sub-paths (§22)
[ ] Worktrees: real pnpm install (not symlink) via a husky-bootstrapping wrapper; periodic prune of clean+merged worktrees; tsgo for fast typecheck (§23)
```

If a section here doesn't apply (e.g. no AI features, no admin UI), skip it — but read it once so you know what you're skipping.
