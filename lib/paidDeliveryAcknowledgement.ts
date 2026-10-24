import { exactRpcRow } from './exactRpcRow';
import { databaseTimestampInstantEquals, exactDatabaseTimestampToken } from './stripeClaimToken';

type DeliveryClaim = {
  stripe_session_id?: unknown;
  status?: unknown;
  updated_at?: unknown;
  event_time?: unknown;
};

export function acknowledgedPaidDeliveryClaim(
  data: unknown,
  expectedSessionId: string,
  expectedEventTime?: number,
) {
  const row = exactRpcRow(data) as DeliveryClaim | null;
  const claimToken = exactDatabaseTimestampToken(row?.updated_at);
  if (!row || row.stripe_session_id !== expectedSessionId || row.status !== 'sending' || !claimToken) {
    return null;
  }
  if (expectedEventTime !== undefined &&
    (!Number.isSafeInteger(row.event_time) || row.event_time !== expectedEventTime)) {
    return null;
  }
  return { claimToken, eventTime: expectedEventTime };
}

export function acknowledgedPaidDeliverySettlement(
  data: unknown,
  expectedSessionId: string,
) {
  const row = exactRpcRow(data) as DeliveryClaim & { sent_at?: unknown } | null;
  const sentAt = exactDatabaseTimestampToken(row?.sent_at);
  const updatedAt = exactDatabaseTimestampToken(row?.updated_at);
  return Boolean(
    row &&
    row.stripe_session_id === expectedSessionId &&
    row.status === 'sent' &&
    sentAt && updatedAt && databaseTimestampInstantEquals(sentAt, updatedAt)
  );
}

export function acknowledgedPaidDeliveryFailure(
  data: unknown,
  expectedSessionId: string,
  expectedError: string,
) {
  const row = exactRpcRow(data) as DeliveryClaim & { last_error?: unknown } | null;
  return Boolean(
    row &&
    row.stripe_session_id === expectedSessionId &&
    row.status === 'pending' &&
    row.last_error === expectedError &&
    exactDatabaseTimestampToken(row.updated_at)
  );
}
