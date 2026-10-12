import { createConcurrencyLimiter } from './concurrencyLimit';

// Both public webhook paths execute the same handler during the legacy URL
// migration. Next can compile route entrypoints into separate module graphs,
// so a limiter owned by the handler module is not guaranteed to be shared:
// simultaneous delivery to both URLs could otherwise double the intended
// Stripe/Supabase/SMTP load. Keep the two budgets on the process global,
// which is shared by every route bundle in one standalone Node worker.
export const STRIPE_WEBHOOK_MAX_CONCURRENT_REQUESTS = 16;
export const STRIPE_WEBHOOK_MAX_CONCURRENT_UPLOADS = 32;

type Limiter = ReturnType<typeof createConcurrencyLimiter>;
type WebhookConcurrencyGlobal = typeof globalThis & {
  __qyRoamStripeWebhookProcessingConcurrency?: Limiter;
  __qyRoamStripeWebhookUploadConcurrency?: Limiter;
};

const shared = globalThis as WebhookConcurrencyGlobal;

const processingConcurrency = shared.__qyRoamStripeWebhookProcessingConcurrency ??=
  createConcurrencyLimiter(STRIPE_WEBHOOK_MAX_CONCURRENT_REQUESTS);
const uploadConcurrency = shared.__qyRoamStripeWebhookUploadConcurrency ??=
  createConcurrencyLimiter(STRIPE_WEBHOOK_MAX_CONCURRENT_UPLOADS);

export function tryAcquireStripeWebhookProcessing() {
  return processingConcurrency.tryAcquire();
}

export function tryAcquireStripeWebhookUpload() {
  return uploadConcurrency.tryAcquire();
}
