import { createConcurrencyLimiter } from './concurrencyLimit';

// Both product routes share one process-wide budget. Separate per-route
// limits would allow a simultaneous Pocket WiFi and eSIM burst to exceed the
// capacity reserved for checkout as a whole. Rejecting excess work promptly
// is safe because checkout request ids remain stable idempotency keys and the
// browser can retry without creating a second payment capability.
export const CHECKOUT_MAX_CONCURRENT_REQUESTS = 12;
const checkoutConcurrency = createConcurrencyLimiter(CHECKOUT_MAX_CONCURRENT_REQUESTS);

export function tryAcquireCheckoutConcurrency() {
  return checkoutConcurrency.tryAcquire();
}
