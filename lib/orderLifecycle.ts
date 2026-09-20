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

// Stripe webhook workers use a durable processing lease. Keep the duration in
// one dependency-free module so recovery and the operations dashboard agree
// about when an unfinished claim is abandoned rather than still in flight.
export const STRIPE_EVENT_CLAIM_STALE_MS = 30 * 60_000;
export const STRIPE_EVENT_CLAIM_CLOCK_SKEW_MS = 60_000;

/**
 * Only a recent, well-formed lease with no recorded failure is still owned by
 * another webhook worker. Missing/invalid timestamps must be recoverable, and
 * a timestamp too far in the future must not block an order indefinitely when
 * a host clock or manually repaired row is wrong.
 */
export function stripeEventClaimInProgress(
  processingStartedAt: string | null | undefined,
  lastError: string | null | undefined,
  nowMs = Date.now(),
) {
  if (lastError) return false;
  const startedAtMs = processingStartedAt ? new Date(processingStartedAt).getTime() : Number.NaN;
  if (!Number.isFinite(startedAtMs)) return false;
  const ageMs = nowMs - startedAtMs;
  return ageMs >= -STRIPE_EVENT_CLAIM_CLOCK_SKEW_MS && ageMs <= STRIPE_EVENT_CLAIM_STALE_MS;
}

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
  // Dispatch is a physical, audited boundary. Never move an order back to a
  // pre-dispatch state: doing so would expose `cancelled` on the next step and
  // strand the checked-out device outside the return workflow.
  dispatched: ['with_customer', 'return_due', 'returned'],
  with_customer: ['return_due', 'returned'],
  return_due: ['returned'],
  // A recorded return is the capacity-release boundary. Reopening it as
  // "with_customer" would silently reserve the router again without a fresh
  // dispatch, delivery reference, or customer hand-off. Correct a mistaken
  // return through an audited operational process instead; the normal order
  // lifecycle may only close a device after physical receipt.
  returned: ['closed'],
};

const ESIM_NEXT: Record<string, readonly string[]> = {
  awaiting_fulfilment: ['fulfilled', 'cancelled'],
  // Sending the QR code / activation instructions is the irreversible digital
  // hand-off. Reopening the order can cause a second fulfilment, while
  // cancelling it would falsely imply that delivered access was withdrawn.
  // Corrections after delivery belong in the support/refund record; the
  // normal fulfilment lifecycle may only close the completed order.
  fulfilled: ['closed'],
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

/**
 * A fulfilment notification tells staff to take an outbound action. It is not
 * a general order-history email, so recovery must never revive a cancelled,
 * returned, or already-completed order just because its earlier SMTP attempt
 * was interrupted. Keep this rule shared by the protected recovery endpoint
 * and the admin exception view.
 */
export function fulfilmentNotificationActionable(productType: string | null | undefined, status: string | null | undefined) {
  if (isEsimProduct(productType)) return status === 'awaiting_fulfilment';
  return status === 'paid' || status === 'packing';
}
