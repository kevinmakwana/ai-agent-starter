import { TOOLS, toolSpecs, validateToolInput } from './tools';

describe('tool input schemas', () => {
  it('accepts valid arguments for every tool', () => {
    const valid: Record<string, unknown> = {
      get_customer: { email: 'ava.brooks@example.com' },
      list_orders: { customerId: 1 },
      get_order: { orderId: 7 },
      create_ticket: { customerId: 1, subject: 'Late parcel', body: 'It has not arrived.' },
      issue_refund: { orderId: 7, amount: 12.5, reason: 'Arrived damaged' },
    };
    for (const t of TOOLS) expect(validateToolInput(t.name, valid[t.name])).toEqual({ ok: true });
  });

  it.each([
    ['get_customer', { email: 'not-an-email' }],
    ['get_customer', {}],
    ['list_orders', { customerId: '1' }],
    ['list_orders', { customerId: 1.5 }],
    ['get_order', { orderId: 0 }],
    ['create_ticket', { customerId: 1, subject: 'x', body: 'ok' }],
    ['issue_refund', { orderId: 1, amount: -5, reason: 'because' }],
    ['issue_refund', { orderId: 1, amount: 5 }],
    ['issue_refund', { orderId: 1, amount: 5, reason: 'because', extra: true }],
    ['get_order', 'not an object'],
  ])('rejects invalid arguments: %s %j', (tool, args) => {
    const r = validateToolInput(tool, args);
    expect(r.ok).toBe(false);
  });

  it('reports unknown tools', () => {
    expect(validateToolInput('drop_database', {})).toEqual({ ok: false, errors: ['Unknown tool "drop_database"'] });
  });

  it('exposes only issue_refund as risky and a JSON schema for each tool', () => {
    expect(TOOLS.filter((t) => t.risky).map((t) => t.name)).toEqual(['issue_refund']);
    for (const s of toolSpecs()) expect(s.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
  });
});
