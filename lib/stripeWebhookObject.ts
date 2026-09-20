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

// `constructEvent` authenticates the JSON bytes, but Stripe's SDK types do
// not validate an event deserialised from those bytes at runtime. Check the
// envelope before routing on its mode/type or reading its payload. This keeps
// an unexpected API-version shape out of the idempotency ledger and prevents
// an untyped `livemode` value from becoming a payment-environment authority.
export function stripeWebhookEventEnvelope(value: unknown): Stripe.Event | null {
  if (!plainRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.type !== 'string' ||
    typeof value.livemode !== 'boolean' ||
    !Number.isSafeInteger(value.created) ||
    !plainRecord(value.data)) {
    return null;
  }
  return value as unknown as Stripe.Event;
}

export function stripeWebhookCheckoutSession(value: unknown): Stripe.Checkout.Session | null {
  if (!plainRecord(value) || value.object !== 'checkout.session' || typeof value.id !== 'string' || typeof value.livemode !== 'boolean') {
    return null;
  }
  return value as unknown as Stripe.Checkout.Session;
}

// Stripe's Event envelope and its embedded object both carry `livemode`.
// Credential-mode validation on the envelope is not enough by itself: an
// unexpected API shape or malformed signed fixture must not let an embedded
// test Session enter a live event's durable retry ledger (or vice versa).
// Require the two authenticated snapshots to agree before the Session id is
// used for an API lookup, idempotency claim, or any order side effect.
export function stripeWebhookCheckoutSessionMatchesEvent(
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
) {
  return session.livemode === event.livemode;
}

// The Checkout metadata is an untyped value at the webhook boundary. Require
// its normal object form before treating the QY Roam source marker as an
// application authority; this also keeps shared-account lookalikes outside
// this application's database and recovery records.
export function hasQyRoamWebhookSource(metadata: unknown) {
  return plainRecord(metadata) && metadata.source === 'qyroam.com';
}
