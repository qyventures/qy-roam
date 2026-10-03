import type Stripe from 'stripe';
import type { QyRoamProductType } from './qyRoamSession';

export type DurableOrderSnapshot = {
  payment_status?: unknown;
  product_type?: unknown;
  amount_sgd?: unknown;
  plan_id?: unknown;
  plan_name?: unknown;
  data_allowance?: unknown;
  country?: unknown;
  travel_start?: unknown;
  travel_end?: unknown;
};

function sgdCents(value: unknown) {
  if (typeof value === 'string' && !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const amount = Number(value);
  const cents = amount * 100;
  // Do not round malformed database values into agreement with Stripe. The
  // orders column is numeric(10,2), so a genuine stored amount has exact-cent
  // precision even when PostgREST returns it as a JSON number.
  return Number.isFinite(amount) && amount >= 0 && Number.isSafeInteger(cents) ? cents : null;
}

/**
 * Prove that the durable row shown to a customer is the paid snapshot created
 * from this authenticated Checkout Session. The Session id is the lookup key,
 * but it is not enough on its own when an import or service-role repair could
 * have inserted an internally valid row with the wrong commercial identity.
 */
export function durableOrderMatchesPaidSession(
  order: DurableOrderSnapshot | null | undefined,
  session: Stripe.Checkout.Session,
  productType: QyRoamProductType,
) {
  if (!order || order.payment_status !== 'paid' || order.product_type !== productType ||
    !Number.isSafeInteger(session.amount_total) || sgdCents(order.amount_sgd) !== session.amount_total ||
    order.plan_name !== (session.metadata?.plan_name || null) ||
    order.country !== (session.metadata?.country || null)) {
    return false;
  }

  if (productType === 'esim') {
    return order.plan_id === (session.metadata?.plan_id || null) &&
      order.data_allowance === (session.metadata?.data_allowance || null);
  }

  return order.travel_start === (session.metadata?.start || null) &&
    order.travel_end === (session.metadata?.end || null);
}
