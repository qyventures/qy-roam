/**
 * Treat only a recently armed failure deadline as an active backoff.
 *
 * Readiness state is shared across Next server module graphs and therefore
 * stores an absolute wall-clock deadline. If the host clock moves backwards,
 * a formerly five-second deadline can otherwise suppress checkout probes for
 * minutes or hours. A deadline farther away than the configured window is not
 * one this process could have legitimately armed, so let the next fail-closed
 * probe repair the state.
 */
export function readinessFailureBackoffActive(
  retryAfter: number,
  now: number,
  maximumWindowMs: number,
) {
  if (!Number.isFinite(retryAfter) || !Number.isFinite(now) ||
      !Number.isFinite(maximumWindowMs) || maximumWindowMs <= 0) return false;
  const remainingMs = retryAfter - now;
  return remainingMs > 0 && remainingMs <= maximumWindowMs;
}
