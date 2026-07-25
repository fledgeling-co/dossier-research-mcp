# CODING_PRACTICES.md

**Audience: AI coding assistants (e.g. Claude Opus 4.8) writing or modifying code in this repo.** This is an operating spec, not background reading — load it before you generate code and apply it *as you write*, not only at review time. The rules are distilled from the high-signal checks the `code-review` skill uses to block or flag PRs; follow them while writing and the review comes back clean.

## How to use this document (agent protocol)

1. **Apply while generating.** Treat every rule below as a constraint on the code you emit, not a post-hoc lint. Prefer the compliant pattern by default; never emit a known anti-pattern intending to "fix it later."
2. **Severity keywords are load-bearing.** **MUST / NEVER** (and the existing **Always / Never** phrasing) are hard constraints — violating one is a bug, not a style choice. **SHOULD / PREFER / AVOID** are strong defaults; deviate only with a stated reason.
3. **Precedence when rules conflict:** `CLAUDE.md` > this document > your own inference. Within this document, the audit-derived rules in §6 refine the generic rules in §1–§5 where they overlap (newer wins). Verify every version-sensitive rule against the live `package.json` before applying it — do not assume a framework major.
4. **Never silently skip a rule.** If a constraint genuinely doesn't apply (different framework version, deliberate design choice), say so explicitly in your response or a code comment — an unexplained deviation reads as a mistake to the next reviewer.
5. **Self-review before you report done.** Run the §7 checklist over the diff you produced and state which files you covered. Never claim adherence you haven't verified; if a check fails, report it with the output rather than asserting success.
6. **No invented APIs.** Every symbol, import, env var, and file path you reference must exist in this repo or in a pinned dependency — grep or read to confirm before citing. When you can't verify, say so instead of fabricating.

Scope: **NestJS API**, **Next.js 15/16 App Router + React 19**, **TypeScript**, **security** — plus client React / React Native hygiene (§6.15) for repos with an Expo client.

This document does **not** repeat the guardrails already in `CLAUDE.md` (no mocks/stubs/placeholders, BFF pattern, validateSession, company-context, HTTP-only cookie tokens). Those still apply with full force.

---

## 1. TypeScript — boundary safety

### Compiler settings
- Never weaken `tsconfig.json` strictness (`strict`, `strictNullChecks`, `noImplicitAny`, `strictFunctionTypes`, `noUncheckedIndexedAccess`). Config changes opt *into* more strictness, not out — a diff that flips one of these off is a bug, not a style choice.

### Types at module boundaries
- Declare explicit return types on exported functions, exported class methods, API handlers, and Server Actions. Inferred return types change silently when bodies change.
- Never return a full DB entity / ORM row from a public boundary (API handler, Server Action, resolver). Pick the fields the caller needs — sensitive columns (`passwordHash`, `apiKey`, `mfaSecret`, internal flags) otherwise leak through to the client.
- Re-export types with `export type { Foo }`, not `import { Foo } from …; export { Foo }`.

### `any`, `unknown`, and casts
- Never introduce `any` (explicit or implicit). Use `unknown` and narrow with a type guard or Zod.
- `as` casts are acceptable only for (a) disambiguating a union the compiler can't narrow on its own, or (b) wrapping library output with verifiably wrong types. Never on user input or `JSON.parse`.
- `as unknown as T` is almost always the wrong answer — fix the source type or build a real adapter.
- Non-null `!` only when the value is provably non-null from surrounding code. Otherwise narrow explicitly.
- `@ts-ignore` / `@ts-expect-error` / `// eslint-disable-next-line` must include a reason comment on the same line — no bare suppressions.

### Discriminated unions
- Every `switch` over a discriminant needs an exhaustiveness `default`:
  ```ts
  default: { const _exhaustive: never = s; return _exhaustive }
  ```
- When you add a variant to a union, grep every usage of the discriminant and update each switch/if-chain. The compiler only helps if you have the exhaustiveness default.
- An `if`/`else-if` chain over a discriminant can't be compiler-checked — convert it to a `switch`, or end it with `assertNever(x)` in the final `else`.

### Promises & async
- No floating promises. Either `await`, `.catch(handler)`, or prefix with `void` to mark fire-and-forget intentional.
- Never use `forEach` with an `async` callback — it ignores the returned promises. Use `for...of` + `await` or `await Promise.all(items.map(...))`.
- In tests, `await expect(asyncFn()).resolves.toEqual(...)` — never `expect(asyncFn()).toEqual(...)`.
- Don't wrap an existing promise in `new Promise((resolve, reject) => { p.then(resolve, reject) })` — just return `p`.
- Don't mix `.then()` chains and `await` in the same function — pick one style.

### Errors
- `catch (e: unknown)` — never `catch (e: any)`. Narrow with `instanceof`.
- Re-throwing: use `throw new Error('context', { cause: originalError })` to preserve the stack. Do not do `throw new Error(originalError.message)`.
- Don't `catch { return null }` to silence errors. If the caller has nothing actionable, at least log. Otherwise rethrow.

### Runtime traps
- Never assign `JSON.parse(...)` directly to a typed variable — validate with Zod first.
- `useState<User>()` implicitly means `User | undefined`. Prefer `useState<User | null>(null)` so null-checking at use sites is mandatory.
- Don't use `?.` to hide a contract violation. If `user` must exist at a code path, assert/throw, don't optional-chain past it.

