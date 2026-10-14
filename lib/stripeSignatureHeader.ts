/**
 * Cheap structural validation for Stripe's signature header before a public
 * request is allowed to occupy a slow-body upload slot. This is deliberately
 * not authentication: stripe-node still verifies the HMAC over the exact raw
 * payload and enforces the timestamp tolerance after the body has been read.
 */
export function structurallyValidStripeSignatureHeader(value: string) {
  // The route also caps the complete header, but bound parser work
  // independently. A comma-heavy lookalike must not turn the unauthenticated
  // admission check into thousands of token/regex operations before its body
  // is rejected. Stripe may include multiple signatures during endpoint
  // secret rotation, so retain a deliberately generous small ceiling.
  const items = value.split(',');
  if (items.length < 2 || items.length > 32) return false;

  let timestampCount = 0;
  let signatureCount = 0;

  for (const item of items) {
    const separator = item.indexOf('=');
    if (separator < 1 || separator === item.length - 1 || item.indexOf('=', separator + 1) !== -1) return false;

    const key = item.slice(0, separator);
    const fieldValue = item.slice(separator + 1);
    // Stripe currently emits token-like scheme names. Permit additional
    // schemes so a provider-side rollout does not break authentic deliveries,
    // but reject whitespace and punctuation-heavy lookalikes cheaply.
    if (!/^[A-Za-z0-9_-]+$/.test(key) || !/^[A-Za-z0-9]+$/.test(fieldValue)) return false;

    if (key === 't') {
      timestampCount += 1;
      // Stripe timestamps are Unix seconds. Twelve digits comfortably covers
      // the service lifetime while keeping Number conversion and validation
      // constant-size for unauthenticated input.
      if (!/^\d{1,12}$/.test(fieldValue)) return false;
      const timestamp = Number(fieldValue);
      if (!Number.isSafeInteger(timestamp) || timestamp < 1) return false;
    } else if (key === 'v1') {
      // stripe-node compares a SHA-256 HMAC encoded as 64 hexadecimal
      // characters. Multiple v1 values are valid during secret rotation.
      if (!/^[a-f0-9]{64}$/.test(fieldValue)) return false;
      signatureCount += 1;
      if (signatureCount > 8) return false;
    }
  }

  return timestampCount === 1 && signatureCount >= 1;
}

/**
 * Reject a signature timestamp that is already too old before allowing its
 * unauthenticated request body to occupy a slow-upload slot. This is only an
 * admission check: the Stripe SDK still verifies the HMAC and repeats the
 * timestamp policy after the exact payload has been read.
 *
 * Apply the tolerance symmetrically. Ordinary clock skew remains accepted,
 * but an authenticated payload with an implausibly future timestamp must not
 * acquire a replay lifetime that lasts until that future time plus the normal
 * tolerance. stripe-node repeats its own (older-than) check after the body is
 * read; this application boundary deliberately adds the missing future-skew
 * half of the freshness policy before slow-upload admission.
 */
export function stripeSignatureTimestampWithinTolerance(
  value: string,
  toleranceSeconds: number,
  receivedAtMs = Date.now(),
) {
  if (!Number.isSafeInteger(toleranceSeconds) || toleranceSeconds < 1 || !Number.isFinite(receivedAtMs)) return false;

  let timestamp: number | null = null;
  for (const item of value.split(',')) {
    if (!item.startsWith('t=')) continue;
    const rawTimestamp = item.slice(2);
    if (!/^\d{1,12}$/.test(rawTimestamp)) return false;
    const parsedTimestamp = Number(rawTimestamp);
    if (!Number.isSafeInteger(parsedTimestamp) || parsedTimestamp < 1 || timestamp !== null) return false;
    timestamp = parsedTimestamp;
  }

  return timestamp !== null &&
    Math.abs(Math.floor(receivedAtMs / 1_000) - timestamp) <= toleranceSeconds;
}
