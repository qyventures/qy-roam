// Basic Auth is intentionally simple, but a public login boundary still needs
// to make online guessing expensive. Keep this guard dependency-free so it can
// run in Next middleware's edge runtime, and keep its state bounded so rotating
// source addresses cannot turn the defence itself into a memory leak.
export const ADMIN_AUTH_FAILURE_WINDOW_MS = 5 * 60_000;
export const ADMIN_AUTH_MAX_FAILURES = 10;
export const ADMIN_AUTH_MAX_CLIENTS = 5_000;

type FailureWindow = { count: number; reset: number };

const OVERFLOW_KEY = 'overflow';

function canonicalIpv4(value: string) {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const parsed = Number(part);
    return parsed <= 255 ? parsed : null;
  });
  return octets.every((part) => part !== null) ? octets.join('.') : null;
}

function canonicalClientIdentity(value?: string | null) {
  const candidate = value?.trim().toLowerCase();
  if (!candidate || candidate.length > 45) return null;
  const ipv4 = canonicalIpv4(candidate);
  if (ipv4) return ipv4;
  // Nginx supplies a canonical socket address in production. This structural
  // check only prevents arbitrary header strings becoming registry keys when
  // the app is reached through a different proxy; the bounded overflow bucket
  // remains the final defence against many syntactically valid IPv6 values.
  if (candidate.includes(':') && /^[0-9a-f:.]+$/.test(candidate)) return candidate;
  return null;
}

export function adminAuthClientKey(req: Request) {
  return canonicalClientIdentity(req.headers.get('x-real-ip')) || 'unknown';
}

export function createFailedAdminAuthLimiter(
  windowMs = ADMIN_AUTH_FAILURE_WINDOW_MS,
  maxFailures = ADMIN_AUTH_MAX_FAILURES,
  maxClients = ADMIN_AUTH_MAX_CLIENTS,
) {
  const failures = new Map<string, FailureWindow>();
  const boundedWindowMs = Number.isSafeInteger(windowMs) && windowMs > 0
    ? windowMs
    : ADMIN_AUTH_FAILURE_WINDOW_MS;
  const boundedMaxFailures = Number.isSafeInteger(maxFailures) && maxFailures > 0
    ? maxFailures
    : 1;
  let nextCleanupAt = 0;
  let lastObservedAt = 0;

  return (req: Request, now = Date.now()) => {
    if (!Number.isFinite(now)) now = Date.now();
    // Do not let a backwards wall-clock correction preserve future reset
    // timestamps and lock legitimate operators out for the adjustment period.
    if (now < lastObservedAt) {
      failures.clear();
      nextCleanupAt = 0;
    }
    lastObservedAt = now;
    const boundedMaxClients = Number.isSafeInteger(maxClients) && maxClients > 0 ? maxClients : 1;
    if (now >= nextCleanupAt) {
      for (const [key, failure] of failures) {
        if (failure.reset <= now) failures.delete(key);
      }
      nextCleanupAt = now + boundedWindowMs;
    }

    const clientKey = adminAuthClientKey(req);
    const individualCapacity = Math.max(0, boundedMaxClients - 1);
    const individualClients = failures.size - (failures.has(OVERFLOW_KEY) ? 1 : 0);
    const key = failures.has(clientKey) || individualClients < individualCapacity ? clientKey : OVERFLOW_KEY;
    const current = failures.get(key);
    if (!current || current.reset <= now) {
      failures.set(key, { count: 1, reset: now + boundedWindowMs });
      return false;
    }
    current.count += 1;
    return current.count > boundedMaxFailures;
  };
}
