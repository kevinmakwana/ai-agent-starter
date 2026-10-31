import { evaluateApproval, type ApprovalPolicyConfig } from './policy';

const cfg = (refundAutoApproveUnder: number): ApprovalPolicyConfig => ({ refundAutoApproveUnder });
const refund = (amount: unknown, priorRefunded: number | undefined, threshold: number) =>
  evaluateApproval('issue_refund', { orderId: 1, amount, reason: 'x' }, { priorRefunded }, cfg(threshold));

describe('evaluateApproval for issue_refund', () => {
  it('auto-approves strictly under the threshold and records the numbers it used', () => {
    expect(refund(24.99, 0, 25)).toEqual({
      mode: 'auto', rule: 'under_threshold', detail: { threshold: 25, priorRefunded: 0, amount: 24.99 }, approvalsRequired: 1,
    });
  });

  it('sends a refund of exactly the threshold to a human', () => {
    expect(refund(25, 0, 25)).toMatchObject({ mode: 'human', rule: 'over_threshold' });
  });

  it('counts earlier refunds on the order toward the threshold (no splitting)', () => {
    expect(refund(10, 15, 25)).toMatchObject({ mode: 'human', rule: 'over_threshold' }); // 25.00 is not under 25
    expect(refund(10, 14.99, 25)).toMatchObject({ mode: 'auto', rule: 'under_threshold' }); // 24.99 is
  });

  it('compares in cents, so floating point drift cannot flip the result', () => {
    expect(refund(0.3, 0.1, 0.41)).toMatchObject({ mode: 'auto' }); // 10 + 30 = 40 cents, under 41
    expect(refund(0.7, 0.1, 0.8)).toEqual({ mode: 'human', rule: 'over_threshold', detail: { threshold: 0.8, priorRefunded: 0.1, amount: 0.7 }, approvalsRequired: 1 }); // 0.1 + 0.7 is 0.7999999999999999 in floats, which would wrongly auto-approve; 80 cents is not under 80
  });

  it('always reviews when no threshold is set', () => {
    expect(refund(0.01, 0, 0)).toMatchObject({ mode: 'human', rule: 'always_review' });
    expect(refund(0.01, 0, -5)).toMatchObject({ mode: 'human', rule: 'always_review' });
    expect(refund(0.01, 0, Number.NaN)).toMatchObject({ mode: 'human', rule: 'always_review' });
  });

  it('fails closed when it cannot evaluate', () => {
    expect(refund(10, undefined, 25)).toMatchObject({ mode: 'human', rule: 'default' }); // no facts
    expect(refund('10', 0, 25)).toMatchObject({ mode: 'human', rule: 'default' });
    expect(refund(Number.NaN, 0, 25)).toMatchObject({ mode: 'human', rule: 'default' });
    expect(refund(-1, 0, 25)).toMatchObject({ mode: 'human', rule: 'default' });
    expect(refund(0, 0, 25)).toMatchObject({ mode: 'human', rule: 'default' });
    expect(evaluateApproval('issue_refund', null, { priorRefunded: 0 }, cfg(25))).toMatchObject({ mode: 'human', rule: 'default' });
  });
});

describe('evaluateApproval for other tools', () => {
  it('sends an unknown risky tool to a human', () => {
    expect(evaluateApproval('delete_everything', { orderId: 1 }, {}, cfg(1000))).toEqual({ mode: 'human', rule: 'default', detail: {}, approvalsRequired: 1 });
  });
});

describe('evaluateApproval for cancel_order', () => {
  it('always goes to a human, whatever the refund threshold', () => {
    for (const threshold of [0, 25, 1_000_000]) {
      expect(evaluateApproval('cancel_order', { orderId: 1, reason: 'changed my mind' }, {}, cfg(threshold))).toEqual({
        mode: 'human', rule: 'tool_requires_review', detail: {}, approvalsRequired: 1,
      });
    }
  });
});

