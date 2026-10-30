import { approvalForCaller } from './run-view';

const approval = {
  id: 'a1', status: 'pending_approval', policyRule: 'always_review', policyDetail: { x: 1 }, notifiedAt: 'now',
  approvalsRequired: 2, approvalsGiven: 1, approvedBy: ['Alice'],
};

describe('approvalForCaller', () => {
  it('gives reviewers everything', () => {
    expect(approvalForCaller(approval, true)).toEqual(approval);
  });

  it('strips the policy, notification and four-eyes fields for customers, keeping the rest', () => {
    expect(approvalForCaller(approval, false)).toEqual({ id: 'a1', status: 'pending_approval' });
  });
});
