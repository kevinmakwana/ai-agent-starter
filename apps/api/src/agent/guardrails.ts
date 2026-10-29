import { GuardrailViolation } from './errors';
import type { OrderStatus } from './types';

const toCents = (amount: number) => Math.round(amount * 100);

/** Tools may only touch the customer the conversation is bound to. */
export function assertSameCustomer(boundCustomerId: number, targetCustomerId: number, what: string): void {
  if (boundCustomerId !== targetCustomerId) {
    throw new GuardrailViolation(
      'CROSS_CUSTOMER',
      `Access denied: ${what} does not belong to the customer in this conversation.`,
    );
  }
}

export interface RefundCheck {
  amount: number;
  orderTotal: number;
  priorRefunded: number;
  status: OrderStatus;
}

/** amount must be > 0, at most 2 decimals, and <= order total minus prior refunds. */
export function assertRefundable({ amount, orderTotal, priorRefunded, status }: RefundCheck): void {
  if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - toCents(amount)) > 1e-6) {
    throw new GuardrailViolation('INVALID_AMOUNT', 'Refund amount must be a positive number with at most 2 decimals.');
  }
  if (status === 'cancelled') {
    throw new GuardrailViolation('ORDER_CANCELLED', 'This order was cancelled and was never charged.');
  }
  const remaining = toCents(orderTotal) - toCents(priorRefunded);
  if (toCents(amount) > remaining) {
    throw new GuardrailViolation(
      'OVER_REFUND',
      `Refund of $${amount.toFixed(2)} exceeds the refundable balance of $${(remaining / 100).toFixed(2)} ` +
        `(order total $${orderTotal.toFixed(2)}, already refunded $${priorRefunded.toFixed(2)}).`,
    );
  }
}

export interface CancelCheck {
  status: OrderStatus;
  priorRefunded: number;
}

/** Only a processing order with no money refunded can still be cancelled. */
export function assertCancellable({ status, priorRefunded }: CancelCheck): void {
  if (status === 'cancelled') throw new GuardrailViolation('ALREADY_CANCELLED', 'This order is already cancelled.');
  if (status !== 'processing') {
    throw new GuardrailViolation(
      'NOT_CANCELLABLE',
      `This order is ${status} and can no longer be cancelled; a refund or a support ticket is the way to resolve it.`,
    );
  }
  if (toCents(priorRefunded) > 0) {
    throw new GuardrailViolation('HAS_REFUNDS', 'This order has refunds recorded against it, so it cannot be cancelled.');
  }
}

export const refundable = (orderTotal: number, priorRefunded: number) =>
  Math.max(0, (toCents(orderTotal) - toCents(priorRefunded)) / 100);
