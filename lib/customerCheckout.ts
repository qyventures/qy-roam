import { fetchCustomerJson } from './clientRequest';
import { parseCustomerCheckoutResponse, type CustomerCheckoutResponse } from './customerCheckoutResponse';

// A paid Checkout Session can become visible to the browser a few seconds
// before its signed webhook has finished persisting the order. Keep that
// reconciliation inside the original customer action: every retry reuses the
// exact request body (and therefore the same Stripe idempotency key).
export const CUSTOMER_CHECKOUT_MAX_RECONCILIATION_ATTEMPTS = 4;
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

export async function fetchCustomerCheckout(
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<CustomerCheckoutResponse> {
  let parsed: CustomerCheckoutResponse | null = null;

  for (let attempt = 0; attempt < CUSTOMER_CHECKOUT_MAX_RECONCILIATION_ATTEMPTS; attempt += 1) {
    const { response, value } = await fetchCustomerJson(input, init);
    parsed = parseCustomerCheckoutResponse(value, response.status);
    if (!parsed.paymentPending || attempt === CUSTOMER_CHECKOUT_MAX_RECONCILIATION_ATTEMPTS - 1) {
      return parsed;
    }
    await wait(customerCheckoutRetryAfterMs(response.headers.get('Retry-After')));
  }

  // The loop always executes at least once. Keep a fail-closed fallback so a
  // future refactor of the attempt constant cannot manufacture a success.
  return parsed ?? parseCustomerCheckoutResponse(null, 500);
}
