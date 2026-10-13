import { CUSTOMER_REQUEST_TIMEOUT_MS, fetchCustomerJson } from './clientRequest';
import { parseCustomerCheckoutResponse, type CustomerCheckoutResponse } from './customerCheckoutResponse';

// A paid Checkout Session can become visible to the browser a few seconds
// before its signed webhook has finished persisting the order. Keep that
// reconciliation inside the original customer action: every retry reuses the
// exact request body (and therefore the same Stripe idempotency key).
export const CUSTOMER_CHECKOUT_MAX_RECONCILIATION_ATTEMPTS = 4;
// This is one customer action, even though a paid Session may need several
// short idempotent polls while its webhook persists the order. Applying the
// normal request timeout independently to every poll could keep the checkout
// button locked for eight minutes during a provider outage. Share one deadline
// across the complete reconciliation sequence instead.
export const CUSTOMER_CHECKOUT_RECONCILIATION_TIMEOUT_MS = CUSTOMER_REQUEST_TIMEOUT_MS;
const DEFAULT_RETRY_AFTER_MS = 3_000;
const MIN_RETRY_AFTER_SECONDS = 1;
const MAX_RETRY_AFTER_SECONDS = 5;

export function customerCheckoutRetryAfterMs(value: string | null) {
  // Checkout emits a delta-seconds Retry-After value. Do not accept HTTP-date
  // input here: a bad intermediary clock must not turn one click into a long,
  // invisible wait, and arbitrary strings must never become NaN timers.
  if (!value || !/^\d+$/.test(value)) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(MIN_RETRY_AFTER_SECONDS, seconds)) * 1_000;
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function checkoutResponseSupersedesPending(response: CustomerCheckoutResponse) {
  // Once this browser has received the route's validated payment-pending
  // envelope, the same reconciliation cycle can only improve it to durable
  // completion. Stripe cannot legitimately move a completed/pending Session
  // back to an open payment URL, and a stale but otherwise valid response
  // must not send an already-paid customer through Checkout again. Terminal
  // replacement outcomes are deliberately observed on a later customer
  // retry, which reuses the same attempt id before the storefront rotates it.
  // This also keeps an ambiguous pending state safe if an async payment fails
  // while the current bounded reconciliation cycle is still in flight.
  return Boolean(
    response.completedSessionId ||
    response.paymentPending
  );
}

export async function fetchCustomerCheckout(
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<CustomerCheckoutResponse> {
  let parsed: CustomerCheckoutResponse | null = null;
  // performance.now() is monotonic; a device clock correction while Checkout
  // is open must not silently extend or prematurely consume this deadline.
  const deadlineAt = performance.now() + CUSTOMER_CHECKOUT_RECONCILIATION_TIMEOUT_MS;

  for (let attempt = 0; attempt < CUSTOMER_CHECKOUT_MAX_RECONCILIATION_ATTEMPTS; attempt += 1) {
    // performance.now() is sub-millisecond in browsers, while the shared
    // request boundary deliberately accepts only finite integer deadlines.
    // Round down so this budget never exceeds the reviewed overall timeout
    // and does not reject every checkout merely because the clock is precise.
    const remainingMs = Math.floor(deadlineAt - performance.now());
    // A previous response or backoff can consume the shared budget. Return the
    // last authenticated pending state instead of starting another request
    // that would extend this click beyond its reviewed browser deadline.
    if (remainingMs < 1) return parsed ?? parseCustomerCheckoutResponse(null, 500);
    let response: Response;
    let value: unknown;
    try {
      ({ response, value } = await fetchCustomerJson(input, init, remainingMs));
    } catch (error) {
      // Once the server has authenticated a paid-but-not-yet-persisted state,
      // a later reconciliation poll is only an attempt to improve that known
      // result. A dropped mobile connection, proxy body failure, or exhausted
      // shared deadline must not replace it with a generic checkout failure:
      // that can make a paid customer try to buy again. Preserve the pending
      // envelope (and therefore the same durable checkout attempt) while
      // still surfacing first-request failures normally.
      if (parsed?.paymentPending) return parsed;
      throw error;
    }
    const next = parseCustomerCheckoutResponse(value, response.status);
    if (parsed?.paymentPending && !checkoutResponseSupersedesPending(next)) {
      return parsed;
    }
    parsed = next;
    if (!parsed.paymentPending || attempt === CUSTOMER_CHECKOUT_MAX_RECONCILIATION_ATTEMPTS - 1) {
      return parsed;
    }
    const retryAfterMs = customerCheckoutRetryAfterMs(response.headers.get('Retry-After'));
    if (deadlineAt - performance.now() <= retryAfterMs) return parsed;
    await wait(retryAfterMs);
  }

  // The loop always executes at least once. Keep a fail-closed fallback so a
  // future refactor of the attempt constant cannot manufacture a success.
  return parsed ?? parseCustomerCheckoutResponse(null, 500);
}
