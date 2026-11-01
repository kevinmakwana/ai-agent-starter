// @vitest-environment jsdom
import assert from 'node:assert/strict';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, vi } from 'vitest';
import type { Approval, Reviewer } from '@/lib/types';
import { ApprovalsPanel } from './ApprovalsPanel';

afterEach(cleanup);

const approval = (over: Partial<Approval> = {}): Approval => ({
  id: 'a1',
  runId: 'run1',
  conversationId: 'c1',
  toolName: 'issue_refund',
  toolArgs: { orderId: 1, amount: 18.75, reason: 'arrived damaged' },
  toolCallId: 'call_2',
  reasoning: 'The customer reports damage.',
  status: 'pending_approval',
  decisionNote: null,
  createdAt: '2026-10-31T10:00:00Z',
  decidedAt: null,
  customerName: 'Ava Brooks',
  customerEmail: 'ava.brooks@example.com',
  userMessage: 'Order #1 arrived damaged, please refund it',
  orderTotal: 40,
  orderRefunded: 10,
  ...over,
});

const reviewer = (id: string): Reviewer => ({
  id,
  email: `${id}@example.com`,
  name: id,
  role: 'reviewer',
  active: true,
  createdAt: '2026-10-31T00:00:00Z',
  lastLoginAt: null,
});

const approveButton = () => screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;

describe('ApprovalsPanel', () => {
  it('shows the refund with the order balance and what the customer said', () => {
    render(<ApprovalsPanel approvals={[approval()]} me={null} onDecide={async () => undefined} />);
    assert.ok(screen.getByText('Refund · order #1'));
    assert.ok(screen.getByText('$18.75'));
    assert.ok(screen.getByText('$30.00')); // 40 total - 10 already refunded
    assert.ok(screen.getByText('Order #1 arrived damaged, please refund it'));
  });

  it('sends the decision with the note', async () => {
    const onDecide = vi.fn(async () => undefined);
    render(<ApprovalsPanel approvals={[approval()]} me={null} onDecide={onDecide} />);
    await userEvent.type(screen.getByLabelText('Reviewer note'), 'looks right');
    await userEvent.click(approveButton());
    assert.deepEqual(onDecide.mock.calls, [['a1', 'approve', 'looks right']]);
  });

  it('lets anyone reject, including a reviewer who already approved', async () => {
    const onDecide = vi.fn(async () => undefined);
    const two = approval({ approvalsRequired: 2, approvalsGiven: 1, approvedBy: ['rae'], approvedByIds: ['rae'] });
    render(<ApprovalsPanel approvals={[two]} me={reviewer('rae')} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    assert.deepEqual(onDecide.mock.calls, [['a1', 'reject', '']]);
  });

  describe('two approvals needed', () => {
    const first = approval({ approvalsRequired: 2, approvalsGiven: 1, approvedBy: ['rae'], approvedByIds: ['rae'] });

    it('shows the progress and disables Approve for the reviewer who gave the first approval', () => {
      render(<ApprovalsPanel approvals={[first]} me={reviewer('rae')} onDecide={async () => undefined} />);
      assert.ok(screen.getByText('1 of 2 approvals · rae'));
      assert.equal(approveButton().disabled, true);
      assert.match(screen.getByText(/You already approved this/).textContent ?? '', /different reviewer/);
    });

    it('enables Approve for a different reviewer', () => {
      render(<ApprovalsPanel approvals={[first]} me={reviewer('sam')} onDecide={async () => undefined} />);
      assert.equal(approveButton().disabled, false);
    });

    it('disables Approve with no reviewer account (shared key or demo cannot satisfy two-person approval)', () => {
      render(<ApprovalsPanel approvals={[first]} me={null} onDecide={async () => undefined} />);
      assert.equal(approveButton().disabled, true);
    });
  });

  it('shows a decided approval without buttons, with its note', () => {
    render(
      <ApprovalsPanel
        approvals={[approval({ status: 'rejected', decisionNote: 'over limit' })]}
        me={null}
        onDecide={async () => undefined}
      />,
    );
    assert.equal(screen.queryByRole('button', { name: 'Approve' }), null);
    assert.ok(screen.getByText('rejected · over limit'));
  });

  it('says so when nothing is waiting', () => {
    render(<ApprovalsPanel approvals={[]} me={null} onDecide={async () => undefined} />);
    assert.ok(screen.getByText(/Nothing waiting/));
  });
});
