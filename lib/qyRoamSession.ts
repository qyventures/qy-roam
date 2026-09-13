import type Stripe from 'stripe';
import { ESIM_PROMO, getEsimPlan } from './esimPlans';
import { LAUNCH_PROMO } from './promotions';
import { getWifiPlan, WIFI_BENCHMARK } from './wifiPlans';
import { parseExactIsoDate, validCheckoutRequestId } from './checkoutValidation';
import { validQyRoamProvenance } from './orderProvenance';
import { operationalConfig } from './operationalConfig';

export type QyRoamProductType = 'esim' | 'pocket_wifi';

export function qyRoamProductType(session: Stripe.Checkout.Session): QyRoamProductType | null {
  if (session.metadata?.source !== 'qyroam.com') return null;
  const productType = session.metadata?.product_type;
  return productType === 'esim' || productType === 'pocket_wifi' ? productType : null;
}

export type QyRoamSessionValidation =
  | { valid: true; productType: QyRoamProductType }
  | { valid: false; reason: string };

function moneyMetadataCents(value?: string) {
  if (!value || !/^\d+\.\d{2}$/.test(value)) return null;
  const cents = Number(value.replace('.', ''));
  return Number.isSafeInteger(cents) ? cents : null;
}

function checkoutAmountSnapshotIsConsistent(session: Stripe.Checkout.Session) {
  const amount = session.amount_total;
  // Keep the amount snapshot canonical as well as signed. A valid HMAC proves
  // that metadata came from this application, but it does not make a
  // server-side creation defect (or a future consumer of this field) safe.
  // The Stripe amount is the payment authority and must exactly match the
  // server-authored integer-cent snapshot used throughout the order record.
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return false;
  return session.metadata?.checkout_amount_cents === String(amount);
}

function historicalPocketWifiSnapshotIsConsistent(session: Stripe.Checkout.Session, days: number) {
  const metadata = session.metadata;
  const country = metadata?.country || '';
  const daily = moneyMetadataCents(metadata?.daily_rate_sgd);
  const rental = moneyMetadataCents(metadata?.rental_before_promo_sgd);
  const discount = moneyMetadataCents(metadata?.promo_discount_sgd);
  const courierFee = moneyMetadataCents(metadata?.courier_fee_sgd);
  const checkoutAmount = Number(metadata?.checkout_amount_cents);
  if (!country || country.length > 100 || metadata?.plan_name !== `${country} Pocket WiFi` ||
    daily === null || daily < 1 || rental === null || discount === null || courierFee === null ||
    !checkoutAmountSnapshotIsConsistent(session) || !Number.isSafeInteger(checkoutAmount) || checkoutAmount < 1 ||
    !metadata?.benchmark_provider || metadata.benchmark_provider.length > 100 ||
    moneyMetadataCents(metadata?.benchmark_rate_sgd) === null || !/^\d{4}-\d{2}-\d{2}$/.test(metadata?.benchmark_verified_on || '')) {
    return false;
  }
  const expectedRental = Math.max(1000, daily * days);
  const expectedDiscount = metadata?.promo_code === LAUNCH_PROMO.code
    ? Math.floor((expectedRental * LAUNCH_PROMO.percent) / 100)
    : metadata?.promo_code === '' ? 0 : null;
  return rental === expectedRental && discount === expectedDiscount &&
    session.currency?.toLowerCase() === 'sgd' && checkoutAmount === rental - discount + courierFee;
}

