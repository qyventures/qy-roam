import { createConcurrencyLimiter } from './concurrencyLimit';

// Both product routes share one process-wide budget. Separate per-route
// limits would allow a simultaneous Pocket WiFi and eSIM burst to exceed the
// capacity reserved for checkout as a whole. Rejecting excess work promptly
// is safe because checkout request ids remain stable idempotency keys and the
// browser can retry without creating a second payment capability.
export const CHECKOUT_MAX_CONCURRENT_REQUESTS = 12;
// Body uploads are cheap compared with Stripe/Supabase work, but Nginx
// deliberately streams them so the application can enforce an absolute
// deadline. Bound those pre-validation reads separately: a burst of slow
// clients must not create unbounded timers, readers and 4 KiB buffers, while
// still leaving a wider ingress lane than the dependency-work pool below.
export const CHECKOUT_MAX_CONCURRENT_UPLOADS = 32;

type Limiter = ReturnType<typeof createConcurrencyLimiter>;
type CheckoutConcurrencyGlobal = typeof globalThis & {
  __qyRoamCheckoutConcurrency?: Limiter;
  __qyRoamCheckoutUploadConcurrency?: Limiter;
};

// Next can place the two product routes in separate server module graphs.
// Store the limiter on the process global so those graphs cannot each admit a
// full checkout budget and silently double the intended Stripe/Supabase load.
const shared = globalThis as CheckoutConcurrencyGlobal;
const checkoutConcurrency = shared.__qyRoamCheckoutConcurrency ??=
  createConcurrencyLimiter(CHECKOUT_MAX_CONCURRENT_REQUESTS);
const checkoutUploadConcurrency = shared.__qyRoamCheckoutUploadConcurrency ??=
  createConcurrencyLimiter(CHECKOUT_MAX_CONCURRENT_UPLOADS);

export function tryAcquireCheckoutConcurrency() {
  return checkoutConcurrency.tryAcquire();
}

export function tryAcquireCheckoutUpload() {
  return checkoutUploadConcurrency.tryAcquire();
}
