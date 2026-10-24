import { databaseTimestampInstantIsAtOrAfter, exactStripeClaimToken } from './stripeClaimToken';

type StripeEventSettlementRow = {
  event_id?: unknown;
  processing_started_at?: unknown;
  processed_at?: unknown;
  last_error?: unknown;
};

/** Prove that the exact webhook lease was durably and coherently settled. */
export function acknowledgedStripeEventSettlement(
  value: unknown,
  eventId: string,
  processingStartedAt: string,
) {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const row = value[0] as StripeEventSettlementRow | null;
  return Boolean(row) &&
    row?.event_id === eventId &&
    exactStripeClaimToken(row?.processing_started_at) === processingStartedAt &&
    databaseTimestampInstantIsAtOrAfter(row?.processed_at, processingStartedAt) &&
    row?.last_error === null;
}
