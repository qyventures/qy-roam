// Checkout Session IDs appear in customer-facing URLs. Treat them as an
// untrusted identifier before using them in a server-side Stripe API request:
// a prefix check alone accepts arbitrarily long garbage, and repeated query
// parameters are represented as arrays by Next.js.
const STRIPE_CHECKOUT_SESSION_ID = /^cs_(?:test|live)_[A-Za-z0-9]+$/;
const MAX_STRIPE_CHECKOUT_SESSION_ID_LENGTH = 255;

export function validStripeCheckoutSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (id.length === 0 || id.length > MAX_STRIPE_CHECKOUT_SESSION_ID_LENGTH) return null;
  return STRIPE_CHECKOUT_SESSION_ID.test(id) ? id : null;
}

/**
 * Bind Stripe's opaque identifier namespace to the runtime mode carried by
 * the same Checkout Session. Credentials normally make contradictory data
 * impossible, but provider responses are still untyped at runtime and these
 * objects can authorize customer redirects, inventory holds, and fulfilment.
 */
export function validStripeCheckoutSessionIdForMode(value: unknown, livemode: unknown): string | null {
  const id = validStripeCheckoutSessionId(value);
  if (!id || typeof livemode !== 'boolean') return null;
  return id.startsWith(livemode ? 'cs_live_' : 'cs_test_') ? id : null;
}
