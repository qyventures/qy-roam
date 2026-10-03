import crypto from 'crypto';

const VERSION = 'v2';
const METADATA_KEY = 'qyroam_provenance';
const MIN_SIGNING_SECRET_LENGTH = 32;
const MAX_SIGNING_SECRET_LENGTH = 4_096;
const MAX_STRIPE_METADATA_FIELDS = 50;
const MAX_STRIPE_METADATA_KEY_LENGTH = 40;
const MAX_STRIPE_METADATA_VALUE_LENGTH = 500;

// Stripe metadata is a bounded string-to-string map. SDK types express that
// shape at compile time, but webhook and API responses are runtime data. Keep
// malformed values out of HMAC serialization so provenance verification stays
// a small, deterministic payment boundary and cannot authenticate a shape the
// downstream order validators do not understand.
export function isCanonicalStripeMetadata(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = Object.entries(descriptors);
  return entries.length <= MAX_STRIPE_METADATA_FIELDS && entries.every(([key, descriptor]) =>
    key.length >= 1 && key.length <= MAX_STRIPE_METADATA_KEY_LENGTH &&
    !key.includes('[') && !key.includes(']') &&
    'value' in descriptor &&
    typeof descriptor.value === 'string' && descriptor.value.length <= MAX_STRIPE_METADATA_VALUE_LENGTH
  );
}

// These values are used as HMAC keys at the payment boundary. Keep the
// configuration check shared by checkout, webhook verification and release
// readiness: a malformed previous rotation key must stop new payment links
// before it can make an in-flight order impossible to verify after payment.
// Do not trim a key here; whitespace can be a deliberate part of an HMAC key
// and changing it would invalidate still-payable Checkout Sessions.
export function hasOrderIntegritySecret(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= MIN_SIGNING_SECRET_LENGTH &&
    value.length <= MAX_SIGNING_SECRET_LENGTH &&
    !/[\x00-\x1f\x7f]/.test(value);
}

export function hasOrderIntegritySigningConfig() {
  const current = process.env.ORDER_INTEGRITY_SECRET;
  const previous = process.env.ORDER_INTEGRITY_SECRET_PREVIOUS;
  return hasOrderIntegritySecret(current) &&
    (!previous || hasOrderIntegritySecret(previous));
}

function activeSecret() {
  const value = process.env.ORDER_INTEGRITY_SECRET;
  return hasOrderIntegritySecret(value) ? value : null;
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
  return hasOrderIntegritySecret(previous) && previous !== current
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
  if (!isCanonicalStripeMetadata(metadata)) throw new Error('Checkout metadata is not canonical Stripe metadata');
  // The signature is stored as one more Stripe metadata field. Refuse to sign
  // an unsigned map that has already consumed all 50 fields: Stripe would
  // reject the update, while the create response would look locally signed
  // but could never become a webhook-verifiable Checkout Session.
  if (!(METADATA_KEY in metadata) && Object.keys(metadata).length >= MAX_STRIPE_METADATA_FIELDS) {
    throw new Error('Checkout metadata has no capacity for provenance');
  }
  const digest = provenanceDigest(sessionId, metadata, signingSecret);
  return `${VERSION}.${digest}`;
}

function provenanceDigest(sessionId: string, metadata: Record<string, string>, signingSecret: string) {
  return crypto.createHmac('sha256', signingSecret).update(payload(sessionId, metadata)).digest('hex');
}

export function validQyRoamProvenance(sessionId: string, metadata?: Record<string, string> | null) {
  if (!isCanonicalStripeMetadata(metadata)) return false;
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