### Trust-boundary validation
- **LLM output is a trust boundary.** Zod-parse every model / tool-call payload before persisting or branching on it; constrain closed sets with `z.enum([...])` and keep the exhaustiveness `default` at every consumer. When a deterministic function is replaced by an LLM call, re-audit every consumer as if the input were user-supplied.
- **Every value crossing a trust boundary gets a runtime schema, not a cast.** This covers `fetch` / `res.json()`, webhook bodies, queue messages, request bodies, and especially auth / token-refresh responses. `as`, `.passthrough()`, and `as unknown as T` are never validation. Persist only the schema-parsed result; a malformed body must yield a 4xx, never a raw 500 from indexing into it (`body.payload.clientPayload`). At an API→domain boundary in a client, validate against the authoritative allowlist (reuse existing label/enum maps) — never `as unknown as Target` an untrusted string into a union.
- **Every user-controlled string field needs an explicit `.max()`** — free text, tokens, and URLs alike. One uncapped `.min()`-only body field allowed a multi-megabyte persisted record (storage/bandwidth DoS) while its siblings were capped. Define length constants centrally so create/patch schemas stay consistent, and pair with an upstream request-body-size limit.
- **For skip-not-fatal / at-least-once ingestion, validate the envelope separately from each item.** Validating a whole array with one strict schema makes a single bad item abort the entire page (and makes the loop's per-item `safeParse` dead code). Validate items individually inside the loop, log field-paths-only (never the value), and skip the bad one so the rest applies.

---

## 2. NestJS API

### Dependency injection
- Every provider class needs `@Injectable()`. Without it, DI cannot resolve its own dependencies.
- Never `new SomeService(...)` for a class registered as a provider — the IoC container is bypassed and singletons/scopes break. (DTOs, entities, value objects are fine to `new`.)
- Prefer constructor injection over property `@Inject(...)`. Property injection is only for subclasses threading deps through `super()`.
- `@Optional()` on an injected token is only for dependencies with a genuine fallback. If the token is mandatory but registered in another module, fix the module wiring — don't mask the bootstrap failure.
- Don't reach for `ModuleRef.get()` / `app.get()` inside services. Acceptable in `main.ts`, factories, or request-scoped resolution in tests.

### Modules
- A provider used outside its declaring module must be listed in that module's `exports` array.
- Never declare the same provider in two modules' `providers` arrays — that creates two separate singletons and state diverges.
- Don't add `@Global()` to a feature module. Reserve it for infrastructure (config, logger, db).
- Don't import module/provider classes through barrel files — causes silent resolution-order inversion and undefined deps.
- A new feature gets its own module. Don't dump it into `AppModule`.

### `forwardRef` and circular deps
- Avoid `forwardRef()` by default. When two modules depend on each other, extract shared logic into a third module, switch one direction to event-driven, or resolve at call time via `ModuleRef.get(...)`.
- Never combine `forwardRef()` with `Scope.REQUEST` — order of instantiation is undefined.

### Scope
- Think twice before adding `Scope.REQUEST`. The scope bubbles up the injection chain — everything transitively depending on a request-scoped provider becomes request-scoped, which is very slow and breaks lifecycle hooks.
- Never request-scope a WebSocket Gateway or a `@Cron` / scheduled job — they cannot be instantiated multiple times.
- `onModuleInit` / `onModuleDestroy` / `onApplicationBootstrap` **do not fire** on request-scoped classes. Don't add lifecycle hooks to a `Scope.REQUEST` provider.

### Validation
- Register the global `ValidationPipe` once — `{ provide: APP_PIPE, useClass: ... }` — with `{ whitelist: true, forbidNonWhitelisted: true, transform: true }`. Without the global registration, DTO decorators are never enforced; everything below assumes it exists.
- A method-scoped `@UsePipes(...)` applies to **every** parameter in the signature. When only one param needs a special pipe, bind it per-parameter (`@Body(new ParseArrayPipe(...))`) and confirm no param is left unvalidated.
- `ValidationPipe` only validates **class-based DTOs** with `class-validator` decorators. Typing `@Body()` as `any`, an interface, or `import type { Dto }` disables validation entirely.
- Array bodies need `@Body(new ParseArrayPipe({ items: CreateXDto }))` or a wrapper class with `@ValidateNested({ each: true }) @Type(() => CreateXDto)`.
- Each DTO field needs at least one `class-validator` decorator (`@IsString()`, `@IsEmail()`, etc.). Bare `field: string` is not validated.
- Don't use generic DTOs — TS doesn't emit runtime metadata for generics, so `ValidationPipe` can't validate them.
- Match `PartialType` / `PickType` / `OmitType` to your DTO's decorator ecosystem: `@nestjs/mapped-types` for plain, `@nestjs/swagger` for Swagger DTOs, `@nestjs/graphql` for GraphQL.

### Global enhancers (pipes, guards, filters, interceptors)
- If a global enhancer needs DI, register it via `{ provide: APP_PIPE, useClass: … }` (or `APP_GUARD`, `APP_FILTER`, `APP_INTERCEPTOR`). `app.useGlobalPipes(new ValidationPipe())` cannot inject anything.
- When using `APP_*` tokens, use `useClass` or `useFactory` (not `useValue`, which disables injection). Ensure any module-scoped deps are visible from the registering module.
- Declare catch-anything filters **first**, specific-type filters after, so the specific filter actually fires.
- In a hybrid HTTP+microservice/gateway app, enhancers registered via `app.useGlobalX()` don't apply across all transports. Use `APP_*` providers to propagate.

### Exception handling
- Throw specific `HttpException` subclasses: `BadRequestException`, `NotFoundException`, `ForbiddenException`, `ConflictException`, etc. — not `new HttpException('msg', 500)` or plain `Error`.
- When rethrowing, preserve the cause: `throw new BadRequestException('msg', { cause: err, description: 'detail' })`.
- `@Catch()` with no args creates a catch-all. In hybrid apps, switch on `host.getType()` (or `switchToHttp()` / `switchToRpc()` / `switchToWs()`) before touching request/response objects. Use `HttpAdapterHost` for responses — don't hardcode Express/Fastify APIs.
- Use `@UseFilters(MyFilter)` (class form), not `@UseFilters(new MyFilter())` (duplicates the instance).
- `HttpException` subclasses are **not logged** by Nest by default — where observability matters, add an `AllExceptionsFilter` that logs them.
- RxJS traps: `tap(sideEffect)` followed by `catchError(() => EMPTY)` silently swallows the side-effect's failure — log or rethrow. An interceptor that returns `Observable<Promise<T>>` never awaits the inner promise — wrap it with `from(...)` / `mergeMap(() => from(...))`.

### Lifecycle & cleanup
- If the app has background work (intervals, queue consumers, WebSocket sessions), ensure `app.enableShutdownHooks()` is called in `main.ts`. Otherwise `onModuleDestroy` / `onApplicationShutdown` never fire on SIGTERM.
- Any service holding `setInterval` / `setTimeout` / RxJS subscriptions / event listeners must implement `OnModuleDestroy` and dispose them.
- Heavy startup work (DB warmup, cache prefill) goes in `onApplicationBootstrap`, not `onModuleInit`.

### Decorator placement gotchas
- `@Public()` on a method inside a controller class with `@UseGuards(JwtAuthGuard)` makes the method public. Only add it intentionally, and confirm the method doesn't read `request.user` (which won't be set).
- Order of `@UseGuards(...)` / `@UseInterceptors(...)` matters — within each kind, execution is in the order listed.

### Tests
- Always `await Test.createTestingModule(...).compile()`. Forgotten `await` = uninitialized module.
- For request-scoped or transient providers in tests, use `moduleRef.resolve(Token, contextId)`, not `moduleRef.get(...)`.
- Globally registered guards/pipes/filters via `APP_*` cannot be overridden with `.overrideProvider()`. Production pattern: `{ provide: APP_GUARD, useExisting: JwtAuthGuard }` + `JwtAuthGuard` as a separate provider, then override `JwtAuthGuard` directly in tests.
- E2E tests must `await app.close()` in `afterAll`.
- Prefer `.overrideProvider(...)` over `jest.mock(...)` — the former goes through the DI container.
- Repository mocks need the canonical token: `{ provide: getRepositoryToken(Entity), useValue: {...} }`. A bare `useValue: {}` won't inject.
- **Jest transform: use `@swc/jest`, not `ts-jest`.** `ts-jest` type-checks every file on every worker — the dominant cost of a slow suite. Type-checking belongs to a separate `tsc`/`tsgo --noEmit` gate, not the runner; jest only needs types *stripped*, which SWC (Rust) does ~10–20× faster. For NestJS the SWC config **must** emit decorator metadata or DI silently fails to resolve: `jsc.parser.decorators: true`, `jsc.transform.{ legacyDecorator: true, decoratorMetadata: true }`, `keepClassNames: true`, `module.type: 'commonjs'`. Set `coverageProvider: 'v8'` (SWC emits no istanbul instrumentation — the default `babel` provider silently reports 0%). Do **not** copy your build `.swcrc`'s `jsc.paths`/`baseUrl` into the jest transform when a jest `resolver`/`moduleNameMapper` already maps your workspace aliases — SWC path-rewriting fights the resolver.
- **On Jest 30, take the opt-in wins:** `testEnvironmentOptions.globalsCleanup: 'on'` (the large memory reduction is opt-in, default `'soft'` only warns), a `workerIdleMemoryLimit` to recycle ballooning workers, and gate coverage + workers so interactive runs stay lean (`collectCoverage: !!process.env.CI`, `maxWorkers: isCI ? '50%' : 4`) — a 16-core box should not run 8 heavy workers fighting for RAM interactively.

### ORM hazards
- Never write a loop that does `await repo.find(...)` per item. Use `relations: [...]` (TypeORM) or `include: {...}` (Prisma) on the initial query.
- Mark sensitive columns with `{ select: false }` (TypeORM) or use `omit` / explicit `select` (Prisma) so default queries don't leak them.
- Multi-statement mutations go inside `dataSource.transaction(...)` (TypeORM) or `prisma.$transaction([...])` (Prisma).
- **Never** build SQL with template-literal interpolation. Always parameterize: `queryRunner.query('... WHERE id = $1', [userId])` or `prisma.$queryRaw\`...\``. Raw concatenation of user input into SQL is SQL injection.
- Add `@Index` to foreign key columns you'll query against.

---

## 3. Next.js (App Router) + React 19

### Server Actions — security is not optional
Every function in a `'use server'` file is reachable as a **direct POST endpoint**, not just through the UI. Every Server Action must:

1. **Authenticate** — verify a session at the top.
2. **Authorize** — check the user owns or has permission to act on the specific resource (prevents IDOR).
3. **Validate input** — parse `FormData` / arguments with Zod (or `zod-form-data` for multi-value fields; `Object.fromEntries(formData)` silently drops repeated keys).
4. **Never return raw DB records** — pick fields explicitly.
5. **Never capture secrets in the closure** — even though Next encrypts closed-over variables, read secrets inside the action body.

