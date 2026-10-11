// Captures the README screenshots with Playwright. Needs the stack running: npm run db:up && npm run seed && npm run dev
// Chats as a customer on "/", then opens the reviewer console on "/reviewer" for the trace + approval shots.
// If the API has REVIEWER_API_KEY set, pass it: REVIEWER_API_KEY=... npm run screenshot
import { chromium } from 'playwright';

const base = process.env.WEB_URL ?? 'http://localhost:3000';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 940 }, deviceScaleFactor: 2, colorScheme: 'light' });

// customer side
await page.goto(base);
// With reviewer auth on, customers can't be listed, so the page asks for an account email instead.
const picker = page.locator('select[aria-label="Customer"]');
const emailBox = page.getByLabel('Your account email');
await picker.or(emailBox).waitFor();
if (await picker.isVisible()) await picker.selectOption({ label: 'Ava Brooks' });
else await emailBox.fill('ava.brooks@example.com');
await page.getByRole('button', { name: 'New', exact: true }).click();
await page.getByLabel('Message').fill('Order #1 arrived damaged, please refund it');
await page.getByRole('button', { name: 'Send' }).click();
await page.getByText('A reviewer will decide shortly').waitFor({ timeout: 15000 });
await page.screenshot({ path: 'docs/customer.png' });

// reviewer side
await page.goto(`${base}/reviewer`);
const key = process.env.REVIEWER_API_KEY;
if (key) {
  await page.getByLabel('Reviewer key').fill(key);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
await page.getByRole('button', { name: /Ava Brooks/ }).first().click();
await page.getByText('pending approval — run paused').waitFor({ timeout: 15000 });
await page.waitForTimeout(500);
await page.screenshot({ path: 'docs/screenshot.png' });

await page.getByRole('tab', { name: /Approvals/ }).click();
await page.getByRole('button', { name: 'Approve' }).waitFor();
await page.screenshot({ path: 'docs/approvals.png' });

await browser.close();
console.log('Saved docs/screenshot.png, docs/approvals.png and docs/customer.png');
