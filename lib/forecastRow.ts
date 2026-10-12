import { parseExactIsoDate } from './checkoutValidation';

const MAX_FORECAST_COUNT = 100_000_000;
const MAX_FORECAST_REVENUE_CENTS = 1_000_000_000_000;

export type ForecastRow = {
  id: number;
  forecast_month: string;
  product_type: 'pocket_wifi' | 'esim';
  forecast_orders: number;
  forecast_revenue_cents: number;
  forecast_units: number;
  method: string;
  notes: string | null;
};

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
  return Number.isSafeInteger(cents) && cents <= MAX_FORECAST_REVENUE_CENTS ? cents : null;
}

function boundedText(value: unknown, maximum: number): string | undefined;
function boundedText(value: unknown, maximum: number, nullable: true): string | null | undefined;
function boundedText(value: unknown, maximum: number, nullable = false): string | null | undefined {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

export function validatedForecastRow(value: unknown): ForecastRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = exactNonnegativeInteger(row.id, Number.MAX_SAFE_INTEGER);
  const month = typeof row.forecast_month === 'string' && parseExactIsoDate(row.forecast_month)
    ? row.forecast_month
    : null;
  const productType = row.product_type === 'pocket_wifi' || row.product_type === 'esim'
    ? row.product_type
    : null;
  const orders = exactNonnegativeInteger(row.forecast_orders, MAX_FORECAST_COUNT);
  const revenueCents = exactNonnegativeMoneyCents(row.forecast_revenue_sgd);
  const units = exactNonnegativeInteger(row.forecast_units, MAX_FORECAST_COUNT);
  const method = boundedText(row.method, 80);
  const notes = boundedText(row.notes, 1_500, true);
  if (!id || !month || !productType || orders === null || revenueCents === null || units === null || method === undefined || notes === undefined) return null;
  return { id, forecast_month: month, product_type: productType, forecast_orders: orders, forecast_revenue_cents: revenueCents, forecast_units: units, method, notes };
}
