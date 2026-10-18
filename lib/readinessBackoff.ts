/**
 * Treat only a recently armed deadline as an active readiness window.
 *
 * Readiness state is shared across Next server module graphs and therefore
 * stores an absolute wall-clock deadline. If the host clock moves backwards,
 * a short success cache or failure backoff can otherwise remain active for
 * minutes or hours. A deadline farther away than the configured window is not
 * one this process could have legitimately armed, so let the next fail-closed
 * probe repair the state.
 */
export function readinessWindowActive(
  deadline: number,
  now: number,
  maximumWindowMs: number,
) {
  if (!Number.isFinite(deadline) || !Number.isFinite(now) ||
      !Number.isFinite(maximumWindowMs) || maximumWindowMs <= 0) return false;
  const remainingMs = deadline - now;
  return remainingMs > 0 && remainingMs <= maximumWindowMs;
}

export function readinessFailureBackoffActive(
  retryAfter: number,
  now: number,
  maximumWindowMs: number,
) {
  return readinessWindowActive(retryAfter, now, maximumWindowMs);
}
