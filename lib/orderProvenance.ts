import crypto from 'crypto';

const VERSION = 'v1';
const METADATA_KEY = 'qyroam_provenance';

function secret() {
  const value = process.env.ORDER_INTEGRITY_SECRET;
  return value && value.length >= 32 ? value : null;
}

function payload(sessionId: string, metadata: Record<string, string>) {
  return [VERSION, sessionId, metadata.source || '', metadata.product_type || '', metadata.checkout_request_id || ''].join('|');
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
  if (!provided || !/^[a-z0-9]+\.[a-f0-9]{64}$/.test(provided)) return false;
  try {
    const expected = signedQyRoamProvenance(sessionId, metadata);
    const left = Buffer.from(provided), right = Buffer.from(expected);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export const QY_ROAM_PROVENANCE_METADATA_KEY = METADATA_KEY;
