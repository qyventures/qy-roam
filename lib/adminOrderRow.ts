import { exactDatabaseTimestampToken } from './stripeClaimToken';
import { validFulfilmentStatus } from './orderLifecycle';
import { validStripeCheckoutSessionId } from './stripeSessionId';

const MANUAL_ORDER_ID = /^manual_[a-f0-9]{48}$/;

function positiveInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nullablePositiveInteger(value: unknown) {
  return value === null || positiveInteger(value);
}

function nullableBoundedText(value: unknown, maximum: number) {
  return value === null || (typeof value === 'string' && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value));
}

/**
 * The dashboard deliberately keeps legacy rows visible for reconciliation,
 * but mutation controls are a stronger boundary than display. Validate every
 * value copied into AdminOrderActions before the browser can turn a malformed
 * PostgREST row into an order-transition or delivery-retry request.
 */
export function adminOrderMutationSafe(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const sessionId = typeof row.stripe_session_id === 'string' &&
    (validStripeCheckoutSessionId(row.stripe_session_id) || MANUAL_ORDER_ID.test(row.stripe_session_id));

  return positiveInteger(row.id) &&
    Boolean(sessionId) &&
    (row.payment_status === 'paid' || row.payment_status === 'unpaid') &&
    typeof row.product_type === 'string' &&
    typeof row.fulfilment_status === 'string' &&
    validFulfilmentStatus(row.product_type, row.fulfilment_status) &&
    Boolean(exactDatabaseTimestampToken(row.updated_at)) &&
    nullablePositiveInteger(row.inventory_item_id) &&
    nullableBoundedText(row.courier_tracking, 200) &&
    nullableBoundedText(row.return_tracking, 200) &&
    nullableBoundedText(row.digital_delivery_reference, 200) &&
    (row.return_disposition === null || ['restock', 'quarantine', 'damaged'].includes(String(row.return_disposition)));
}
