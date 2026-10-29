import { GuardrailViolation } from './errors';
import { assertCancellable, assertRefundable, assertSameCustomer, refundable } from './guardrails';
import { TOOLS, type ToolContext } from './tools';
import { MemoryShop } from '../../test/fakes';
import type { Order } from './types';

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as GuardrailViolation).code; } };

describe('pure guardrails', () => {
  it('blocks access to another customer', () => {
    expect(code(() => assertSameCustomer(1, 2, 'Order #2'))).toBe('CROSS_CUSTOMER');
    expect(code(() => assertSameCustomer(1, 1, 'Order #1'))).toBeUndefined();
  });

  it('allows a refund up to total minus prior refunds, exactly', () => {
    expect(code(() => assertRefundable({ amount: 40, orderTotal: 50, priorRefunded: 10, status: 'delivered' }))).toBeUndefined();
    expect(code(() => assertRefundable({ amount: 0.1 + 0.2, orderTotal: 0.3, priorRefunded: 0, status: 'delivered' }))).toBeUndefined();
  });

  it('blocks over-refunds, including via earlier refunds', () => {
    expect(code(() => assertRefundable({ amount: 50.01, orderTotal: 50, priorRefunded: 0, status: 'delivered' }))).toBe('OVER_REFUND');
    expect(code(() => assertRefundable({ amount: 41, orderTotal: 50, priorRefunded: 10, status: 'delivered' }))).toBe('OVER_REFUND');
  });

  it('blocks non-positive, fractional-cent and cancelled-order refunds', () => {
    expect(code(() => assertRefundable({ amount: 0, orderTotal: 50, priorRefunded: 0, status: 'delivered' }))).toBe('INVALID_AMOUNT');
    expect(code(() => assertRefundable({ amount: 1.005, orderTotal: 50, priorRefunded: 0, status: 'delivered' }))).toBe('INVALID_AMOUNT');
    expect(code(() => assertRefundable({ amount: 5, orderTotal: 50, priorRefunded: 0, status: 'cancelled' }))).toBe('ORDER_CANCELLED');
  });

  it('computes the refundable balance', () => {
    expect(refundable(66.99, 10)).toBe(56.99);
    expect(refundable(10, 10)).toBe(0);
  });
});

