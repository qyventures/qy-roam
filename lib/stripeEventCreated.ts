// Stripe event timestamps are used as the payment-confirmation and Meta CAPI
// Purchase time. Keep that boundary explicit instead of allowing an
// unexpected SDK/object shape to turn into an invalid ISO date or a far-future
// analytics event. Historical Stripe retries remain valid; only impossible
// values and timestamps materially ahead of the service clock are rejected.
export const STRIPE_EVENT_CREATED_MAX_FUTURE_SECONDS = 24 * 60 * 60;

export function validStripeEventCreated(value: unknown, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) return null;
  return value <= nowSeconds + STRIPE_EVENT_CREATED_MAX_FUTURE_SECONDS ? value : null;
}
