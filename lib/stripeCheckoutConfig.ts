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

/**
 * Stripe webhook signing secrets do not identify test versus live mode. Bind
 * every signed event to the configured API-key mode before it can reach order
 * persistence or external side effects. Unknown key formats fail closed: an
 * API credential that cannot establish the event mode is not a safe payment
 * authority.
 */
export function stripeEventMatchesConfiguredMode(key: string, livemode: unknown) {
  // `livemode` is declared as boolean by Stripe's TypeScript types, but this
  // boundary receives deserialised webhook and API data at runtime. Do not
  // let a truthy string (for example, an unexpectedly shaped test double or
  // SDK response) pass the live-key branch and turn an untyped value into
  // payment authority.
  if (typeof livemode !== 'boolean') return false;
  const configuredKey = key.trim();
  if (configuredKey.startsWith('sk_live_') || configuredKey.startsWith('rk_live_')) return livemode;
  if (configuredKey.startsWith('sk_test_') || configuredKey.startsWith('rk_test_')) return !livemode;
  return false;
}
