import { TOOLS, toolSpecs, validateToolInput } from './tools';

describe('tool input schemas', () => {
  it('accepts valid arguments for every tool', () => {
    const valid: Record<string, unknown> = {
      get_customer: { email: 'ava.brooks@example.com' },
      list_orders: {},
      get_order: { orderId: 7 },
      create_ticket: { subject: 'Late parcel', body: 'It has not arrived.' },
      issue_refund: { orderId: 7, amount: 12.5, reason: 'Arrived damaged' },
      track_shipment: { orderId: 7 },
      cancel_order: { orderId: 7, reason: 'Ordered by mistake' },
    };
    for (const t of TOOLS) expect(validateToolInput(t.name, valid[t.name])).toEqual({ ok: true });
  });

  it.each([
    ['get_customer', { email: 'not-an-email' }],
    ['get_customer', {}],
    ['list_orders', { customerId: 1 }], // the conversation decides whose orders; the model can't pick
    ['list_orders', 'not an object'],
    ['get_order', { orderId: 0 }],
    ['get_order', { orderId: 2 ** 31 }], // beyond the database's integer: must not reach a query
    ['issue_refund', { orderId: 1e12, amount: 5, reason: 'because' }],
    ['create_ticket', { subject: 'x', body: 'ok' }],
    ['create_ticket', { customerId: 1, subject: 'Late parcel', body: 'ok' }],
    ['issue_refund', { orderId: 1, amount: -5, reason: 'because' }],
    ['issue_refund', { orderId: 1, amount: 5 }],
    ['issue_refund', { orderId: 1, amount: 5, reason: 'because', extra: true }],
    ['get_order', 'not an object'],
    ['track_shipment', {}],
    ['track_shipment', { orderId: 0 }],
    ['track_shipment', { orderId: 1, customerId: 1 }],
    ['cancel_order', { orderId: 1 }],
    ['cancel_order', { orderId: 1, reason: 'no' }],
    ['cancel_order', { orderId: 1, reason: 'because', extra: true }],
    ['cancel_order', { orderId: 2 ** 31, reason: 'because' }],
  ])('rejects invalid arguments: %s %j', (tool, args) => {
    const r = validateToolInput(tool, args);
    expect(r.ok).toBe(false);
  });

  it('accepts the largest order id the database can hold', () => {
    expect(validateToolInput('get_order', { orderId: 2 ** 31 - 1 })).toEqual({ ok: true });
  });

  it('refuses NUL characters but not text that merely looks like an escape of one', () => {
    expect(validateToolInput('create_ticket', { subject: 'Late parcel', body: 'a\u0000b' }).ok).toBe(false);
    expect(validateToolInput('create_ticket', { subject: 'Late parcel', body: 'literal \\u0000 text' })).toEqual({ ok: true });
  });

  it('reports unknown tools', () => {
    expect(validateToolInput('drop_database', {})).toEqual({ ok: false, errors: ['Unknown tool "drop_database"'] });
  });

  it('exposes only issue_refund and cancel_order as risky, and a JSON schema for each tool', () => {
    expect(TOOLS.filter((t) => t.risky).map((t) => t.name)).toEqual(['issue_refund', 'cancel_order']);
    for (const s of toolSpecs()) expect(s.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
  });
});
