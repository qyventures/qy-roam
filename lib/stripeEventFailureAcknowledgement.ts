import { databaseTimestampInstantEquals, exactStripeClaimToken } from './stripeClaimToken';

type StripeEventFailureRow = {
  event_id?: unknown;
  processing_started_at?: unknown;
  processed_at?: unknown;
  last_failed_at?: unknown;
  last_error?: unknown;
};

/**
 * Prove that the recovery write belongs to the exact webhook claim that
 * failed. PostgREST responses are runtime data, and merely receiving one row
 * must not make a mismatched or incomplete acknowledgement look durable.
 */
export function acknowledgedStripeEventFailure(
  value: unknown,
  eventId: string,
  processingStartedAt: string,
  failedAt: string,
  message: string,
) {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const row = value[0] as StripeEventFailureRow | null;
  return Boolean(row) &&
    row?.event_id === eventId &&
    exactStripeClaimToken(row?.processing_started_at) === processingStartedAt &&
    row?.processed_at === null &&
    databaseTimestampInstantEquals(row?.last_failed_at, failedAt) &&
    row?.last_error === message;
}
