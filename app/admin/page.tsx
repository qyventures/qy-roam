import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import AdminOrderActions from '@/components/AdminOrderActions';
import { fulfilmentNotificationActionable, isPocketWifiProduct, isSupportedProduct, stripeEventClaimInProgress } from '@/lib/orderLifecycle';
import { hasRequiredMetaCapiPurchaseConfig } from '@/lib/runtimeConfig';
import { isSafeDigitalDeliveryReference } from '@/lib/digitalDeliveryReference';
import { operationalDaysFromToday } from '@/lib/operationalDate';
import { POCKET_WIFI_RETURN_GRACE_DAYS, pocketWifiReturnTiming } from '@/lib/pocketWifiReturns';
import { stripeSecretKeyMode } from '@/lib/stripeCheckoutConfig';
import { tryAcquireAdminDashboardConcurrency } from '@/lib/adminDashboardConcurrency';
import { formatSingaporeDate, formatSingaporeTimestamp } from '@/lib/singaporeTimestamp';
import { customerOrderReference } from '@/lib/customerOrderReference';

export const dynamic = 'force-dynamic';

// Supabase caps a single select response. The operations dashboard must not
// quietly become a view of only the newest orders once that cap is reached:
// old unresolved returns and unsent fulfilment notices are still actionable.
// Keep requests bounded for a server-rendered admin page, but make a growing
// data set visible to staff before it can hide operational work.
const ADMIN_PAGE_SIZE = 250;
const ADMIN_MAX_ROWS = 5_000;

type PagedResult = { data: any[]; error: any; truncated: boolean };
type PageCursor = string | number;

async function loadKeysetPages(
  fetchPage: (after: PageCursor | null, limit: number) => PromiseLike<{ data: any[] | null; error: any }>,
  cursorFor: (row: any) => PageCursor | null,
): Promise<PagedResult> {
  const data: any[] = [];
  const seenCursors = new Set<PageCursor>();
  let after: PageCursor | null = null;
  for (let loaded = 0; loaded < ADMIN_MAX_ROWS; loaded += ADMIN_PAGE_SIZE) {
    const result = await fetchPage(after, ADMIN_PAGE_SIZE);
    if (result.error) return { data: [], error: result.error, truncated: false };
    // PostgREST normally honours the requested limit and ordering, but this
    // dashboard is an operational authority: a malformed gateway response or
    // repeated keyset row must not inflate totals, duplicate fulfilment work,
    // or hide an older exception behind a cursor that merely looks usable.
    // Validate every row identity, not only the final continuation cursor.
    if (!Array.isArray(result.data) || result.data.length > ADMIN_PAGE_SIZE) {
      return { data: [], error: new Error('Operational ledger returned an invalid page'), truncated: false };
    }
    const page = result.data;
    for (const row of page) {
      const cursor = cursorFor(row);
      if (cursor === null || seenCursors.has(cursor)) {
        return { data: [], error: new Error('Operational ledger returned an invalid pagination cursor'), truncated: false };
      }
      seenCursors.add(cursor);
    }
    data.push(...page);
    if (page.length < ADMIN_PAGE_SIZE) return { data, error: null, truncated: false };
    const next = cursorFor(page[page.length - 1]);
    // Every operational ledger below pages on an immutable unique identity.
    // If a provider returns a malformed/repeated cursor, fail the view closed
    // rather than looping or presenting a silently incomplete ledger.
    if (next === null || next === after) {
      return { data: [], error: new Error('Operational ledger returned an invalid pagination cursor'), truncated: false };
    }
    after = next;
  }
  // A full final page does not prove that rows were omitted. Probe exactly
  // one row beyond the rendered boundary so an account with precisely 5,000
  // records is not put into a permanent false incident state. Conversely, a
  // failed probe means completeness is unknown and must fail the panel closed
  // instead of presenting the first 5,000 rows as a trustworthy full view.
  const beyond = await fetchPage(after, 1);
  if (beyond.error) return { data: [], error: beyond.error, truncated: false };
  if (!Array.isArray(beyond.data) || beyond.data.length > 1) {
    return { data: [], error: new Error('Operational ledger returned an invalid truncation probe'), truncated: false };
  }
  return { data, error: null, truncated: beyond.data.length > 0 };
}

function daysFromToday(value: string | null | undefined) {
  return operationalDaysFromToday(value);
}

function isEsim(order: any) { return order.product_type === 'esim'; }
function paidAmountCents(value: unknown) {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const [dollars, fraction = ''] = raw.split('.');
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 9_999_999_999 ? cents : null;
}
function money(value: unknown) {
  const cents = paidAmountCents(value);
  return cents === null ? '—' : formatCents(cents);
}
function formatCents(cents: number) {
  return Number.isSafeInteger(cents) && cents >= 0 ? `S$${(cents / 100).toFixed(2)}` : '—';
}
// Payment settlement is an accounting boundary, so never let the VPS locale
// or timezone decide how it is presented to Singapore operations. Checkout
// creation and payment confirmation can be hours or days apart for an
// asynchronous payment method; showing both timestamps makes that distinction
// explicit while keeping malformed legacy values visibly unavailable.
function isStripeCheckoutOrder(order: any) { return typeof order.stripe_session_id === 'string' && order.stripe_session_id.startsWith('cs_'); }
function stripeEventDashboardUrl(eventId: unknown) {
  const match = typeof eventId === 'string' ? /^stripe:(evt_[A-Za-z0-9]{8,96})$/.exec(eventId) : null;
  if (!match) return null;
  // The admin page never exposes the credential itself. Its mode only selects
  // the matching Stripe dashboard so an operator cannot accidentally inspect
  // or resend a test event while reconciling a live paid order (or vice versa).
  // Use the same bounded key parser as checkout and webhook mode validation.
  // Production may intentionally use a least-privilege `rk_live_…` key; the
  // recovery link must remain available in that supported configuration.
  const stripeMode = stripeSecretKeyMode(process.env.STRIPE_SECRET_KEY);
  if (!stripeMode) return null;
  return `https://dashboard.stripe.com/${stripeMode === 'test' ? 'test/' : ''}events/${match[1]}`;
}
function customerKey(order: any) {
  return String(order.email || order.phone || order.customer_name || order.stripe_session_id || '').trim().toLowerCase();
}
function withinDays(value: string | null | undefined, days: number) {
  if (!value) return false;
  const t = new Date(value).getTime();
  return Number.isFinite(t) && t >= Date.now() - days * 86400000;
}

