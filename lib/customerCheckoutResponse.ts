import { safeStripeCheckoutUrl } from './stripeCheckoutUrl';
import { validStripeCheckoutSessionId } from './stripeSessionId';

export type CustomerCheckoutResponse = {
  checkoutUrl: string | null;
  completedSessionId: string | null;
  error: string | null;
  checkoutExpired: boolean;
  checkoutRequestConflict: boolean;
  paymentFailed: boolean;
};

function safeCustomerError(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 500 &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

// A same-origin response is still runtime data: a stale service worker,
// intermediary error page, or future route regression must not be able to
// turn a checkout click into an arbitrary browser navigation. Only successful
// responses can carry a payment or confirmation capability, and each one is
// validated at the same canonical boundary used by the server.
export function parseCustomerCheckoutResponse(value: unknown, responseStatus: number): CustomerCheckoutResponse {
  const empty: CustomerCheckoutResponse = {
    checkoutUrl: null,
    completedSessionId: null,
    error: null,
    checkoutExpired: false,
    checkoutRequestConflict: false,
    paymentFailed: false,
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
  if (!Number.isSafeInteger(responseStatus) || responseStatus < 100 || responseStatus > 599) return empty;

  const input = value as Record<string, unknown>;
  const responseOk = responseStatus >= 200 && responseStatus < 300;
  const checkoutUrl = responseOk ? safeStripeCheckoutUrl(input.url) : null;
  const completedSessionId = responseOk && input.completed === true
    ? validStripeCheckoutSessionId(input.sessionId)
    : null;

  if (responseOk) {
    // A successful checkout response must select exactly one validated
    // redirect capability. In particular, never honour retry-rotation flags
    // from a malformed HTTP 2xx payload: discarding the browser's durable
    // Stripe idempotency key after the server may have created a Session can
    // turn a response-shape regression into a second payable Session.
    if (Boolean(checkoutUrl) === Boolean(completedSessionId)) return empty;
    return {
      ...empty,
      checkoutUrl,
      completedSessionId,
    };
  }

  // Only the route's deliberate conflict response can declare that the
  // server has proved this attempt safe to replace. A proxy, stale service
  // worker, or future generic 4xx/5xx response must not be able to copy one
  // of these fields into its body and make the next click create a second
  // payable Session under a fresh Stripe idempotency key.
  const mayReplaceAttempt = responseStatus === 409;
  return {
    ...empty,
    error: safeCustomerError(input.error),
    checkoutExpired: mayReplaceAttempt && input.checkoutExpired === true,
    checkoutRequestConflict: mayReplaceAttempt && input.checkoutRequestConflict === true,
    paymentFailed: mayReplaceAttempt && input.paymentFailed === true,
  };
}