Files with secrets / DB access must start with `import 'server-only'` (first import). This makes the bundler throw if the file is ever imported into a client bundle.

Mutations (`db.x.update`, `revalidateTag`, `revalidatePath`, logout) must never happen as a side-effect of render. They belong in Server Actions invoked by user gestures or in Route Handlers invoked by webhooks.

If deployed behind a proxy/CDN that rewrites Host, configure `experimental.serverActions.allowedOrigins` in `next.config.js` — otherwise Next's automatic CSRF check rejects every action POST.

### RSC vs Client Component boundary
- Server Components run in Node — no `window`, `document`, `localStorage`, `sessionStorage`, `navigator`, or DOM APIs. To use them, either mark the file `'use client'`, move the access into `useEffect`, or isolate with `dynamic(() => import(...), { ssr: false })`.
- Never render non-deterministic values during render: `Date.now()`, `new Date()`, `Math.random()`, `crypto.randomUUID()`, locale-dependent `toLocaleString()`. Pass stable values from server as props, or compute after hydration in `useEffect`.
- Props from Server → Client must be serializable (no functions, class instances, Maps/Sets, Promises unless consumed with `use()`).
- A `'use client'` file (or anything it transitively imports) must not read `process.env.<NON_NEXT_PUBLIC_*>` or import DB / secret-bearing modules. Protect with `'server-only'` at the source.
- `<Context.Provider>` only works in Client Components. Wrap a provider in a `'use client'` component if rendering from a Server Component.
- Don't add `'use client'` to files with no client-side reactivity — it pulls the whole import subtree into the client bundle. Keep the boundary as low in the tree as possible.
- Route segments that fetch async data get `loading.tsx` and `error.tsx` boundaries — without them, slow networks show nothing and render errors bubble to the nearest (often root) boundary.

### Async runtime APIs (Next.js 15+)
- `cookies()`, `headers()`, `params`, `searchParams`, `draftMode()` are async — always `await` them.
- `cookies().set(...)` only inside a Server Action or Route Handler. Setting cookies during a Server Component render throws.
- Adding any of `cookies()`, `headers()`, `searchParams`, an uncached `fetch`, or `noStore()` to a previously-static route opts the whole segment into dynamic rendering. Notice when you're doing this.

### Caching (Next.js 15+)
- Default `fetch()` is no longer cached. Add `{ cache: 'force-cache', next: { revalidate: 600, tags: ['...'] } }` where caching is wanted.
- `revalidatePath` / `revalidateTag` only inside Server Actions or Route Handlers.
- `export const revalidate = 600` — must be a literal, not `60 * 10`.
- `unstable_cache` (or the `'use cache'` directive) keys on the explicit `keyParts` array. If the wrapped function reads `cookies()` / `auth()` / `headers()` from the closure, those must be in the key — otherwise cross-user cache leak.
- `dynamic = 'force-dynamic'` + `cache: 'force-cache'` contradict; pick one.

### React 19 hooks
- `useActionState` (from `react`) replaces `useFormState` (deprecated).
- `useFormStatus` only returns the **parent** form's status. Don't call it from the same component that renders the `<form>` — it silently never shows pending.
- `useOptimistic` depends on being inside a Transition. `<form action={...}>` provides one automatically; outside of one, React warns and state behaves unpredictably.
- In React 19, `ref` is a regular prop. Don't reach for `forwardRef` in new code unless you actually need it.
- `startTransition(async () => { ... })` — state read after `await` inside the callback may be stale. Snapshot values before awaiting.

### Hydration mismatches
- Don't conditionally render based on `typeof window !== 'undefined'` in the render path — server and client diverge by definition.
- `useState` initializers must not read `localStorage` / `sessionStorage` / `document`. Read in a `useEffect` after mount and `setState`.
- Don't nest `<p>` in `<p>`, `<div>` in `<p>`, `<a>` in `<a>`, or `<button>` in `<button>` — the reconciler rewrites silently.
- Don't use `suppressHydrationWarning` to silence a fixable mismatch — it's a targeted escape hatch, not a blanket fix.
- iOS Safari rewrites auto-detected phone numbers / dates / emails into links, diverging from the server HTML. When such content is SSR'd, add `<meta name="format-detection" content="telephone=no, date=no, email=no, address=no" />`.
- CSS-in-JS (styled-components / emotion) needs the SSR-aware style registry from the Next.js docs — without it you get hydration mismatches and FOUC.

### `next/image` and `next/link`
- `next/image` needs `alt` (use `alt=""` for decorative), plus either `width` + `height` or `fill` (with a sized parent). `fill` needs `sizes`.
- External `next/image` sources need a matching entry in `images.remotePatterns`.
- Use `<Link>` for internal navigation (prefetching + client-side nav). Leave `mailto:`, `tel:`, external URLs as `<a>`.
- `<Link target="_blank">` always needs `rel="noopener noreferrer"`.

### Route Handlers (`route.ts`)
- State-mutating handlers (POST/PUT/PATCH/DELETE) need explicit auth + authorization checks — not just proxy/middleware.
- Route Handlers **do not** have built-in CSRF protection. Use a custom header check (`X-Request-Source: web`), double-submit cookies, or manual `Origin` vs `Host` comparison.
- `context.params` is a Promise in Next 15+: `{ params }: { params: Promise<{ id: string }> }`, then `const { id } = await params`.
- `request.formData()` needs Zod validation before use.
- Session cookies: `httpOnly: true, secure: true, sameSite: 'strict'`, explicit `maxAge` and `path`.
- Webhook handlers verify the signature **before** reading the body. Pass the raw body (`await request.text()`) to the provider's verifier, **not** `await request.json()`.
- Rate-limit auth, password-reset, and email-sending endpoints.

### File uploads & external conversion services
Vercel serverless functions cap **request bodies at 4.5 MB**. Any upload / download flow that pushes raw file bytes through a Route Handler or Server Action will break for real-world files and produce opaque `FUNCTION_PAYLOAD_TOO_LARGE` errors. The rules below apply to every new upload path.

- **Upload client-side, not server-side.** Browsers must upload originals directly to Vercel Blob via `handleUpload` + a short-lived upload token (`/api/files/upload-token`, `/api/knowledge/upload-token`). Do not accept user file bytes through a Route Handler just to forward them to blob storage — that pins every upload to the 4.5 MB cap and wastes CPU decoding/re-encoding.
- **Pass URLs, not bytes, to downstream services.** Once the client has uploaded to blob, give external converters (markitdown-microservice, pageindex-node, any future doc-processing service) the **public Vercel Blob URL** and let them fetch the file themselves. Never base64-encode file contents into a JSON body — base64 inflates payloads ~33%, so a 3.5 MB PDF exceeds the 4.5 MB body cap before it even reaches the network.
  - `convertBlobUrlToMarkdown(blobUrl, mimeType, filename)` in `lib/files/convert-to-markdown.ts` is the only sanctioned entry point for markdown conversion in the web app. It POSTs `{ url }` to the microservice.
  - There is no `convertFileToMarkdown(buffer, …)`. Do not reintroduce one. If you find yourself wanting to convert a buffer, you probably meant to upload that buffer to Vercel Blob first and convert by URL.
- **Conversion is non-fatal.** The original blob must always be persisted before conversion runs. Conversion failures are logged (`captureConversionFailure(...)`) and surfaced to the caller as `markdownUrl: null`, but must never cause the overall upload to fail — the user still has a usable file in blob storage.
- **Client-upload routes still need auth.** `handleUpload`'s `onBeforeGenerateToken` runs inside your Route Handler — validate the session there before returning a token. Never issue a blob upload token to an unauthenticated request.
- **Synchronous vs webhook conversion.**
  - Synchronous flows (user needs `markdownUrl` in the immediate response): upload client-side, then call `/api/files/convert-blob` with the blob URL. Works identically in dev and prod.
  - Async flows (fire-and-forget): rely on the `onUploadCompleted` webhook inside the upload-token route. Note that Vercel Blob webhooks only fire in production, so `onUploadCompleted` is unreliable in local dev — the synchronous path is the fallback.
