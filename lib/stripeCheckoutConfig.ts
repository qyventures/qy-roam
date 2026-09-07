/**
 * A test-mode Stripe key is useful locally, but it must never be able to
 * create a checkout on the production storefront. Stripe's webhook signing
 * secret does not encode the mode, so the server credential is the reliable
 * boundary available to this application.
 */
export function hasRequiredStripeCheckoutConfig() {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return false;
  return process.env.NODE_ENV !== 'production' || key.startsWith('sk_live_') || key.startsWith('rk_live_');
}