function tripFlag(order: any) {
  // A delayed payment method can create an awaiting-payment order before
  // Stripe confirms funds. Keep that row visible for reconciliation, but do
  // not turn it into a dispatch or digital-fulfilment instruction.
  if (order.payment_status !== 'paid') return '';
  if (['closed', 'cancelled', 'payment_failed'].includes(order.fulfilment_status)) return '';
  const untilDeparture = daysFromToday(order.travel_start);
  if (isEsim(order)) {
    if (['fulfilled','closed'].includes(order.fulfilment_status)) return '';
    // A missing/corrupt departure must be louder than an ordinary future
    // trip. Otherwise it is excluded from both the urgency queue and row flag.
    if (typeof untilDeparture !== 'number') return '⚠ Departure schedule unavailable — reconcile travel dates';
    if (typeof untilDeparture === 'number' && untilDeparture <= 2 && !['fulfilled','closed'].includes(order.fulfilment_status)) {
      return untilDeparture < 0 ? '⚠ Departure passed — eSIM fulfilment unresolved' : `⚠ Departure in ${untilDeparture} day${untilDeparture === 1 ? '' : 's'} — issue eSIM`;
    }
    return '';
  }
  const awaitingDispatch = !['dispatched', 'with_customer', 'return_due', 'returned'].includes(order.fulfilment_status);
  if (awaitingDispatch && typeof untilDeparture !== 'number') return '⚠ Departure schedule unavailable — reconcile travel dates';
  if (typeof untilDeparture === 'number' && untilDeparture <= 2 && awaitingDispatch) {
    return untilDeparture < 0 ? '⚠ Departure passed — dispatch unresolved' : `⚠ Departure in ${untilDeparture} day${untilDeparture === 1 ? '' : 's'} — dispatch check`;
  }
  const returnTiming = pocketWifiReturnTiming(order.travel_end, order.fulfilment_status);
  if (returnTiming === 'schedule_unknown') return '⚠ Return schedule unavailable — reconcile rental dates';
  if (returnTiming === 'overdue') return '⚠ Return overdue';
  if (returnTiming === 'due') return 'Return due';
  return '';
}

const cardStyle = {border:'1px solid #e4e8ef',borderRadius:16,padding:'18px 20px',background:'#fff',boxShadow:'0 8px 24px rgba(0,0,0,.04)'} as const;
const metricStyle = {fontSize:30,fontWeight:800,lineHeight:1.1,marginTop:6} as const;

export default async function AdminPage() {
  const releaseDashboard = tryAcquireAdminDashboardConcurrency();
  if (!releaseDashboard) {
    return <main className="wrap" style={{padding:'34px 0 70px'}}>
      <h1>Operations dashboard is busy</h1>
      <div role="alert" style={{...cardStyle,borderColor:'#f59e0b',background:'#fffbeb'}}>
        Another dashboard view is loading the order and delivery ledgers. Wait a few seconds, then refresh this page. No order data or operational work has been lost.
      </div>
    </main>;
  }

  try {
    return await renderAdminPage();
  } finally {
    releaseDashboard();
  }
}

