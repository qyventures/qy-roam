import { validCheckoutRequestId } from './checkoutValidation';
import { validStripeCheckoutSessionId } from './stripeSessionId';

const ITEM_STATUSES = new Set(['available', 'quarantined', 'damaged', 'maintenance']);
const PRODUCT_TYPES = new Set(['pocket_wifi', 'esim']);
const MOVEMENT_TYPES = new Set(['opening_stock', 'adjustment', 'purchase', 'write_off', 'dispatch', 'return', 'return_quarantined', 'return_damaged', 'status_change']);

function positiveInteger(value: unknown) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function nonNegativeInteger(value: unknown) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function exactMoneyCents(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(text)) return null;
  const [dollars, fraction = ''] = text.split('.');
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
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
  const id = positiveInteger(row.id), quantity = nonNegativeInteger(row.quantity_on_hand), reorder = nonNegativeInteger(row.reorder_level), unitCostCents = exactMoneyCents(row.unit_cost_sgd);
  if (id === null || quantity === null || reorder === null || unitCostCents === null || typeof row.name !== 'string' || !row.name.trim() || typeof row.product_type !== 'string' || !PRODUCT_TYPES.has(row.product_type) || typeof row.status !== 'string' || !ITEM_STATUSES.has(row.status)) return null;
  const productType = row.product_type, status = row.status;
  const name = row.name;
  return { ...row, id, name, product_type: productType, status, quantity_on_hand: quantity, reorder_level: reorder, unit_cost_cents: unitCostCents };
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
  if (!requestId || (row.stripe_session_id !== null && !sessionId) || !start || !end || rentalDays < 1 || rentalDays > 90 || !expiresAt || !createdAt) return null;
  return { ...row, checkout_request_id: requestId, stripe_session_id: sessionId, travel_start: start, travel_end: end, expires_at: expiresAt, created_at: createdAt };
}
