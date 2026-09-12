import { validCheckoutRequestId } from './checkoutValidation';

export type CheckoutAttempt = {
  fingerprint: string;
  requestId: string;
  createdAt: number;
};

const STORAGE_PREFIX = 'qyroam_checkout_attempt_v1_';
// Checkout Sessions expire after the short server-side payment window. Keep a
// little recovery margin for clock skew and delayed browser retries, without
// letting an old tab reuse an idempotency key indefinitely.
export const CHECKOUT_ATTEMPT_MAX_AGE_MS = 45 * 60 * 1000;

function storageKey(product: 'esim' | 'pocket_wifi') {
  return `${STORAGE_PREFIX}${product}`;
}

function usableAttempt(value: unknown, fingerprint: string, now: number): CheckoutAttempt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const attempt = value as Partial<CheckoutAttempt>;
  if (attempt.fingerprint !== fingerprint || typeof attempt.fingerprint !== 'string' || attempt.fingerprint.length > 1000) return null;
  if (!validCheckoutRequestId(attempt.requestId)) return null;
  if (typeof attempt.createdAt !== 'number' || !Number.isFinite(attempt.createdAt) || !Number.isInteger(attempt.createdAt) || attempt.createdAt > now + 60_000) return null;
  if (now - attempt.createdAt > CHECKOUT_ATTEMPT_MAX_AGE_MS) return null;
  return attempt as CheckoutAttempt;
}

export function checkoutAttempt(
  product: 'esim' | 'pocket_wifi',
  fingerprint: string,
  inMemory: CheckoutAttempt | null,
  now = Date.now(),
): CheckoutAttempt {
  const current = usableAttempt(inMemory, fingerprint, now);
  if (current) return current;

  try {
    const stored = usableAttempt(JSON.parse(window.sessionStorage.getItem(storageKey(product)) || 'null'), fingerprint, now);
    if (stored) return stored;
  } catch {
    // Privacy modes can deny storage. In-memory idempotency still protects
    // repeated clicks for the lifetime of the rendered page.
  }

  const created = { fingerprint, requestId: crypto.randomUUID(), createdAt: now };
  try { window.sessionStorage.setItem(storageKey(product), JSON.stringify(created)); } catch { /* optional storage */ }
  return created;
}

export function clearCheckoutAttempt(product: 'esim' | 'pocket_wifi') {
  try { window.sessionStorage.removeItem(storageKey(product)); } catch { /* optional storage */ }
}
