import { exactRpcRow } from './exactRpcRow';
import { exactDatabaseTimestampToken } from './stripeClaimToken';

export type ExpectedManualOrder = {
  stripeSessionId: string;
  productType: 'pocket_wifi' | 'esim';
  fulfilmentStatus: string;
  amountCents: number;
  customerName: string | null;
  email: string | null;
  phone: string | null;
  planId: string | null;
  planName: string | null;
  dataAllowance: string | null;
  country: string | null;
  travelStart: string | null;
  travelEnd: string | null;
  notes: string;
};

function orderAmountCents(value: unknown) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) return null;
  const match = String(value).match(/^(\d{1,8})(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/**
 * Verify the complete commercial identity returned by an atomic manual-sale
 * RPC before the admin UI reports that a paid order was saved.
 *
 * An error-free PostgREST response is not a commit acknowledgement: an older
 * function, response-shape drift, or gateway anomaly can still return no row
 * or the wrong row. Manual eSIM creation grants a digital entitlement and a
 * Pocket WiFi sale consumes scarce dated capacity, so both require the same
 * exact durable-order boundary.
 */
export function acknowledgedManualOrder(value: unknown, expected: ExpectedManualOrder) {
  const row = exactRpcRow(value);
  if (!row) return null;
  const id = typeof row.id === 'number' && Number.isSafeInteger(row.id) && row.id > 0
    ? row.id
    : null;
  const paymentConfirmedAt = exactDatabaseTimestampToken(row.payment_confirmed_at);
  const updatedAt = exactDatabaseTimestampToken(row.updated_at);
  if (id === null || !paymentConfirmedAt || !updatedAt ||
    row.stripe_session_id !== expected.stripeSessionId ||
    row.payment_status !== 'paid' ||
    row.product_type !== expected.productType ||
    row.fulfilment_status !== expected.fulfilmentStatus ||
    row.measurement_consent !== 'essential' ||
    orderAmountCents(row.amount_sgd) !== expected.amountCents ||
    row.customer_name !== expected.customerName ||
    row.email !== expected.email || row.phone !== expected.phone ||
    row.plan_id !== expected.planId || row.plan_name !== expected.planName ||
    row.data_allowance !== expected.dataAllowance || row.country !== expected.country ||
    row.travel_start !== expected.travelStart || row.travel_end !== expected.travelEnd ||
    row.notes !== expected.notes) {
    return null;
  }
  return { id, payment_confirmed_at: paymentConfirmedAt, updated_at: updatedAt };
}
