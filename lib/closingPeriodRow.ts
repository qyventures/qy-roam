import { parseExactIsoDate } from './checkoutValidation';

const MAX_CLOSING_AMOUNT_CENTS = 9_999_999_999;

export type ClosingPeriodRow = {
  id: number;
  period_start: string;
  period_end: string;
  status: 'open' | 'closed';
  gross_sales_cents: number;
  refunds_cents: number;
  net_sales_cents: number;
  fees_cents: number;
  cogs_cents: number;
  gross_profit_cents: number;
  closed_by: string | null;
  closed_at: string | null;
};

function exactPositiveInteger(value: unknown) {
  const raw = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function exactMoneyCents(value: unknown, nonnegative: boolean) {
  const raw = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw) || raw.startsWith('-0')) return null;
  const negative = raw.startsWith('-');
  const [dollars, fraction = ''] = (negative ? raw.slice(1) : raw).split('.');
  const cents = (Number(dollars) * 100 + Number(fraction.padEnd(2, '0'))) * (negative ? -1 : 1);
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_CLOSING_AMOUNT_CENTS || (nonnegative && cents < 0)) return null;
  return cents;
}

function exactTimestamp(value: unknown) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? value : null;
}

export function validatedClosingPeriodRow(value: unknown): ClosingPeriodRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = exactPositiveInteger(row.id);
  const start = typeof row.period_start === 'string' && parseExactIsoDate(row.period_start) ? row.period_start : null;
  const end = typeof row.period_end === 'string' && parseExactIsoDate(row.period_end) ? row.period_end : null;
  const status = row.status === 'open' || row.status === 'closed' ? row.status : null;
  const gross = exactMoneyCents(row.gross_sales_sgd, true);
  const refunds = exactMoneyCents(row.refunds_sgd, true);
  const net = exactMoneyCents(row.net_sales_sgd, false);
  const fees = exactMoneyCents(row.fees_sgd, true);
  const cogs = exactMoneyCents(row.cogs_sgd, true);
  const profit = exactMoneyCents(row.gross_profit_sgd, false);
  const closedBy = row.closed_by === null ? null : typeof row.closed_by === 'string' && row.closed_by.trim() && row.closed_by.length <= 100 ? row.closed_by : undefined;
  const closedAt = row.closed_at === null ? null : exactTimestamp(row.closed_at) ?? undefined;
  if (!id || !start || !end || end < start || !status || gross === null || refunds === null || net === null || fees === null || cogs === null || profit === null || closedBy === undefined || closedAt === undefined) return null;
  if (net !== gross - refunds || profit !== net - fees - cogs) return null;
  if ((status === 'closed') !== Boolean(closedBy && closedAt)) return null;
  return { id, period_start: start, period_end: end, status, gross_sales_cents: gross, refunds_cents: refunds, net_sales_cents: net, fees_cents: fees, cogs_cents: cogs, gross_profit_cents: profit, closed_by: closedBy, closed_at: closedAt };
}