- **Size caps are defense in depth.** Enforce per-route maxima in `onBeforeGenerateToken` (`maximumSizeInBytes`) in addition to the downstream converter's own cap (markitdown-microservice allows up to 50 MB per document).

### Middleware / Proxy
- On Next.js 16+, rename `middleware.ts` → `proxy.ts`.
- Proxy auth is defense in depth — still verify authn+authz inside each Server Action / Route Handler. A matcher change or refactor can silently remove proxy coverage.
- `matcher` must be statically analyzable — no variables, no dynamic concat.
- To set headers on the **forwarded request**, use `NextResponse.next({ request: { headers: newHeaders } })`. `NextResponse.next({ headers })` sets *response* headers.
- If the proxy targets the edge runtime, no `fs`, `child_process`, `crypto.randomBytes`, native deps, or large compiled payloads.

---

## 4. Security (OWASP-aligned, cross-cutting)

### Access control (A01)
- Every state-mutating endpoint / Server Action authenticates **and** authorizes (resource-ownership check, not just "logged in").
- Deny-by-default auth: global guard + explicit `@Public()` opt-out, not opt-in per controller.
- Never trust the client filename on uploads. Sanitize, or rename to a server-generated UUID. Constrain MIME type, extension, size — and virus-scan user-facing uploads before serving them to other users.
- No mass assignment: never pipe the whole parsed body into `db.x.update({ data: req.body })` or `Object.assign(user, req.body)`. Use a class-validator DTO with `whitelist: true, forbidNonWhitelisted: true`, an explicit allowlist, or ORM projection.
- No open redirects: allowlist destinations or restrict to relative paths. After-auth open redirects are CRITICAL (can leak OAuth codes).
- **Authorization fails closed.** Missing/unknown moderation or status ⇒ deny / 404, never expose. A visibility check that defaults to *visible* on missing data is a leak.
- **Scope the owner/viewer into the DB filter itself** (`authorId` / `userId` in the query), not a post-fetch check — every read and mutation re-scopes its filter. Project private fields by viewer (self vs other); default to omitting and opt in to exposing.
- **Encode resource-access invariants (existence + ownership + moderation/visibility) in one mandatory loader** (`getPostOr404`, `findCommentById`) and route every handler touching the resource through it — never re-query the model inline. When an invariant applies to a family of parallel endpoints (report, react, delete-own), put it in shared logic so it can't be present in one route and missing in a sibling.
- **Privacy/visibility flags default closed (private)**, with the default defined once in the shared contract — server and client defaulting differently is a leak.

### Cryptography (A02)
- Passwords: hash with **argon2id** (preferred) or bcrypt cost ≥ 12. Never `md5` / `sha1` / `sha256` for passwords. If stuck with `crypto.scrypt`, set explicit `cost`/`blockSize`/`parallelization` — Node's defaults are too weak.
- Tokens (reset, session, invite): `crypto.randomBytes(32).toString('hex')` or `crypto.randomUUID()` — never `Math.random()`.
- JWT: never the `none` algorithm. Pin algorithms on verify: `jwt.verify(token, key, { algorithms: ['RS256'] })` (prevents HS/RS key confusion). Always set `expiresIn`. Never commit the secret — read from env. Prefer asymmetric signing (RS256/ES256) when multiple services verify but only one signs — verifiers then hold no signing secret.
- Session cookies: `httpOnly: true, secure: true, sameSite: 'strict'`. In production never `secure: false`.
- Never reference `process.env.<NON_NEXT_PUBLIC_*>` from a client bundle. Use `import 'server-only'` on the secret-bearing file.
- Compare secret material with constant-time equality: `crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))` (length-check first). Required for API keys, reset tokens, hand-rolled HMAC signatures, MFA codes.

### Injection (A03)
- SQL: always parameterize — `queryRunner.query('... WHERE id = $1', [id])` or `prisma.$queryRaw\`...\``. Never `$queryRawUnsafe(sql)` with user input.
- Mongo: strip `$`-prefixed keys from user input or validate with a strict schema before building the `where` filter.
- Shell: use `execFile` / `execFileSync` with an argument array. Never `exec` / `execSync` with interpolated user input.
- HTML: raw-HTML React props (the `dangerously*` set) must only ever receive sanitized output (run through a sanitizer like DOMPurify). Otherwise it's stored XSS.
- URLs: validate scheme before rendering a user-controlled string as `href` — block `javascript:` / `data:` schemes.
- Prototype pollution: avoid recursive merges on user input. If unavoidable, use `Object.create(null)` targets or a merge lib that rejects `__proto__`, `constructor`, `prototype` keys.
- Same rule for every query language: never concatenate user input into LDAP, XPath, or search-engine query strings — parameterize or escape, exactly as for SQL.

### Misconfiguration & headers (A05)
- Set security headers: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, CSP. Use `helmet` (NestJS) or `next.config.js` `headers()` / proxy.
- CORS: explicit allowlist — never `Access-Control-Allow-Origin: *` with `credentials: true`, never origin reflection (copying `req.headers.origin` back without a check), never `app.enableCors()` with no args in a credentialed API.
- Don't ship Swagger / GraphQL Playground / detailed `/health` to production.
- Production error responses never include raw error messages or stack traces — exception handlers sanitize to a generic message + correlation id; the detail goes to logs.

### Dependencies (A06)
- Pin new dependencies. No `latest` / `*` in production; tight semver + lockfile commit.
- Commit `package.json` and lockfile (`pnpm-lock.yaml`) together — CI resolving different versions breaks review assumptions.
- Don't add `--legacy-peer-deps` / `--force` to install scripts — fix the underlying peer conflict.
- Run `pnpm audit` / `npm audit` when adding a dependency; don't ship one with known HIGH/CRITICAL CVEs — pick a patched version or an alternative.

### Auth & sessions (A07)
- Rotate session IDs after successful login (prevents session fixation).
- Rotate refresh tokens on use; invalidate the old one.
- On login endpoints, return a generic "invalid credentials" — don't distinguish "email not found" from "wrong password".
- Repeated failed logins need an account-protection control beyond rate limiting: per-account lockout with exponential backoff, or CAPTCHA, after N failures.
- Find-or-create flows (OAuth callbacks, invite redemption, token consumption) must be atomic: unique constraint + `upsert` / `ON CONFLICT`. Concurrent requests otherwise create duplicate rows or double-consume tokens.
- **Don't assume which claims your IdP issues.** Verify before designing around them — Auth0 passwordless omits `jti`, so a `jti`-based deny-list silently can't revoke anything. Base revocation on a stable fingerprint (SHA-256 of the token) instead, and warn on the gap.

### Integrity (A08)
- Webhook handlers: verify signature **before** parsing. Pass raw body, not re-serialized JSON. In NestJS: `NestFactory.create(AppModule, { rawBody: true })` + `@RawBody()`. In Next.js: `await request.text()`, not `await request.json()`.
- Never `eval` or dynamic code-construction (the `Function` constructor, `vm.runInNewContext`) on user input.

### Logging (A09)
- Never log values that are (or transitively contain): full request bodies on auth/payment endpoints, request headers (contain `Authorization` / `Cookie`), user/session/account entities (contain `passwordHash` / `refreshToken`), tokens, secrets, API keys, JWTs, or full env/config objects.
- Configure Pino/Winston with a `redact` allowlist (`password`, `token`, `authorization`, `cookie`, `*.passwordHash`).
- Audit log account deletion, role changes, refunds, payouts — in addition to the operation succeeding.

### SSRF (A10)
- `fetch(userProvidedUrl)` needs a host allowlist or block on private/loopback/link-local ranges (`127.0.0.1`, `169.254.0.0/16`, `10.0.0.0/8`, `192.168.0.0/16`, `::1`).
- Don't pipe an SSRF-vulnerable fetch response back to the user — internal data exfil.

### Cross-cutting
- Never commit `.env`, `.env.local`, `credentials.json`, `serviceAccount.json`, or cloud keys.
- Never disable TLS verification in HTTP clients (e.g. `rejectUnauthorized: false` on an `https.Agent`) in production.
- No hardcoded admin credentials or default passwords.
- Don't pass auth tokens / reset tokens / OAuth codes / JWTs in query strings (they end up in logs, referrers, analytics). Use POST body or path segment with proper auth.

