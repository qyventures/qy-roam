// An order transition performs a read followed by one atomic RPC while it
// owns a scarce admin-operations slot. Bound the complete dependency sequence
// so two individually slow PostgREST calls cannot retain that slot
// indefinitely and prevent dispatch, return, or digital fulfilment work.
export const ADMIN_ORDER_DEPENDENCY_TIMEOUT_MS = 15_000;

export function createAdminOrderDeadline(timeoutMs = ADMIN_ORDER_DEPENDENCY_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ADMIN_ORDER_DEPENDENCY_TIMEOUT_MS) {
    throw new RangeError('Invalid admin order dependency timeout');
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Admin order dependency work timed out')),
    timeoutMs,
  );

  return {
    signal: controller.signal,
    async waitFor<T>(work: Promise<T>) {
      if (controller.signal.aborted) throw new Error('Admin order dependency work timed out');
      let rejectOnAbort: (() => void) | undefined;
      const deadline = new Promise<never>((_, reject) => {
        rejectOnAbort = () => reject(new Error('Admin order dependency work timed out'));
        controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
      });
      try {
        // Abort PostgREST as the first line of defence, but do not assume a
        // transport will always settle its promise after cancellation. Race
        // the complete admitted transition so a stalled dependency cannot
        // retain one of the shared operations slots forever.
        return await Promise.race([work, deadline]);
      } finally {
        if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort);
      }
    },
    dispose() { clearTimeout(timeout); },
  };
}
