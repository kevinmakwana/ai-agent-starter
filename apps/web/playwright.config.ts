import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

// One browser flow against the built API and web app (mock LLM, open demo mode). Build first: npm run build.
// It re-seeds the database, which truncates every table, so it needs a disposable database whose name ends in `_test`.
const dbUrl = process.env.E2E_DATABASE_URL;
if (!dbUrl) throw new Error('Set E2E_DATABASE_URL to a disposable database whose name ends in _test (it is re-seeded).');
if (!new URL(dbUrl).pathname.slice(1).endsWith('_test')) {
  throw new Error('E2E_DATABASE_URL must point at a database whose name ends in _test: the run truncates every table.');
}

// Unusual ports, and no reuse of a running server, so a dev stack on 3000/3001 is never driven by accident.
const API_PORT = 3201;
const WEB_PORT = 3200;
const root = resolve(__dirname, '../..');

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://127.0.0.1:${WEB_PORT}`, trace: 'retain-on-failure' },
  // PLAYWRIGHT_CHANNEL=chrome runs on an installed Chrome when Playwright's own Chromium is not downloaded.
  projects: [{ name: 'chromium', use: { browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL || undefined } }],
  webServer: [
    {
      name: 'api',
      command: 'node apps/api/dist/db/seed.js && node apps/api/dist/main.js',
      cwd: root,
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DATABASE_URL: dbUrl,
        API_PORT: String(API_PORT),
        LLM_PROVIDER: 'mock',
        MOCK_DELAY_MS: '0',
        // A developer's root .env must not turn on keys, accounts, auto-approval or outbound notifications here.
        REVIEWER_API_KEY: '',
        CUSTOMER_LOGIN: 'false',
        REFUND_AUTO_APPROVE_UNDER: '0',
        FOUR_EYES_REFUND_OVER: '0',
        FOUR_EYES_CANCELLATIONS: 'false',
        NOTIFY_WEBHOOK_URL: '',
        NOTIFY_SLACK_WEBHOOK_URL: '',
        NOTIFY_SMTP_URL: '',
      },
    },
    {
      name: 'web',
      command: `npx next start -p ${WEB_PORT}`,
      cwd: resolve(root, 'apps/web'),
      url: `http://127.0.0.1:${WEB_PORT}/`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { API_URL: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
