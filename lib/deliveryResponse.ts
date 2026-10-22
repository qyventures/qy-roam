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

/**
 * Accept the JSON media type used by Meta and the fulfilment relay without
 * letting an untrusted response hide control characters or an unbounded
 * parameter section after an otherwise-valid `application/json` prefix.
 * Parameters remain supported because ordinary providers commonly append a
 * charset declaration; their semantics do not affect JSON acknowledgement
 * parsing, but the complete header must still be printable and bounded.
 */
export function deliveryResponseHasJsonContentType(value: string | null) {
  if (!value || value.length > 256 || !/^[\x20-\x7e]+$/.test(value)) return false;
  const [mediaType, ...parameters] = value.split(';');
  if (mediaType.trim().toLowerCase() !== 'application/json') return false;
  // A trailing/empty parameter is malformed rather than a harmless charset
  // annotation. Reject it so a generic proxy fallback cannot masquerade as
  // the provider acknowledgement contract with only a matching prefix.
  return parameters.every((parameter) => parameter.trim().length > 0);
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