---

## 5. Style reminders
- **Scoped diffs — every changed line traces to the task.** When modifying existing code, change only what the task requires. Don't reformat, re-quote, re-order imports, or add type hints/docstrings to code you're not there to change, and don't refactor working code adjacent to your fix. This is diff-scope discipline, not licence to leave a rule violated: code you write or rewrite still follows §1–§6, and NEW code follows them even where its neighbours don't — otherwise match the surrounding cosmetic style.
- **Clean up only your own orphans.** Remove imports/variables/functions YOUR change made unused. Don't delete pre-existing dead code as a drive-by — flag it (or fix it in a separate, stated change) so the diff stays reviewable.
- Don't ship `console.log` debug statements to production. If you need logs, use the project logger.
- Don't leave commented-out code. Delete it; git remembers.
- Don't write comments that restate what the code does. Only comment *why* when the reason is non-obvious (subtle invariant, workaround, surprising behavior).
- Consolidate similar fixes: if the same rule is violated in N places, fix all N — don't half-solve and leave the others.
- **Don't weaken or fake tests.** Never remove assertions, add `.skip`, or loosen tolerances to make a change pass; don't write tests that mock so much they only test the mocks. Match the test layer to the change — a pure function gets a unit test, not only a slow E2E.
- **Establish one logging facade on day one** (env / `__DEV__`-gated, the single sanctioned place that writes to console, ready for a telemetry sink). Catch blocks log at least a breadcrumb for genuinely-unexpected failures; only expected/no-op paths stay silent. Retrofitting a logger after error-swallowing catches have spread is wasted work.
- **A behavior-affecting change updates the relevant spec/contract doc in the same PR** — treat the spec as part of the change, not a follow-up sweep (a single fix round can otherwise leave dozens of spec sections to reconcile afterward).
- **Don't hard-code volatile metrics** (exact test/file counts, LOC, coverage %) in prose docs — they go stale on every change. Describe *what* is tested and let the test runner / coverage report own the numbers.
- **Verify automated "gap analysis" claims before acting on them.** Integration/contract tests often cover a module that has no co-located unit test, and intentional design choices (e.g. "admin reads Mongo directly, not the `/v1` API") read as gaps. Cross-check each claimed gap against the actual test files and the contract doc; keep a short "deliberately absent by design" list so the same items aren't re-flagged.
- **A code-review verdict must state its coverage** (files reviewed / skipped) and must not assert overall adherence until coverage is complete or the gaps are named — a partial pass reported as complete forced a full redo that then found a production-breaking bug.
- **When parallelizing edits by file, a fix that introduces a new cross-file import edge is one unit** covering both consumer and producer (the file exporting the symbol) — or run a typecheck gate between waves. Disjoint files are not always independent fixes. (`tsc` type-checks test files even though Vitest skips them — run typecheck over tests too.)

---

## 6. Audit-derived rules

Hard-won lessons from the May 2026 security review and React Doctor sweep. Generic best-practices rephrased as concrete repo-specific gotchas — the rules a new contributor will hit if they don't know them. Sections §1–§5 above are still authoritative; §6 is what the next reviewer will check first.

§6.1–§6.9 come from a security review + React sweep of a single Next.js app. §6.10–§6.13 add gotchas surfaced building a multi-app monorepo (an Expo/React-Native client + several Next.js 16 services — API, operator console, catalogue crawler — in one pnpm-workspaces + Turborepo repo): cross-service contract drift, Redis/KV correctness, Vercel cron/queue jobs, and the React Query client data layer. §6.14–§6.15 are re-synced from the `code-review` skill's logic-bugs, quality, frontend-web, and react-native lenses (v1.1.1, July 2026) — the checks that skill applies to any mutation path or client surface. Where newer multi-app guidance refines an older single-app rule, the newer rule wins. The day-one *setup* lessons (monorepo, pnpm, RN/Expo, the pre-push-hook gate) live in `NEW_PROJECT_BEST_PRACTICES.md`.

### 6.1 Authentication boundaries

- **Sign-up endpoints must NEVER mint a session for an email that already exists.** The "sign in if account exists, otherwise create" shape on a public POST is account takeover by anyone who guesses an email. Existing email → 409, no cookie set, route the caller through the proper email-code flow. Session minting only on genuinely new accounts.
- **Every state-mutating public POST runs four things, in order:** `Origin === Host` check → IP rate limit (incr/expire via the shared KV) → Zod-validated body → handler logic. The first three run before any DB read or session mint.
- **Don't leak account existence.** Endpoints that take an email (sign-in code request, sign-up, password reset) must produce identical responses for registered and unregistered emails — same status code, same body shape, same response-time class. Common leaks observed:
  - Rate-limit counter that only increments for one branch (4 probes distinguishes 429 from 200).
  - Send-email errors that surface as 502 only on the registered branch (200 vs 502 is the oracle).
  - Different latency between branches (the registered branch awaits Resend; the unregistered branch returns immediately).
  Run the rate-limit increment unconditionally, swallow Resend errors (log them, return success), and equalise the work.
- **Auth gates run BEFORE body parsing.** `await req.formData()` and `await req.json()` materialise multipart payloads in memory before they return. If `getSession()` is below them, an unauthenticated attacker can force the function to read megabytes before the 401 fires. Auth first, parse second.
- **Per-IP rate limits, not global buckets.** A single `RATE_LIMIT_KEY = "admin:login:attempts"` lets any unauthenticated visitor lock every admin out by failing N logins from anywhere. Partition by IP (primary) with an optional global ceiling (secondary, looser) on top. On successful login, clear ONLY the per-IP key, not the global one.
- **Distinct trust domains use distinct keys.** Admin JWTs must not share the salon `JWT_SECRET`. Audience pinning prevents direct token reuse, but a compromise of one key shouldn't enable minting tokens in the other domain. Separate env (`ADMIN_JWT_SECRET`), separate getter, optional fallback with a one-shot warning so a missed deploy doesn't take auth offline.
- **Single-shared admin passwords need entropy enforcement.** A correct constant-time compare doesn't help if the password is `summer2024`. Warn at validation time when `ADMIN_PASSWORD` is below ~24 chars; long-term, move admin auth to email-code.
- **For an internal operator/admin console in v1, default to a single `ADMIN_PASSWORD` credential** (constant-time compare + entropy boot-warning, above) and derive any session-signing key from it via HKDF — don't introduce a second secret or a JWT before the requirement demands it. Match the requirement's stated simplicity before adding crypto machinery.
- **When one app serves two trust domains** (machine Bearer-key API + human cookie-session admin), the proxy/middleware matcher must enumerate each domain explicitly. A catch-all `return true` default-deny accidentally applied the admin-cookie gate to the Bearer-authenticated `/api/v1/*` surface and redirected unauthenticated machine traffic to `/login` (CRITICAL). Default the API surface to its own auth; verify a junk/malformed cookie is treated as unauthenticated, not a 500.

### 6.2 Cookies and CSRF

- **Cookie `path` matters per RFC 6265 §5.1.4.** A cookie set with `path=/admin` is NOT sent on requests to `/api/admin/*` — the browser's path-match requires the cookie path to be a prefix of the request URI. If your admin pages POST to `/api/admin/...` from a `/admin/*` page, set `path=/` and rely on JWT `audience` for trust isolation between admin and salon cookies. Path narrowing is redundant defence-in-depth that breaks the happy path.
- **`sameSite: 'strict'` covers most CSRF for cookie-bearing endpoints; an `Origin === Host` check is the explicit belt-and-braces.** Add it on every state-mutating Route Handler; it costs four lines and closes the gap when a downstream proxy or browser quirk loosens the strict-cookie behaviour.

### 6.3 Mongoose / data layer

