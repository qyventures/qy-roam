import type Stripe from 'stripe';

export type QyRoamCheckoutEventType =
  | 'checkout.session.completed'
  | 'checkout.session.async_payment_succeeded'
  | 'checkout.session.async_payment_failed'
  | 'checkout.session.expired';

/**
 * Validate the Stripe-owned state carried by a terminal Checkout event before
 * it can persist an order, release inventory, or trigger delivery. Keeping
 * this pure makes every accepted and rejected transition executable in tests
 * instead of relying on route-source assertions for a payment boundary.
 */
export function stripeCheckoutEventStateIssue(
  eventType: QyRoamCheckoutEventType,
  session: Pick<Stripe.Checkout.Session, 'status' | 'payment_status'>,
) {
  if (eventType === 'checkout.session.expired') {
    // QY Roam Checkout Sessions always have a positive amount and therefore
    // can expire only while unpaid. Do not use a broad `!== paid` check here:
    // this expiry path intentionally runs before full order validation, and
    // accepting `no_payment_required` (or a future Stripe state) could release
    // a scarce Pocket WiFi reservation without a valid payment lifecycle.
    return session.status === 'expired' && session.payment_status === 'unpaid'
      ? null
      : 'Expired event does not contain an expired unpaid Checkout Session';
  }
  if (session.status !== 'complete') return 'Terminal checkout event does not contain a complete Checkout Session';
  if (eventType === 'checkout.session.async_payment_succeeded' && session.payment_status !== 'paid') {
    return 'Asynchronous payment success does not contain a paid Checkout Session';
  }
  if (eventType === 'checkout.session.async_payment_failed' && session.payment_status !== 'unpaid') {
    return 'Asynchronous payment failure does not contain an unpaid Checkout Session';
  }
  return null;
}
