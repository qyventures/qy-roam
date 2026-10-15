import { exactRpcRow } from './exactRpcRow';
import { exactDatabaseTimestampToken } from './stripeClaimToken';

type ExpectedInventoryMutation = {
  id?: number;
  sku?: string;
  status?: string;
  quantityOnHand?: number;
};

/**
 * Verify the single inventory row returned by an atomic stock RPC.
 *
 * An error-free PostgREST response only proves that the request completed; it
 * does not prove that the response identifies the item and state the operator
 * intended to change. Keep that acknowledgement exact before the admin UI
 * reports a physical-stock mutation as saved.
 */
export function acknowledgedInventoryMutation(
  value: unknown,
  expected: ExpectedInventoryMutation,
) {
  const row = exactRpcRow(value);
  if (!row) return null;
  const id = typeof row.id === 'number' && Number.isSafeInteger(row.id) && row.id > 0
    ? row.id
    : null;
  const quantityOnHand = typeof row.quantity_on_hand === 'number' &&
    Number.isSafeInteger(row.quantity_on_hand) && row.quantity_on_hand >= 0 &&
    row.quantity_on_hand <= 1_000_000
    ? row.quantity_on_hand
    : null;
  const updatedAt = exactDatabaseTimestampToken(row.updated_at);
  if (id === null || quantityOnHand === null || !updatedAt) return null;
  if (expected.id !== undefined && id !== expected.id) return null;
  if (expected.sku !== undefined && row.sku !== expected.sku) return null;
  if (expected.status !== undefined && row.status !== expected.status) return null;
  if (expected.quantityOnHand !== undefined && quantityOnHand !== expected.quantityOnHand) return null;
  return { id, quantity_on_hand: quantityOnHand, updated_at: updatedAt };
}
