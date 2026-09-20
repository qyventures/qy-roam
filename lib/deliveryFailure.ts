// Provider errors can surface in the protected operations UI through the
// durable retry ledgers. Keep the useful, application-authored diagnostics
// (notably SMTP and HTTP status codes), but never persist arbitrary Error
// text from a network stack, relay, SDK, or proxy: those messages can include
// echoed request details, configured hostnames, or credentials.
const SAFE_PROVIDER_FAILURE = /^(?:SMTP error \d{3}|SMTP connection timed out|SMTP response is too large|SMTP delivery timed out|SMTP relay failed \(\d{3}\)|SMTP relay did not acknowledge the fulfilment message|Meta CAPI failed \(\d{3}\)|Meta CAPI did not acknowledge the Purchase event)$/;

export function safeProviderDeliveryFailure(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : '';
  return SAFE_PROVIDER_FAILURE.test(message) ? message : fallback;
}

// Stripe-event failures are also surfaced in the protected operations UI.
// Unlike the two delivery ledgers above, this path can catch errors from the
// Stripe SDK, PostgREST, or a future dependency before a more specific
// delivery record exists. Do not persist their arbitrary messages: SDK and
// proxy errors can echo request details, endpoint configuration, or customer
// data. The event id, event type, and Checkout Session id are already stored
// separately for an operator to reconcile the failed event safely.
export function safeWebhookProcessingFailure(_error: unknown) {
  return 'Stripe webhook processing failed; retry or inspect the affected event.';
}
