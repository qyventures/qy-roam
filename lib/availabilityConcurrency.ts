import { createConcurrencyLimiter } from './concurrencyLimit';

// Availability scans can fan out across multiple Stripe pages before taking
// an atomic Supabase inventory snapshot. Bound simultaneous live promises so
// a provider slowdown cannot retain unbounded requests in the app process.
// Excess lookups fail fast and are safe for the date picker to retry.
export const AVAILABILITY_MAX_CONCURRENT_REQUESTS = 8;

type Limiter = ReturnType<typeof createConcurrencyLimiter>;
type AvailabilityConcurrencyGlobal = typeof globalThis & {
  __qyRoamAvailabilityConcurrency?: Limiter;
};

// Next can evaluate a server module more than once during a route-graph
// rebuild while requests admitted by the previous graph are still active.
// Keep the provider-work budget process-wide so a reload cannot temporarily
// multiply the intended Stripe/Supabase availability load.
const shared = globalThis as AvailabilityConcurrencyGlobal;
const availabilityConcurrency = shared.__qyRoamAvailabilityConcurrency ??=
  createConcurrencyLimiter(AVAILABILITY_MAX_CONCURRENT_REQUESTS);

export function tryAcquireAvailabilityConcurrency() {
  return availabilityConcurrency.tryAcquire();
}
