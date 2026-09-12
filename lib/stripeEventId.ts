// Stripe event ids are opaque, but production event objects use the `evt_`
// namespace. Keep the public webhook's durable idempotency key bounded and
// free of control characters before it reaches logs or the database ledger.
// This is deliberately stricter than a generic non-empty string: an
// unexpectedly shaped signed payload should remain in Stripe's retry trail,
// not become an awkward or unbounded operational record.
export function validStripeEventId(value: unknown) {
  if (typeof value !== 'string') return null;
  return /^evt_[A-Za-z0-9]{8,96}$/.test(value) ? value : null;
}
