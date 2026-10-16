export type InventoryMutationFailure = {
  status: 404 | 409;
  message: string;
};

// Inventory RPC errors can describe an expected operational conflict, but
// arbitrary database/provider text must never be reflected to an admin
// browser. Keep this allow-list tied to application-authored PL/pgSQL errors.
export function inventoryMutationFailure(error: unknown): InventoryMutationFailure | null {
  const message = typeof error === 'object' && error !== null && 'message' in error &&
    typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : '';

  if (/inventory item not found/i.test(message)) {
    return { status: 404, message: 'Inventory item not found. Refresh the stock register before retrying.' };
  }
  if (/inventory operation identity already belongs to different/i.test(message)) {
    return { status: 409, message: 'This stock operation was already used with different details. Refresh the stock register and confirm the saved movement before trying again.' };
  }
  if (/inventory operation no longer matches current status/i.test(message)) {
    return { status: 409, message: 'This device status changed after the operation was submitted. Refresh the stock register before making another change.' };
  }
  if (/inventory item is assigned to an active Pocket WiFi custody order/i.test(message)) {
    return { status: 409, message: 'This device is assigned to an active Pocket WiFi order. Reconcile its dispatch or return before changing stock.' };
  }
  if (/inventory quantity is out of range/i.test(message)) {
    return { status: 409, message: 'This movement would make the recorded stock quantity invalid. Refresh the stock register and reconcile the physical count.' };
  }
  return null;
}
