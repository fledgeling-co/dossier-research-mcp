import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // Hermetic by default: no network, no live keys. Every test injects its
    // Gemini client and points the store at a temp dir.
    env: { DEEP_RESEARCH_HERMETIC: '1' },
  },
});
