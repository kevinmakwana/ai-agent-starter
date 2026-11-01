import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// One flat config for the monorepo. Typed linting uses each app's own tsconfig through the project service.
const typed = (dir, extra = {}) => ({
  files: [`${dir}/src/**/*.{ts,tsx}`, `${dir}/test/**/*.ts`],
  extends: [tseslint.configs.recommended],
  languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }, ...extra },
  rules: {
    // A forgotten await on a guarded business operation is a bug, not a style issue.
    '@typescript-eslint/no-floating-promises': 'error',
    // JSX handlers may return promises; passing an async function where a callback must be synchronous is still flagged.
    '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
    // Network data is `unknown` until narrowed; a needed cast gets a comment naming the invariant that makes it safe.
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  },
});

export default defineConfig(
  globalIgnores(['**/dist/**', '**/.next/**', '**/coverage/**', '**/node_modules/**', 'apps/web/next-env.d.ts']),
  js.configs.recommended,
  typed('apps/api', { globals: globals.node }),
  {
    ...typed('apps/web', { globals: { ...globals.browser, ...globals.node } }),
    extends: [tseslint.configs.recommended, reactHooks.configs.flat.recommended],
  },
  {
    // Deliberate: errors built from notification, mail and webhook failures carry no `cause`, so a URL or
    // credential in the original error cannot reach a log line.
    rules: { 'preserve-caught-error': 'off' },
  },
  {
    // The two React Compiler rules flag deliberate patterns (latest-callback ref, resetting status when the target goes
    // away). The app does not use the React Compiler; revisit if it adopts it.
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: { 'react-hooks/refs': 'off', 'react-hooks/set-state-in-effect': 'off' },
  },
  {
    // node:test registers tests with top-level `test()` / `describe()` calls that return promises.
    files: ['apps/web/**/*.test.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', 'apps/api/test/**/*.ts'],
    rules: { '@typescript-eslint/no-misused-promises': 'off' },
  },
  // Config files at the app roots sit outside the app tsconfigs, so they are parsed but not type-checked.
  { files: ['apps/*/*.ts', 'apps/*/e2e/**/*.ts'], extends: [tseslint.configs.recommended], languageOptions: { globals: globals.node } },
  { files: ['**/*.mjs'], languageOptions: { globals: globals.node } },
  prettier,
);
