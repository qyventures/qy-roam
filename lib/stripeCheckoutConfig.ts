/**
 * A test-mode Stripe key is useful locally, but it must never be able to
 * create a checkout on the production storefront. Stripe's webhook signing
 * secret does not encode the mode, so the server credential is the reliable
 * boundary available to this application.
 */
const MAX_STRIPE_SECRET_KEY_LENGTH = 256;

function stripeSecretKeyMode(value?: string) {
  const key = value?.trim();
  if (!key || key.length > MAX_STRIPE_SECRET_KEY_LENGTH) return null;
  // Stripe server keys are opaque, but both standard and restricted keys
  // have a stable type/mode prefix and a substantial ASCII credential body.
  // A prefix alone is not configuration: accepting `sk_live_` used to make
  // health and launch control green while every Stripe request failed.
  const match = /^(?:sk|rk)_(live|test)_[A-Za-z0-9]{16,}$/.exec(key);
  return match?.[1] as 'live' | 'test' | undefined || null;
}

export function hasRequiredStripeCheckoutConfig() {
  const mode = stripeSecretKeyMode(process.env.STRIPE_SECRET_KEY);
  return mode !== null && (process.env.NODE_ENV !== 'production' || mode === 'live');
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
  const configuredMode = stripeSecretKeyMode(key);
  if (configuredMode === 'live') return livemode;
  if (configuredMode === 'test') return !livemode;
  return false;
}