- **`findOne` then `create` is a race condition.** Concurrent inbound webhooks for the same key surface as unhandled `E11000` (the duplicate-key error from the unique index). Use `findOneAndUpdate({ ... }, { $setOnInsert: { ... } }, { upsert: true, new: true })` — atomic, single round-trip, no race.
- **Schema invariants must be load-bearing, not commented.** If "each phone resolves to one stylist" is the routing invariant, the index needs `{ unique: true }`. A non-unique index plus a hand-rolled comment is two lookups away from silent misrouting.
- **PATCH allowlists need an app-layer uniqueness pre-check on collision-bearing fields.** A PATCH that lets a user rename their `slug` will surface a Mongo unique-index violation as a 500 with stack — useless to the user and noisy in logs. Pre-check `findBySlug(...)` and return 409 on collision before the update fires.
- **Don't return full DB records from public endpoints.** Project explicitly to a `PublicSalon` / `PublicStylist` shape so a future schema field with PII or internal flags doesn't silently leak through.
- **Mirror enum/format/required/nullable constraints from the type into the schema — and across services that share a collection.** A closed-set field declares `enum: [...FOO_VALUES]` derived from the same `as const` tuple used for the TS union and the Zod schema (one source of truth, no `as` casts). When two services read/write the same collection, the schema mirror MUST replicate `enum`/`required`/defaults, not just field names (one app's `status` was a bare `String` while the other enforced an enum). Pin every jointly-read enum in a parity test.
- **Avoid Mongoose reserved pathnames as field names** (`isNew`, `id`, `errors`, `schema`, `collection`, `db`, `modelName`, …). `Model.create({ isNew })` silently drops the value. If a domain field must use one, set it via `doc.set('field', v)` + `suppressReservedKeysWarning`.
- **`select: false` fields are silently absent unless re-selected.** Every read path needing the field must `.select('+field')` — a missing one returned wrong self-user data with no error. Prefer one shared loader that always selects the full self-projection.
- **Don't `$set` a dotted path into a possibly-null parent.** `$set: { 'adminOverride.category': x }` throws when `adminOverride` is `null` (the default for fresh docs) — the *first* write 500s. Build and `$set` the whole parent object merged from the prior value. Test the first-write-from-default case.
- **The serverless connection-cache singleton must clear its cached promise on rejection** (`catch` and reset `cached.promise = null`), or a transient connect failure poisons the cache and wedges every later request.
- **Pagination cursors are untrusted input.** A decoded cursor reaching `new Types.ObjectId(cursor.id)` or `new Date(cursor.x)` unguarded throws a BSONError/RangeError that surfaces as a **500-with-stack instead of a 400**. Centralize encode/decode in one pure `lib/cursor.ts` that validates (`Types.ObjectId.isValid(...)`, valid Date) and maps malformed input to a 400. Wrap repeated keyset clauses in one shared helper and route every paginated route through it — this exact bug was copy-pasted across 5+ routes while a guarded form already existed elsewhere.
- **A cursor validator must accept every id shape in use.** If entities mix `ObjectId` and `nanoid` ids, a hard `/^[0-9a-f]{24}$/` check makes nanoid-keyed endpoints undecodable, permanently breaking scroll past page 1. Round-trip-test page 2 via the returned `nextCursor`, and feed a malformed cursor asserting a clean 400. A timestamp used as a string-compared keyset key must be fixed-width canonical ISO (millisecond, UTC), normalized at ingestion — varying fractional-second width makes lexicographic order diverge from chronological.

### 6.4 File uploads

- **Client-upload token routes MUST require a session.** Anonymous callers receiving signed Vercel Blob tokens lets anyone write to the project's Blob store under whatever account the route falls back to. §3 already says this — the pitfall is when a "demo mode" fallback path bypasses it. Session check first; rate limit second.
- **`x-forwarded-for` is attacker-controlled outside Vercel's edge.** Per-IP rate limits keyed off the leftmost XFF token can be bypassed by rotating spoofed headers. Useful as defence-in-depth, never the only guard on a public path that costs money (Blob writes, AI calls).
- **Pass URLs, not bytes, between server-side stages.** Once the browser has uploaded to Blob via the signed-token flow, the API receives the URL and passes it through. Re-fetching the bytes server-side and re-uploading wastes Function bandwidth and orphans the original blob.

### 6.5 Anonymous / demo paths

- **An anonymous demo route is stateless.** No DB writes, no AI spend, no Blob writes. Synthesise the response and return. Real persistence requires a session.
- **PII in server-component props leaks to anonymous viewers.** A server component that calls `db.stylists.list(...)` and passes `phoneNumber` into a client component prop serialises that phone into `__NEXT_DATA__` and the rendered HTML — visible to any anonymous visitor. Redact or omit PII fields when `!session`.

### 6.6 Email / HTML interpolation

- **Every user-controlled value interpolated into an HTML email body MUST be HTML-escaped.** Even when an adjacent function in the same file already does it. Escape the user's name and (defensively) the code even when it's regex-bound to digits — the rule "user-influenced value → escapeHtml before HTML interpolation" stays universal and survives future refactors.
- **`mailto:` href interpolations need `encodeURIComponent`** per RFC 6068. A name like `"Foo&cc=attacker@example.com"` parses as additional mailto headers in macOS Mail / Outlook / Gmail handlers — silent BCC injection.

### 6.7 CSP

- **`'unsafe-inline'` on `script-src` nullifies CSP's main XSS protection.** Use the Next.js 16 nonce pattern: `proxy.ts` generates a per-request nonce, sets it on `x-nonce`, writes the CSP response header with `'nonce-${nonce}' 'strict-dynamic'`. The root layout `await headers()`s to opt into dynamic rendering so each request gets a fresh nonce. CSP migrates out of `next.config.mjs` headers() and into the proxy.
- **The nonce must be on the forwarded REQUEST headers, and is only verifiable with a real build.** `strict-dynamic` makes the browser ignore `'self'`, so Next's own bootstrap/hydration scripts must carry the nonce — but Next only stamps them when it finds the CSP on the *request* headers (`NextResponse.next({ request: { headers } })`), not just the response. Set it both places and make the root layout async (`await headers()`). This is invisible to lint/typecheck/test — verify with a production build + curl/browser that every `<script>` carries the matching nonce. Note `next start` will NOT serve an `output: 'standalone'` build; run `node .next/standalone/server.js` after copying `.next/static` + `public` in.
- **Style nonces are harder.** Tailwind + framer-motion inject inline styles; nonce-ing them requires a styling rework. Pragmatic posture: nonce scripts now, leave `style-src 'unsafe-inline'` for a follow-up.
- **External origins explicitly enumerated in `connect-src`.** The browser's `@vercel/blob/client` `upload()` PUTs file bytes directly to `blob.vercel-storage.com` (not `public.blob.vercel-storage.com` — that's the public-read CDN). Without that host in `connect-src`, the upload fails silently as "Load failed" / "Failed to fetch" with no useful diagnostic.

### 6.8 Operational guardrails

- **Destructive scripts (seed, migrate, replaceAll) require an env guard against non-local databases.** A developer who has just run `vercel env pull` against production has prod creds in `.env.local` — the next `npm run seed` wipes the production tenant. Refuse to run unless `MONGODB_URI` is recognisably local (`mongodb://localhost`, `@localhost`, `@127.0.0.1`) OR an explicit `SEED_CONFIRM=yes-wipe-this-database` is set.
- **`.gitignore` for env files catches ALL `.env*`, not just `.local`.** Next.js loads `.env`, `.env.production`, `.env.development`, `.env.test` per its precedence rules — if your gitignore only excludes `.env.local`, a contributor copying `.env.local` to `.env` for tooling that doesn't honour the `.local` convention silently commits secrets. Pattern: `.env`, `.env.*`, `!.env.example`.
- **In-memory KV fallback is dev-only.** A process-local Map cross-contaminates sign-in codes and rate-limit counters within an instance, and silently bypasses both across instances. In production, fail-loud at boot unless an explicit opt-out env var is set — a missed `REDIS_URL` should crash the deploy, not silently degrade auth.
- **Audit-log every privileged admin mutation.** Action, before-snapshot, after-snapshot, IP, ISO timestamp. Audit failure must NOT propagate — `void`-fire with a `.catch` that logs but never throws, so an audit hiccup can't break the user-facing operation. Index `{salonId, at:-1}` for per-salon timelines and `{at:-1}` for the global feed.
- **For env-var defaults that must reject empty strings, use `process.env.X || default`, not `??`.** `??` only guards null/undefined; a committed `.env.example` key is commonly present-but-empty, which slips through `??` and reaches the consumer as `''` — an empty `LOG_LEVEL=` crashed `next build` via pino. `??` is correct only when `''` is a legitimate value. Validate env at startup (Zod) so an invalid value fails fast with a clear message rather than mid-build.
- **Security-sensitive env vars fail closed.** Storage tokens for private/PII buckets and signing secrets must be `requireEnv()`-asserted and fail loudly when absent — never fall back to a public/default store (a selfie upload token silently fell back to the public Blob bucket). Centralize env validation in one typed module.
- **`.env.example` must equal the keys the code actually reads** — no dead vars, no undocumented ones. Add a key-parity check between `.env.example` and the code.

