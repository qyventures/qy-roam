const MAX_CRM_MONEY_CENTS = 1_000_000_000_000;
const MAX_CRM_ORDER_COUNT = 100_000_000;

function exactPositiveInteger(value: unknown) {
  const raw = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function exactNonnegativeInteger(value: unknown, maximum: number) {
  const raw = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

function exactNonnegativeMoneyCents(value: unknown) {
  const raw = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const [dollars, fraction = ''] = raw.split('.');
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents <= MAX_CRM_MONEY_CENTS ? cents : null;
}

function exactProbabilityBasisPoints(value: unknown) {
  const raw = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const basisPoints = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(basisPoints) && basisPoints <= 10_000 ? basisPoints : null;
}

export function validatedCrmCustomer(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = exactPositiveInteger(row.id);
  const totalOrders = exactNonnegativeInteger(row.total_orders, MAX_CRM_ORDER_COUNT);
  const lifetimeValueCents = exactNonnegativeMoneyCents(row.lifetime_value_sgd);
  if (id === null || totalOrders === null || lifetimeValueCents === null) return null;
  return { ...row, id, total_orders: totalOrders, lifetime_value_cents: lifetimeValueCents };
}

export function validatedCrmOpportunity(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = exactPositiveInteger(row.id);
  const expectedValueCents = exactNonnegativeMoneyCents(row.expected_value_sgd);
  const probabilityBasisPoints = exactProbabilityBasisPoints(row.probability);
  if (id === null || expectedValueCents === null || probabilityBasisPoints === null) return null;
  return { ...row, id, expected_value_cents: expectedValueCents, probability_basis_points: probabilityBasisPoints };
}
