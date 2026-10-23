import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { validatedSalesReportRow } from '@/lib/salesReportRow';
import { runAdminDashboardWork } from '@/lib/adminDashboardConcurrency';

export const dynamic = 'force-dynamic';

const REPORT_PAGE_SIZE = 250;
const REPORT_MAX_ROWS = 5_000;
const card = { border: '1px solid #e4e8ef', borderRadius: 16, padding: 18, background: '#fff' } as const;
const moneyFromCents = (cents: number) => `S$${(cents / 100).toFixed(2)}`;

type ReportResult = { data: any[]; error: unknown; truncated: boolean };

async function loadReportPages(db: NonNullable<ReturnType<typeof getSupabaseAdmin>>): Promise<ReportResult> {
  const data: any[] = [];
  const seenRows = new Set<string>();
  let previousDate: string | null = null;
  let previousProduct: string | null = null;
  let afterDate: string | null = null;
  let afterProduct: string | null = null;
  const fetchPage = (limit: number) => {
    let query = db
      .from('sales_daily_summary')
      .select('*')
      .order('sales_date', { ascending: false })
      .order('product_type', { ascending: true })
      .limit(limit);
    if (afterDate !== null && afterProduct !== null) {
      // Both cursor values come from a row validated below against closed
      // date/product grammars, so they are safe to place in PostgREST's
      // composite OR expression. The ordering means the next row is on an
      // older date, or a later product bucket on the same date.
      query = query.or(`sales_date.lt.${afterDate},and(sales_date.eq.${afterDate},product_type.gt.${afterProduct})`);
    }
    return query;
  };

  for (let loaded = 0; loaded < REPORT_MAX_ROWS; loaded += REPORT_PAGE_SIZE) {
    const result = await fetchPage(REPORT_PAGE_SIZE);
    if (result.error) return { data: [], error: result.error, truncated: false };
    // The view's natural identity is one product bucket per sales date. A
    // duplicate or out-of-order identity is evidence that the provider did
    // not honour the cursor contract (or that the view is corrupt), so its
    // revenue must not be counted twice or presented as a complete report.
    if (!Array.isArray(result.data) || result.data.length > REPORT_PAGE_SIZE) {
      return { data: [], error: new Error('Sales report returned an invalid page'), truncated: false };
    }
    const page = result.data;
    for (const row of page) {
      const validDate = typeof row?.sales_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.sales_date);
      const validProduct = row?.product_type === 'pocket_wifi' || row?.product_type === 'esim';
      const identity = validDate && validProduct
        ? `${row.sales_date}\u0000${row.product_type}`
        : null;
      const followsPrevious = previousDate === null || previousProduct === null
        || row.sales_date < previousDate
        || (row.sales_date === previousDate && row.product_type > previousProduct);
      if (identity === null || seenRows.has(identity) || !followsPrevious) {
        return { data: [], error: new Error('Sales report returned an invalid or duplicate identity'), truncated: false };
      }
      seenRows.add(identity);
      previousDate = row.sales_date;
      previousProduct = row.product_type;
    }
    data.push(...page);
    if (page.length < REPORT_PAGE_SIZE) return { data, error: null, truncated: false };
    const cursor = page[page.length - 1];
    const nextDate = cursor?.sales_date;
    const nextProduct = cursor?.product_type;
    if (typeof nextDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(nextDate)
      || (nextProduct !== 'pocket_wifi' && nextProduct !== 'esim')
      || (nextDate === afterDate && nextProduct === afterProduct)) {
      return { data: [], error: new Error('Sales report returned an invalid pagination cursor'), truncated: false };
    }
    afterDate = nextDate;
    afterProduct = nextProduct;
  }

  // A full last page may be the exact end of the view. Probe one additional
  // row so staff see an overflow warning only when reporting data was actually
  // omitted. A failed probe makes completeness unknown and therefore fails
  // the report closed rather than presenting partial figures as authoritative.
  const beyond = await fetchPage(1);
  if (beyond.error) return { data: [], error: beyond.error, truncated: false };
  if (!Array.isArray(beyond.data) || beyond.data.length > 1) {
    return { data: [], error: new Error('Sales report returned an invalid truncation probe'), truncated: false };
  }
  return { data, error: null, truncated: beyond.data.length > 0 };
}

