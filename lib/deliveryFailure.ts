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
