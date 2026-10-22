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
    expect(refund(0.3, 0.1, 0.41)).toMatchObject({ mode: 'auto' }); // 0.1 + 0.3 is 0.4 in cents, not 0.40000000000000002
    expect(refund(0.2, 0.1, 0.3)).toMatchObject({ mode: 'human' }); // 0.1 + 0.2 must equal 0.3, not sit just under it
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
    expect(evaluateApproval('cancel_order', { orderId: 1 }, {}, cfg(1000))).toEqual({ mode: 'human', rule: 'default', detail: {} });
  });
});
