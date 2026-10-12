import { createConcurrencyLimiter } from './concurrencyLimit';

// The main operations dashboard can page across five independent ledgers.
// Basic Auth proves the caller is staff, but does not prevent overlapping tab
// refreshes or monitoring retries from multiplying that provider work. Keep a
// small fail-fast budget so one complete dashboard remains useful during an
// incident instead of every render competing through long Supabase scans.
export const ADMIN_DASHBOARD_MAX_CONCURRENT_REQUESTS = 2;

type Limiter = ReturnType<typeof createConcurrencyLimiter>;
type AdminDashboardConcurrencyGlobal = typeof globalThis & {
  __qyRoamAdminDashboardConcurrency?: Limiter;
};

// Next can evaluate server modules through more than one graph. Store the
// limiter on the process global so each graph shares the same production
// budget in the standalone single-process deployment.
const shared = globalThis as AdminDashboardConcurrencyGlobal;
const adminDashboardConcurrency = shared.__qyRoamAdminDashboardConcurrency ??=
  createConcurrencyLimiter(ADMIN_DASHBOARD_MAX_CONCURRENT_REQUESTS);

export function tryAcquireAdminDashboardConcurrency() {
  return adminDashboardConcurrency.tryAcquire();
}

// Keep the release in one shared boundary so every read-heavy admin page
// returns its slot after success or failure. Callers provide a typed fallback
// that lets the page fail closed with its existing "data unavailable" UI
// instead of throwing a render error when the operational read budget is full.
export async function runAdminDashboardWork<T, B>(work: () => Promise<T>, busy: B): Promise<T | B> {
  const release = tryAcquireAdminDashboardConcurrency();
  if (!release) return busy;
  try {
    return await work();
  } finally {
    release();
  }
}