### 6.9 React 19 / Next.js 16 hygiene

- **Use `next/font` over `<link>` Google Fonts.** Self-hosted at build time means no render-blocking stylesheet, no CLS, and Google Fonts origins drop out of CSP entirely. Tailwind theme tokens reference the `--font-*` CSS variables exposed by `next/font`, not the named font family.
- **`new Date()` in render is a hydration mismatch.** Footer copyright years rendered with `new Date().getFullYear()` will diverge between server and client across midnight UTC. Hardcode the year (one-line annual update), or read post-mount in `useEffect`, or `suppressHydrationWarning` on the specific node.
- **Capture callback props in a ref synced via `useEffect`** when a long-lived listener (window keydown, document scroll) needs to call the latest version. `const fnRef = useRef(fn); useEffect(() => { fnRef.current = fn; }, [fn]);` lets the listener call `fnRef.current(...)` without re-subscribing on every parent render. React 19's `useEffectEvent` is the eventual fix; the ref pattern works today.
- **Form labels must be associated with their control** for screen readers. Either wrap the label around the control or use `htmlFor` + matching `id`. Bare `<label>` followed by an unrelated `<input>` doesn't announce.
- **Bypass `/_next/image` for already-compressed Blob photos.** The optimizer's transcode round-trip adds latency without meaningful payload reduction for already-compressed JPEGs. `<Image src={blobUrl} unoptimized />` keeps the sizing API but skips `/_next/image?url=...&w=N&q=75`. Keep the optimizer for static brand assets where WebP conversion does help.
- **Inline data URLs don't go through `next/image`.** A QR-code data URL added via `useEffect` is already-decoded — the optimizer can't process data URIs. Per-instance `// eslint-disable-next-line @next/next/no-img-element` with a reason comment.
- **Per-page `metadata` exports on server-component pages.** Even when the root layout's metadata would suffice, an explicit `export const metadata: Metadata = { title, description }` on each server-rendered page is grep-able SEO-friendly and silences the missing-metadata lint.
- **A Next.js lint gate without `eslint-config-next` is hollow.** `@eslint/js` + `typescript-eslint` alone omit `@next/next` + `react-hooks` + `jsx-a11y` — a clean `npm run lint` can pass while skipping every rule that matters (wiring it in immediately surfaces real issues a green lint was hiding — e.g. `Date.now()`-in-render). Wire `eslint-config-next` (flat-config `core-web-vitals`) from day one and confirm the plugins are active before trusting lint as a gate.

### 6.10 App↔API and cross-service contracts

When two apps (RN/Expo client ↔ API, admin ↔ API, crawler ↔ API) share an HTTP wire shape, a DB collection, or a webhook signing scheme in one monorepo, **TypeScript on each side passes while the shapes silently diverge** — each side is internally consistent. Drift like this ships undetected and is caught only by manual review; it is one of the most frequent and severe cross-app failure modes.

- **Prefer a shared `packages/contract`** workspace package holding the wire DTO types, imported by both producer and consumer, so the compiler enforces parity.
- **If a shared package isn't viable** (the client transitively imports `react-native`, or optional-vs-required asymmetries make exact type assertions a rabbit hole), scaffold **bidirectional key-set parity tests** *with the feature, not after*: a producer test asserting every emitted DTO field is a declared client field, AND a consumer test (`Record<keyof ApiX, true>` enumeration + runtime field-list assert) so neither side can add/drop a field unnoticed. **Guarding only one end is a trap.**
- **Standardize the list/pagination envelope once** (decide bare-array vs `{ items }` vs `Page<>` and apply it to *every* list endpoint) so sibling endpoints never diverge — one returning `{ items }` while a sibling returned a bare array crashed product search.
- **A consumed field must be serialized.** If the client reads a field, the server's DTO/projection must expose it; a model field that never reaches the serializer makes a whole client code path dead.
- **Cross-service secrets and signing schemes are part of the contract.** A webhook HMAC scheme (body-only vs timestamp+body), shared API keys, and ID namespacing must be pinned in one spec and verified on both sides; never ship a "breaking contract change the other side must adopt" as a one-sided code change.
- **Document the sync workflow** in a `CONTRACTS.md`: when you change a wire field, update the type + both guard lists + the contract doc together, and keep a short "intentionally absent by design" list (e.g. "admin reads Mongo directly, does not call /v1") so design choices aren't repeatedly re-flagged as gaps.

### 6.11 Redis / KV correctness

