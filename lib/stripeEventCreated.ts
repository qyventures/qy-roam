// Stripe event timestamps are used as the payment-confirmation and Meta CAPI
// Purchase time. Keep that boundary explicit instead of allowing an
// unexpected SDK/object shape to turn into an invalid ISO date, an ancient
// accounting entry, or a far-future analytics event. Historical Stripe
// retries remain valid, but Stripe did not exist before 2010; an older value
// cannot be a real Stripe event and must not poison the durable order ledger.
export const STRIPE_EVENT_CREATED_MIN_SECONDS = 1_262_304_000; // 2010-01-01T00:00:00Z
export const STRIPE_EVENT_CREATED_MAX_FUTURE_SECONDS = 24 * 60 * 60;

export function validStripeEventCreated(value: unknown, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < STRIPE_EVENT_CREATED_MIN_SECONDS) return null;
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) return null;
  return value <= nowSeconds + STRIPE_EVENT_CREATED_MAX_FUTURE_SECONDS ? value : null;
}

/**
 * A signed Stripe Event cannot predate the Checkout Session it names. The
 * generic timestamp guard above deliberately permits historical retries, but
 * this payment boundary also has the freshly retrieved Session available.
 * Rejecting an impossible ordering prevents a malformed event from becoming
 * an apparently valid historical payment time in the order ledger or CAPI.
 */
export function validStripePaymentEventCreated(
  eventCreated: unknown,
  sessionCreated: unknown,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const validEventCreated = validStripeEventCreated(eventCreated, nowSeconds);
  const validSessionCreated = validStripeEventCreated(sessionCreated, nowSeconds);
  return validEventCreated !== null && validSessionCreated !== null && validEventCreated >= validSessionCreated
    ? validEventCreated
    : null;
}
