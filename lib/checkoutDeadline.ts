import { STRIPE_REQUEST_TIMEOUT_MS } from './stripeClient';

// Several individually bounded provider calls can otherwise stack while one
// checkout holds a scarce shared worker slot. Give the complete admitted
// dependency sequence one absolute budget while retaining Stripe's shorter
// per-request timeout and durable idempotency recovery.
export const CHECKOUT_DEPENDENCY_TIMEOUT_MS = 30_000;
export const CHECKOUT_FAILURE_RECOVERY_RESERVE_MS = 3_000;

export function createCheckoutDeadline(timeoutMs = CHECKOUT_DEPENDENCY_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CHECKOUT_DEPENDENCY_TIMEOUT_MS) {
    throw new RangeError('Invalid checkout dependency timeout');
  }
  const deadlineAtMs = Date.now() + timeoutMs;
  // Pocket WiFi checkout can acquire scarce inventory before the final
  // payment-capability checks. Preserve a small part of the admitted request
  // budget for releasing a reservation that is still provably unlinked when
  // one of those checks aborts. Reusing an already-expired processing signal
  // would leave that capacity unavailable until the reservation expires.
  const recoveryReserveMs = Math.min(
    CHECKOUT_FAILURE_RECOVERY_RESERVE_MS,
    Math.max(1, Math.floor(timeoutMs / 4)),
  );
  const processingDeadlineAtMs = deadlineAtMs - recoveryReserveMs;
  const controller = new AbortController();
  const recoveryController = new AbortController();
  const processingTimeout = setTimeout(
    () => controller.abort(new Error('Checkout dependency work timed out')),
    Math.max(1, processingDeadlineAtMs - Date.now()),
  );
  const recoveryTimeout = setTimeout(
    () => recoveryController.abort(new Error('Checkout reservation recovery timed out')),
    Math.max(1, deadlineAtMs - Date.now()),
  );
  return {
    signal: controller.signal,
    recoverySignal: recoveryController.signal,
    async waitFor<T>(work: Promise<T>) {
      if (controller.signal.aborted) throw new Error('Checkout dependency work timed out');
      let rejectOnAbort: (() => void) | undefined;
      const deadline = new Promise<never>((_, reject) => {
        rejectOnAbort = () => reject(new Error('Checkout dependency work timed out'));
        controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
      });
      try {
        // Readiness checks are cached and shared across callers, so aborting
        // their underlying provider request here would also cancel useful
        // work for other requests. Race only this admitted checkout against
        // its deadline; the shared probe retains its own transport timeout.
        return await Promise.race([work, deadline]);
      } finally {
        if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort);
      }
    },
    stripeRequestOptions() {
      const remainingMs = processingDeadlineAtMs - Date.now();
      if (remainingMs < 1 || controller.signal.aborted) throw new Error('Checkout dependency work timed out');
      return { timeout: Math.min(STRIPE_REQUEST_TIMEOUT_MS, remainingMs) };
    },
    dispose() {
      clearTimeout(processingTimeout);
      clearTimeout(recoveryTimeout);
    },
  };
}
