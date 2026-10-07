import type Stripe from 'stripe';
import type { QyRoamProductType } from './qyRoamSession';
import { getEsimPlan } from './esimPlans';
import { validStripeCheckoutSessionIdForMode } from './stripeSessionId';

export type DurableOrderSnapshot = {
  stripe_session_id?: unknown;
  payment_status?: unknown;
  product_type?: unknown;
  amount_sgd?: unknown;
  plan_id?: unknown;
  plan_name?: unknown;
  data_allowance?: unknown;
  country?: unknown;
  travel_start?: unknown;
  travel_end?: unknown;
  measurement_consent?: unknown;
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
  // Keep this shared join safe without relying on every caller to repeat the
  // Stripe payment-state boundary first. The database row can say `paid`, but
  // only a completed, paid, one-time SGD Checkout Session is authority for a
  // QY Roam fulfilment or customer confirmation. This is especially important
  // for admin recovery, where a successful match can trigger external email
  // and analytics side effects.
  const sessionId = validStripeCheckoutSessionIdForMode(session.id, session.livemode);
  const expectedMeasurementConsent = session.metadata?.measurement_consent === 'accepted'
    ? 'accepted'
    : 'essential';
  if (!order || !sessionId || order.stripe_session_id !== sessionId ||
    order.payment_status !== 'paid' || order.product_type !== productType ||
    session.metadata?.product_type !== productType ||
    order.measurement_consent !== expectedMeasurementConsent ||
    session.mode !== 'payment' || session.status !== 'complete' || session.payment_status !== 'paid' ||
    session.currency?.toLowerCase() !== 'sgd' ||
    typeof session.amount_total !== 'number' || !Number.isSafeInteger(session.amount_total) || session.amount_total <= 0 ||
    sgdCents(order.amount_sgd) !== session.amount_total ||
    order.plan_name !== (session.metadata?.plan_name || null) ||
    order.country !== (session.metadata?.country || null)) {
    return false;
  }

  if (productType === 'esim') {
    // Checkout Sessions created during the rollout of data-allowance
    // snapshots can legitimately omit this metadata field. The webhook uses
    // the then-current catalogue plan as the entitlement source for exactly
    // those validated sessions, so customer confirmation must reconcile
    // against the same value. A retired plan cannot take this fallback path:
    // validateQyRoamSession requires retired Sessions to carry their complete
    // signed historical entitlement snapshot.
    const expectedDataAllowance = session.metadata?.data_allowance ??
      getEsimPlan(session.metadata?.plan_id)?.data ?? null;
    return order.plan_id === (session.metadata?.plan_id || null) &&
      order.data_allowance === expectedDataAllowance &&
      // Stripe eSIM checkout never creates a physical rental period. Keep
      // product-inapplicable fields in this exact durable join as well: a
      // service-role import or repair with stray travel dates must not unlock
      // customer confirmation or admin delivery recovery as though it were
      // the row persisted from this digital Checkout Session.
      order.travel_start === null && order.travel_end === null;
  }

  return order.travel_start === (session.metadata?.start || null) &&
    order.travel_end === (session.metadata?.end || null) &&
    // Pocket WiFi has no digital package entitlement. Reject a cross-product
    // or partially repaired row instead of silently ignoring those fields at
    // the paid-order authority boundary.
    order.plan_id === null && order.data_allowance === null;
}
