import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Pure-logic tests run in Node. A component test opts into jsdom with `// @vitest-environment jsdom` on its first line.
export default defineConfig({
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  test: { include: ['src/**/*.test.{ts,tsx}'], restoreMocks: true },
});