export default async function ReportsPage() {
  const db = getSupabaseAdmin();
  const reportResult: ReportResult = db
    ? await runAdminDashboardWork(
      () => loadReportPages(db),
      { data: [], error: new Error('Admin dashboard is busy'), truncated: false },
    )
    : { data: [], error: new Error('Sales database is not configured'), truncated: false };
  const rows = reportResult.data;
  const reportUnavailable = Boolean(reportResult.error);
  // This view feeds revenue and campaign decisions. Postgres normally returns
  // coherent aggregates, but historical imports or a changed view can expose
  // strings, negative values, fractional counts, or unknown product buckets.
  // Never coerce those into plausible-looking zero/NaN totals.
  const validatedRows = rows.map(validatedSalesReportRow);
  const invalidRows = validatedRows.filter((row) => row === null).length;
  const reportIncomplete = reportUnavailable || reportResult.truncated || invalidRows > 0;
  const safeRows = validatedRows.filter((row): row is NonNullable<typeof row> => row !== null);
  const revenueCents = safeRows.reduce((sum, row) => sum + row.revenue_cents, 0);
  const orders = safeRows.reduce((sum, row) => sum + row.paid_orders, 0);
  const wifiCents = safeRows.filter((row) => row.product_type === 'pocket_wifi').reduce((sum, row) => sum + row.revenue_cents, 0);
  const esimCents = safeRows.filter((row) => row.product_type === 'esim').reduce((sum, row) => sum + row.revenue_cents, 0);
  const metric = (value: string | number) => reportIncomplete ? '—' : value;

  return <main className="wrap section legal" style={{ maxWidth: 1280 }}>
    <span className="eyebrow">Reports</span>
    <h1>Sales &amp; performance reporting</h1>
    {!db && <div style={card}><strong>Database connection required.</strong></div>}
    {db && <>
      {reportUnavailable && <div role="alert" style={{ ...card, borderColor: '#dc2626', background: '#fef2f2', marginBottom: 20 }}>
        <strong>Sales reporting data is currently unavailable.</strong>
        <div style={{ marginTop: 6 }}>Do not treat these totals or an empty table as zero sales. Restore the database/schema connection and refresh before making a revenue or campaign decision.</div>
      </div>}
      {reportResult.truncated && <div role="alert" style={{ ...card, borderColor: '#b45309', background: '#fffbeb', marginBottom: 20 }}>
        <strong>The sales reporting view is larger than this operational screen can safely load.</strong>
        <div style={{ marginTop: 6 }}>More than {REPORT_MAX_ROWS.toLocaleString('en-SG')} daily product rows exist. Headline totals are hidden because they would be incomplete; archive or export older reporting data before relying on this page.</div>
      </div>}
      {invalidRows > 0 && <div role="alert" style={{ ...card, borderColor: '#dc2626', background: '#fef2f2', marginBottom: 20 }}>
        <strong>Sales reporting contains {invalidRows.toLocaleString('en-SG')} invalid aggregate {invalidRows === 1 ? 'row' : 'rows'}.</strong>
        <div style={{ marginTop: 6 }}>Headline totals are hidden. Reconcile the daily sales view before using this report for accounting, inventory, pricing, or campaign decisions.</div>
      </div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
        <div style={card}><small>Reported revenue</small><h2>{metric(moneyFromCents(revenueCents))}</h2></div>
        <div style={card}><small>Paid orders</small><h2>{metric(orders)}</h2></div>
        <div style={card}><small>Pocket WiFi</small><h2>{metric(moneyFromCents(wifiCents))}</h2></div>
        <div style={card}><small>eSIM</small><h2>{metric(moneyFromCents(esimCents))}</h2></div>
        <div style={card}><small>Average order value</small><h2>{metric(moneyFromCents(orders ? Math.round(revenueCents / orders) : 0))}</h2></div>
      </div>
      <h2 style={{ marginTop: 28 }}>Daily sales</h2>
      {reportUnavailable
        ? <p>Sales reporting is unavailable; no conclusion can be drawn from this page.</p>
        : rows.length === 0
          ? <p>No sales data yet.</p>
          : <div style={{ overflowX: 'auto', ...card }}><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 680 }}><thead><tr><th align="left">Date</th><th align="left">Product</th><th align="right">Orders</th><th align="right">Revenue</th><th align="right">AOV</th></tr></thead><tbody>{validatedRows.map((row, index) => row
            ? <tr key={`${row.sales_date}-${row.product_type}`} style={{ borderTop: '1px solid #e5e7eb' }}><td>{row.sales_date}</td><td>{row.product_type}</td><td align="right">{row.paid_orders}</td><td align="right">{moneyFromCents(row.revenue_cents)}</td><td align="right">{moneyFromCents(row.paid_orders ? Math.round(row.revenue_cents / row.paid_orders) : 0)}</td></tr>
            : <tr key={`invalid-${index}`} style={{ borderTop: '1px solid #e5e7eb' }}><td colSpan={5}><strong>Invalid aggregate row — reconciliation required</strong></td></tr>)}</tbody></table></div>}
    </>}
  </main>;
}
