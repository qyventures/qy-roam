import crypto from 'crypto';

export const MANUAL_ORDER_REFERENCE_MAX_LENGTH = 120;

// This value is an idempotency identity, not display copy. Never truncate it:
// two provider references with the same prefix must not collapse onto one
// paid order. Whitespace around an operator-entered reference is harmless,
// but the complete normalized value must satisfy the bounded contract.
export function manualOrderReference(value: unknown) {
  if (typeof value !== 'string') return null;
  const reference = value.trim();
  return reference.length <= MANUAL_ORDER_REFERENCE_MAX_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9._:/#-]{4,119}$/.test(reference)
    ? reference
    : null;
}

export function manualOrderSessionId(reference: string) {
  return `manual_${crypto.createHash('sha256').update(reference).digest('hex').slice(0, 48)}`;
}
