// Customer confirmation performs a Stripe read followed by a Supabase read.
// Each transport has its own timeout, but treating those limits independently
// can retain one of the small shared confirmation slots for their combined
// duration during a cascading provider outage. Give the complete lookup one
// end-to-end budget and pass its signal to the second dependency. Stripe's
// client-level timeout remains the first boundary; an already-expired signal
// prevents the privileged ledger request from starting afterwards.
export const CONFIRMATION_LOOKUP_TIMEOUT_MS = 20_000;

export function createConfirmationDeadline(timeoutMs = CONFIRMATION_LOOKUP_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CONFIRMATION_LOOKUP_TIMEOUT_MS) {
    throw new RangeError('Invalid confirmation lookup timeout');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error('Order confirmation lookup timed out'));
  }, timeoutMs);

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
    },
  };
}
