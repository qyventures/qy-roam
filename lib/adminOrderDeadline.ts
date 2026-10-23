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
    dispose() { clearTimeout(timeout); },
  };
}
