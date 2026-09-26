import type Stripe from 'stripe';
import { isSafeSmtpMailbox } from './smtp';

export type PaidFulfilmentProductType = 'esim' | 'pocket_wifi';

function normalizedPhone(value?: string | null) {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
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
  if (shipping?.country !== 'SG' || !shipping.line1?.trim() || !shipping.postal_code?.trim()) {
    return 'Paid Pocket WiFi order is missing a complete Singapore delivery address';
  }
  return null;
}
