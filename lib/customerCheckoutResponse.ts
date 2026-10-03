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
export function parseCustomerCheckoutResponse(value: unknown, responseOk: boolean): CustomerCheckoutResponse {
  const empty: CustomerCheckoutResponse = {
    checkoutUrl: null,
    completedSessionId: null,
    error: null,
    checkoutExpired: false,
    checkoutRequestConflict: false,
    paymentFailed: false,
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;

  const input = value as Record<string, unknown>;
  const checkoutUrl = responseOk ? safeStripeCheckoutUrl(input.url) : null;
  const completedSessionId = responseOk && input.completed === true
    ? validStripeCheckoutSessionId(input.sessionId)
    : null;

  // A response must select one redirect capability. Treat contradictory data
  // as malformed instead of choosing whichever field happened to be checked
  // first in a component.
  if (checkoutUrl && completedSessionId) return empty;

  return {
    checkoutUrl,
    completedSessionId,
    error: safeCustomerError(input.error),
    checkoutExpired: input.checkoutExpired === true,
    checkoutRequestConflict: input.checkoutRequestConflict === true,
    paymentFailed: input.paymentFailed === true,
  };
}
