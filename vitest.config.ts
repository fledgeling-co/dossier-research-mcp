import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Two projects, because they test different things at different speeds.
 *
 * `unit` is pure logic, milliseconds, no processes. `acceptance` spawns a real
 * server per file and speaks MCP to it, which is slower but is the only place
 * a registration or schema defect can surface. Both are hermetic.
 *
 * Transform: @swc/core via unplugin-swc, for parity with the org's other
 * repos. Note `oxc: false` is load-bearing: Vitest 4 transforms with Oxc and
 * unplugin-swc only disables esbuild, so without it swc loads and does nothing.
 */
const shared = {
  environment: 'node' as const,
  // Hermetic by construction: a live client is never constructed, so a stray
  // key in the environment cannot make the suite spend money.
  env: { DOSSIER_HERMETIC: '1' },
};

export default defineConfig({
  oxc: false,
  plugins: [
    swc.vite({
      jsc: { target: 'es2022', parser: { syntax: 'typescript', dynamicImport: true } },
      module: { type: 'es6' },
      sourceMaps: true,
    }),
  ],
  test: {
    projects: [
      {
        extends: true,
        test: {
          ...shared,
          name: 'unit',
          include: ['tests/*.test.ts', 'src/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          ...shared,
          name: 'acceptance',
          include: ['tests/acceptance/**/*.acceptance.test.ts'],
          // Each file spawns its own server; starting several at once on one
          // machine is the fastest way to make this suite flaky.
          fileParallelism: false,
          testTimeout: 45_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