async function renderAdminPage() {
  const supabase = getSupabaseAdmin();
  // An admin dashboard that quietly turns a failed query into an empty table
  // is dangerous: staff can conclude there are no orders to fulfil. Fetch the
  // independent panels together, but preserve each failure so the UI fails
  // loudly while leaving any successfully loaded operational data visible.
  const unavailable: PagedResult = { data: [], error: new Error('Order database is not configured'), truncated: false };
  const [result, inventoryResult, notificationResult, metaDeliveryResult, stripeEventResult] = supabase
    ? await Promise.all([
        loadKeysetPages((after, limit) => {
          let query = supabase.from('orders').select('*').order('id', { ascending: false }).limit(limit);
          if (typeof after === 'number') query = query.lt('id', after);
          return query;
        }, row => Number.isSafeInteger(row?.id) && row.id > 0 ? row.id : null),
        // This list feeds the per-order dispatch selector, so a single
        // PostgREST response is not a safe fleet boundary. Page on the
        // immutable inventory id: otherwise a status/name edit can move a row
        // across page boundaries, or a valid router beyond the response cap can
        // silently disappear from the custody workflow. The shared ceiling
        // keeps rendering bounded and the
        // truncation warning below makes an oversized fleet explicit.
        loadKeysetPages((after, limit) => {
          let query = supabase.from('inventory_items')
          .select('id,sku,name,quantity_on_hand,status')
          .eq('product_type', 'pocket_wifi')
          .order('id')
          .limit(limit);
          if (typeof after === 'number') query = query.gt('id', after);
          return query;
        }, row => Number.isSafeInteger(row?.id) && row.id > 0 ? row.id : null),
        loadKeysetPages((after, limit) => {
          let query = supabase.from('fulfilment_notifications').select('stripe_session_id,status,last_error,last_attempt_at,sent_at').order('stripe_session_id').limit(limit);
          if (typeof after === 'string') query = query.gt('stripe_session_id', after);
          return query;
        }, row => typeof row?.stripe_session_id === 'string' && row.stripe_session_id ? row.stripe_session_id : null),
        loadKeysetPages((after, limit) => {
          let query = supabase.from('meta_purchase_deliveries').select('stripe_session_id,status,last_error,last_attempt_at,sent_at').order('stripe_session_id').limit(limit);
          if (typeof after === 'string') query = query.gt('stripe_session_id', after);
          return query;
        }, row => typeof row?.stripe_session_id === 'string' && row.stripe_session_id ? row.stripe_session_id : null),
        // Load every unfinished claim, then classify it with the exact same
        // lease rule as the webhook worker. Filtering only in PostgREST by an
        // old timestamp misses NULL and implausibly future processing leases:
        // both are reclaimable by the worker and therefore must also be
        // visible to operations if Stripe stops retrying.
        // Webhook exceptions are paid-order recovery work, not a diagnostic
        // sample. Apply the same bounded pagination policy as the other
        // operational ledgers so a busy incident cannot silently hide older
        // failed/abandoned events after the first 100 rows.
        loadKeysetPages((after, limit) => {
          let query = supabase.from('stripe_events')
          .select('event_id,event_type,stripe_session_id,received_at,attempts,processing_started_at,last_failed_at,last_error')
          .is('processed_at', null)
          .order('event_id')
          .limit(limit);
          if (typeof after === 'string') query = query.gt('event_id', after);
          return query;
        }, row => typeof row?.event_id === 'string' && row.event_id ? row.event_id : null),
      ])
    : [unavailable, unavailable, unavailable, unavailable, unavailable];
  // Keyset reads use immutable identities so concurrent inserts/updates cannot
  // shift rows between pages. Restore the operator-friendly presentation
  // order only after the complete bounded ledger has been loaded.
  const orders: any[] = (result.data ?? []).sort((a:any,b:any) =>
    String(b.created_at || '').localeCompare(String(a.created_at || '')) || Number(b.id || 0) - Number(a.id || 0));
  const orderByStripeSession = new Map(orders.map((order:any)=>[order.stripe_session_id,order]));
  const inventoryItems: any[] = (inventoryResult.data ?? []).sort((a:any,b:any) =>
    String(a.name || '').localeCompare(String(b.name || '')) || Number(a.id || 0) - Number(b.id || 0));
  const notifications: any[] = notificationResult.data ?? [];
  const notificationBySession = new Map(notifications.map((n:any)=>[n.stripe_session_id,n]));
  // A webhook failure before the notification ledger is created leaves no row
  // to count here. Include every paid Stripe order without a confirmed send so
  // the attention total agrees with the per-order warning and staff do not
  // mistake a zero metric for a healthy fulfilment queue.
  const notificationExceptions = orders.filter((order:any) =>
    order.payment_status === 'paid' &&
    isStripeCheckoutOrder(order) &&
    fulfilmentNotificationActionable(order.product_type, order.fulfilment_status) &&
    notificationBySession.get(order.stripe_session_id)?.status !== 'sent',
  );
  const metaDeliveries: any[] = metaDeliveryResult.data ?? [];
  const metaDeliveryBySession = new Map(metaDeliveries.map((delivery:any)=>[delivery.stripe_session_id,delivery]));
  const metaCapiConfigured = hasRequiredMetaCapiPurchaseConfig();
  // A missing CAPI ledger is actionable only when the buyer gave measurement
  // consent. Without this persisted marker, an absent record is ambiguous:
  // it can mean either a deliberately untracked purchase or a failed webhook.
  const metaDeliveryExceptions = orders.filter((order:any) =>
    order.payment_status === 'paid' &&
    isStripeCheckoutOrder(order) &&
    order.measurement_consent === 'accepted' &&
    metaCapiConfigured &&
    metaDeliveryBySession.get(order.stripe_session_id)?.status !== 'sent',
  );
  const webhookFailures: any[] = (stripeEventResult.data ?? []).filter((event:any) => {
    return !stripeEventClaimInProgress(event.processing_started_at, event.last_error);
  });
  const failedPanels = [
    result.error && 'orders',
    inventoryResult.error && 'inventory',
    notificationResult.error && 'fulfilment notifications',
    metaDeliveryResult.error && 'Meta delivery status',
    stripeEventResult.error && 'Stripe webhook failures',
  ].filter(Boolean) as string[];
  // A failed read must never collapse into plausible-looking zero revenue or
  // empty fulfilment queues. Independent ledgers can remain visible, but all
  // order-derived views must distinguish "unavailable" from a healthy empty
  // account.
  const ordersUnavailable = Boolean(result.error);
  // Bounded detail remains useful during a large backlog, but a truncated
  // order ledger cannot support trustworthy revenue, customer, or exception
  // totals. Treat it like an unavailable aggregate source rather than
  // presenting the first 5,000 rows as the whole business.
  const ordersIncomplete = ordersUnavailable || result.truncated;
  // Email and CAPI exception totals join orders to their independent delivery
  // ledgers. If either side failed or hit its safety ceiling, a numeric result
  // can be materially wrong (including treating an omitted `sent` row as a
  // failure), so the combined fulfilment summary must fail closed as well.
  const fulfilmentSummaryIncomplete = ordersIncomplete ||
    Boolean(notificationResult.error) || notificationResult.truncated ||
    Boolean(metaDeliveryResult.error) || metaDeliveryResult.truncated;
  // An incomplete webhook ledger cannot support a trustworthy exception
  // count. In particular, rendering zero after a failed read can falsely tell
  // operations that every paid event is healthy, while rendering the bounded
  // row count as a total hides exceptions beyond the safety ceiling.
  const webhookSummaryIncomplete = Boolean(stripeEventResult.error) || stripeEventResult.truncated;
  const truncatedPanels = [
    result.truncated && 'orders',
    inventoryResult.truncated && 'Pocket WiFi inventory',
    notificationResult.truncated && 'fulfilment notifications',
    metaDeliveryResult.truncated && 'Meta delivery status',
    stripeEventResult.truncated && 'Stripe webhook failures',
  ].filter(Boolean) as string[];

  const paid = orders.filter((o:any)=>o.payment_status === 'paid');
  // Additive database constraints deliberately keep historical/imported rows
  // visible even when they predate today's paid-ledger contract. Never turn a
  // malformed amount into zero/NaN or silently omit a bad payment timestamp
  // from rolling revenue: flag those rows for reconciliation and withhold all
  // financial/customer aggregates until the source ledger is coherent.
  const invalidPaidAmounts = paid.filter((o:any)=>paidAmountCents(o.amount_sgd) === null);
  const invalidPaidProducts = paid.filter((o:any)=>!isSupportedProduct(o.product_type));
  const invalidPaymentTimes = paid.filter((o:any) => {
    const timestamp = typeof o.payment_confirmed_at === 'string' ? Date.parse(o.payment_confirmed_at) : Number.NaN;
    return !Number.isFinite(timestamp);
  });
  const reportingIntegrityIssues = [
    ...invalidPaidAmounts.map((o:any)=>`order #${o.id} has an invalid paid amount`),
    ...invalidPaidProducts.map((o:any)=>`order #${o.id} has an unknown product identity`),
    ...invalidPaymentTimes.map((o:any)=>`order #${o.id} has an invalid payment confirmation time`),
  ];
  const reportingIncomplete = ordersIncomplete || reportingIntegrityIssues.length > 0;
  // "Active" on this operations dashboard means paid work that can safely be
  // fulfilled. Unpaid asynchronous Checkouts remain in the order table below
  // and in Stripe recovery visibility, but must never inflate the fulfilment
  // workload or departure/return exception queues.
  const active = paid.filter((o:any)=>isSupportedProduct(o.product_type) && !['closed','cancelled','payment_failed'].includes(o.fulfilment_status));
  const revenueCents = paid.reduce((sum:number,o:any)=>sum + (paidAmountCents(o.amount_sgd) || 0), 0);
  // A Checkout Session can be created days before an asynchronous payment is
  // confirmed. Sales recency must follow the immutable payment boundary used
  // by period closing and Meta Purchase, otherwise a newly settled payment
  // can be omitted from the rolling metric and customer purchase ordering.
  const revenue30Cents = paid.filter((o:any)=>withinDays(o.payment_confirmed_at,30)).reduce((sum:number,o:any)=>sum + (paidAmountCents(o.amount_sgd) || 0), 0);
  const esimRevenueCents = paid.filter(isEsim).reduce((sum:number,o:any)=>sum + (paidAmountCents(o.amount_sgd) || 0), 0);
  const wifiRevenueCents = paid.filter((o:any)=>!isEsim(o)).reduce((sum:number,o:any)=>sum + (paidAmountCents(o.amount_sgd) || 0), 0);

  const customerMap = new Map<string, any>();
  for (const o of paid) {
    const key = customerKey(o);
    if (!key) continue;
    const current = customerMap.get(key) || {name:o.customer_name,email:o.email,phone:o.phone,orders:0,revenue:0,last:o.payment_confirmed_at,products:new Set<string>()};
    current.orders += 1;
    current.revenue += paidAmountCents(o.amount_sgd) || 0;
    current.products.add(isEsim(o) ? 'eSIM' : 'Pocket WiFi');
    if (String(o.payment_confirmed_at || '') > String(current.last || '')) current.last = o.payment_confirmed_at;
    customerMap.set(key,current);
  }
  const customers = Array.from(customerMap.values()).sort((a,b)=>String(b.last).localeCompare(String(a.last)));
  const repeatCustomers = customers.filter(c=>c.orders > 1);

  const wifiDispatchExceptions = active.filter((o:any) => {
    if (!isPocketWifiProduct(o.product_type)) return false;
    const days = daysFromToday(o.travel_start);
    return typeof days === 'number' && days <= 2 && !['dispatched','with_customer','return_due','returned'].includes(o.fulfilment_status);
  });
  const esimExceptions = active.filter((o:any) => {
    if (!isEsim(o)) return false;
    const days = daysFromToday(o.travel_start);
    return typeof days === 'number' && days <= 2 && !['fulfilled','closed'].includes(o.fulfilment_status);
  });
  // Date-based urgency can only classify a coherent itinerary. Keep paid,
  // actionable orders with invalid starts in a dedicated queue instead of
  // silently treating them as not urgent. Terminal states were removed from
  // `active` above; custody/fulfilled states no longer need a departure action.
  const departureScheduleExceptions = active.filter((o:any) => {
    if (typeof daysFromToday(o.travel_start) === 'number') return false;
    if (isEsim(o)) return !['fulfilled','closed'].includes(o.fulfilment_status);
    if (isPocketWifiProduct(o.product_type)) {
      return !['dispatched','with_customer','return_due','returned'].includes(o.fulfilment_status);
    }
    return false;
  });
  const returnDueOrders = active.filter((o:any) => {
    if (!isPocketWifiProduct(o.product_type)) return false;
    const timing = pocketWifiReturnTiming(o.travel_end, o.fulfilment_status);
    return timing === 'due' || timing === 'overdue';
  }).sort((a:any,b:any) => String(a.travel_end || '').localeCompare(String(b.travel_end || '')) || Number(a.id || 0) - Number(b.id || 0));
  const overdueReturnOrders = returnDueOrders.filter((o:any) => {
    return pocketWifiReturnTiming(o.travel_end, o.fulfilment_status) === 'overdue';
  });
  // A router in recorded customer custody must never vanish from operations
  // merely because a legacy/repair write damaged its itinerary. Keep these
  // separate from genuinely due returns: staff must reconcile the booked
  // dates before deciding what promise or deadline applies to the customer.
  const returnScheduleExceptions = active.filter((o:any) =>
    isPocketWifiProduct(o.product_type) &&
    pocketWifiReturnTiming(o.travel_end, o.fulfilment_status) === 'schedule_unknown'
  );

  return <main className="wrap section legal" style={{maxWidth:1280}}>
    <span className="eyebrow">QY Roam Operations & CRM</span>
    <h1 style={{marginBottom:8}}>Sales, orders and customers</h1>
    <p style={{marginTop:0,color:'#64748b'}}>One operating view for Pocket WiFi and travel eSIM. Data is sourced from paid Stripe checkouts and protected manual sales persisted in Supabase.</p>

    {!supabase && <div style={cardStyle}><strong>Order database is not configured yet.</strong></div>}
    {supabase && <>
      {failedPanels.length > 0 && <div role="alert" style={{...cardStyle,borderColor:'#dc2626',background:'#fef2f2',marginBottom:20}}>
        <strong>Operational data is currently unavailable: {failedPanels.join(', ')}.</strong>
        <div style={{marginTop:6}}>Do not treat empty panels as no orders. Restore the database/schema connection and refresh before taking fulfilment or inventory decisions.</div>
      </div>}
      {truncatedPanels.length > 0 && <div role="alert" style={{...cardStyle,borderColor:'#b45309',background:'#fffbeb',marginBottom:20}}>
        <strong>Operational data needs archiving or a dedicated reporting view.</strong>
        <div style={{marginTop:6}}>This screen safely loaded its first {ADMIN_MAX_ROWS.toLocaleString()} rows but stopped before all {truncatedPanels.join(', ')} could be reviewed. Do not rely on these totals or exception counts until the backlog is reconciled.</div>
      </div>}
      {!ordersIncomplete && reportingIntegrityIssues.length > 0 && <div role="alert" style={{...cardStyle,borderColor:'#dc2626',background:'#fef2f2',marginBottom:20}}>
        <strong>Paid sales ledger needs reconciliation.</strong>
        <div style={{marginTop:6}}>Financial and customer aggregates are withheld because {reportingIntegrityIssues.slice(0,3).join('; ')}{reportingIntegrityIssues.length > 3 ? `; and ${reportingIntegrityIssues.length - 3} more issue${reportingIntegrityIssues.length === 4 ? '' : 's'}` : ''}. The order rows remain visible below; correct the durable ledger before using dashboard totals.</div>
      </div>}
      {!metaCapiConfigured && <div role="alert" style={{...cardStyle,borderColor:'#b45309',background:'#fffbeb',marginBottom:20}}>
        <strong>Meta CAPI Purchase delivery is not configured.</strong>
        <div style={{marginTop:6}}>Consented purchases remain safely recorded in the order ledger, but no server-side Purchase events can be sent or retried until a valid Pixel ID and CAPI access token are configured.</div>
      </div>}
      <nav style={{display:'flex',gap:10,flexWrap:'wrap',margin:'22px 0'}}>
        <a className="secondary" href="#dashboard">Dashboard</a>
        <a className="secondary" href="#orders">Orders</a>
        <a className="secondary" href="#customers">Customers</a>
        <a className="secondary" href="#fulfilment">Fulfilment</a>
      </nav>

      <section id="dashboard">
        {reportingIncomplete ? <p role="status"><strong>Sales and order metrics are unavailable until the complete paid ledger is loaded and valid.</strong> {result.truncated && <>The bounded order detail below remains available for investigation, but it is not used for headline totals.</>}</p> : <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(190px,1fr))',gap:14}}>
          <div style={cardStyle}><small>Paid revenue</small><div style={metricStyle}>{formatCents(revenueCents)}</div><small>{paid.length} paid orders</small></div>
          <div style={cardStyle}><small>Revenue · last 30 days</small><div style={metricStyle}>{formatCents(revenue30Cents)}</div><small>rolling 30-day sales</small></div>
          <div style={cardStyle}><small>Active paid orders</small><div style={metricStyle}>{active.length}</div><small>safe to track for fulfilment</small></div>
          <div style={cardStyle}><small>Customers</small><div style={metricStyle}>{customers.length}</div><small>{repeatCustomers.length} repeat customers</small></div>
          <div style={cardStyle}><small>eSIM revenue</small><div style={metricStyle}>{formatCents(esimRevenueCents)}</div><small>{paid.filter(isEsim).length} paid orders</small></div>
          <div style={cardStyle}><small>Pocket WiFi revenue</small><div style={metricStyle}>{formatCents(wifiRevenueCents)}</div><small>{paid.filter((o:any)=>!isEsim(o)).length} paid orders</small></div>
        </div>}
      </section>

      <section id="fulfilment" style={{marginTop:28}}>
        <h2>Fulfilment attention</h2>
        {fulfilmentSummaryIncomplete && <p role="status"><strong>Order-derived fulfilment queues are unavailable until the complete order and delivery ledgers can be loaded.</strong> Use the independent Stripe webhook exception panel below while the affected data source is restored or the backlog is reconciled.</p>}
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:14}}>
          {!fulfilmentSummaryIncomplete && <>
            <div style={cardStyle}><small>WiFi dispatch exceptions</small><div style={metricStyle}>{wifiDispatchExceptions.length}</div><small>departing within 2 days / unresolved</small></div>
            <div style={cardStyle}><small>eSIM fulfilment exceptions</small><div style={metricStyle}>{esimExceptions.length}</div><small>departing within 2 days / unresolved</small></div>
            <div style={cardStyle}><small>Departure schedule exceptions</small><div style={metricStyle}>{departureScheduleExceptions.length}</div><small>paid unresolved orders with invalid travel starts</small></div>
            <div style={cardStyle}><small>WiFi returns due</small><div style={metricStyle}>{returnDueOrders.length}</div><small>{overdueReturnOrders.length} more than {POCKET_WIFI_RETURN_GRACE_DAYS} days overdue</small></div>
            <div style={cardStyle}><small>WiFi return schedule exceptions</small><div style={metricStyle}>{returnScheduleExceptions.length}</div><small>in-custody routers with invalid rental end dates</small></div>
            <div style={cardStyle}><small>Ops email exceptions</small><div style={metricStyle}>{notificationExceptions.length}</div><small>paid Stripe-order notifications not confirmed sent</small></div>
            <div style={cardStyle}><small>Meta CAPI exceptions</small><div style={metricStyle}>{metaDeliveryExceptions.length}</div><small>consented purchases not confirmed delivered</small></div>
          </>}
          <div style={cardStyle}><small>Stripe webhook exceptions</small>{webhookSummaryIncomplete
            ? <><div style={{...metricStyle,fontSize:22}}>Unavailable</div><small>complete recovery ledger required</small></>
            : <><div style={metricStyle}>{webhookFailures.length}</div><small>failed or abandoned events awaiting a signed retry</small></>}</div>
        </div>
        {!ordersIncomplete && departureScheduleExceptions.length > 0 && <div role="alert" style={{...cardStyle,borderColor:'#dc2626',background:'#fef2f2',marginTop:14}}>
          <strong>Paid-order departure schedules need reconciliation.</strong>
          <div style={{marginTop:6}}>These orders still require dispatch or digital fulfilment but have no valid travel start date. Verify the durable order against Stripe or the protected manual-sale record, contact the customer when necessary, and correct the source record before relying on departure urgency.</div>
          <ul>{departureScheduleExceptions.slice(0,50).map((order:any)=><li key={order.id} style={{marginBottom:8}}>
            <a href={`#order-${order.id}`}><strong>Order #{order.id}</strong></a>
            {' · '}{order.customer_name || order.email || order.phone || 'Customer details unavailable'}
            {' · '}{isEsim(order) ? 'eSIM' : 'Pocket WiFi'}
            {' · '}status <code>{order.fulfilment_status || 'unknown'}</code>
            {' · '}travel start <code>{order.travel_start || 'missing'}</code>
          </li>)}</ul>
          {departureScheduleExceptions.length > 50 && <div><strong>{departureScheduleExceptions.length - 50} more departure schedule exceptions are not expanded here.</strong> Review the flagged order rows below to reconcile the full queue.</div>}
        </div>}
        {!ordersIncomplete && returnDueOrders.length > 0 && <div role="alert" style={{...cardStyle,borderColor:overdueReturnOrders.length > 0 ? '#dc2626' : '#b45309',background:overdueReturnOrders.length > 0 ? '#fef2f2' : '#fffbeb',marginTop:14}}>
          <strong>{overdueReturnOrders.length > 0 ? 'Pocket WiFi returns need immediate follow-up.' : 'Pocket WiFi returns are due.'}</strong>
          <div style={{marginTop:6}}>Confirm the device is in transit, record the return tracking reference, and use the protected receipt action only after the physical router is received and inspected.</div>
          <ul>{returnDueOrders.slice(0,50).map((order:any)=>{
            const days = daysFromToday(order.travel_end);
            const daysPastTrip = typeof days === 'number' ? Math.abs(days) : null;
            const overdue = pocketWifiReturnTiming(order.travel_end, order.fulfilment_status) === 'overdue';
            return <li key={order.id} style={{marginBottom:8}}>
              <a href={`#order-${order.id}`}><strong>Order #{order.id}</strong></a>
              {' · '}{order.customer_name || order.email || order.phone || 'Customer details unavailable'}
              {' · '}trip ended {order.travel_end}
              {daysPastTrip !== null && <> ({daysPastTrip} day{daysPastTrip === 1 ? '' : 's'} ago)</>}
              {' · '}status <code>{order.fulfilment_status || 'unknown'}</code>
              {' · '}{order.return_tracking ? <>return reference <code>{order.return_tracking}</code></> : <strong>no return reference recorded</strong>}
              {overdue && <> · <strong>overdue</strong></>}
            </li>;
          })}</ul>
          {returnDueOrders.length > 50 && <div><strong>{returnDueOrders.length - 50} more due returns are not expanded here.</strong> Review the flagged order rows below to reconcile the full queue.</div>}
        </div>}
        {!ordersIncomplete && returnScheduleExceptions.length > 0 && <div role="alert" style={{...cardStyle,borderColor:'#dc2626',background:'#fef2f2',marginTop:14}}>
          <strong>Pocket WiFi return schedules need reconciliation.</strong>
          <div style={{marginTop:6}}>These paid orders record a router outside operations but do not have a valid rental end date. Verify the durable order against Stripe and the customer booking before giving return instructions or releasing inventory.</div>
          <ul>{returnScheduleExceptions.slice(0,50).map((order:any)=><li key={order.id} style={{marginBottom:8}}>
            <a href={`#order-${order.id}`}><strong>Order #{order.id}</strong></a>
            {' · '}{order.customer_name || order.email || order.phone || 'Customer details unavailable'}
            {' · '}status <code>{order.fulfilment_status || 'unknown'}</code>
            {' · '}rental end <code>{order.travel_end || 'missing'}</code>
          </li>)}</ul>
          {returnScheduleExceptions.length > 50 && <div><strong>{returnScheduleExceptions.length - 50} more schedule exceptions are not expanded here.</strong> Review the flagged order rows below to reconcile the full queue.</div>}
        </div>}
        {!stripeEventResult.error && webhookFailures.length > 0 && <div role="alert" style={{...cardStyle,borderColor:'#dc2626',background:'#fef2f2',marginTop:14}}>
          <strong>Payment processing needs attention.</strong>
          <div style={{marginTop:6}}>Stripe may still retry recent events, but automatic retries are finite. Open the signed event in Stripe, reconcile it against the order and delivery ledgers, then use Stripe’s manual resend when needed. Do not ask the customer to pay again.{stripeEventResult.truncated && <> This is a bounded investigation sample, not the complete exception queue.</>}</div>
          <ul>{webhookFailures.slice(0,50).map((failure:any)=>{
            const stripeUrl = stripeEventDashboardUrl(failure.event_id);
            const persistedOrder = ordersIncomplete ? undefined : orderByStripeSession.get(failure.stripe_session_id);
            return <li key={failure.event_id} style={{marginBottom:8}}>
              <code>{failure.event_type}</code>
              {failure.stripe_session_id && <> · session <code>{failure.stripe_session_id}</code></>}
              {' · '}attempt {failure.attempts}
              {' · '}received {formatSingaporeTimestamp(failure.received_at)} SGT
              {failure.last_failed_at && <> · last failed {formatSingaporeTimestamp(failure.last_failed_at)} SGT</>}
              {' · '}{ordersIncomplete
                ? <strong> order persistence lookup unavailable</strong>
                : persistedOrder
                  ? <>order #{persistedOrder.id} recorded as <code>{persistedOrder.payment_status || 'unknown'}</code></>
                  : <strong> no order record</strong>}
              {' · '}{String(failure.last_error||'Processing worker stopped before completion').slice(0,180)}
              {stripeUrl && <> · <a href={stripeUrl} target="_blank" rel="noreferrer"><strong>Open Stripe event ↗</strong></a></>}
            </li>;
          })}</ul>
          {webhookFailures.length > 50 && <div><strong>{webhookFailures.length - 50} more webhook exceptions are not expanded here.</strong> Use the total above and Stripe/Supabase ledgers to reconcile the full queue.</div>}
        </div>}
      </section>
    </>}

    <section id="orders" style={{marginTop:34}}>
      <h2>Orders</h2>
      {ordersUnavailable ? <p><strong>Orders are unavailable.</strong> Restore the database/schema connection and refresh; this is not an empty order ledger.</p> : result.truncated ? <p role="status"><strong>Showing the first {ADMIN_MAX_ROWS.toLocaleString()} orders only.</strong> Use these rows for investigation, not totals or a complete fulfilment queue.</p> : supabase && orders.length === 0 && <p>No orders yet.</p>}
      {orders.length > 0 && <div style={{overflowX:'auto',...cardStyle,padding:0}}><table style={{width:'100%',borderCollapse:'collapse',minWidth:1180}}>
        <thead><tr style={{background:'#f8fafc'}}><th align="left" style={{padding:'12px 10px'}}>Order / created</th><th align="left">Customer</th><th align="left">Product / trip</th><th align="left">Payment / confirmed</th><th align="left">Amount</th><th align="left">Ops email</th><th align="left">Meta CAPI</th><th align="left">Fulfilment</th></tr></thead>
        <tbody>{orders.map((o:any)=>{
          const flag = tripFlag(o);
          const product = isEsim(o) ? 'eSIM' : isPocketWifiProduct(o.product_type) ? 'Pocket WiFi' : 'Unknown product';
          const stripeCheckoutOrder = isStripeCheckoutOrder(o);
          const notification:any = notificationBySession.get(o.stripe_session_id);
          const metaDelivery:any = metaDeliveryBySession.get(o.stripe_session_id);
          // The recovery endpoint retries both delivery ledgers idempotently.
          // Expose it for a missing/failed Meta event even after the ops email
          // was successfully sent, which is the common post-Stripe-retry case.
          const canRetryNotifications = o.payment_status === 'paid' && isSupportedProduct(o.product_type) && stripeCheckoutOrder && (
            (fulfilmentNotificationActionable(o.product_type, o.fulfilment_status) && notification?.status !== 'sent') ||
            (metaCapiConfigured && o.measurement_consent === 'accepted' && metaDelivery?.status !== 'sent')
          );
          const supportReference = customerOrderReference(o.stripe_session_id);
          return <tr id={`order-${o.id}`} key={o.id} style={{borderTop:'1px solid #e5e8ed',verticalAlign:'top'}}>
            <td style={{padding:'14px 10px',maxWidth:220}}>{supportReference && <><strong>{supportReference}</strong><br/></>}<code style={{overflowWrap:'anywhere'}}>{String(o.stripe_session_id || o.id)}</code><br/><small>{formatSingaporeTimestamp(o.created_at)} SGT</small></td>
            <td style={{padding:'14px 8px'}}>{o.customer_name || '-'}<br/><small>{o.phone || '-'}</small>{o.email && <><br/><small>{o.email}</small></>}</td>
            <td style={{padding:'14px 8px'}}><strong>{product}</strong>{o.plan_name && <><br/><small>{o.plan_name}</small></>}{isEsim(o) && o.plan_id && <><br/><small>Plan ID: {o.plan_id}</small></>}{isEsim(o) && o.data_allowance && <><br/><small>Data: {o.data_allowance}</small></>}<br/>{o.country || '-'}<br/><small>{o.travel_start || '-'} → {o.travel_end || '-'}</small>{flag && <><br/><small><strong>{flag}</strong></small></>}</td>
            <td style={{padding:'14px 8px'}}>{o.payment_status || '-'}<br/><small>{o.payment_status === 'paid' ? `${formatSingaporeTimestamp(o.payment_confirmed_at)} SGT` : 'Not confirmed'}</small></td>
            <td style={{padding:'14px 8px'}}><strong>{money(o.amount_sgd)}</strong></td>
            <td style={{padding:'14px 8px'}}>{notification?.status === 'sent' ? '✓ Sent' : notification ? `⚠ ${notification.status}` : o.payment_status === 'paid' && stripeCheckoutOrder ? '⚠ Not recorded' : o.payment_status === 'paid' ? 'Manual sale · operator recorded' : '-'}{notification?.last_error && <><br/><small>{String(notification.last_error).slice(0,120)}</small></>}</td>
            <td style={{padding:'14px 8px'}}>{metaDelivery?.status === 'sent' ? '✓ Sent' : !metaCapiConfigured && o.measurement_consent === 'accepted' ? 'CAPI unavailable' : metaDelivery ? `⚠ ${metaDelivery.status}` : o.payment_status === 'paid' && stripeCheckoutOrder ? 'Not requested / not recorded' : o.payment_status === 'paid' ? 'Manual sale · no measurement consent' : '-'}{metaDelivery?.last_error && <><br/><small>{String(metaDelivery.last_error).slice(0,120)}</small></>}</td>
            <td style={{padding:'14px 8px'}}>{o.return_disposition && <small>Return: {String(o.return_disposition).replaceAll('_',' ')}</small>}{isEsim(o) && o.digital_delivery_reference && <small>{isSafeDigitalDeliveryReference(o.digital_delivery_reference) ? 'Delivery audit reference recorded' : '⚠ Unsafe legacy delivery value hidden — review support record'}</small>}<AdminOrderActions key={`${o.id}:${o.updated_at}`} id={o.id} initialStatus={o.fulfilment_status} initialUpdatedAt={o.updated_at} paymentStatus={o.payment_status} productType={o.product_type} courierTracking={o.courier_tracking} returnTracking={o.return_tracking} initialReturnDisposition={o.return_disposition} digitalDeliveryReference={isSafeDigitalDeliveryReference(o.digital_delivery_reference) ? o.digital_delivery_reference : ''} inventoryItemId={o.inventory_item_id} inventoryItems={inventoryItems} canRetryNotifications={canRetryNotifications}/></td>
          </tr>;
        })}</tbody>
      </table></div>}
    </section>

    <section id="customers" style={{marginTop:34}}>
      <h2>Customer CRM</h2>
      <p style={{color:'#64748b'}}>Customer history is aggregated from paid orders. This is the first CRM layer; lead stages, notes, tasks and WhatsApp history can be added next.</p>
      {reportingIncomplete && <p><strong>Customer order history is unavailable until the complete paid ledger is loaded and valid.</strong></p>}
      {!reportingIncomplete && customers.length > 0 && <div style={{overflowX:'auto',...cardStyle,padding:0}}><table style={{width:'100%',borderCollapse:'collapse',minWidth:760}}>
        <thead><tr style={{background:'#f8fafc'}}><th align="left" style={{padding:'12px 10px'}}>Customer</th><th align="left">Products</th><th align="left">Orders</th><th align="left">Lifetime value</th><th align="left">Last purchase</th></tr></thead>
        <tbody>{customers.slice(0,200).map((c:any,idx:number)=><tr key={`${c.email || c.phone || c.name}-${idx}`} style={{borderTop:'1px solid #e5e8ed'}}>
          <td style={{padding:'14px 10px'}}><strong>{c.name || '-'}</strong><br/><small>{c.email || '-'}</small><br/><small>{c.phone || '-'}</small></td>
          <td>{Array.from(c.products).join(' + ')}</td>
          <td>{c.orders}{c.orders > 1 ? ' · Repeat' : ''}</td>
          <td><strong>{formatCents(c.revenue)}</strong></td>
          <td>{formatSingaporeDate(c.last, '-')}</td>
        </tr>)}</tbody>
      </table></div>}
    </section>

    <p style={{marginTop:28}}><strong>Access:</strong> this page and its admin API are protected by application middleware in production.</p>
  </main>;
}
