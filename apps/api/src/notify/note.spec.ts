import { buildNote } from './note';
import type { ClaimedAction } from './types';

const CONSOLE = 'https://console.example.com/reviewer';
const ALLOWED = ['amount', 'consoleUrl', 'createdAt', 'id', 'orderId', 'rule', 'tool'];

const row = (over: Partial<ClaimedAction> = {}): ClaimedAction => ({
  id: 'a1', toolName: 'issue_refund', toolArgs: { orderId: 11, amount: 18.754 }, createdAt: '2026-10-29T10:00:00.000Z', rule: 'always_review', ...over,
});

describe('buildNote', () => {
  it('builds the allowed fields from a refund and never leaks the free-text reason', () => {
    const r = row({ toolArgs: { orderId: 11, amount: 18.754, reason: 'mail me at ava@example.com' } });
    const note = buildNote(r, CONSOLE);
    expect(note).toEqual({ id: 'a1', tool: 'issue_refund', orderId: 11, amount: 18.75, rule: 'always_review', createdAt: r.createdAt, consoleUrl: CONSOLE });
    expect(Object.keys(note).sort()).toEqual(ALLOWED);
    expect(JSON.stringify(note)).not.toContain('ava@example.com');
    expect(JSON.stringify(note)).not.toContain('reason');
  });

  it('has no amount for a cancellation', () => {
    const note = buildNote(row({ toolName: 'cancel_order', toolArgs: { orderId: 11, reason: 'x', amount: 5 } }), CONSOLE);
    expect(note.tool).toBe('cancel_order');
    expect(note.orderId).toBe(11);
    expect(note).not.toHaveProperty('amount');
  });

  it.each([
    ['a string', '11; DROP'],
    ['a fraction', 1.5],
    ['a negative', -3],
    ['zero', 0],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])('omits an orderId that is %s', (_label, orderId) => {
    expect(buildNote(row({ toolArgs: { orderId, amount: 5 } }), CONSOLE)).not.toHaveProperty('orderId');
  });

  it.each([
    ['a string', '99'],
    ['negative', -1],
    ['zero', 0],
    ['Infinity', Infinity],
    ['NaN', NaN],
  ])('omits an amount that is %s', (_label, amount) => {
    expect(buildNote(row({ toolArgs: { orderId: 11, amount } }), CONSOLE)).not.toHaveProperty('amount');
  });

  it.each([['too long', 'x'.repeat(500)], ['markup', '<b>'], ['empty', ''], ['null', null]])('omits a rule that is %s', (_label, rule) => {
    expect(buildNote(row({ rule }), CONSOLE)).not.toHaveProperty('rule');
  });

  it('replaces an invalid tool name with unknown', () => {
    expect(buildNote(row({ toolName: 'Not Valid!' }), CONSOLE).tool).toBe('unknown');
  });

  it('copies nothing else from the tool args', () => {
    const note = buildNote(row({ toolName: 'create_ticket', toolArgs: { subject: 'hi', email: 'a@b.co', customerId: 'c1' } }), CONSOLE);
    expect(Object.keys(note).sort()).toEqual(['consoleUrl', 'createdAt', 'id', 'rule', 'tool']);
  });
});
