export const META_ATTRIBUTION_METADATA_KEYS = [
  'meta_fbp',
  'meta_fbc',
  'meta_client_user_agent',
  'meta_client_ip',
] as const;

// Reusing a Stripe idempotency key prevents duplicate payable Sessions when a
// shopper retries checkout. If they have revoked optional measurement in the
// meantime, however, the original Session must not retain consent or matching
// identifiers. Consent can be narrowed on a retry, never broadened: accepting
// measurement after a Session was created requires a future checkout attempt
// and cannot retroactively authorise data already attached to this one.
export function stripeMeasurementConsentDowngrade(
  metadata: Record<string, string> | null | undefined,
  measurementConsent: unknown,
): Record<string, string | null> | null {
  if (measurementConsent === true || metadata?.measurement_consent !== 'accepted') return null;
  return {
    measurement_consent: 'essential',
    ...Object.fromEntries(META_ATTRIBUTION_METADATA_KEYS.map((key) => [key, null])),
  };
}
