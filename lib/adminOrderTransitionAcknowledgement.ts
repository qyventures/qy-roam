import { databaseTimestampInstantEquals, exactDatabaseTimestampToken } from './stripeClaimToken';

type ExpectedOrderTransition = {
  orderId: number;
  status: string;
  digitalDeliveryReference?: string;
  inventoryItemId?: number;
  courierTracking?: string;
  returnTracking?: string;
  returnDisposition?: string;
  dispatched?: boolean;
  returned?: boolean;
};

/**
 * Treat the transition RPC response as a commit acknowledgement. In
 * particular, an eSIM fulfilment is not complete unless the returned row
 * contains the exact non-secret audit reference that accompanied the digital
 * hand-off. The same rule applies to physical custody: status alone cannot
 * prove that the selected router, tracking evidence, inspection decision and
 * custody timestamp were durably recorded in the atomic inventory transition.
 */
export function acknowledgedOrderTransition(value: unknown, expected: ExpectedOrderTransition) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const order = value as {
    id?: unknown;
    fulfilment_status?: unknown;
    updated_at?: unknown;
    digital_delivery_reference?: unknown;
    inventory_item_id?: unknown;
    courier_tracking?: unknown;
    return_tracking?: unknown;
    return_disposition?: unknown;
    dispatched_at?: unknown;
    returned_at?: unknown;
  };
  const updatedAt = exactDatabaseTimestampToken(order.updated_at);
  if (order.id !== expected.orderId || order.fulfilment_status !== expected.status || !updatedAt) return null;
  if (expected.digitalDeliveryReference !== undefined &&
    order.digital_delivery_reference !== expected.digitalDeliveryReference) return null;
  if (expected.inventoryItemId !== undefined && order.inventory_item_id !== expected.inventoryItemId) return null;
  if (expected.courierTracking !== undefined && order.courier_tracking !== expected.courierTracking) return null;
  if (expected.returnTracking !== undefined && order.return_tracking !== expected.returnTracking) return null;
  if (expected.returnDisposition !== undefined && order.return_disposition !== expected.returnDisposition) return null;
  // Both custody timestamps are written from the same database `v_now` as
  // updated_at by the transition RPC. Requiring the exact represented instant
  // rejects a syntactically valid but stale timestamp from an old/malformed
  // response while preserving PostgreSQL's offset and microsecond formats.
  if (expected.dispatched && !databaseTimestampInstantEquals(order.dispatched_at, updatedAt)) return null;
  if (expected.returned && !databaseTimestampInstantEquals(order.returned_at, updatedAt)) return null;
  return { id: expected.orderId, fulfilment_status: expected.status, updated_at: updatedAt };
}