describe('tool-level guardrails (conversation bound to customer 1)', () => {
  const ctx = (): ToolContext => ({ customerId: 1, shop: new MemoryShop() });

  it('lets the bound customer read their own data', async () => {
    await expect(tool('get_order').execute(ctx(), { orderId: 1 })).resolves.toMatchObject({ order: { id: 1 } });
    await expect(tool('list_orders').execute(ctx(), {})).resolves.toMatchObject({ orders: [{ id: 1 }, { id: 3 }] });
  });

  it('always acts on the bound customer, even if a customerId slips past schema validation', async () => {
    const shop = new MemoryShop();
    const c: ToolContext = { customerId: 1, shop };
    const orders = (await tool('list_orders').execute(c, { customerId: 2 })) as { orders: { id: number }[] };
    expect(orders.orders.map((o) => o.id)).toEqual([1, 3]); // customer 2's order #2 is never returned
    await tool('create_ticket').execute(c, { customerId: 2, subject: 'hi there', body: 'x' });
    expect(shop.tickets).toMatchObject([{ customerId: 1 }]);
  });

  it('blocks cross-customer reads and writes', async () => {
    const c = ctx();
    await expect(tool('get_order').execute(c, { orderId: 2 })).rejects.toMatchObject({ code: 'CROSS_CUSTOMER' });
    await expect(tool('get_customer').execute(c, { email: 'ben.carter@example.com' })).rejects.toMatchObject({ code: 'CROSS_CUSTOMER' });
    await expect(tool('issue_refund').preflight!(c, { orderId: 2, amount: 5, reason: 'nope' })).rejects.toMatchObject({ code: 'CROSS_CUSTOMER' });
  });

  it('blocks an over-refund at preflight and at execution', async () => {
    const c = ctx();
    await expect(tool('issue_refund').preflight!(c, { orderId: 1, amount: 50.01, reason: 'too much' })).rejects.toMatchObject({ code: 'OVER_REFUND' });
    await expect(tool('issue_refund').execute(c, { orderId: 1, amount: 50.01, reason: 'too much' })).rejects.toMatchObject({ code: 'OVER_REFUND' });
  });

  const processing = (id = 10): Order => ({ id, customerId: 1, status: 'processing', total: 30, items: [], createdAt: '2026-01-05T00:00:00.000Z' });

  it('track_shipment returns the shipment of an own delivered order', async () => {
    await expect(tool('track_shipment').execute(ctx(), { orderId: 1 })).resolves.toMatchObject({
      shipped: true, orderId: 1, carrier: 'FedEx', trackingNumber: 'FX900000001', status: 'delivered',
    });
  });

  it("track_shipment refuses another customer's order without touching the shipment table", async () => {
    const shop = new MemoryShop();
    const getShipment = jest.spyOn(shop, 'getShipment');
    await expect(tool('track_shipment').execute({ customerId: 1, shop }, { orderId: 2 })).rejects.toMatchObject({ code: 'CROSS_CUSTOMER' });
    expect(getShipment).not.toHaveBeenCalled();
  });

  it('track_shipment says an unshipped order has no shipment', async () => {
    const shop = new MemoryShop();
    shop.orders.push(processing());
    await expect(tool('track_shipment').execute({ customerId: 1, shop }, { orderId: 10 })).resolves.toEqual({
      shipped: false, orderId: 10, orderStatus: 'processing',
    });
  });

  it('cancel_order preflight passes only for an own, processing order with no refunds', async () => {
    const shop = new MemoryShop();
    shop.orders.push(processing(), processing(11));
    shop.refunds.push({ id: 1, orderId: 11, amount: 5, reason: 'partial' });
    const c: ToolContext = { customerId: 1, shop };
    const preflight = (orderId: number) => tool('cancel_order').preflight!(c, { orderId, reason: 'changed my mind' });

    await expect(preflight(10)).resolves.toBeDefined();
    await expect(preflight(1)).rejects.toMatchObject({ code: 'NOT_CANCELLABLE' });
    await expect(preflight(3)).rejects.toMatchObject({ code: 'ALREADY_CANCELLED' });
    await expect(preflight(11)).rejects.toMatchObject({ code: 'HAS_REFUNDS' });
    await expect(preflight(2)).rejects.toMatchObject({ code: 'CROSS_CUSTOMER' });
  });

  it('cancel_order execute cancels the order', async () => {
    const shop = new MemoryShop();
    shop.orders.push(processing());
    await expect(tool('cancel_order').execute({ customerId: 1, shop }, { orderId: 10, reason: 'changed my mind' })).resolves.toEqual({
      orderId: 10, status: 'cancelled',
    });
    expect((await shop.getOrder(10))?.status).toBe('cancelled');
  });
});

describe('assertCancellable', () => {
  it('allows a processing order with no refunds', () => {
    expect(code(() => assertCancellable({ status: 'processing', priorRefunded: 0 }))).toBeUndefined();
  });
  it('refuses a cancelled order first, then shipped or delivered ones, then refunded ones', () => {
    expect(code(() => assertCancellable({ status: 'cancelled', priorRefunded: 5 }))).toBe('ALREADY_CANCELLED');
    expect(code(() => assertCancellable({ status: 'shipped', priorRefunded: 0 }))).toBe('NOT_CANCELLABLE');
    expect(code(() => assertCancellable({ status: 'delivered', priorRefunded: 5 }))).toBe('NOT_CANCELLABLE');
    expect(code(() => assertCancellable({ status: 'processing', priorRefunded: 0.01 }))).toBe('HAS_REFUNDS');
  });
});
