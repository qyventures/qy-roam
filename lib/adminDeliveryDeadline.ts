import { STRIPE_REQUEST_TIMEOUT_MS } from './stripeClient';
import { performance } from 'node:perf_hooks';

// Delivery recovery must verify the durable order and its signed Stripe
// Session before it can safely resume email or analytics side effects. Bound
// that complete lookup sequence while it owns one of the small recovery
// admission slots; independent transport timeouts can otherwise stack during
// a cascading Supabase/Stripe outage. Reserve the final few seconds for
// releasing a provider-delivery lease after an aborted attempt. Without that
// separate signal, the recovery update inherits an already-aborted signal and
// leaves an unaccepted delivery stuck as `sending` until stale-lease recovery.
export const ADMIN_DELIVERY_LOOKUP_TIMEOUT_MS = 20_000;
export const ADMIN_DELIVERY_FAILURE_RECOVERY_RESERVE_MS = 3_000;

export function createAdminDeliveryDeadline(timeoutMs = ADMIN_DELIVERY_LOOKUP_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ADMIN_DELIVERY_LOOKUP_TIMEOUT_MS) {
    throw new RangeError('Invalid admin delivery lookup timeout');
  }

  const deadlineAtMs = performance.now() + timeoutMs;
  const recoveryReserveMs = Math.min(
    ADMIN_DELIVERY_FAILURE_RECOVERY_RESERVE_MS,
    Math.max(1, Math.floor(timeoutMs / 4)),
  );
  const processingDeadlineAtMs = deadlineAtMs - recoveryReserveMs;
  const controller = new AbortController();
  const recoveryController = new AbortController();
  const processingTimeout = setTimeout(
    () => controller.abort(new Error('Admin delivery lookup timed out')),
    Math.max(1, processingDeadlineAtMs - performance.now()),
  );
  const recoveryTimeout = setTimeout(
    () => recoveryController.abort(new Error('Admin delivery failure recovery timed out')),
    Math.max(1, deadlineAtMs - performance.now()),
  );

  return {
    signal: controller.signal,
    recoverySignal: recoveryController.signal,
    stripeRequestOptions() {
      const remainingMs = processingDeadlineAtMs - performance.now();
      if (remainingMs < 1 || controller.signal.aborted) throw new Error('Admin delivery lookup timed out');
      return { timeout: Math.min(STRIPE_REQUEST_TIMEOUT_MS, remainingMs) };
    },
    dispose() {
      clearTimeout(processingTimeout);
      clearTimeout(recoveryTimeout);
    },
  };
}
