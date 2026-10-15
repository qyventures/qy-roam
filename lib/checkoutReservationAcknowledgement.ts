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
