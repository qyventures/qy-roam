import crypto from 'crypto';

const VERSION = 'v2';
const LEGACY_VERSION = 'v1';
const METADATA_KEY = 'qyroam_provenance';

function secret() {
  const value = process.env.ORDER_INTEGRITY_SECRET;
  return value && value.length >= 32 ? value : null;
}

function legacyPayload(sessionId: string, metadata: Record<string, string>) {
  return [LEGACY_VERSION, sessionId, metadata.source || '', metadata.product_type || '', metadata.checkout_request_id || ''].join('|');
}

function payload(sessionId: string, metadata: Record<string, string>) {
  // Checkout Session metadata remains mutable through Stripe's API. Bind every
  // server-authored metadata field (rather than only the product marker and
  // request id) so a party with access to a shared Stripe account cannot alter
  // travel dates, a plan, or a price-related field after session creation.
  // Exclude the signature itself to make repeat signing stable.
  const fields = Object.keys(metadata)
    .filter((key) => key !== METADATA_KEY)
    .sort()
    .map((key) => [key, metadata[key]]);
  return JSON.stringify([VERSION, sessionId, fields]);
}

/**
 * Bind a Checkout Session to this application after Stripe has assigned its
 * immutable session id. Catalogue validation alone cannot distinguish a
 * lookalike session manually created in a shared Stripe account.
 */
export function signedQyRoamProvenance(sessionId: string, metadata: Record<string, string>) {
  const signingSecret = secret();
  if (!signingSecret) throw new Error('ORDER_INTEGRITY_SECRET is not configured');
  const digest = crypto.createHmac('sha256', signingSecret).update(payload(sessionId, metadata)).digest('hex');
  return `${VERSION}.${digest}`;
}

export function validQyRoamProvenance(sessionId: string, metadata?: Record<string, string> | null) {
  if (!metadata) return false;
  const provided = metadata[METADATA_KEY];
  const match = provided && /^(v[12])\.([a-f0-9]{64})$/.exec(provided);
  if (!match) return false;
  try {
    // Preserve verification of sessions issued before v2 during rollout. New
    // sessions are always v2; v1 support can be removed after the historical
    // order-status and Stripe retry window is no longer needed.
    const signingSecret = secret();
    if (!signingSecret) return false;
    const expected = match[1] === LEGACY_VERSION
      ? `${LEGACY_VERSION}.${crypto.createHmac('sha256', signingSecret).update(legacyPayload(sessionId, metadata)).digest('hex')}`
      : signedQyRoamProvenance(sessionId, metadata);
    const left = Buffer.from(provided), right = Buffer.from(expected);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export const QY_ROAM_PROVENANCE_METADATA_KEY = METADATA_KEY;
