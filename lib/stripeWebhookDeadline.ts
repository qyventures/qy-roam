import { STRIPE_REQUEST_TIMEOUT_MS } from './stripeClient';

// A webhook performs several individually bounded calls before Stripe can be
// acknowledged. Keep the complete durable-processing sequence from stacking
// those timeouts while it owns one of the scarce webhook processing slots.
export const STRIPE_WEBHOOK_DEPENDENCY_TIMEOUT_MS = 30_000;

export function createStripeWebhookDeadline(timeoutMs = STRIPE_WEBHOOK_DEPENDENCY_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > STRIPE_WEBHOOK_DEPENDENCY_TIMEOUT_MS) {
    throw new RangeError('Invalid Stripe webhook dependency timeout');
  }
  const deadlineAtMs = Date.now() + timeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Stripe webhook dependency work timed out')), timeoutMs);

  return {
    signal: controller.signal,
    stripeRequestOptions() {
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs < 1 || controller.signal.aborted) throw new Error('Stripe webhook dependency work timed out');
      return { timeout: Math.min(STRIPE_REQUEST_TIMEOUT_MS, remainingMs) };
    },
    dispose() { clearTimeout(timeout); },
  };
}
