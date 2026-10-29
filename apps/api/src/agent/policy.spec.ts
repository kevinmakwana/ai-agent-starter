import { evaluateApproval, type ApprovalPolicyConfig } from './policy';

const cfg = (refundAutoApproveUnder: number): ApprovalPolicyConfig => ({ refundAutoApproveUnder });
const refund = (amount: unknown, priorRefunded: number | undefined, threshold: number) =>
  evaluateApproval('issue_refund', { orderId: 1, amount, reason: 'x' }, { priorRefunded }, cfg(threshold));

describe('evaluateApproval for issue_refund', () => {
  it('auto-approves strictly under the threshold and records the numbers it used', () => {
    expect(refund(24.99, 0, 25)).toEqual({
      mode: 'auto', rule: 'under_threshold', detail: { threshold: 25, priorRefunded: 0, amount: 24.99 },
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
    expect(refund(0.7, 0.1, 0.8)).toEqual({ mode: 'human', rule: 'over_threshold', detail: { threshold: 0.8, priorRefunded: 0.1, amount: 0.7 } }); // 0.1 + 0.7 is 0.7999999999999999 in floats, which would wrongly auto-approve; 80 cents is not under 80
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
    expect(evaluateApproval('delete_everything', { orderId: 1 }, {}, cfg(1000))).toEqual({ mode: 'human', rule: 'default', detail: {} });
  });
});

describe('evaluateApproval for cancel_order', () => {
  it('always goes to a human, whatever the refund threshold', () => {
    for (const threshold of [0, 25, 1_000_000]) {
      expect(evaluateApproval('cancel_order', { orderId: 1, reason: 'changed my mind' }, {}, cfg(threshold))).toEqual({
        mode: 'human', rule: 'tool_requires_review', detail: {},
      });
    }
  });
});