function historicalEsimSnapshotIsConsistent(session: Stripe.Checkout.Session) {
  const metadata = session.metadata;
  const planId = metadata?.plan_id || '';
  const country = metadata?.country || '';
  const planName = metadata?.plan_name || '';
  const checkoutAmount = Number(metadata?.checkout_amount_cents);
  const dataAllowance = metadata?.data_allowance;
  // The checkout provenance authenticates this immutable-at-creation snapshot.
  // These checks still reject malformed records if a historic plan has since
  // been retired or repriced in the live catalogue.
  return /^[a-z0-9][a-z0-9-]{1,80}$/.test(planId) && country.length > 0 && country.length <= 100 &&
    planName.startsWith(`${country} · `) && / · [1-9]\d{0,2} days$/.test(planName) &&
    (dataAllowance === undefined || (dataAllowance.length > 0 && dataAllowance.length <= 200)) &&
    metadata?.promo_code === ESIM_PROMO.code && metadata?.promo_discount_percent === String(ESIM_PROMO.percent) &&
    moneyMetadataCents(metadata?.benchmark_price_sgd) !== null &&
    checkoutAmountSnapshotIsConsistent(session) && Number.isSafeInteger(checkoutAmount) && checkoutAmount >= 50 &&
    session.currency?.toLowerCase() === 'sgd';
}

/**
 * Validate the server-authored identity of a QY Roam Checkout Session before
 * paid-order persistence or fulfilment. Stripe signs webhook events, but a
 * session can also be created manually in a shared Stripe account. The source
 * marker alone must therefore not be enough to persist or fulfil an order.
 */
