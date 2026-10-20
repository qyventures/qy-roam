import {
  QY_ROAM_PROVENANCE_METADATA_KEY,
  signedQyRoamProvenance,
} from './orderProvenance';
import {
  META_ATTRIBUTION_METADATA_KEYS,
  stripeMeasurementConsentDowngrade,
} from './stripeMeasurementConsent';

// Revoking optional measurement changes metadata covered by the order HMAC.
// Return one Stripe update that both removes the optional identifiers and
// replaces the signature. A two-call scrub/re-sign sequence creates a short
// interval in which a legitimate payment event carries an obsolete signature
// and is therefore (correctly) rejected by the fulfilment webhook.
export function signedStripeMeasurementConsentDowngrade(
  sessionId: string,
  metadata: Record<string, string> | null | undefined,
  measurementConsent: unknown,
): Record<string, string | null> | null {
  const downgrade = stripeMeasurementConsentDowngrade(metadata, measurementConsent);
  if (!downgrade || !metadata) return null;

  // Preserve the dynamic Stripe metadata map type after overriding consent.
  // Without the annotation TypeScript narrows this object to only the known
  // consent property, which rejects the deliberate attribution-key deletes
  // and provenance re-signing during a production build.
  const narrowedMetadata: Record<string, string> = {
    ...metadata,
    measurement_consent: 'essential',
  };
  for (const key of META_ATTRIBUTION_METADATA_KEYS) delete narrowedMetadata[key];
  narrowedMetadata[QY_ROAM_PROVENANCE_METADATA_KEY] = signedQyRoamProvenance(
    sessionId,
    narrowedMetadata,
  );

  return {
    ...downgrade,
    [QY_ROAM_PROVENANCE_METADATA_KEY]: narrowedMetadata[QY_ROAM_PROVENANCE_METADATA_KEY],
  };
}
