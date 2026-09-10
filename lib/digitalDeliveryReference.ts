// eSIM QR and activation data are customer credentials, not order metadata.
// An order may retain a compact provider or secure-mail-log reference so
// operations can audit fulfilment without copying a usable entitlement into
// the application database or admin UI.
const MAX_DIGITAL_DELIVERY_REFERENCE_LENGTH = 200;

export function normalizeDigitalDeliveryReference(value: string | null | undefined) {
  return (value || '').trim();
}

export function digitalDeliveryReferenceIssue(value: string | null | undefined) {
  const reference = normalizeDigitalDeliveryReference(value);
  if (!reference) return 'A delivery reference is required before marking an eSIM order fulfilled.';
  if (reference.length > MAX_DIGITAL_DELIVERY_REFERENCE_LENGTH) return 'The eSIM delivery reference must be 200 characters or fewer.';
  if (/[\u0000-\u001f\u007f]/.test(reference)) return 'The eSIM delivery reference must be a single-line audit reference.';
  // Provider portals and activation payloads are deliberately excluded. A
  // reference should identify the secure record where delivery was performed,
  // never contain a credential capable of activating service by itself.
  if (/(?:\b(?:lpa:|smdp\+?|activation\s*(?:code|token)|qr\s*code|iccid|imsi|eid|confirmation\s*code)\b|https?:\/\/|\bwww\.)/i.test(reference)) {
    return 'Record a provider order ID or secure delivery/email log reference, not an eSIM QR code, activation credential, or delivery URL.';
  }
  return null;
}

export function isSafeDigitalDeliveryReference(value: string | null | undefined) {
  return !digitalDeliveryReferenceIssue(value);
}
