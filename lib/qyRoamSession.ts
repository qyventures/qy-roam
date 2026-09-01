import type Stripe from 'stripe';
import { ESIM_PROMO, getEsimPlan } from './esimPlans';
import { LAUNCH_PROMO } from './promotions';
import { getWifiPlan, WIFI_BENCHMARK } from './wifiPlans';
import { parseExactIsoDate, validCheckoutRequestId } from './checkoutValidation';

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

/**
 * Validate the server-authored identity of a QY Roam Checkout Session before
 * paid-order persistence or fulfilment. Stripe signs webhook events, but a
 * session can also be created manually in a shared Stripe account. The source
 * marker alone must therefore not be enough to persist or fulfil an order.
 */
export function validateQyRoamSession(session: Stripe.Checkout.Session): QyRoamSessionValidation {
  const productType = qyRoamProductType(session);
  if (!productType) return { valid: false, reason: 'unknown QY Roam product identity' };
  if (!validCheckoutRequestId(session.metadata?.checkout_request_id)) {
    return { valid: false, reason: 'missing or invalid checkout request id' };
  }

  if (productType === 'pocket_wifi') {
    const plan = getWifiPlan(session.metadata?.country);
    if (!plan) return { valid: false, reason: 'unknown Pocket WiFi destination' };
    const start = parseExactIsoDate(session.metadata?.start);
    const end = parseExactIsoDate(session.metadata?.end);
    if (!start || !end || end < start) return { valid: false, reason: 'invalid Pocket WiFi travel dates' };
    const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
    if (days < 1 || days > 90 || session.metadata?.days !== String(days)) {
      return { valid: false, reason: 'Pocket WiFi rental duration does not match its dates' };
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
    const configuredCourierFee = Math.max(0, Math.round(Number(process.env.COURIER_FEE_SGD || '0') * 100));
    const courierFee = courierFeeMetadata === undefined
      ? configuredCourierFee
      : moneyMetadataCents(courierFeeMetadata);
    if (courierFee === null || !Number.isSafeInteger(configuredCourierFee)) {
      return { valid: false, reason: 'missing or invalid Pocket WiFi courier fee' };
    }
    const expectedAmount = rentalBeforePromo - discount + courierFee;
    if (session.currency?.toLowerCase() !== 'sgd' || session.amount_total !== expectedAmount) {
      return { valid: false, reason: 'Pocket WiFi currency or amount does not match the catalogue' };
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
      return { valid: false, reason: 'Pocket WiFi catalogue metadata does not match the selected plan' };
    }
  }

  if (productType === 'esim') {
    const plan = getEsimPlan(session.metadata?.plan_id);
    if (!plan) return { valid: false, reason: 'unknown eSIM plan id' };
    const expectedAmount = Math.max(50, Math.round(plan.qyPriceSgd * 100));
    if (session.currency?.toLowerCase() !== 'sgd' || session.amount_total !== expectedAmount) {
      return { valid: false, reason: 'eSIM currency or amount does not match the catalogue' };
    }
    if (
      session.metadata?.country !== plan.destination ||
      session.metadata?.plan_name !== `${plan.destination} · ${plan.days} days` ||
      session.metadata?.promo_code !== ESIM_PROMO.code ||
      session.metadata?.benchmark_price_sgd !== plan.benchmarkPriceSgd.toFixed(2) ||
      session.metadata?.promo_discount_percent !== String(ESIM_PROMO.percent)
    ) {
      return { valid: false, reason: 'eSIM catalogue metadata does not match the selected plan' };
    }
  }

  return { valid: true, productType };
}
