export const WIFI_FULFILMENT_STATUSES = [
  'awaiting_payment',
  'payment_failed',
  'paid',
  'packing',
  'dispatched',
  'with_customer',
  'return_due',
  'returned',
  'closed',
  'cancelled',
] as const;

export const ESIM_FULFILMENT_STATUSES = [
  'awaiting_payment',
  'payment_failed',
  'awaiting_fulfilment',
  'fulfilled',
  'closed',
  'cancelled',
] as const;

export function isEsimProduct(productType?: string | null) {
  return productType === 'esim';
}

export function validFulfilmentStatus(productType: string | null | undefined, status: string) {
  return (isEsimProduct(productType) ? ESIM_FULFILMENT_STATUSES : WIFI_FULFILMENT_STATUSES).includes(status as never);
}

// Statuses are operational state, not free-form labels. Keeping the permitted
// edges here means the API can prevent an accidental "returned" router before
// it has ever been dispatched, while the admin UI only offers meaningful next
// actions. Stripe's payment webhook is deliberately not subject to this graph:
// it is the payment authority and may promote awaiting_payment to paid.
const WIFI_NEXT: Record<string, readonly string[]> = {
  paid: ['packing', 'dispatched', 'cancelled'],
  packing: ['paid', 'dispatched', 'cancelled'],
  // Cancellation can release a router only before it leaves operations. Once
  // dispatched, it remains committed to the trip until a physical return is
  // recorded; otherwise an operator could accidentally sell the same router
  // to an overlapping booking.
  dispatched: ['packing', 'with_customer', 'return_due', 'returned'],
  with_customer: ['dispatched', 'return_due', 'returned'],
  return_due: ['with_customer', 'returned'],
  // A recorded return is the capacity-release boundary. Reopening it as
  // "with_customer" would silently reserve the router again without a fresh
  // dispatch, delivery reference, or customer hand-off. Correct a mistaken
  // return through an audited operational process instead; the normal order
  // lifecycle may only close a device after physical receipt.
  returned: ['closed'],
};

const ESIM_NEXT: Record<string, readonly string[]> = {
  awaiting_fulfilment: ['fulfilled', 'cancelled'],
  fulfilled: ['awaiting_fulfilment', 'closed', 'cancelled'],
};

export function allowedFulfilmentStatuses(productType: string | null | undefined, current: string) {
  if (!validFulfilmentStatus(productType, current)) return [];
  const transitions = isEsimProduct(productType) ? ESIM_NEXT : WIFI_NEXT;
  return [current, ...(transitions[current] || [])];
}

export function validFulfilmentTransition(productType: string | null | undefined, current: string, next: string) {
  return allowedFulfilmentStatuses(productType, current).includes(next);
}

export function initialFulfilmentStatus(productType: string | null | undefined, paymentStatus: string) {
  if (paymentStatus !== 'paid') return paymentStatus === 'failed' ? 'payment_failed' : 'awaiting_payment';
  return isEsimProduct(productType) ? 'awaiting_fulfilment' : 'paid';
}
