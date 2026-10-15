import { exactRpcRow } from './exactRpcRow';
import { exactDatabaseTimestampToken } from './stripeClaimToken';

export type ExpectedClosingPeriod = {
  periodStart: string;
  periodEnd: string;
  locked: boolean;
  grossSalesCents: number;
  refundsCents: number;
  netSalesCents: number;
  feesCents: number;
  cogsCents: number;
  grossProfitCents: number;
  closedBy: string | null;
  notes: string | null;
};

function exactMoneyCents(value: unknown) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const match = String(value).match(/^(-?)(\d{1,8})(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const magnitude = Number(match[2]) * 100 + Number((match[3] || '').padEnd(2, '0'));
  const cents = match[1] ? -magnitude : magnitude;
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * Verify the exact financial snapshot returned by the atomic period-close RPC
 * before reporting success to an operator. An error-free provider response is
 * not sufficient authority for an irreversible accounting close.
 */
export function acknowledgedClosingPeriod(value: unknown, expected: ExpectedClosingPeriod) {
  const row = exactRpcRow(value);
  if (!row) return null;
  const id = typeof row.id === 'number' && Number.isSafeInteger(row.id) && row.id > 0
    ? row.id
    : null;
  const createdAt = exactDatabaseTimestampToken(row.created_at);
  const updatedAt = exactDatabaseTimestampToken(row.updated_at);
  const closedAt = row.closed_at === null ? null : exactDatabaseTimestampToken(row.closed_at);
  const expectedStatus = expected.locked ? 'closed' : 'open';

  if (id === null || !createdAt || !updatedAt ||
    row.period_start !== expected.periodStart || row.period_end !== expected.periodEnd ||
    row.status !== expectedStatus ||
    exactMoneyCents(row.gross_sales_sgd) !== expected.grossSalesCents ||
    exactMoneyCents(row.refunds_sgd) !== expected.refundsCents ||
    exactMoneyCents(row.net_sales_sgd) !== expected.netSalesCents ||
    exactMoneyCents(row.fees_sgd) !== expected.feesCents ||
    exactMoneyCents(row.cogs_sgd) !== expected.cogsCents ||
    exactMoneyCents(row.gross_profit_sgd) !== expected.grossProfitCents ||
    row.closed_by !== expected.closedBy || row.notes !== expected.notes ||
    (expected.locked ? !closedAt : closedAt !== null)) {
    return null;
  }
  return { id, status: expectedStatus, created_at: createdAt, updated_at: updatedAt, closed_at: closedAt };
}
