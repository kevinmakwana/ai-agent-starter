import { expect, test, type Page } from '@playwright/test';

const API = 'http://127.0.0.1:3201';

// The live-update UI: the "Live / Connecting / Polling" chip, a decision showing up in an open chat with no reload, and the
// fallback to polling when the event streams cannot be opened. Each test uses its own customer so they never share an approval.

const streamChip = (page: Page) => page.locator('.chip.stream').first();

async function startChat(page: Page, customer: string, message: string) {
  await page.goto('/');
  await page.locator('select[aria-label="Customer"]').selectOption({ label: customer });
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByLabel('Message').fill(message);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('A reviewer will decide shortly')).toBeVisible({ timeout: 15_000 });
}

test('with streams open, both pages say Live and a decision reaches the open chat without a reload', async ({ browser }) => {
  const customer = await (await browser.newContext()).newPage();
  const reviewer = await (await browser.newContext()).newPage();

  await startChat(customer, 'Ben Carter', 'Order #2 arrived damaged, please refund it');
  await expect(streamChip(customer)).toContainText('Live', { timeout: 15_000 });

  await reviewer.goto('/reviewer');
  await expect(streamChip(reviewer)).toContainText('Live', { timeout: 15_000 });
  await reviewer
    .getByRole('button', { name: /Ben Carter/ })
    .first()
    .click();
  await expect(reviewer.getByText('pending approval — run paused')).toBeVisible({ timeout: 15_000 });
  await reviewer.getByRole('tab', { name: /Approvals/ }).click();

  // Mark the page object: a reload would lose this, so finding it again proves the chat updated in place.
  await customer.evaluate(() => ((window as unknown as { __kept: boolean }).__kept = true));
  await reviewer.getByRole('button', { name: 'Approve' }).click();
  await expect(customer.getByText(/your refund of \$[\d.]+ for order #2 was approved and issued/)).toBeVisible({ timeout: 10_000 });
  expect(await customer.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true);
  await expect(streamChip(customer)).toContainText('Live');
});

test('when the event streams cannot be opened the page says Polling, still shows the decision, and goes back to Live', async ({
  browser,
  request,
}) => {
  const customer = await (await browser.newContext()).newPage();
  let blocked = true;
  await customer.route('**/api/**/events', (route) => (blocked ? route.abort() : route.continue()));

  await startChat(customer, 'Chloe Diaz', 'Order #3 arrived damaged, please refund it');
  await expect(streamChip(customer)).toContainText('Polling', { timeout: 20_000 });

  // Decided through the API, so the only way the page can learn of it is by polling.
  const pending = (await (await request.get(`${API}/approvals?status=pending`)).json()) as { id: string; customerName: string }[];
  const mine = pending.find((a) => a.customerName === 'Chloe Diaz');
  expect(mine).toBeDefined();
  await request.post(`${API}/approvals/${mine!.id}`, { data: { decision: 'approve' } });
  await expect(customer.getByText(/for order #3 was approved and issued/)).toBeVisible({ timeout: 15_000 });
  await expect(streamChip(customer)).toContainText('Polling');

  blocked = false;
  await expect(streamChip(customer)).toContainText('Live', { timeout: 30_000 });
});
