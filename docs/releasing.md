# Releasing

## The whole flow

```bash
npm version patch    # or minor / major
```

That single command:

1. Runs `npm run gate` (typecheck, lint, test, build). A failing build can't produce a tag.
2. Bumps `package.json`.
3. Runs `scripts/sync-version.mjs` so `src/version.ts` matches, and stages it.
4. Commits and tags `vX.Y.Z`.
5. Pushes with the tag.

The tag push triggers [`.github/workflows/release.yml`](../.github/workflows/release.yml), which re-runs the gate, checks two invariants, publishes to npm with provenance, and cuts a GitHub release.

Nothing publishes on a push to `main`. That's deliberate: a tag is a decision, a merge often isn't.

## The two invariants the workflow checks

Both of these fail silently if nobody checks them, which is why they're explicit steps.

**The tag matches `package.json`.** Tagging `v0.2.0` on a commit whose package says `0.1.9` would publish `0.1.9` under a `v0.2.0` tag, and the two would disagree forever.

**The advertised version matches the published one.** `src/version.ts` is what the MCP handshake reports to clients. If it drifts, every connected client reports a version that was never released, and you'd only find out from a confusing bug report.

## Checking the pipeline without spending a version

```bash
gh workflow run release.yml -f dry_run=true
```

Runs the gate and `npm pack --dry-run`, then stops. Use it after changing the workflow.

## Retiring the token

Right now the workflow authenticates with an automation token in the `NPM_TOKEN` repo secret. It works, but it's a long-lived credential that can publish this package from anywhere it leaks to.

**npm Trusted Publishing removes it.** npm accepts a short-lived OIDC token minted by GitHub Actions for a specific repo and workflow, so there's no stored secret at all. The workflow already has `id-token: write` and already publishes with `--provenance`, so the change is small:

1. On npmjs.com, open the package settings, then **Publishing access**, and add a trusted publisher: this repository, workflow file `release.yml`.
2. Delete the `NODE_AUTH_TOKEN` env block from the publish step in `release.yml`.
3. Delete the `NPM_TOKEN` repo secret and revoke the token on npmjs.com.

Note: the package has to exist on npm before you can configure a trusted publisher for it, so the first release uses the token and every release after it doesn't have to.

## Provenance

`npm publish --provenance` records a signed attestation linking the published tarball to this repository and the exact workflow run that built it. It shows on the npm page as a verified badge, and anyone can check the tarball came from this source rather than someone's laptop. It needs `id-token: write` on the job, which is why that permission is there.

## If a release goes wrong

npm allows unpublishing within 72 hours, after which the version is permanent. `npm deprecate dossier-research-mcp@x.y.z "reason"` is usually the better move; it leaves the version installable for anyone pinned to it while warning everyone else.
