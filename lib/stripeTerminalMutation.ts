type ReleasedReservation = {
  checkout_request_id?: unknown;
  stripe_session_id?: unknown;
};

type ClosedOrder = {
  stripe_session_id?: unknown;
  fulfilment_status?: unknown;
};

// Stripe terminal events are idempotent: the target may already have been
// removed or transitioned by an earlier delivery. A mutation acknowledgement
// is therefore valid when it returns no row, or exactly the row this event was
// authorised to change. Reject every other shape before acknowledging Stripe.
export function acknowledgedExpiredReservationRelease(
  value: unknown,
  checkoutRequestId: string,
  stripeSessionId: string,
) {
  if (!Array.isArray(value) || value.length > 1) return false;
  if (value.length === 0) return true;
  const row = value[0] as ReleasedReservation | null;
  return row !== null &&
    typeof row === 'object' &&
    row.checkout_request_id === checkoutRequestId &&
    (row.stripe_session_id === null || row.stripe_session_id === stripeSessionId);
}

export function acknowledgedExpiredOrderClosure(value: unknown, stripeSessionId: string) {
  if (!Array.isArray(value) || value.length > 1) return false;
  if (value.length === 0) return true;
  const row = value[0] as ClosedOrder | null;
  return row !== null &&
    typeof row === 'object' &&
    row.stripe_session_id === stripeSessionId &&
    row.fulfilment_status === 'payment_failed';
}
