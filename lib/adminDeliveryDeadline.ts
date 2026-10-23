import { STRIPE_REQUEST_TIMEOUT_MS } from './stripeClient';

// Delivery recovery must verify the durable order and its signed Stripe
// Session before it can safely resume email or analytics side effects. Bound
// that complete lookup sequence while it owns one of the small recovery
// admission slots; independent transport timeouts can otherwise stack during
// a cascading Supabase/Stripe outage.
export const ADMIN_DELIVERY_LOOKUP_TIMEOUT_MS = 20_000;

export function createAdminDeliveryDeadline(timeoutMs = ADMIN_DELIVERY_LOOKUP_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ADMIN_DELIVERY_LOOKUP_TIMEOUT_MS) {
    throw new RangeError('Invalid admin delivery lookup timeout');
  }

  const deadlineAtMs = Date.now() + timeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Admin delivery lookup timed out')),
    timeoutMs,
  );

  return {
    signal: controller.signal,
    stripeRequestOptions() {
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs < 1 || controller.signal.aborted) throw new Error('Admin delivery lookup timed out');
      return { timeout: Math.min(STRIPE_REQUEST_TIMEOUT_MS, remainingMs) };
    },
    dispose() { clearTimeout(timeout); },
  };
}
