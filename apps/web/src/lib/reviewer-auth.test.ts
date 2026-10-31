import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { approvalProgress, canApprove, needsLogin } from './reviewer-auth';
import type { Approval, Reviewer } from './types';

const me: Reviewer = { id: 'r1', email: 'a@example.com', name: 'Alice', role: 'reviewer', active: true, createdAt: '', lastLoginAt: null };
const approval = (over: Partial<Approval> = {}): Approval => ({
  id: 'a1', runId: 'run', conversationId: 'c', toolName: 'issue_refund', toolArgs: { orderId: 1, amount: 50 }, toolCallId: 't', reasoning: '',
  status: 'pending_approval', decisionNote: null, createdAt: '', decidedAt: null, customerName: 'n', customerEmail: 'e', userMessage: null,
  orderTotal: 50, orderRefunded: 0, ...over,
});

describe('needsLogin', () => {
  it('is true only in accounts mode without a signed-in reviewer', () => {
    assert.equal(needsLogin({ reviewerAccounts: true }, null), true);
    assert.equal(needsLogin({ reviewerAccounts: true }, me), false);
  });

  it('is false in key and demo mode (the key box handles key mode) and before health has loaded', () => {
    assert.equal(needsLogin({ reviewerAccounts: false }, null), false);
    assert.equal(needsLogin(null, null), false);
  });
});

describe('approvalProgress', () => {
  it('says nothing for a one-approval action or a customer view without the fields', () => {
    assert.equal(approvalProgress(approval({ approvalsRequired: 1 })), null);
    assert.equal(approvalProgress(approval()), null);
  });

  it('shows how many of the required approvals are in, with who gave them', () => {
    assert.equal(approvalProgress(approval({ approvalsRequired: 2, approvalsGiven: 0, approvedBy: [] })), '0 of 2 approvals');
    assert.equal(approvalProgress(approval({ approvalsRequired: 2, approvalsGiven: 1, approvedBy: ['Bob'] })), '1 of 2 approvals · Bob');
    assert.equal(approvalProgress(approval({ approvalsRequired: 2, approvalsGiven: 2, approvedBy: ['Bob', 'Cy'], status: 'approved' })), '2 of 2 approvals · Bob, Cy');
  });

  it('tolerates missing counters on a two-approval action', () => {
    assert.equal(approvalProgress(approval({ approvalsRequired: 2 })), '0 of 2 approvals');
  });
});

describe('canApprove', () => {
  const two = (over: Partial<Approval> = {}) => approval({ approvalsRequired: 2, approvalsGiven: 0, approvedBy: [], approvedByIds: [], ...over });

  it('allows a one-approval action for anyone, signed in or not', () => {
    assert.deepEqual(canApprove(approval(), me), { allowed: true, reason: null });
    assert.deepEqual(canApprove(approval({ approvalsRequired: 1 }), null), { allowed: true, reason: null });
  });

  it('allows a signed-in reviewer who has not approved a two-approval action yet', () => {
    assert.equal(canApprove(two(), me).allowed, true);
    assert.equal(canApprove(two({ approvalsGiven: 1, approvedBy: ['Bob'], approvedByIds: ['r2'] }), me).allowed, true);
  });

  it('blocks the reviewer who already gave an approval, matching on id and not on name', () => {
    const mine = two({ approvalsGiven: 1, approvedBy: ['Alice'], approvedByIds: ['r1'] });
    const blocked = canApprove(mine, me);
    assert.equal(blocked.allowed, false);
    assert.match(blocked.reason ?? '', /already approved/i);
    // a different person who happens to share the name is not blocked
    assert.equal(canApprove(two({ approvedBy: ['Alice'], approvedByIds: ['someone-else'], approvalsGiven: 1 }), me).allowed, true);
  });

  it('blocks a key or demo caller from a two-approval action: they have no identity', () => {
    const blocked = canApprove(two(), null);
    assert.equal(blocked.allowed, false);
    assert.match(blocked.reason ?? '', /reviewer account/i);
  });

  it('blocks everything once the action is decided', () => {
    assert.equal(canApprove(approval({ status: 'approved' }), me).allowed, false);
    assert.equal(canApprove(two({ status: 'rejected' }), me).allowed, false);
  });
});
