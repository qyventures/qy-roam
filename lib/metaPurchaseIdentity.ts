import crypto from 'crypto';
import { validStripeCheckoutSessionId } from './stripeSessionId';

// Meta needs one stable identity to deduplicate the browser Pixel and CAPI
// copies of a Purchase. A Checkout Session id is also the capability used by
// QY Roam's customer confirmation pages, so it must not be disclosed to an
// advertising provider as either event_id or order_id. Derive a one-way,
// domain-separated identifier instead.
export function metaPurchaseIdentity(sessionId: unknown) {
  const validSessionId = validStripeCheckoutSessionId(sessionId);
  if (!validSessionId) return null;
  const digest = crypto
    .createHash('sha256')
    .update('qy-roam-meta-purchase\0', 'utf8')
    .update(validSessionId, 'utf8')
    .digest('hex');
  return `qyr_purchase_${digest}`;
}
