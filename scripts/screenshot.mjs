// Captures the README screenshots with Playwright. Needs the stack running: npm run db:up && npm run seed && npm run dev
import { chromium } from 'playwright';

const base = process.env.WEB_URL ?? 'http://localhost:3000';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 940 }, deviceScaleFactor: 2, colorScheme: 'light' });

await page.goto(base);
await page.getByLabel('Customer').selectOption({ label: 'Ava Brooks' });
await page.getByRole('button', { name: 'New', exact: true }).click();
await page.getByLabel('Message').waitFor();

await page.getByLabel('Message').fill('Order #1 arrived damaged, please refund it');
await page.getByRole('button', { name: 'Send' }).click();
await page.getByText('pending approval — run paused').waitFor({ timeout: 15000 });
await page.waitForTimeout(500);
await page.screenshot({ path: 'docs/screenshot.png' });

await page.getByRole('tab', { name: /Approvals/ }).click();
await page.getByRole('button', { name: 'Approve' }).waitFor();
await page.screenshot({ path: 'docs/approvals.png' });

await browser.close();
console.log('Saved docs/screenshot.png and docs/approvals.png');
