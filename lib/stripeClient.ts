import Stripe from 'stripe';

// Stripe's SDK default request timeout is intentionally generous for many
// back-office use cases. It is too long for a customer checkout, availability
// response, or a webhook worker: an upstream stall should fail into the
// existing recoverable/idempotent paths instead of consuming a server worker
// for more than a minute. Checkout creation already supplies an idempotency
// key, so one network retry is safe and helps transient connections without
// turning a short outage into a long request queue.
export const STRIPE_REQUEST_TIMEOUT_MS = 15_000;
export const STRIPE_MAX_NETWORK_RETRIES = 1;

export function createStripeClient(secretKey: string) {
  return new Stripe(secretKey, {
    apiVersion: '2024-06-20',
    timeout: STRIPE_REQUEST_TIMEOUT_MS,
    maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
  });
}
