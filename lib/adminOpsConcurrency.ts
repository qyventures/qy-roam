import { createConcurrencyLimiter } from './concurrencyLimit';

// Admin operations include inventory mutations, manual paid-order creation,
// and accounting closes that can page through the paid-order ledger. Basic
// Auth limits who can call them, not how much overlapping database work a
// double-submit, retrying browser, or automation client can create. Keep this
// pool separate from customer checkout and fail fast instead of queueing
// mutable requests whose operator context may be stale by the time they run.
export const ADMIN_OPS_MAX_CONCURRENT_REQUESTS = 4;

type Limiter = ReturnType<typeof createConcurrencyLimiter>;
type AdminOpsConcurrencyGlobal = typeof globalThis & {
  __qyRoamAdminOpsConcurrency?: Limiter;
};

// The general operations and per-order mutation routes can be compiled into
// separate server module graphs. A process-global pool keeps them on one
// database-work budget instead of admitting the configured maximum per route.
const shared = globalThis as AdminOpsConcurrencyGlobal;
const adminOpsConcurrency = shared.__qyRoamAdminOpsConcurrency ??=
  createConcurrencyLimiter(ADMIN_OPS_MAX_CONCURRENT_REQUESTS);

export function tryAcquireAdminOpsConcurrency() {
  return adminOpsConcurrency.tryAcquire();
}
