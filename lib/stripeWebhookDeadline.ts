import { STRIPE_REQUEST_TIMEOUT_MS } from './stripeClient';

// A webhook performs several individually bounded calls before Stripe can be
// acknowledged. Keep the complete durable-processing sequence from stacking
// those timeouts while it owns one of the scarce webhook processing slots.
export const STRIPE_WEBHOOK_DEPENDENCY_TIMEOUT_MS = 30_000;
export const STRIPE_WEBHOOK_FAILURE_RECOVERY_RESERVE_MS = 3_000;

export function createStripeWebhookDeadline(timeoutMs = STRIPE_WEBHOOK_DEPENDENCY_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > STRIPE_WEBHOOK_DEPENDENCY_TIMEOUT_MS) {
    throw new RangeError('Invalid Stripe webhook dependency timeout');
  }
  const startedAtMs = Date.now();
  const deadlineAtMs = startedAtMs + timeoutMs;
  // Preserve a small part of the admitted request budget for marking a
  // claimed event failed. Without this reserve, the processing signal can
  // expire and the recovery write then starts a fresh 15-second Supabase
  // transport timeout while the request still owns a scarce webhook slot.
  const recoveryReserveMs = Math.min(
    STRIPE_WEBHOOK_FAILURE_RECOVERY_RESERVE_MS,
    Math.max(1, Math.floor(timeoutMs / 4)),
  );
  const processingDeadlineAtMs = deadlineAtMs - recoveryReserveMs;
  const controller = new AbortController();
  const recoveryController = new AbortController();
  const processingTimeout = setTimeout(
    () => controller.abort(new Error('Stripe webhook dependency work timed out')),
    Math.max(1, processingDeadlineAtMs - Date.now()),
  );
  const recoveryTimeout = setTimeout(
    () => recoveryController.abort(new Error('Stripe webhook failure recovery timed out')),
    Math.max(1, deadlineAtMs - Date.now()),
  );

  return {
    signal: controller.signal,
    recoverySignal: recoveryController.signal,
    stripeRequestOptions() {
      const remainingMs = processingDeadlineAtMs - Date.now();
      if (remainingMs < 1 || controller.signal.aborted) throw new Error('Stripe webhook dependency work timed out');
      return { timeout: Math.min(STRIPE_REQUEST_TIMEOUT_MS, remainingMs) };
    },
    dispose() {
      clearTimeout(processingTimeout);
      clearTimeout(recoveryTimeout);
    },
  };
}
