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
  // Both checkout routes deliberately return 200 for their only two success
  // envelopes. Do not treat redirects, partial-content responses, or another
  // future 2xx shape as authority to navigate away from the storefront.
  const responseOk = responseStatus === 200;
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
    // Validate the raw branch markers as well as the resulting capability.
    // Otherwise `{ url: valid, completed: true, sessionId: malformed }`
    // silently degrades into a URL response even though the server claimed
    // two mutually exclusive outcomes. The inverse ambiguity is equally
    // unsafe. Fail closed and retain the current idempotency key.
    const claimsCheckoutUrl = Object.prototype.hasOwnProperty.call(input, 'url');
    const claimsCompletedSession = input.completed === true ||
      Object.prototype.hasOwnProperty.call(input, 'sessionId');
    if (claimsCheckoutUrl === claimsCompletedSession ||
      Boolean(checkoutUrl) === Boolean(completedSessionId)) return empty;
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
  const error = safeCustomerError(input.error);
  const requestedReplacementReasons = [
    input.checkoutExpired === true,
    input.checkoutRequestConflict === true,
    input.paymentFailed === true,
  ];
  // These states are mutually exclusive outcomes of one server-side
  // reconciliation. Require exactly one deliberate reason and the bounded
  // customer-facing explanation emitted with it before discarding the
  // browser's durable Stripe idempotency key. A malformed/stale 409 that
  // combines flags (or carries only a flag) must remain safely retryable with
  // the original attempt instead of opening a second payable Session.
  const mayReplaceAttempt = responseStatus === 409 && Boolean(error) &&
    requestedReplacementReasons.filter(Boolean).length === 1;
  return {
    ...empty,
    error,
    checkoutExpired: mayReplaceAttempt && input.checkoutExpired === true,
    checkoutRequestConflict: mayReplaceAttempt && input.checkoutRequestConflict === true,
    paymentFailed: mayReplaceAttempt && input.paymentFailed === true,
  };
}
