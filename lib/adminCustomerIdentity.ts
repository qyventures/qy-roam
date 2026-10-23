import { normalizedCustomerPhone } from './customerPhone';

/**
 * Derive the conservative identity used by the order-backed dashboard
 * preview. Names are display data, not unique customer identifiers: merging
 * two name-only orders can invent repeat business and lifetime value. Prefer
 * a normalized contact point, then keep an otherwise anonymous order in its
 * own bucket.
 */
export function adminCustomerIdentity(order: {
  id?: unknown;
  email?: unknown;
  phone?: unknown;
  stripe_session_id?: unknown;
}) {
  const email = typeof order.email === 'string' ? order.email.trim().toLowerCase() : '';
  if (email) return `email:${email}`;

  const phone = normalizedCustomerPhone(typeof order.phone === 'string' ? order.phone : null);
  if (phone) return `phone:${phone}`;

  if (typeof order.id === 'number' && Number.isSafeInteger(order.id) && order.id > 0) {
    return `order:${order.id}`;
  }

  const sessionId = typeof order.stripe_session_id === 'string' ? order.stripe_session_id.trim() : '';
  return sessionId ? `session:${sessionId}` : null;
}

export function compareCustomerPurchaseRecency(
  a: { last?: unknown; identity?: unknown },
  b: { last?: unknown; identity?: unknown },
) {
  const aTime = typeof a.last === 'string' ? new Date(a.last).getTime() : Number.NaN;
  const bTime = typeof b.last === 'string' ? new Date(b.last).getTime() : Number.NaN;
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
  if (Number.isFinite(aTime) !== Number.isFinite(bTime)) return Number.isFinite(bTime) ? 1 : -1;
  return String(a.identity || '').localeCompare(String(b.identity || ''));
}