- **Counter-with-expiry must be atomic or self-healing.** `INCR` then `EXPIRE` only when `n===1` strands a TTL-less key on a crash between the two (permanent rate-limit lockout). Set the TTL in the same op, or re-assert `EXPIRE` whenever `ttl < 0`.
- **Locks store a unique owner token and release with compare-and-delete.** Never unconditionally `del(key)` in `finally` — a run that outlived the TTL would delete the next holder's lock. Release only if the stored value still equals this run's token.
- **Serialize cron / long-running sync jobs behind a single-flight lock** (`SET NX` + TTL + holder token) from the start; on serverless, assume invocations overlap and design jobs to be idempotent or mutually exclusive.
- **Never use a raw token/secret (or its prefix) as a cache/rate-limit key** — hash it (collision/leak risk).
- **Rate-limit ALL mutating and expensive routes** (POST/PUT/**DELETE**, reports, search, token issuance), not just auth — including the DELETE counterpart of any throttled PUT. On authenticated endpoints key by **user id** (optionally plus IP); reserve IP-only for unauthenticated routes.

### 6.12 Vercel cron/queue jobs & outbound fetch

- **One Vercel config source.** Put crons AND queue/function triggers in a single `vercel.json` (the file Vercel reads natively). Splitting them across `vercel.json` and a `vercel.ts` (with no `@vercel/config generate` prebuild step) leaves one set as dead config — the crons silently never register and the entire pipeline never runs in prod.
- **Set `export const runtime` and `export const maxDuration` (≤300) on every cron and queue-consumer route.** A queue `visibilityTimeout` extends the redelivery *lease*, NOT the Function wall-clock ceiling — don't conflate them.
- **Handle the queue final delivery.** On `deliveryCount >= max`, `markFailed` (drain gauges) rather than rethrow, or jobs are silently dropped at the last attempt. Put this in one shared consumer wrapper.
- **Treat any crawled/external URL as SSRF-untrusted.** Before fetching: parse + host-allowlist, use `redirect: 'manual'` and re-validate each hop, block private/loopback/link-local IPs, cap response size and time.
- **Every outbound server-to-server fetch sets an explicit timeout** (`signal: AbortSignal.timeout(ms)`) so a hung upstream can't stall the function.

### 6.13 React Query / client data layer

- **React Query v5 optimistic rollback: `setQueryData(key, undefined)` is a no-op** (it does not clear the entry), so a naive rollback never reverts a failed toggle. Restore the captured previous value; when it was `undefined`, use `qc.removeQueries({ queryKey, exact: true })`.
- **Gate authed (`/me/*`) hooks on auth in apps with a guest mode:** `enabled: isAuthenticated`. Otherwise guest browsing fires an authed request, gets 401, and a reactive handler can `forceLogout()` a tokenless guest. The global 401 handler must no-op (surface an `ApiError`, not force logout) when there is no stored token.
- **User-initiated writes must `await mutateAsync` and only show success / navigate on success;** surface failures (toast/Alert) and leave the form intact. No fire-and-forget for a write the user is told succeeded.
- **Every module-level / in-memory cache holding user-scoped data needs a reset wired into the central sign-out path**, alongside query-cache and secure-storage clears — add the clear hook when you introduce the cache, or user A's data leaks into user B's session.

### 6.14 Cross-cutting logic-bug patterns

Recurring bug shapes on mutation paths — the checks the review's logic-bugs lens runs first.

- **Side-effect ordering and per-item marking.** Never fire the irreversible side-effect (send email/push) before the "done" marker can be persisted, and in cron/queue loops mark each item processed immediately after its own side-effect succeeds — a batch update at the end re-sends everything that completed before a mid-loop throw.
- **Re-check entity state at process time, not enqueue time.** Between enqueue and execution the recipient may have unsubscribed, the resource closed, the tenant been suspended — the processor re-reads current state instead of trusting the enqueue-time snapshot.
- **"Regenerate / reset from rules" paths must not clobber user edits** (`deleteMany({ source: 'SYSTEM' }) + insertMany` wipes user-modified rows) **and must fire the same side-effects as the primary create path** (a regenerate that calls the repo directly skips the sync/webhook the normal create triggers).
- **Key multi-provider / multi-tenant state.** A flat `user.oauth = {...}` lets a second connected provider overwrite the first — key by provider/tenant id. Scope role lookups by the active company: `companyRoles.find(r => r.role === 'admin')` without `r.companyId === ctx.companyId` grants cross-tenant admin.
- **Validate a discriminator together with its dependent required fields.** If only `channel === 'email'` requires `respondentEmail`, a client-supplied (or defaulted) `channel: 'inbox'` bypasses the requirement. Trust-bearing discriminators (channel, source) derive from server state, never the client's claim.
- **Guard `new Date(externalInput)`.** An `Invalid Date` persists as a poisoned value that breaks every downstream comparison — reject with `Number.isNaN(d.getTime())` or `z.coerce.date()`. And check window filters for off-by-one: an `offsetDays: 60` config must be matched exactly by the query's `$lt`/`$lte` endpoints.
- **Mongo path conflicts:** `$set` and `$unset` on overlapping path prefixes in one update throw a path-conflict error (often swallowed by a catch) — split the update or write the final shape with a single `$set`.
- **Anonymous flows must be un-linkable.** An `isAnonymous: true` response that stores a correlation token mapping back to an identity-bearing row is re-identifiable — drop the token or hash it with a per-collection salt.
- **Hot-path performance:** repeated `find`/`filter` inside a loop is O(n²) — build a `Map` first; unbounded list queries get pagination; identical expensive computations repeated per request/render get memoized.

### 6.15 Client React & React Native hygiene

The client-side rules the review's frontend and RN lenses check first (§3 covers the Next.js server side; §6.13 the client data layer).

**React (web and native):**
- Every value read inside `useEffect`/`useMemo`/`useCallback` is in its dep array (stale closures), and every subscription/listener/timer/observer set up in an effect is torn down in cleanup — fetches get an `AbortController`.
- No conditional hooks (after an early return, inside a branch/loop), and never define a component inside another component's render body — it remounts and loses state on every parent render.
- Don't mirror props or derived data into state via `useState` + `useEffect` — compute in render or `useMemo`. Never `setState` during render or unconditionally in an effect (render loop).
- `count && <X />` renders a literal `0` when count is 0 — use `count > 0 ? … : null`. Index-as-key on lists that reorder/insert/delete bleeds state between rows — use stable ids.
- Every async-data component renders loading, empty, and error states — not just the happy path.
- Accessibility baseline: interactive behavior on `<button>`/`<a>`, not click-`div`s; `aria-label` on icon-only buttons; focus trap + return-focus on modals; `aria-live` for async status; state never conveyed by color alone.
- Use design tokens / theme values, not literal colors/spacing/z-index; no `!important` or z-index escalation to beat existing rules. A prop threaded through 3+ layers untouched wants composition/`children`/context; a 4th boolean prop wants a `variant` union.

**React Native / Expo:**
- Screens stay mounted after `navigate` — effect cleanup does **not** run on navigate-away. Scope polling/subscriptions with `useFocusEffect` / `isFocused`. Never pass non-serializable values (callbacks, class instances, Dates) in navigation params.
- Dynamic lists use `FlatList`/`FlashList` — never `ScrollView`, which mounts every child — with a stable `keyExtractor` and memoized row components (no inline `renderItem` arrows).
- Tokens, PII, and auth state go in SecureStore/Keychain, never plain AsyncStorage.
- Platform divergence: iOS `shadow*` vs Android `elevation`; safe-area insets over hardcoded padding; per-platform `KeyboardAvoidingView` behavior; ≥ ~44pt touch targets (or `hitSlop`).
- Camera/location/notification features check + request permission and handle the denied path (no crash, no silent no-op); a dependency needing native code needs a config plugin / prebuild — it breaks Expo Go.
- Animate with `useNativeDriver: true` or Reanimated worklets — never setState-per-frame; touchables get `accessibilityRole` / `accessibilityLabel`.

---

## 7. Agent self-review (run before reporting the change done)

A fast pre-submit pass over your own diff. Don't declare the change complete until you've checked each item against the files you actually touched, and state which files you reviewed. This is the same lens the `code-review` skill applies — clearing it here means the review comes back clean.

- **Boundaries:** every new trust-boundary input (`res.json()`, request/webhook/queue body, env var, pagination cursor, LLM/tool-call output) is Zod-parsed, not cast (§1, §6.3). Every exported function / handler / Server Action has an explicit return type and returns a projected shape, never a raw DB record.
- **Auth:** every state-mutating endpoint / Server Action / Route Handler authenticates, then authorizes the *specific resource* (ownership check, not just "logged in"), before any DB read or mutation (§3, §4, §6.1). Auth gates run before body parsing.
- **Secrets & logging:** no secret read from a client bundle; secret-bearing files start with `import 'server-only'`; no token / header / full-entity / full-body value logged (§4 A09).
- **Async & errors:** no floating promises; no `forEach(async …)`; `catch (e: unknown)` with narrowing; no `catch { return null }` swallow (§1).
- **Types:** no new `any`, no `as unknown as T` on untrusted input, no `@ts-ignore` without a same-line reason; every `switch` over a union you touched still has its exhaustiveness `default` (§1).
- **Consistency:** if the same rule is violated in N places, fix all N (don't half-solve); a behavior-affecting change updates the relevant spec/contract doc in the same change (§5).
- **Cross-app contracts:** a changed wire field updates the shared type / both parity guard lists / the contract doc together (§6.10).
- **Verification claim:** run `tsc --noEmit` (over tests too) and the lint gate before declaring done; report any failure with its output rather than asserting success.
- **Diff scope:** every changed line traces to the task — no drive-by reformatting or refactoring the change didn't require; orphans your change created are removed, and pre-existing dead code is flagged, not silently deleted (§5).
- **No regressions:** re-read the surrounding code you modified and confirm you didn't break an existing invariant — the §6 gotchas are the ones reviewers hit first.

---

## Sources
- OWASP Top 10:2021
- NestJS docs — Providers, Modules, Pipes, Exception filters, Validation, Authentication, Testing, Lifecycle, Circular dependencies, Injection scopes
- Next.js docs — Mutating Data, Data Security, `cookies()` / `headers()`, Server/Client Components, Caching, Route Handlers, Proxy
- React 19 — `useActionState`, `useFormStatus`, `useOptimistic`
- `plugins/code-review` skill in `diolog-plugins` (authoritative source of the rules above) — last re-synced against v1.1.1 checklists (typescript, nestjs, nextjs, security, logic-bugs, quality-lenses, frontend-web, react-native) on 2026-07-06; §6.14–§6.15 added in that pass
- May 2026 security audit (`code-review-security-2026-05-10.md`) + React review sweep — concrete repo-specific gotchas distilled in §6.1–§6.9.
- Multi-app monorepo build retrospective (May 2026) — post-initial-implementation rework mined from the build sessions of an Expo/RN client + three Next.js 16 services; distilled into §6.10–§6.13 here and the monorepo/RN/gate sections of `NEW_PROJECT_BEST_PRACTICES.md`.
