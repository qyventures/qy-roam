import { createFailedAdminAuthLimiter, createGlobalFailedAdminAuthLimiter } from './adminAuthRateLimit';

// Confirmation pages perform provider-backed reads before rendering. Keep a
// separate allowance from authentication failures while reusing the same
// edge-safe, bounded client registry and allocation-free global window.
export const CONFIRMATION_RATE_LIMIT_WINDOW_MS = 60_000;
export const CONFIRMATION_CLIENT_RATE_LIMIT_MAX_ATTEMPTS = 30;
export const CONFIRMATION_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS = 180;

type ConfirmationRateLimitGlobal = typeof globalThis & {
  __qyRoamConfirmationClientLimiter?: ReturnType<typeof createFailedAdminAuthLimiter>;
  __qyRoamConfirmationGlobalLimiter?: ReturnType<typeof createGlobalFailedAdminAuthLimiter>;
};

// Next can evaluate middleware dependencies in more than one module graph
// during a process lifetime. A route- or graph-local limiter would grant a
// fresh set of Stripe/ledger reads to every copy, weakening overload
// protection precisely while the server is rebuilding or recovering. Keep
// both confirmation budgets on one process-wide boundary. This remains
// instance-local; production ingress is still responsible if the service is
// later scaled to multiple workers.
const shared = globalThis as ConfirmationRateLimitGlobal;
const confirmationClientLimiter = shared.__qyRoamConfirmationClientLimiter ??=
  createFailedAdminAuthLimiter(
    CONFIRMATION_RATE_LIMIT_WINDOW_MS,
    CONFIRMATION_CLIENT_RATE_LIMIT_MAX_ATTEMPTS,
  );
const confirmationGlobalLimiter = shared.__qyRoamConfirmationGlobalLimiter ??=
  createGlobalFailedAdminAuthLimiter(
    CONFIRMATION_RATE_LIMIT_WINDOW_MS,
    CONFIRMATION_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS,
  );

export function confirmationClientLimited(req: Request, now = Date.now()) {
  return confirmationClientLimiter(req, now);
}

export function confirmationGloballyLimited(now = Date.now()) {
  return confirmationGlobalLimiter(now);
}
