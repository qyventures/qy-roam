import type Stripe from 'stripe';
import { ESIM_PROMO, getEsimPlan } from './esimPlans';

export type QyRoamProductType = 'esim' | 'pocket_wifi';

export function qyRoamProductType(session: Stripe.Checkout.Session): QyRoamProductType | null {
  if (session.metadata?.source !== 'qyroam.com') return null;
  const productType = session.metadata?.product_type;
  return productType === 'esim' || productType === 'pocket_wifi' ? productType : null;
}

export type QyRoamSessionValidation =
  | { valid: true; productType: QyRoamProductType }
  | { valid: false; reason: string };

const CHECKOUT_REQUEST_ID = /^[A-Za-z0-9_-]{16,80}$/;

/**
 * Validate the server-authored identity of a QY Roam Checkout Session before
 * paid-order persistence or fulfilment. Stripe signs webhook events, but a
 * session can also be created manually in a shared Stripe account. The source
 * marker alone must therefore not be enough to trigger eSIM fulfilment.
 */
export function validateQyRoamSession(session: Stripe.Checkout.Session): QyRoamSessionValidation {
  const productType = qyRoamProductType(session);
  if (!productType) return { valid: false, reason: 'unknown QY Roam product identity' };
  if (!CHECKOUT_REQUEST_ID.test(session.metadata?.checkout_request_id || '')) {
    return { valid: false, reason: 'missing or invalid checkout request id' };
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
      session.metadata?.promo_code !== ESIM_PROMO.code
    ) {
      return { valid: false, reason: 'eSIM catalogue metadata does not match the selected plan' };
    }
  }

  return { valid: true, productType };
}
