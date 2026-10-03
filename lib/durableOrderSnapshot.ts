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
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) return null;

  // PostgREST may expose PostgreSQL numeric values as either JSON strings or
  // numbers. Converting a valid number with multiplication is not safe here:
  // for example, 4.81 * 100 is 480.99999999999994 in JavaScript. Parse its
  // shortest decimal representation instead, while still rejecting values
  // with sub-cent precision rather than rounding them into agreement with
  // Stripe.
  const decimal = typeof value === 'number' ? value.toString() : value;
  const match = decimal.match(/^(\d{1,8})(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] || '').padEnd(2, '0'));
  const cents = whole * 100 + fraction;
  return Number.isSafeInteger(cents) ? cents : null;
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
