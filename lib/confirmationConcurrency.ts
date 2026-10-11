import { createConcurrencyLimiter } from './concurrencyLimit';

// Customer confirmation views each perform a Stripe read and may then query
// the paid-order ledger. The middleware rate limit bounds work per minute,
// but it does not prevent every allowed request arriving simultaneously while
// a provider is slow. Share one small, non-queueing budget across /success and
// /booking so excess refreshes fail fast instead of retaining server workers.
export const CONFIRMATION_MAX_CONCURRENT_REQUESTS = 12;
const confirmationConcurrency = createConcurrencyLimiter(CONFIRMATION_MAX_CONCURRENT_REQUESTS);

export function tryAcquireConfirmationConcurrency() {
  return confirmationConcurrency.tryAcquire();
}
