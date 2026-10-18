// Readiness is a release authority used during both cutover and rollback.
// Aborting the provider request is necessary, but it is not by itself a
// deadline: a transport or future client implementation may ignore the
// AbortSignal and leave the caller waiting forever. Race the work against an
// independent rejection so every probe releases its HTTP/concurrency slot.
export const READINESS_PROBE_TIMEOUT_MS = 8_000;

export class ReadinessProbeTimeoutError extends Error {}

export async function runReadinessProbe<T>(
  probe: (signal: AbortSignal) => Promise<T>,
  timeoutMs = READINESS_PROBE_TIMEOUT_MS,
) {
  const boundedTimeoutMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : READINESS_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new ReadinessProbeTimeoutError('Production readiness probe timed out'));
    }, boundedTimeoutMs);
  });

  try {
    return await Promise.race([Promise.resolve().then(() => probe(controller.signal)), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
