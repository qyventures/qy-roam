import { createConcurrencyLimiter } from './concurrencyLimit';

// A recovery attempt can span bounded Stripe, Supabase, SMTP, and Meta calls.
// Keep this separate from ordinary admin database mutations so a slow provider
// cannot prevent staff from recording dispatches or returns.
export const ADMIN_DELIVERY_MAX_CONCURRENT_REQUESTS = 4;

type Limiter = ReturnType<typeof createConcurrencyLimiter>;
type AdminDeliveryConcurrencyGlobal = typeof globalThis & {
  __qyRoamAdminDeliveryConcurrency?: Limiter;
};

// Next can retain an old route graph while evaluating its replacement. Store
// admission state on the process global so both graphs share one provider-work
// ceiling and cannot each start a full set of delivery recovery attempts.
const shared = globalThis as AdminDeliveryConcurrencyGlobal;
const adminDeliveryConcurrency = shared.__qyRoamAdminDeliveryConcurrency ??=
  createConcurrencyLimiter(ADMIN_DELIVERY_MAX_CONCURRENT_REQUESTS);

export function tryAcquireAdminDeliveryConcurrency() {
  return adminDeliveryConcurrency.tryAcquire();
}
