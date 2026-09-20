import type Stripe from 'stripe';

// Stripe's SDK types describe the current API shape, but webhook data is
// deserialised input. Validate the small identity surface this application
// needs before using an event object as a Checkout Session id, mode boundary,
// or metadata source. A signed payload with an unexpected API shape cannot be
// repaired by retrying it, so callers reject it before it reaches either
// Stripe's API or the durable idempotency ledger.
function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function stripeWebhookCheckoutSession(value: unknown): Stripe.Checkout.Session | null {
  if (!plainRecord(value) || value.object !== 'checkout.session' || typeof value.id !== 'string' || typeof value.livemode !== 'boolean') {
    return null;
  }
  return value as unknown as Stripe.Checkout.Session;
}

// The Checkout metadata is an untyped value at the webhook boundary. Require
// its normal object form before treating the QY Roam source marker as an
// application authority; this also keeps shared-account lookalikes outside
// this application's database and recovery records.
export function hasQyRoamWebhookSource(metadata: unknown) {
  return plainRecord(metadata) && metadata.source === 'qyroam.com';
}
