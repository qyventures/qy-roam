import { createConcurrencyLimiter } from './concurrencyLimit';

// Availability scans can fan out across multiple Stripe pages before taking
// an atomic Supabase inventory snapshot. Bound simultaneous live promises so
// a provider slowdown cannot retain unbounded requests in the app process.
// Excess lookups fail fast and are safe for the date picker to retry.
export const AVAILABILITY_MAX_CONCURRENT_REQUESTS = 8;
const availabilityConcurrency = createConcurrencyLimiter(AVAILABILITY_MAX_CONCURRENT_REQUESTS);

export function tryAcquireAvailabilityConcurrency() {
  return availabilityConcurrency.tryAcquire();
}
