import { STRIPE_REQUEST_TIMEOUT_MS } from './stripeClient';

// Customer confirmation performs a Stripe read followed by a Supabase read.
// Each transport has its own timeout, but treating those limits independently
// can retain one of the small shared confirmation slots for their combined
// duration during a cascading provider outage. Give the complete lookup one
// end-to-end budget, cap Stripe to the time remaining, and pass the same
// deadline signal to the second dependency.
export const CONFIRMATION_LOOKUP_TIMEOUT_MS = 20_000;

export function createConfirmationDeadline(timeoutMs = CONFIRMATION_LOOKUP_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CONFIRMATION_LOOKUP_TIMEOUT_MS) {
    throw new RangeError('Invalid confirmation lookup timeout');
  }

  const deadlineAtMs = Date.now() + timeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error('Order confirmation lookup timed out'));
  }, timeoutMs);

  return {
    signal: controller.signal,
    stripeRequestOptions() {
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs < 1 || controller.signal.aborted) throw new Error('Order confirmation lookup timed out');
      return { timeout: Math.min(STRIPE_REQUEST_TIMEOUT_MS, remainingMs) };
    },
    dispose() {
      clearTimeout(timeout);
    },
  };
}
