import { isIP } from 'node:net';

// Checkout is intentionally rate-limited per application instance. This is a
// lightweight guard ahead of the payment provider, not a substitute for an
// edge/WAF limit. Its bookkeeping must remain bounded: a stream of spoofed or
// unique client keys must not turn the protection itself into a memory leak.
export const CHECKOUT_RATE_LIMIT_WINDOW_MS = 60_000;
export const CHECKOUT_RATE_LIMIT_MAX_ATTEMPTS = 12;
export const CHECKOUT_RATE_LIMIT_MAX_CLIENTS = 5_000;
export const CHECKOUT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS = 120;
export const AVAILABILITY_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS = 300;

type Attempt = { count: number; reset: number };

// This value cannot collide with a client key because accepted client keys are
// IP address literals. Once the individual-client registry is full, new
// identities share this bucket instead of evicting established entries. An
// eviction policy lets a rotating-IP caller continuously arrive as a "new"
// client and reset both its own limit and the limits of legitimate shoppers.
const CHECKOUT_RATE_LIMIT_OVERFLOW_KEY = 'overflow';

function validClientIp(value?: string | null) {
  const candidate = value?.trim();
  return candidate && candidate.length <= 45 && isIP(candidate) !== 0 ? candidate : null;
}

export function checkoutClientKey(req: Request) {
  // Production Nginx overwrites X-Real-IP with the socket peer. Do not use
  // forwarding-chain headers as fallbacks: a caller can create an arbitrary
  // number of apparent client identities with X-Forwarded-For or a CDN-style
  // header if the application is ever reached through a misconfigured proxy.
  // Missing or malformed trusted provenance intentionally shares one
  // conservative bucket, which is preferable to making the rate limiter
  // bypassable at this public Stripe/Supabase work boundary.
  return validClientIp(req.headers.get('x-real-ip')) || 'unknown';
}

export function createCheckoutAttemptLimiter(
  windowMs = CHECKOUT_RATE_LIMIT_WINDOW_MS,
  maxAttempts = CHECKOUT_RATE_LIMIT_MAX_ATTEMPTS,
  maxClients = CHECKOUT_RATE_LIMIT_MAX_CLIENTS,
) {
  const attempts = new Map<string, Attempt>();
  // Retaining active identities prevents a rotating-IP caller from evicting
  // shoppers mid-window, but retaining expired identities forever would let a
  // short address burst permanently push every future shopper into the shared
  // overflow bucket. Sweep at most once per window so recovery is automatic
  // without turning every request into an O(maxClients) scan.
  let nextCleanupAt = 0;

  return (req: Request, now = Date.now()) => {
    const clientKey = checkoutClientKey(req);
    // Reserve one of the bounded entries for excess identities. Existing
    // individually tracked clients retain their own windows, while every new
    // identity after capacity is reached consumes the shared overflow limit.
    // maxClients is an internal configuration value; clamp it so a mistaken
    // zero/non-integer value cannot make the registry unbounded or unusable.
    const boundedMaxClients = Number.isSafeInteger(maxClients) && maxClients > 0 ? maxClients : 1;
    const individualCapacity = Math.max(0, boundedMaxClients - 1);
    if (now >= nextCleanupAt) {
      for (const [key, attempt] of attempts) {
        if (attempt.reset <= now) attempts.delete(key);
      }
      nextCleanupAt = now + windowMs;
    }
    // The overflow bucket consumes one Map entry but is not an individual
    // client slot. Excluding it here lets expired shopper identities actually
    // return their capacity while keeping the total registry bounded by
    // `boundedMaxClients`.
    const individualClients = attempts.size - (attempts.has(CHECKOUT_RATE_LIMIT_OVERFLOW_KEY) ? 1 : 0);
    const key = attempts.has(clientKey) || individualClients < individualCapacity
      ? clientKey
      : CHECKOUT_RATE_LIMIT_OVERFLOW_KEY;
    const current = attempts.get(key);
    if (current && current.reset <= now) {
      attempts.set(key, { count: 1, reset: now + windowMs });
      return false;
    }
    if (!current) {
      attempts.set(key, { count: 1, reset: now + windowMs });
      return false;
    }
    current.count += 1;
    return current.count > maxAttempts;
  };
}

// Per-client throttling protects ordinary shoppers from one noisy neighbour,
// but it cannot cap aggregate provider work when a caller rotates addresses.
// Keep a second, allocation-free fixed window at each expensive public route.
// This is deliberately an instance-local overload guard (the production
// service runs one standalone process); an edge/WAF can still enforce a wider
// deployment-level policy if the service is scaled horizontally later.
export function createGlobalAttemptLimiter(
  windowMs = CHECKOUT_RATE_LIMIT_WINDOW_MS,
  maxAttempts = CHECKOUT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS,
) {
  const boundedWindowMs = Number.isSafeInteger(windowMs) && windowMs > 0
    ? windowMs
    : CHECKOUT_RATE_LIMIT_WINDOW_MS;
  const boundedMaxAttempts = Number.isSafeInteger(maxAttempts) && maxAttempts > 0
    ? maxAttempts
    : 1;
  let count = 0;
  let reset = 0;

  return (now = Date.now()) => {
    if (!Number.isFinite(now)) now = Date.now();
    if (reset <= now) {
      count = 1;
      reset = now + boundedWindowMs;
      return false;
    }
    count += 1;
    return count > boundedMaxAttempts;
  };
}
