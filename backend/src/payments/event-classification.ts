import type { ProviderEventClass } from './provider-adapter.interface';

/**
 * Explicit per-provider webhook event allowlists.
 *
 * Financial state may ONLY change for event types listed here. Anything not
 * listed is recorded for audit and acknowledged with 200 (so providers stop
 * retrying) but never mutates donation money state. This is a default-deny
 * design: unknown event types can never be interpreted as a successful
 * payment just because they are "not a failure".
 *
 * TERMINAL_FAILURE: safe to flip a PENDING donation to FAILED because these
 * events cannot later turn into a successful charge.
 * Non-terminal failures (e.g. Stripe `payment_intent.payment_failed`, which
 * Stripe retries) are deliberately NOT listed: they are recorded only.
 */
export const PROVIDER_EVENT_ALLOWLIST: Record<string, { SUCCESS: string[]; TERMINAL_FAILURE: string[]; REFUND: string[]; DISPUTE: string[]; PAYOUT_TRANSFER: string[] }> = {
  PAYSTACK: {
    SUCCESS: ['charge.success'],
    TERMINAL_FAILURE: ['charge.failed'],
    REFUND: ['refund.processed', 'refund.pending', 'refund.failed'],
    DISPUTE: ['charge.dispute.create', 'charge.dispute.remind', 'charge.dispute.resolve'],
    // v1.0.7 §13 — payout transfer events. A signed transfer event only
    // TRIGGERS authoritative verification; it never settles by itself.
    PAYOUT_TRANSFER: ['transfer.success', 'transfer.failed', 'transfer.reversed'],
  },
  FLUTTERWAVE: {
    // `charge.completed` requires data.status === 'successful' (checked by the caller);
    // Flutterwave emits it for failed charges too.
    SUCCESS: ['charge.completed'],
    TERMINAL_FAILURE: ['charge.failed'],
    REFUND: ['refund.completed', 'refund.processed', 'refund.failed'],
    DISPUTE: [],
    // v1.0.7 §13 — transfer.* events (transfer.completed fires for failed
    // transfers too; data.status is re-fetched from the API).
    PAYOUT_TRANSFER: ['transfer.completed', 'transfer.failed', 'transfer.reversed'],
  },
  STRIPE: {
    SUCCESS: ['checkout.session.completed', 'checkout.session.async_payment_succeeded'],
    TERMINAL_FAILURE: ['checkout.session.expired', 'checkout.session.async_payment_failed'],
    REFUND: ['charge.refunded', 'refund.updated'],
    DISPUTE: ['charge.dispute.created', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated'],
    // v1.0.7 §6: Stripe payouts are disabled — no transfer events accepted.
    PAYOUT_TRANSFER: [],
  },
  PAYPAL: {
    // CHECKOUT.ORDER.APPROVED is deliberately excluded: the order is approved
    // by the buyer but money is not captured yet.
    SUCCESS: ['PAYMENT.CAPTURE.COMPLETED'],
    TERMINAL_FAILURE: ['PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.DECLINED', 'CHECKOUT.ORDER.VOIDED'],
    REFUND: ['PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED', 'PAYMENT.REFUND.COMPLETED', 'PAYMENT.REFUND.FAILED'],
    DISPUTE: ['CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED'],
    // v1.0.7: PayPal payouts are not implemented — no transfer events.
    PAYOUT_TRANSFER: [],
  },
  MOCK: {
    SUCCESS: ['charge.success', 'payment.succeeded'],
    TERMINAL_FAILURE: ['charge.failed', 'payment.failed'],
    REFUND: ['refund.processed'],
    DISPUTE: [],
    PAYOUT_TRANSFER: ['mock.transfer.success', 'mock.transfer.failed'],
  },
};

export function classifyProviderEvent(provider: string, eventType?: string): ProviderEventClass {
  if (!eventType) return 'UNKNOWN';
  const table = PROVIDER_EVENT_ALLOWLIST[provider];
  if (!table) return 'UNKNOWN';
  if (table.SUCCESS.includes(eventType)) return 'SUCCESS';
  if (table.TERMINAL_FAILURE.includes(eventType)) return 'TERMINAL_FAILURE';
  if (table.REFUND.includes(eventType)) return 'REFUND';
  if (table.DISPUTE.includes(eventType)) return 'DISPUTE';
  if (table.PAYOUT_TRANSFER?.includes(eventType)) return 'PAYOUT_TRANSFER';
  return 'UNKNOWN';
}
