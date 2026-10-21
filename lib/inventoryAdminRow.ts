import { validCheckoutRequestId } from './checkoutValidation';
import { validStripeCheckoutSessionId } from './stripeSessionId';

const ITEM_STATUSES = new Set(['available', 'quarantined', 'damaged', 'maintenance']);
const PRODUCT_TYPES = new Set(['pocket_wifi', 'esim']);
const MOVEMENT_TYPES = new Set(['opening_stock', 'adjustment', 'purchase', 'write_off', 'dispatch', 'return', 'return_quarantined', 'return_damaged', 'status_change']);
const ACTIVE_CUSTODY_STATUSES = new Set(['dispatched', 'with_customer', 'return_due']);
const MAX_INVENTORY_QUANTITY = 1_000_000;
const MAX_INVENTORY_UNIT_COST_CENTS = 10_000_000;

function positiveInteger(value: unknown) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function nonNegativeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : null;
}
function exactMoneyCents(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(text)) return null;
  const [dollars, fraction = ''] = text.split('.');
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents <= MAX_INVENTORY_UNIT_COST_CENTS ? cents : null;
}
function exactTimestamp(value: unknown) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const instant = Date.parse(value);
  const year = new Date(instant).getUTCFullYear();
  return Number.isFinite(instant) && year >= 2000 && year <= 2200 ? value : null;
}
function exactDate(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

export function validatedInventoryItem(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = positiveInteger(row.id), quantity = nonNegativeInteger(row.quantity_on_hand, MAX_INVENTORY_QUANTITY), reorder = nonNegativeInteger(row.reorder_level, MAX_INVENTORY_QUANTITY), unitCostCents = exactMoneyCents(row.unit_cost_sgd);
  if (id === null || quantity === null || reorder === null || unitCostCents === null || typeof row.sku !== 'string' || !row.sku.trim() || row.sku.length > 80 || typeof row.name !== 'string' || !row.name.trim() || typeof row.product_type !== 'string' || !PRODUCT_TYPES.has(row.product_type) || typeof row.status !== 'string' || !ITEM_STATUSES.has(row.status)) return null;
  const productType = row.product_type, status = row.status;
  const name = row.name, sku = row.sku;
  return { ...row, id, sku, name, product_type: productType, status, quantity_on_hand: quantity, reorder_level: reorder, unit_cost_cents: unitCostCents };
}

export function validatedInventoryMovement(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = positiveInteger(row.id), inventoryItemId = positiveInteger(row.inventory_item_id);
  const quantity = typeof row.quantity === 'number' ? row.quantity : typeof row.quantity === 'string' && /^-?(?:0|[1-9]\d*)$/.test(row.quantity) ? Number(row.quantity) : NaN;
  const createdAt = exactTimestamp(row.created_at);
  if (id === null || inventoryItemId === null || !Number.isSafeInteger(quantity) || createdAt === null || typeof row.movement_type !== 'string' || !MOVEMENT_TYPES.has(row.movement_type)) return null;
  const quantityMatchesType = row.movement_type === 'opening_stock' || row.movement_type === 'purchase' ? quantity > 0 :
    row.movement_type === 'adjustment' ? quantity !== 0 : row.movement_type === 'write_off' ? quantity < 0 :
    row.movement_type === 'dispatch' ? quantity === -1 : row.movement_type === 'return' ? quantity === 1 : quantity === 0;
  if (!quantityMatchesType) return null;
  return { ...row, id, inventory_item_id: inventoryItemId, quantity, created_at: createdAt };
}

export function validatedCheckoutReservation(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const requestId = validCheckoutRequestId(row.checkout_request_id);
  const sessionId = row.stripe_session_id === null ? null : validStripeCheckoutSessionId(row.stripe_session_id);
  const start = exactDate(row.travel_start), end = exactDate(row.travel_end), expiresAt = exactTimestamp(row.expires_at), createdAt = exactTimestamp(row.created_at);
  const rentalDays = start && end ? (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 + 1 : 0;
  // Checkout creates a reservation for the same bounded payment window as
  // the Stripe Session. Reject a corrupt direct write that would make the
  // operations screen present a pre-expired or effectively permanent hold as
  // valid capacity evidence. The database enforces this for new writes; this
  // check keeps older NOT VALID exceptions visibly unavailable as well.
  const holdLifetimeMs = expiresAt && createdAt ? Date.parse(expiresAt) - Date.parse(createdAt) : 0;
  if (!requestId || (row.stripe_session_id !== null && !sessionId) || !start || !end || rentalDays < 1 || rentalDays > 90 || !expiresAt || !createdAt || holdLifetimeMs <= 0 || holdLifetimeMs > 37 * 60_000) return null;
  return { ...row, checkout_request_id: requestId, stripe_session_id: sessionId, travel_start: start, travel_end: end, expires_at: expiresAt, created_at: createdAt };
}

export function validatedInventoryCustodyOrder(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = positiveInteger(row.id);
  const inventoryItemId = row.inventory_item_id === null ? null : positiveInteger(row.inventory_item_id);
  const travelEnd = exactDate(row.travel_end);
  const dispatchedAt = exactTimestamp(row.dispatched_at);
  if (
    id === null ||
    (row.inventory_item_id !== null && inventoryItemId === null) ||
    typeof row.fulfilment_status !== 'string' ||
    !ACTIVE_CUSTODY_STATUSES.has(row.fulfilment_status) ||
    typeof row.stripe_session_id !== 'string' ||
    !row.stripe_session_id ||
    row.stripe_session_id.length > 255 ||
    (row.travel_end !== null && travelEnd === null) ||
    (row.dispatched_at !== null && dispatchedAt === null) ||
    (row.courier_tracking !== null && (typeof row.courier_tracking !== 'string' || !row.courier_tracking.trim() || row.courier_tracking.length > 200 || /[\u0000-\u001f\u007f]/.test(row.courier_tracking)))
  ) return null;
  return {
    ...row,
    id,
    inventory_item_id: inventoryItemId,
    fulfilment_status: row.fulfilment_status,
    travel_end: travelEnd,
    dispatched_at: dispatchedAt,
    courier_tracking: row.courier_tracking as string | null,
  };
}
