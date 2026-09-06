// Checkout is intentionally rate-limited per application instance. This is a
// lightweight guard ahead of the payment provider, not a substitute for an
// edge/WAF limit. Its bookkeeping must remain bounded: a stream of spoofed or
// unique client keys must not turn the protection itself into a memory leak.
export const CHECKOUT_RATE_LIMIT_WINDOW_MS = 60_000;
export const CHECKOUT_RATE_LIMIT_MAX_ATTEMPTS = 12;
export const CHECKOUT_RATE_LIMIT_MAX_CLIENTS = 5_000;

type Attempt = { count: number; reset: number };

export function checkoutClientKey(req: Request) {
  return (req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown').trim();
}

export function createCheckoutAttemptLimiter(
  windowMs = CHECKOUT_RATE_LIMIT_WINDOW_MS,
  maxAttempts = CHECKOUT_RATE_LIMIT_MAX_ATTEMPTS,
  maxClients = CHECKOUT_RATE_LIMIT_MAX_CLIENTS,
) {
  const attempts = new Map<string, Attempt>();

  return (req: Request, now = Date.now()) => {
    const key = checkoutClientKey(req);
    const current = attempts.get(key);
    if (current && current.reset <= now) {
      attempts.set(key, { count: 1, reset: now + windowMs });
      return false;
    }
    if (!current) {
      // Map preserves insertion order, so evicting its oldest entry is a
      // constant-space fallback even during an attack of entirely new keys.
      // An evicted client merely starts a fresh local window; this is safer
      // than allowing unbounded process memory growth.
      while (attempts.size >= maxClients) {
        const oldest = attempts.keys().next().value;
        if (oldest === undefined) break;
        attempts.delete(oldest);
      }
      attempts.set(key, { count: 1, reset: now + windowMs });
      return false;
    }
    current.count += 1;
    return current.count > maxAttempts;
  };
}
