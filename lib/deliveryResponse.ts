/**
 * Decode a provider acknowledgement without normalising malformed bytes.
 *
 * Fulfilment relay and Meta responses can settle durable paid-order delivery
 * ledgers. Buffer#toString replaces invalid UTF-8 with U+FFFD, which means the
 * JSON parser would inspect text different from the bytes the provider sent.
 * Reject that response and leave the delivery retryable instead.
 */
export function strictDeliveryResponseText(bytes: Uint8Array) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
