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

// Fetch exposes decoded response bytes while retaining the provider's encoded
// Content-Length. Only the content codings supported by the Node fetch runtime
// may opt out of an exact length comparison. Treat unknown, chained, or
// control-character-bearing values as a malformed acknowledgement instead of
// letting an arbitrary header weaken the paid-delivery settlement boundary.
export function deliveryResponseContentEncoding(value: string | null) {
  if (value === null || value === '') return 'identity' as const;
  if (value.length > 128 || !/^[\x20-\x7e]+$/.test(value)) return null;
  const encoding = value.trim().toLowerCase();
  if (encoding === 'identity') return 'identity' as const;
  if (encoding === 'gzip' || encoding === 'deflate' || encoding === 'br') return 'encoded' as const;
  return null;
}
