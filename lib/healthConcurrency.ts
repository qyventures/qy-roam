import { createConcurrencyLimiter } from './concurrencyLimit';

// An authenticated readiness probe fans out to Stripe and several Supabase
// checks. Monitoring retries can overlap when either provider is slow, so use
// a separate, non-queueing budget that cannot retain an unbounded number of
// requests or consume the checkout admission pool.
export const HEALTH_MAX_CONCURRENT_REQUESTS = 4;

type Limiter = ReturnType<typeof createConcurrencyLimiter>;
type HealthConcurrencyGlobal = typeof globalThis & {
  __qyRoamHealthConcurrency?: Limiter;
};

// Readiness checks can overlap a Next route-graph rebuild. Store their
// admission state on the process global so old and new module instances do
// not each fan out a full set of Stripe and Supabase probes.
const shared = globalThis as HealthConcurrencyGlobal;
const healthConcurrency = shared.__qyRoamHealthConcurrency ??=
  createConcurrencyLimiter(HEALTH_MAX_CONCURRENT_REQUESTS);

export function tryAcquireHealthConcurrency() {
  return healthConcurrency.tryAcquire();
}