export function validateQyRoamSession(session: Stripe.Checkout.Session): QyRoamSessionValidation {
  const productType = qyRoamProductType(session);
  if (!productType) return { valid: false, reason: 'unknown QY Roam product identity' };
  // QY Roam sells one-time travel products. The metadata HMAC authenticates
  // the server-authored order snapshot, but it does not itself bind Stripe's
  // Checkout mode. Keep this payment boundary explicit so a future checkout
  // configuration regression (for example, a subscription session carrying
  // otherwise valid metadata) cannot enter fulfilment as a one-time order.
  if (session.mode !== 'payment') {
    return { valid: false, reason: 'QY Roam orders must use one-time payment Checkout mode' };
  }
  // Every QY Roam Checkout Session has a positive payable amount. Stripe's
  // `no_payment_required` state (and any future/unknown SDK value) therefore
  // cannot represent one of our orders. Keep this explicit at the shared
  // webhook/admin validation boundary: otherwise an unexpected state could be
  // persisted as an apparently legitimate awaiting-payment order and consume
  // Pocket WiFi capacity indefinitely without a matching success/failure
  // transition that our lifecycle understands.
  if (session.payment_status !== 'paid' && session.payment_status !== 'unpaid') {
    return { valid: false, reason: 'QY Roam order has an unsupported payment status' };
  }
  if (!validCheckoutRequestId(session.metadata?.checkout_request_id)) {
    return { valid: false, reason: 'missing or invalid checkout request id' };
  }
  if (!validQyRoamProvenance(session.id, session.metadata)) {
    return { valid: false, reason: 'missing or invalid QY Roam checkout provenance' };
  }
  if (!checkoutAmountSnapshotIsConsistent(session)) {
    return { valid: false, reason: 'checkout amount snapshot does not match the Stripe payment amount' };
  }

  if (productType === 'pocket_wifi') {
    const config = operationalConfig();
    const plan = getWifiPlan(session.metadata?.country);
    const start = parseExactIsoDate(session.metadata?.start);
    const end = parseExactIsoDate(session.metadata?.end);
    if (!start || !end || end < start) return { valid: false, reason: 'invalid Pocket WiFi travel dates' };
    const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
    if (days < 1 || days > 90 || session.metadata?.days !== String(days)) {
      return { valid: false, reason: 'Pocket WiFi rental duration does not match its dates' };
    }

    // The webhook can run after a catalogue rate or destination changes. The
    // v2 provenance binds every pricing field and the Checkout Session id, so
    // a valid historical snapshot remains safer than rejecting a real payment
    // solely because today's catalogue differs from the one the buyer saw.
    if (!plan) {
      return historicalPocketWifiSnapshotIsConsistent(session, days)
        ? { valid: true, productType }
        : { valid: false, reason: 'unknown Pocket WiFi destination or invalid historical snapshot' };
    }

    const rentalBeforePromo = Math.max(1000, Math.round(plan.daily * days * 100));
    const promoCode = session.metadata?.promo_code || '';
    if (promoCode !== '' && promoCode !== LAUNCH_PROMO.code) {
      return { valid: false, reason: 'unknown Pocket WiFi promo code' };
    }
    const discount = promoCode === LAUNCH_PROMO.code
      ? Math.floor((rentalBeforePromo * LAUNCH_PROMO.percent) / 100)
      : 0;
    const courierFeeMetadata = session.metadata?.courier_fee_sgd;
    // Sessions opened immediately before this field was deployed remain valid
    // against the server's configured fee during a rolling release.
    const configuredCourierFee = config?.courierFeeCents;
    const courierFee = courierFeeMetadata === undefined
      ? configuredCourierFee
      : moneyMetadataCents(courierFeeMetadata);
    if (typeof courierFee !== 'number' || !Number.isSafeInteger(courierFee) || (courierFeeMetadata === undefined && !Number.isSafeInteger(configuredCourierFee))) {
      return { valid: false, reason: 'missing or invalid Pocket WiFi courier fee' };
    }
    const expectedAmount = rentalBeforePromo - discount + courierFee;
    if (session.currency?.toLowerCase() !== 'sgd' || session.amount_total !== expectedAmount) {
      return historicalPocketWifiSnapshotIsConsistent(session, days)
        ? { valid: true, productType }
        : { valid: false, reason: 'Pocket WiFi currency or amount does not match the catalogue' };
    }
    if (
      session.metadata?.plan_name !== `${plan.country} Pocket WiFi` ||
      session.metadata?.daily_rate_sgd !== plan.daily.toFixed(2) ||
      session.metadata?.benchmark_provider !== WIFI_BENCHMARK.provider ||
      session.metadata?.benchmark_rate_sgd !== plan.benchmarkRateSgd.toFixed(2) ||
      session.metadata?.benchmark_verified_on !== WIFI_BENCHMARK.verifiedOn ||
      session.metadata?.rental_before_promo_sgd !== (rentalBeforePromo / 100).toFixed(2) ||
      session.metadata?.promo_discount_sgd !== (discount / 100).toFixed(2)
    ) {
      return historicalPocketWifiSnapshotIsConsistent(session, days)
        ? { valid: true, productType }
        : { valid: false, reason: 'Pocket WiFi catalogue metadata does not match the selected plan' };
    }
  }

  if (productType === 'esim') {
    const plan = getEsimPlan(session.metadata?.plan_id);
    if (!plan) {
      return historicalEsimSnapshotIsConsistent(session)
        ? { valid: true, productType }
        : { valid: false, reason: 'unknown eSIM plan id or invalid historical snapshot' };
    }
    const expectedAmount = Math.max(50, Math.round(plan.qyPriceSgd * 100));
    if (session.currency?.toLowerCase() !== 'sgd' || session.amount_total !== expectedAmount) {
      return historicalEsimSnapshotIsConsistent(session)
        ? { valid: true, productType }
        : { valid: false, reason: 'eSIM currency or amount does not match the catalogue' };
    }
    if (
      session.metadata?.country !== plan.destination ||
      session.metadata?.plan_name !== `${plan.destination} · ${plan.days} days` ||
      (session.metadata?.data_allowance !== undefined && session.metadata.data_allowance !== plan.data) ||
      session.metadata?.promo_code !== ESIM_PROMO.code ||
      session.metadata?.benchmark_price_sgd !== plan.benchmarkPriceSgd.toFixed(2) ||
      session.metadata?.promo_discount_percent !== String(ESIM_PROMO.percent)
    ) {
      return historicalEsimSnapshotIsConsistent(session)
        ? { valid: true, productType }
        : { valid: false, reason: 'eSIM catalogue metadata does not match the selected plan' };
    }
  }

  return { valid: true, productType };
}
