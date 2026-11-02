import { expect, test } from '@playwright/test';

const API = 'http://127.0.0.1:3201';

// The product's main path in a real browser: a customer asks for a refund, the run parks, a reviewer approves it in the
// console, and the customer's chat picks the run up again. The refund itself is checked through the API.
test('a refund request waits for a reviewer, then runs once approved', async ({ browser, request }) => {
  const customer = await (await browser.newContext()).newPage();
  await customer.goto('/');
  await customer.locator('select[aria-label="Customer"]').selectOption({ label: 'Ava Brooks' });
  await customer.getByRole('button', { name: 'New', exact: true }).click();
  await customer.getByLabel('Message').fill('Order #1 arrived damaged, please refund it');
  await customer.getByRole('button', { name: 'Send' }).click();
  await expect(customer.getByText('A reviewer will decide shortly')).toBeVisible({ timeout: 15_000 });

  // Nothing has been refunded while it waits.
  const ofAva = (rows: { customerName: string }[]) => rows.filter((a) => a.customerName === 'Ava Brooks');
  const waiting = ofAva(await (await request.get(`${API}/approvals?status=pending`)).json());
  expect(waiting).toHaveLength(1);
  expect(waiting[0]).toMatchObject({ toolName: 'issue_refund', customerName: 'Ava Brooks', status: 'pending_approval' });

  const reviewer = await (await browser.newContext()).newPage();
  await reviewer.goto('/reviewer');
  await reviewer
    .getByRole('button', { name: /Ava Brooks/ })
    .first()
    .click();
  await expect(reviewer.getByText('pending approval — run paused')).toBeVisible({ timeout: 15_000 });
  await reviewer.getByRole('tab', { name: /Approvals/ }).click();
  await reviewer.getByRole('button', { name: 'Approve' }).click();

  await expect(customer.getByText(/your refund of \$[\d.]+ for order #1 was approved and issued/)).toBeVisible({ timeout: 15_000 });
  expect(ofAva(await (await request.get(`${API}/approvals?status=approved`)).json())).toHaveLength(1);
  expect(ofAva(await (await request.get(`${API}/approvals?status=pending`)).json())).toHaveLength(0);
});
