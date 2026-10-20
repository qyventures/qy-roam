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
  payment_confirmed_at?: unknown;
  shipping_address?: unknown;
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
      order.travel_start === null && order.travel_end === null &&
      // eSIM fulfilment is entirely digital. The webhook deliberately drops
      // incidental Stripe shipping data, so an address here cannot be part
      // of the exact order snapshot created by that boundary.
      order.shipping_address === null;
  }

  return order.travel_start === (session.metadata?.start || null) &&
    order.travel_end === (session.metadata?.end || null) &&
    // Pocket WiFi has no digital package entitlement. Reject a cross-product
    // or partially repaired row instead of silently ignoring those fields at
    // the paid-order authority boundary.
    order.plan_id === null && order.data_allowance === null;
}

/**
 * Prove that a paid persistence acknowledgement also retained the signed
 * Stripe event time that authorized the payment transition. The commercial
 * join above is necessary but not sufficient for the webhook: fulfilment and
 * Purchase delivery must not begin when an old database function, malformed
 * gateway response, or manual repair returned a paid row with a missing or
 * different accounting timestamp.
 */
export function durablePaidOrderMatchesPaymentEvent(
  order: DurableOrderSnapshot | null | undefined,
  session: Stripe.Checkout.Session,
  productType: QyRoamProductType,
  eventCreated: number,
) {
  if (!durableOrderMatchesPaidSession(order, session, productType) ||
    !Number.isSafeInteger(eventCreated) || eventCreated <= 0 ||
    typeof order?.payment_confirmed_at !== 'string') {
    return false;
  }

  const confirmedAt = Date.parse(order.payment_confirmed_at);
  return Number.isFinite(confirmedAt) && confirmedAt === eventCreated * 1_000;
}

/**
 * Prove that a terminal asynchronous payment failure belongs to the exact
 * authenticated Checkout Session before a caller rotates its idempotency key
 * or tells the customer to try again. A row keyed by the Session id alone is
 * not sufficient: imports and service-role repairs can still leave a
 * commercially mismatched row that must remain recoverable by operators.
 */
export function durableOrderMatchesFailedSession(
  order: DurableOrderSnapshot | null | undefined,
  session: Stripe.Checkout.Session,
  productType: QyRoamProductType,
) {
  const sessionId = validStripeCheckoutSessionIdForMode(session.id, session.livemode);
  const expectedMeasurementConsent = session.metadata?.measurement_consent === 'accepted'
    ? 'accepted'
    : 'essential';
  if (!order || !sessionId || order.stripe_session_id !== sessionId ||
    order.payment_status !== 'unpaid' || order.product_type !== productType ||
    session.metadata?.product_type !== productType ||
    order.measurement_consent !== expectedMeasurementConsent ||
    session.mode !== 'payment' || session.status !== 'complete' || session.payment_status !== 'unpaid' ||
    session.currency?.toLowerCase() !== 'sgd' ||
    typeof session.amount_total !== 'number' || !Number.isSafeInteger(session.amount_total) || session.amount_total <= 0 ||
    sgdCents(order.amount_sgd) !== session.amount_total ||
    order.plan_name !== (session.metadata?.plan_name || null) ||
    order.country !== (session.metadata?.country || null)) {
    return false;
  }

  if (productType === 'esim') {
    const expectedDataAllowance = session.metadata?.data_allowance ??
      getEsimPlan(session.metadata?.plan_id)?.data ?? null;
    return order.plan_id === (session.metadata?.plan_id || null) &&
      order.data_allowance === expectedDataAllowance &&
      order.travel_start === null && order.travel_end === null &&
      order.shipping_address === null;
  }

  return order.travel_start === (session.metadata?.start || null) &&
    order.travel_end === (session.metadata?.end || null) &&
    order.plan_id === null && order.data_allowance === null;
}

/**
 * A delayed asynchronous-failure event can be delivered after the same
 * Checkout Session is already durably paid. The persistence RPC deliberately
 * refuses to downgrade that order and returns its existing paid row. Treat
 * that result as an idempotent acknowledgement only when the row still
 * matches the failed event's complete commercial snapshot as a paid Session;
 * a merely matching Session id must never hide a corrupt order.
 */
export function durableOrderMatchesFailedOrAlreadyPaidSession(
  order: DurableOrderSnapshot | null | undefined,
  session: Stripe.Checkout.Session,
  productType: QyRoamProductType,
) {
  return durableOrderMatchesUnpaidOrAlreadyPaidSession(order, session, productType);
}

/**
 * Completed-but-unpaid Checkout Sessions create a durable asynchronous-payment
 * commitment before Stripe reports success or failure. Require the same exact
 * commercial join for that provisional write as for a terminal failure. A
 * delayed unpaid completion/failure may also race behind an already-paid row;
 * acknowledge that no-op only when the paid row still matches this Session.
 */
export function durableOrderMatchesUnpaidOrAlreadyPaidSession(
  order: DurableOrderSnapshot | null | undefined,
  session: Stripe.Checkout.Session,
  productType: QyRoamProductType,
) {
  if (durableOrderMatchesFailedSession(order, session, productType)) return true;
  if (session.status !== 'complete' || session.payment_status !== 'unpaid') return false;
  return durableOrderMatchesPaidSession(
    order,
    { ...session, payment_status: 'paid' },
    productType,
  );
}
