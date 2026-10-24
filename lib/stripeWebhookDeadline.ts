import { STRIPE_REQUEST_TIMEOUT_MS } from './stripeClient';
import { performance } from 'node:perf_hooks';

// A webhook performs several individually bounded calls before Stripe can be
// acknowledged. Keep the complete durable-processing sequence from stacking
// those timeouts while it owns one of the scarce webhook processing slots.
export const STRIPE_WEBHOOK_DEPENDENCY_TIMEOUT_MS = 30_000;
export const STRIPE_WEBHOOK_FAILURE_RECOVERY_RESERVE_MS = 3_000;

export function createStripeWebhookDeadline(timeoutMs = STRIPE_WEBHOOK_DEPENDENCY_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > STRIPE_WEBHOOK_DEPENDENCY_TIMEOUT_MS) {
    throw new RangeError('Invalid Stripe webhook dependency timeout');
  }
  // This is an elapsed processing budget. Keep it on a monotonic clock so an
  // NTP/host wall-clock correction cannot prematurely abandon a paid event
  // or give a later Stripe refresh more time than the admitted worker owns.
  const startedAtMs = performance.now();
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
    Math.max(1, processingDeadlineAtMs - performance.now()),
  );
  const recoveryTimeout = setTimeout(
    () => recoveryController.abort(new Error('Stripe webhook failure recovery timed out')),
    Math.max(1, deadlineAtMs - performance.now()),
  );

  return {
    signal: controller.signal,
    recoverySignal: recoveryController.signal,
    async waitFor<T>(work: Promise<T>) {
      if (controller.signal.aborted) throw new Error('Stripe webhook dependency work timed out');
      let rejectOnAbort: (() => void) | undefined;
      const deadline = new Promise<never>((_, reject) => {
        rejectOnAbort = () => reject(new Error('Stripe webhook dependency work timed out'));
        controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
      });
      try {
        // AbortSignal remains the cooperative cancellation boundary for each
        // provider. Race the complete admitted workflow as well so a stalled
        // or future transport that ignores cancellation cannot retain a
        // scarce paid-order processing slot indefinitely.
        return await Promise.race([work, deadline]);
      } finally {
        if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort);
      }
    },
    stripeRequestOptions() {
      const remainingMs = processingDeadlineAtMs - performance.now();
      if (remainingMs < 1 || controller.signal.aborted) throw new Error('Stripe webhook dependency work timed out');
      return { timeout: Math.min(STRIPE_REQUEST_TIMEOUT_MS, remainingMs) };
    },
    dispose() {
      clearTimeout(processingTimeout);
      clearTimeout(recoveryTimeout);
    },
  };
}
