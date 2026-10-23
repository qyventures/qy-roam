// Live Pocket WiFi availability performs a bounded Stripe hold scan followed
// by an atomic Supabase stock snapshot. Each transport has its own timeout,
// but allowing those limits to stack can retain one of the small shared
// availability slots for too long during a provider outage. Give the complete
// inventory lookup one deadline; an expired signal also prevents the
// privileged database request from starting after a slow Stripe scan.
export const AVAILABILITY_LOOKUP_TIMEOUT_MS = 20_000;

export function createAvailabilityDeadline(timeoutMs = AVAILABILITY_LOOKUP_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > AVAILABILITY_LOOKUP_TIMEOUT_MS) {
    throw new RangeError('Invalid availability lookup timeout');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error('Live availability lookup timed out'));
  }, timeoutMs);

  return {
    signal: controller.signal,
    async waitFor<T>(work: Promise<T>) {
      if (controller.signal.aborted) throw new Error('Live availability lookup timed out');
      let rejectOnAbort: (() => void) | undefined;
      const deadline = new Promise<never>((_, reject) => {
        rejectOnAbort = () => reject(new Error('Live availability lookup timed out'));
        controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
      });
      try {
        // Schema-readiness work is cached across requests and cannot inherit
        // this caller's AbortSignal without cancelling the shared probe for
        // every shopper. Race this admitted availability request instead so
        // a stuck shared promise cannot retain one of the small live-work
        // slots indefinitely.
        return await Promise.race([work, deadline]);
      } finally {
        if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort);
      }
    },
    dispose() {
      clearTimeout(timeout);
    },
  };
}
