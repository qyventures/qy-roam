/**
 * Cheap structural validation for Stripe's signature header before a public
 * request is allowed to occupy a slow-body upload slot. This is deliberately
 * not authentication: stripe-node still verifies the HMAC over the exact raw
 * payload and enforces the timestamp tolerance after the body has been read.
 */
export function structurallyValidStripeSignatureHeader(value: string) {
  let timestampCount = 0;
  let signatureCount = 0;

  for (const item of value.split(',')) {
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
      if (!/^\d+$/.test(fieldValue)) return false;
      const timestamp = Number(fieldValue);
      if (!Number.isSafeInteger(timestamp) || timestamp < 1) return false;
    } else if (key === 'v1') {
      // stripe-node compares a SHA-256 HMAC encoded as 64 hexadecimal
      // characters. Multiple v1 values are valid during secret rotation.
      if (!/^[a-f0-9]{64}$/.test(fieldValue)) return false;
      signatureCount += 1;
    }
  }

  return timestampCount === 1 && signatureCount >= 1;
}
