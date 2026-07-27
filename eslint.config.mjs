import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Flat config, type-aware.
 *
 * CP §6.9's warning applies in spirit: a lint gate that isn't wired to the
 * type-aware rules is hollow — it passes while skipping every check that
 * actually matters. `projectService` turns those on, which is what makes the
 * floating-promise and unsafe-argument rules below real rather than decorative.
 *
 * The rules that are errors here are the ones CP calls hard constraints: no
 * `any`, no floating promises, no unchecked `catch (e: any)`. Everything else
 * the type-checker already covers, so this config stays small on purpose.
 */
export default tseslint.config(
  {
    // `.worktrees/` holds git worktrees of this same repository, used by the
    // feature pipeline. Linting them makes the main tree's gate fail on another
    // branch's half-written code, which is both wrong and impossible to act on
    // from here. Each worktree runs its own gate against its own branch.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'assets/**', '.worktrees/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // CP §1 — hard constraints, so these are errors not warnings.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // A bare suppression is a lint failure; one with a reason is fine.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description', 'ts-ignore': 'allow-with-description' },
      ],
      // Unused vars are caught by tsgo's noUnusedLocals; duplicating it here
      // only produces double-reported errors on the same line.
      '@typescript-eslint/no-unused-vars': 'off',
      // `async` is frequently required for INTERFACE CONFORMANCE, not because
      // the body awaits: FastMCP resource `load()` returns a Promise, and the
      // scripted DeepResearchClient in tests must match an async interface. The
      // rule cannot tell those from a genuinely-sync function marked async, and
      // every hit here was the former.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Tests deliberately construct malformed payloads to prove the parsers
    // reject them, so the unsafe-* family is noise rather than signal here.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // MUST come last: flat config is last-wins, so placing this before
    // `recommendedTypeChecked` would let that re-enable type checking here.
    // These files sit outside tsconfig's `include`, so the type-aware service
    // cannot resolve them; lint them untyped rather than widening tsconfig to
    // cover build tooling.
    files: ['*.config.mjs', '*.config.ts', 'scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      // Untyped linting loses the Node lib types, so `no-undef` starts firing
      // on globals these build scripts legitimately use. Declared inline rather
      // than adding the `globals` package for four names.
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly', Buffer: 'readonly' },
    },
  },
);
