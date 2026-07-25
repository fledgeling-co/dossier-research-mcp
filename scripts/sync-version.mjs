// Keeps src/version.ts in lockstep with package.json.
//
// The MCP handshake advertises src/version.ts, so if the two drift a client
// reports a version that was never released. `npm version` calls this in its
// `version` lifecycle step, after package.json is bumped and before the commit,
// so the sync lands in the same commit as the bump. The release workflow
// re-checks the invariant and refuses to publish if it was bypassed.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const target = join(root, 'src/version.ts');

writeFileSync(
  target,
  `/** Kept in lockstep with package.json by scripts/sync-version.mjs. */\nexport const version = '${version}';\n`,
);
console.log(`src/version.ts -> ${version}`);
