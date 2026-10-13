import type Stripe from 'stripe';
import { isSafeSmtpMailbox } from './smtp';

export type PaidFulfilmentProductType = 'esim' | 'pocket_wifi';

function normalizedPhone(value?: string | null) {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

function validSingaporePostalCode(value?: string | null) {
  // Singapore delivery postcodes are exactly six digits. Stripe asks for an
  // SG shipping address, but its Checkout object remains external input at
  // this boundary; a merely non-empty value can still leave operations with
  // a paid router order that the courier cannot route.
  return typeof value === 'string' && /^\d{6}$/.test(value.trim());
}

const MAX_DELIVERY_ADDRESS_FIELD_LENGTH = 200;

function safeDeliveryAddressField(value: string | null | undefined, required = false) {
  if (value === null || value === undefined) return !required;
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  return (!required || normalized.length > 0) &&
    normalized.length <= MAX_DELIVERY_ADDRESS_FIELD_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(normalized);
}

// Stripe Checkout normally guarantees the fields requested when the Session
// was created, but the signed completion event is the final hand-off into
// operations. Keep this boundary executable in isolation so both webhook and
// protected admin-recovery paths reject an undeliverable paid order in exactly
// the same way.
export function paidFulfilmentDetailsIssue(
  session: Pick<Stripe.Checkout.Session, 'payment_status' | 'customer_details' | 'shipping_details'>,
  productType: PaidFulfilmentProductType,
) {
  if (session.payment_status !== 'paid') return null;

  const email = session.customer_details?.email?.trim();
  if (!isSafeSmtpMailbox(email)) return 'Paid order is missing a valid customer email';
  if (productType === 'esim') return null;

  if (!normalizedPhone(session.customer_details?.phone)) {
    return 'Paid Pocket WiFi order is missing a valid customer phone number';
  }
  const shipping = session.shipping_details?.address;
  // Stripe normally applies its own address limits, but the refreshed
  // Checkout object is still external runtime data. These values are copied
  // into both the durable order and the human fulfilment message, so reject
  // control characters and unbounded fields instead of persisting ambiguous
  // multi-line courier instructions or oversized operational records.
  if (shipping?.country !== 'SG' ||
    !safeDeliveryAddressField(shipping.line1, true) ||
    !safeDeliveryAddressField(shipping.line2) ||
    !safeDeliveryAddressField(shipping.city) ||
    !safeDeliveryAddressField(shipping.state) ||
    !validSingaporePostalCode(shipping.postal_code)) {
    return 'Paid Pocket WiFi order is missing a complete Singapore delivery address';
  }
  return null;
}
