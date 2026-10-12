import { createConcurrencyLimiter } from './concurrencyLimit';

// An authenticated readiness probe fans out to Stripe and several Supabase
// checks. Monitoring retries can overlap when either provider is slow, so use
// a separate, non-queueing budget that cannot retain an unbounded number of
// requests or consume the checkout admission pool.
export const HEALTH_MAX_CONCURRENT_REQUESTS = 4;
const healthConcurrency = createConcurrencyLimiter(HEALTH_MAX_CONCURRENT_REQUESTS);

export function tryAcquireHealthConcurrency() {
  return healthConcurrency.tryAcquire();
}
