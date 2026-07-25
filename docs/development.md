# Development

```bash
npm install
npm run dev             # tsx src/index.ts
npm run typecheck       # tsgo --noEmit
npm run lint            # eslint 9 flat, type-aware
npm test                # unit: pure logic, milliseconds
npm run test:acceptance # acceptance: drives the real MCP protocol over stdio
npm run test:all        # both of the above. This is what the gate runs
npm run test:paid       # spends real money. Never in the gate, opt-in only
npm run build
npm run gate            # typecheck, lint, test:all, build. Run it before you push
npm run inspect         # MCP Inspector
```

**Toolchain:** [tsgo](https://github.com/microsoft/typescript-go) (`@typescript/native-preview`) compiles and typechecks, eslint 9 flat and type-aware lints, vitest runs the tests on the swc transform.

**Two suites, because they catch different things.** The unit project covers pure logic in milliseconds. The acceptance project spawns the actual server and speaks JSON-RPC to it, which is the only place a registration or schema defect can surface: a tool missing from `tools/list`, a resource template that never matches, a response violating its own `outputSchema`. It found four real bugs the day it was written, including two documented sub-resources that were silently dead.

There is a third project, `paid`, which runs real research against the live API and asserts on what comes back: that a report has structure and confidence qualifiers, that most of its citations resolve, that collaborative planning returns a reviewable plan rather than your own prompt echoed, that corpus grounding produces its contradictions section. **It is deliberately excluded from the gate and cannot block a deploy.** It needs `DOSSIER_PAID_TESTS=1` and a real key, skips itself without them, gives itself a budget ceiling, and cancels whatever it started.

```bash
DOSSIER_PAID_TESTS=1 GEMINI_API_KEY=... npm run test:paid   # roughly $2-4
```

[`docs/test-plan.md`](test-plan.md) is the AC-traceability matrix: every criterion, the test that verifies it, and the gaps named with reasons rather than left implied.

> [!NOTE]
> Both suites are hermetic by construction. `DOSSIER_HERMETIC=1` is set in `vitest.config.ts` and the acceptance harness blanks the credential vars, so a stray key in your environment can't make the tests spend money. Unit tests inject a scripted `DeepResearchClient`; acceptance tests seed state through `Store` and point each server at its own temp directory.

Using it as a library:

```ts
import { buildPrompt } from 'dossier-research-mcp/server';

const { prompt, archetype, preEngineered } = buildPrompt({
  question: 'What disclosure obligations apply to dual-listed issuers?',
  scope: { jurisdiction: 'UK and Singapore', decisionContext: 'inform a board paper' },
});
```

`createServer(deps)` and `buildDeps(config)` are exported too, so you can mount the tools inside an existing FastMCP server, or inject a fake client for your own tests.

Releasing is `npm version patch`, which gates, bumps, tags and pushes; the workflow publishes from the tag. [docs/releasing.md](releasing.md) has the detail, including how to retire the npm token in favour of Trusted Publishing.

---

<div align="center">

**MIT** © fledgeling-co · [Report an issue](https://github.com/fledgeling-co/dossier-research-mcp/issues)

<sub>Dossier isn't affiliated with Google. "Gemini" and "Vertex AI" are trademarks of Google LLC.</sub>

</div>

---

## Related

- [Test plan](test-plan.md): the AC-traceability matrix and the coverage model.
- [Releasing](releasing.md): the tag-triggered publish flow, and how to retire the npm token.
