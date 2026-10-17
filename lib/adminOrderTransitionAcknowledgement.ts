import { exactDatabaseTimestampToken } from './stripeClaimToken';

type ExpectedOrderTransition = {
  orderId: number;
  status: string;
  digitalDeliveryReference?: string;
};

/**
 * Treat the transition RPC response as a commit acknowledgement. In
 * particular, an eSIM fulfilment is not complete unless the returned row
 * contains the exact non-secret audit reference that accompanied the digital
 * hand-off; status alone cannot prove that evidence was durably recorded.
 */
export function acknowledgedOrderTransition(value: unknown, expected: ExpectedOrderTransition) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const order = value as {
    id?: unknown;
    fulfilment_status?: unknown;
    updated_at?: unknown;
    digital_delivery_reference?: unknown;
  };
  const updatedAt = exactDatabaseTimestampToken(order.updated_at);
  if (order.id !== expected.orderId || order.fulfilment_status !== expected.status || !updatedAt) return null;
  if (expected.digitalDeliveryReference !== undefined &&
    order.digital_delivery_reference !== expected.digitalDeliveryReference) return null;
  return { id: expected.orderId, fulfilment_status: expected.status, updated_at: updatedAt };
}
