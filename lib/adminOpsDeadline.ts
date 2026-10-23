// General admin operations include single-record mutations, inventory RPCs,
// manual paid-order creation, and a paginated accounting-ledger scan followed
// by its closing RPC. Bound that complete dependency sequence while it owns a
// scarce shared operations slot; individually bounded PostgREST calls are not
// sufficient when one request can make many of them in series.
export const ADMIN_OPS_DEPENDENCY_TIMEOUT_MS = 15_000;

export function createAdminOpsDeadline(timeoutMs = ADMIN_OPS_DEPENDENCY_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ADMIN_OPS_DEPENDENCY_TIMEOUT_MS) {
    throw new RangeError('Invalid admin operations dependency timeout');
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Admin operations dependency work timed out')),
    timeoutMs,
  );

  return {
    signal: controller.signal,
    dispose() { clearTimeout(timeout); },
  };
}
