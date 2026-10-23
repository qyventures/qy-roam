import { STRIPE_REQUEST_TIMEOUT_MS } from './stripeClient';

// Several individually bounded provider calls can otherwise stack while one
// checkout holds a scarce shared worker slot. Give the complete admitted
// dependency sequence one absolute budget while retaining Stripe's shorter
// per-request timeout and durable idempotency recovery.
export const CHECKOUT_DEPENDENCY_TIMEOUT_MS = 30_000;

export function createCheckoutDeadline(timeoutMs = CHECKOUT_DEPENDENCY_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CHECKOUT_DEPENDENCY_TIMEOUT_MS) {
    throw new RangeError('Invalid checkout dependency timeout');
  }
  const deadlineAtMs = Date.now() + timeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Checkout dependency work timed out')), timeoutMs);
  return {
    signal: controller.signal,
    stripeRequestOptions() {
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs < 1 || controller.signal.aborted) throw new Error('Checkout dependency work timed out');
      return { timeout: Math.min(STRIPE_REQUEST_TIMEOUT_MS, remainingMs) };
    },
    dispose() { clearTimeout(timeout); },
  };
}
