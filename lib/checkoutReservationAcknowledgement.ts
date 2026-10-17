type CheckoutReservationRow = {
  checkout_request_id?: unknown;
  stripe_session_id?: unknown;
};

// A newly acquired, still-unlinked reservation is owned exclusively by the
// checkout request that created it. Cleanup is successful only when Supabase
// returns that one exact row; an empty or ambiguous response could otherwise
// leave scarce inventory held while the customer is told the attempt ended.
export function acknowledgedUnlinkedReservationRelease(
  value: unknown,
  checkoutRequestId: string,
) {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const row = value[0] as CheckoutReservationRow | null;
  return row !== null &&
    typeof row === 'object' &&
    row.checkout_request_id === checkoutRequestId &&
    row.stripe_session_id === null;
}

// A terminal Checkout Session may already have been cleaned up by its signed
// webhook before the browser retries. Accept that idempotent empty result, or
// one exact row owned by this request and Session. Paid recovery deliberately
// does not accept an unlinked row: it could belong to a newer attempt.
export function acknowledgedLinkedReservationRelease(
  value: unknown,
  checkoutRequestId: string,
  stripeSessionId: string,
) {
  if (!Array.isArray(value) || value.length > 1) return false;
  if (value.length === 0) return true;
  const row = value[0] as CheckoutReservationRow | null;
  return row !== null &&
    typeof row === 'object' &&
    row.checkout_request_id === checkoutRequestId &&
    row.stripe_session_id === stripeSessionId;
}

// An expired Session is no longer payable, so recovery may safely remove its
// exact linked reservation or an unlinked retry reservation with the same
// durable browser identity. As above, zero rows is a valid idempotent replay.
export function acknowledgedExpiredCheckoutReservationRelease(
  value: unknown,
  checkoutRequestId: string,
  stripeSessionId: string,
) {
  if (!Array.isArray(value) || value.length > 1) return false;
  if (value.length === 0) return true;
  const row = value[0] as CheckoutReservationRow | null;
  return row !== null &&
    typeof row === 'object' &&
    row.checkout_request_id === checkoutRequestId &&
    (row.stripe_session_id === null || row.stripe_session_id === stripeSessionId);
}
