import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Transform: @swc/core via unplugin-swc, replacing Vitest's default esbuild.
 *
 * Honest reason: toolchain parity across the org, not speed — esbuild and swc
 * are within noise of each other on a codebase this size, and this project has
 * no decorators, which is the one case where the difference is functional
 * rather than cosmetic. Keeping one transform everywhere means a file that
 * compiles in CI compiles here, and nobody has to hold two mental models of
 * how TypeScript gets stripped.
 */
export default defineConfig({
  // Vitest 4 transforms with Oxc, not esbuild. unplugin-swc only knows to
  // switch off the latter, so without this the swc plugin loads and Oxc still
  // does the work — the transform would be swc in name only. Vitest says so
  // out loud on start-up, which is the only reason this was caught.
  oxc: false,
  plugins: [
    swc.vite({
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', dynamicImport: true },
      },
      module: { type: 'es6' },
      sourceMaps: true,
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // Hermetic by default: no network, no live keys. Every test injects its
    // Gemini client and points the store at a temp dir.
    env: { DEEP_RESEARCH_HERMETIC: '1' },
  },
});
