import { createConcurrencyLimiter } from './concurrencyLimit';

// Admin JSON mutations are bounded by size and time, but their bodies are
// deliberately read before the smaller database-work pool is acquired. Keep
// that ingress work bounded too: a stalled authenticated browser, automation
// retry storm, or leaked credential must not create an unlimited number of
// simultaneous request-stream readers while preserving capacity for normal
// operator saves.
export const ADMIN_UPLOAD_MAX_CONCURRENT_REQUESTS = 12;

type Limiter = ReturnType<typeof createConcurrencyLimiter>;
type AdminUploadConcurrencyGlobal = typeof globalThis & {
  __qyRoamAdminUploadConcurrency?: Limiter;
};

// General operations and per-order mutations can live in separate Next.js
// module graphs. Share one process-wide allowance so each route cannot admit
// the full upload budget independently.
const shared = globalThis as AdminUploadConcurrencyGlobal;
const adminUploadConcurrency = shared.__qyRoamAdminUploadConcurrency ??=
  createConcurrencyLimiter(ADMIN_UPLOAD_MAX_CONCURRENT_REQUESTS);

export function tryAcquireAdminUpload() {
  return adminUploadConcurrency.tryAcquire();
}
