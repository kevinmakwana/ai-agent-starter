import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Pure-logic tests run in Node. A component test opts into jsdom with `// @vitest-environment jsdom` on its first line.
export default defineConfig({
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    // Files no test imports count as 0%, so the number is not flattered by what is left out. The pages and the Playwright flow
    // are not measured here: browser runs are not instrumented.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}'],
      reporter: ['text-summary', 'json-summary', 'lcov', 'html'],
      // A floor a few points under today's number, to catch a drop; raise it when tests are added.
      thresholds: { statements: 32, branches: 27, functions: 27, lines: 32 },
    },
  },
});
