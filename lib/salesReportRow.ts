import { parseExactIsoDate } from './checkoutValidation';

const MAX_REPORT_REVENUE_CENTS = 1_000_000_000_000;
const MAX_REPORT_ORDER_COUNT = 100_000_000;

export type SalesReportRow = {
  sales_date: string;
  product_type: 'pocket_wifi' | 'esim';
  paid_orders: number;
  revenue_cents: number;
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
  return Number.isSafeInteger(cents) && cents <= MAX_REPORT_REVENUE_CENTS ? cents : null;
}

export function validatedSalesReportRow(value: unknown): SalesReportRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const salesDate = typeof row.sales_date === 'string' && parseExactIsoDate(row.sales_date)
    ? row.sales_date
    : null;
  const productType = row.product_type === 'pocket_wifi' || row.product_type === 'esim'
    ? row.product_type
    : null;
  const paidOrders = exactNonnegativeInteger(row.paid_orders, MAX_REPORT_ORDER_COUNT);
  const revenueCents = exactNonnegativeMoneyCents(row.revenue_sgd);
  if (!salesDate || !productType || paidOrders === null || revenueCents === null) return null;
  return { sales_date: salesDate, product_type: productType, paid_orders: paidOrders, revenue_cents: revenueCents };
}
