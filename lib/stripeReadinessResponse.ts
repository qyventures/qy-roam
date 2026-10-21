import { validStripeCheckoutSessionIdForMode } from './stripeSessionId';
import { stripeSecretKeyMode } from './stripeCheckoutConfig';

/**
 * Validate the small Stripe list response used by production readiness.
 *
 * The probe requests exactly one Checkout Session. Requiring the complete
 * list envelope prevents a malformed gateway response from promoting a
 * release, while validating the optional row proves that the authenticated
 * credential and returned capabilities agree on test/live mode.
 */
export function stripeCheckoutListReadinessAcknowledged(value: unknown, secretKey: string) {
  const mode = stripeSecretKeyMode(secretKey);
  if (!mode) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const list = value as Record<string, unknown>;
  if (
    list.object !== 'list' ||
    list.url !== '/v1/checkout/sessions' ||
    typeof list.has_more !== 'boolean' ||
    !Array.isArray(list.data) ||
    list.data.length > 1
  ) return false;

  return list.data.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const session = entry as Record<string, unknown>;
    return session.object === 'checkout.session' &&
      validStripeCheckoutSessionIdForMode(session.id, mode === 'live');
  });
}
