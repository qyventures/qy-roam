// The primary operations dashboard scans five ledgers in parallel and holds a
// scarce process-wide admission slot until all of them finish. Bound that
// complete snapshot so a stalled PostgREST connection cannot permanently
// consume every dashboard slot and hide paid-order recovery work.
export const ADMIN_DASHBOARD_LOOKUP_TIMEOUT_MS = 15_000;

export function createAdminDashboardDeadline(timeoutMs = ADMIN_DASHBOARD_LOOKUP_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ADMIN_DASHBOARD_LOOKUP_TIMEOUT_MS) {
    throw new RangeError('Invalid admin dashboard lookup timeout');
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Admin dashboard lookup timed out')),
    timeoutMs,
  );

  return {
    signal: controller.signal,
    dispose() { clearTimeout(timeout); },
  };
}
