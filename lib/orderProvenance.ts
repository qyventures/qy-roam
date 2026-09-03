import crypto from 'crypto';

const VERSION = 'v2';
const METADATA_KEY = 'qyroam_provenance';

function activeSecret() {
  const value = process.env.ORDER_INTEGRITY_SECRET;
  return value && value.length >= 32 ? value : null;
}

// Checkout Sessions can remain payable for a short period and Stripe can retry
// a webhook after an operational key rotation. Accept exactly one prior key
// during that handover, while continuing to issue every new signature with the
// active key. Keeping this to one explicitly named value avoids an unbounded
// collection of old credentials remaining payment authorities indefinitely.
function verificationSecrets() {
  const current = activeSecret();
  if (!current) return [];
  const previous = process.env.ORDER_INTEGRITY_SECRET_PREVIOUS;
  return previous && previous.length >= 32 && previous !== current
    ? [current, previous]
    : [current];
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
  const signingSecret = activeSecret();
  if (!signingSecret) throw new Error('ORDER_INTEGRITY_SECRET is not configured');
  const digest = provenanceDigest(sessionId, metadata, signingSecret);
  return `${VERSION}.${digest}`;
}

function provenanceDigest(sessionId: string, metadata: Record<string, string>, signingSecret: string) {
  return crypto.createHmac('sha256', signingSecret).update(payload(sessionId, metadata)).digest('hex');
}

export function validQyRoamProvenance(sessionId: string, metadata?: Record<string, string> | null) {
  if (!metadata) return false;
  const provided = metadata[METADATA_KEY];
  const match = provided && /^(v2)\.([a-f0-9]{64})$/.exec(provided);
  if (!match) return false;
  try {
    // v1 covered only a product marker and request id, leaving mutable plan
    // and travel metadata outside the integrity boundary. It must never
    // authorize a paid order or inventory hold after v2 is deployed.
    const left = Buffer.from(provided);
    // Evaluate each configured handover key. New sessions are always signed
    // with the active one, but a valid in-flight session signed immediately
    // before rotation remains eligible for fulfilment until the previous key
    // is deliberately removed after Stripe's retry window.
    return verificationSecrets().some((signingSecret) => {
      const expected = `${VERSION}.${provenanceDigest(sessionId, metadata, signingSecret)}`;
      const right = Buffer.from(expected);
      return left.length === right.length && crypto.timingSafeEqual(left, right);
    });
  } catch {
    return false;
  }
}

export const QY_ROAM_PROVENANCE_METADATA_KEY = METADATA_KEY;
