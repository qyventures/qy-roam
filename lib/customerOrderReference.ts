import crypto from 'crypto';

// Give customers and operations one compact lookup value without displaying
// the Stripe Checkout Session id, which is also the capability used to open
// the customer status page. This is an identifier, not an authentication
// token: the admin still requires Basic Auth and customer pages still require
// the complete, validated Stripe Session id in their URL.
export function customerOrderReference(value: unknown) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(value)) return null;

  const digest = crypto.createHash('sha256').update(`qyroam-order-reference:${value}`).digest('hex').slice(0, 12).toUpperCase();
  return `QYR-${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`;
}
