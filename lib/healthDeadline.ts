// Authenticated health fans out across Stripe, Supabase, and inventory. Each
// current probe has its own transport deadline, but the route also needs a
// wall-clock boundary so a future probe that ignores cancellation cannot hold
// one of the small readiness concurrency slots forever.
export const HEALTH_READINESS_TIMEOUT_MS = 10_000;

export function createHealthDeadline(timeoutMs = HEALTH_READINESS_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > HEALTH_READINESS_TIMEOUT_MS) {
    throw new RangeError('Invalid health readiness timeout');
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Health readiness timed out')),
    timeoutMs,
  );

  return {
    signal: controller.signal,
    async waitFor<T>(work: Promise<T>) {
      if (controller.signal.aborted) throw new Error('Health readiness timed out');
      let rejectOnAbort: (() => void) | undefined;
      const deadline = new Promise<never>((_, reject) => {
        rejectOnAbort = () => reject(new Error('Health readiness timed out'));
        controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
      });
      try {
        return await Promise.race([work, deadline]);
      } finally {
        if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort);
      }
    },
    dispose() { clearTimeout(timeout); },
  };
}
