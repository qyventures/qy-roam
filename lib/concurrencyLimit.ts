// A small allocation-free admission guard for expensive public handlers.
// Callers that cannot acquire a slot should fail fast with a retryable
// response; queuing inside the process would retain request bodies and socket
// state while every active dependency call is already using the worker.
export function createConcurrencyLimiter(maxConcurrent: number) {
  const limit = Number.isSafeInteger(maxConcurrent) && maxConcurrent > 0
    ? maxConcurrent
    : 1;
  let active = 0;

  return {
    tryAcquire() {
      if (active >= limit) return null;
      active += 1;
      let released = false;
      return () => {
        // A release callback can safely be used from nested cleanup paths
        // without allowing the count to become negative.
        if (released) return;
        released = true;
        active -= 1;
      };
    },
    activeCount() {
      return active;
    },
  };
}