describe('evaluateApproval: approvalsRequired (four-eyes)', () => {
  const eyes = (refundOver: number, cancellations = false): ApprovalPolicyConfig => ({ refundAutoApproveUnder: 0, fourEyes: { refundOver, cancellations } });
  const refundWith = (amount: unknown, config: ApprovalPolicyConfig, facts = { priorRefunded: 0 }) =>
    evaluateApproval('issue_refund', { orderId: 1, amount, reason: 'x' }, facts, config);
  const cancel = (config: ApprovalPolicyConfig) => evaluateApproval('cancel_order', { orderId: 1 }, {}, config);

  it('is 1 unless four-eyes is configured, whatever the amount', () => {
    expect(refundWith(10_000, cfg(0))).toMatchObject({ mode: 'human', approvalsRequired: 1 });
    expect(refundWith(10_000, eyes(0))).toMatchObject({ approvalsRequired: 1 }); // 0 = off
    expect(cancel(cfg(0))).toMatchObject({ approvalsRequired: 1 });
  });

  it('needs two for a refund strictly over the threshold, one at or under it', () => {
    expect(refundWith(100.01, eyes(100))).toMatchObject({ mode: 'human', approvalsRequired: 2 });
    expect(refundWith(100, eyes(100))).toMatchObject({ approvalsRequired: 1 }); // boundary: not "over"
    expect(refundWith(99.99, eyes(100))).toMatchObject({ approvalsRequired: 1 });
  });

  it('judges this refund, not the order total, and compares in cents', () => {
    expect(refundWith(60, eyes(100), { priorRefunded: 80 })).toMatchObject({ approvalsRequired: 1 });
    expect(refundWith(0.3, eyes(0.29))).toMatchObject({ approvalsRequired: 2 });
    expect(refundWith(0.1 + 0.2, eyes(0.3))).toMatchObject({ approvalsRequired: 1 }); // 0.30000000000000004 is 30 cents
  });

  it('records the count in the audit detail only when it is 2', () => {
    expect(refundWith(500, eyes(100))).toMatchObject({ detail: { approvalsRequired: 2 } });
    expect(refundWith(50, eyes(100))).toMatchObject({ approvalsRequired: 1 });
    expect((refundWith(50, eyes(100)).detail as Record<string, unknown>).approvalsRequired).toBeUndefined();
  });

  it('keeps the rule, and never lets four-eyes cause or prevent auto-approval', () => {
    const both: ApprovalPolicyConfig = { refundAutoApproveUnder: 100, fourEyes: { refundOver: 10, cancellations: false } };
    expect(refundWith(50, both)).toMatchObject({ mode: 'auto', rule: 'under_threshold', approvalsRequired: 1 }); // auto never parks
    expect(refundWith(150, both)).toMatchObject({ mode: 'human', rule: 'over_threshold', approvalsRequired: 2 });
    expect(refundWith(500, eyes(100))).toMatchObject({ rule: 'always_review' });
  });

  it('needs two for every cancellation only when the flag is on', () => {
    expect(cancel(eyes(0, true))).toMatchObject({ mode: 'human', rule: 'tool_requires_review', approvalsRequired: 2, detail: { approvalsRequired: 2 } });
    expect(cancel(eyes(0, false))).toMatchObject({ approvalsRequired: 1 });
  });

  it('stays at 1 when the amount cannot be read, and for tools that are not refunds or cancellations', () => {
    expect(refundWith('500', eyes(100))).toMatchObject({ rule: 'always_review', approvalsRequired: 1 });
    expect(refundWith(Number.NaN, eyes(100))).toMatchObject({ approvalsRequired: 1 });
    expect(evaluateApproval('issue_refund', null, {}, eyes(100))).toMatchObject({ approvalsRequired: 1 });
    expect(evaluateApproval('create_ticket', {}, {}, eyes(1, true))).toMatchObject({ rule: 'default', approvalsRequired: 1 });
  });
});
