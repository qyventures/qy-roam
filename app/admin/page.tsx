import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import AdminOrderActions from '@/components/AdminOrderActions';
import { fulfilmentNotificationActionable, STRIPE_EVENT_CLAIM_STALE_MS } from '@/lib/orderLifecycle';
import { hasRequiredMetaCapiPurchaseConfig } from '@/lib/runtimeConfig';
import { isSafeDigitalDeliveryReference } from '@/lib/digitalDeliveryReference';

export const dynamic = 'force-dynamic';

// Supabase caps a single select response. The operations dashboard must not
// quietly become a view of only the newest orders once that cap is reached:
// old unresolved returns and unsent fulfilment notices are still actionable.
// Keep requests bounded for a server-rendered admin page, but make a growing
// data set visible to staff before it can hide operational work.
const ADMIN_PAGE_SIZE = 250;
const ADMIN_MAX_ROWS = 5_000;

type PagedResult = { data: any[]; error: any; truncated: boolean };

async function loadPages(fetchPage: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: any }>): Promise<PagedResult> {
  const data: any[] = [];
  for (let from = 0; from < ADMIN_MAX_ROWS; from += ADMIN_PAGE_SIZE) {
    const result = await fetchPage(from, from + ADMIN_PAGE_SIZE - 1);
    if (result.error) return { data: [], error: result.error, truncated: false };
    const page = result.data || [];
    data.push(...page);
    if (page.length < ADMIN_PAGE_SIZE) return { data, error: null, truncated: false };
  }
  return { data, error: null, truncated: true };
}

function localDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00+08:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysFromToday(value: string | null | undefined) {
  const target = localDate(value);
  if (!target) return null;
  const now = new Date();
  const todaySg = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
  todaySg.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - todaySg.getTime()) / 86400000);
}

function isEsim(order: any) { return order.product_type === 'esim'; }
function money(value: number) { return `S$${Number(value || 0).toFixed(2)}`; }
function isStripeCheckoutOrder(order: any) { return typeof order.stripe_session_id === 'string' && order.stripe_session_id.startsWith('cs_'); }
function customerKey(order: any) {
  return String(order.email || order.phone || order.customer_name || order.stripe_session_id || '').trim().toLowerCase();
}
function withinDays(value: string | null | undefined, days: number) {
  if (!value) return false;
  const t = new Date(value).getTime();
  return Number.isFinite(t) && t >= Date.now() - days * 86400000;
}

function tripFlag(order: any) {
  if (['closed', 'cancelled', 'payment_failed'].includes(order.fulfilment_status)) return '';
  const untilDeparture = daysFromToday(order.travel_start);
  if (isEsim(order)) {
    if (typeof untilDeparture === 'number' && untilDeparture <= 2 && !['fulfilled','closed'].includes(order.fulfilment_status)) {
      return untilDeparture < 0 ? '⚠ Departure passed — eSIM fulfilment unresolved' : `⚠ Departure in ${untilDeparture} day${untilDeparture === 1 ? '' : 's'} — issue eSIM`;
    }
    return '';
  }
  if (typeof untilDeparture === 'number' && untilDeparture <= 2 && !['dispatched', 'with_customer', 'return_due', 'returned'].includes(order.fulfilment_status)) {
    return untilDeparture < 0 ? '⚠ Departure passed — dispatch unresolved' : `⚠ Departure in ${untilDeparture} day${untilDeparture === 1 ? '' : 's'} — dispatch check`;
  }
  const afterTrip = daysFromToday(order.travel_end);
  if (typeof afterTrip === 'number' && afterTrip < -5 && !['returned', 'closed'].includes(order.fulfilment_status)) return '⚠ Return overdue';
  if (typeof afterTrip === 'number' && afterTrip < 0 && !['returned', 'closed'].includes(order.fulfilment_status)) return 'Return due';
  return '';
}

const cardStyle = {border:'1px solid #e4e8ef',borderRadius:16,padding:'18px 20px',background:'#fff',boxShadow:'0 8px 24px rgba(0,0,0,.04)'} as const;
const metricStyle = {fontSize:30,fontWeight:800,lineHeight:1.1,marginTop:6} as const;

export default async function AdminPage() {
  const supabase = getSupabaseAdmin();
  const webhookExceptionCutoff = new Date(Date.now() - STRIPE_EVENT_CLAIM_STALE_MS).toISOString();
  // An admin dashboard that quietly turns a failed query into an empty table
  // is dangerous: staff can conclude there are no orders to fulfil. Fetch the
  // independent panels together, but preserve each failure so the UI fails
  // loudly while leaving any successfully loaded operational data visible.
  const unavailable: PagedResult = { data: [], error: new Error('Order database is not configured'), truncated: false };
  const [result, inventoryResult, notificationResult, metaDeliveryResult, stripeEventResult] = supabase
    ? await Promise.all([
        loadPages((from, to) => supabase.from('orders').select('*').order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to)),
        supabase.from('inventory_items').select('id,sku,name,quantity_on_hand,status').eq('product_type', 'pocket_wifi').order('name'),
        loadPages((from, to) => supabase.from('fulfilment_notifications').select('stripe_session_id,status,last_error,last_attempt_at,sent_at').order('updated_at', { ascending: false }).order('stripe_session_id').range(from, to)),
        loadPages((from, to) => supabase.from('meta_purchase_deliveries').select('stripe_session_id,status,last_error,last_attempt_at,sent_at').order('updated_at', { ascending: false }).order('stripe_session_id').range(from, to)),
        // Include claims with no recorded error: a worker can exit after the
        // durable claim is inserted and before its catch handler runs. Recent
        // claims are filtered below, while abandoned leases must be visible to
        // operations even before Stripe's next scheduled retry arrives.
        supabase.from('stripe_events').select('event_id,event_type,stripe_session_id,attempts,processing_started_at,last_failed_at,last_error').is('processed_at', null).or(`last_error.not.is.null,processing_started_at.lt.${webhookExceptionCutoff}`).order('processing_started_at', { ascending: false }).limit(100),
      ])
    : [unavailable, unavailable, unavailable, unavailable, unavailable];
  const orders: any[] = result.data ?? [];
  const inventoryItems: any[] = inventoryResult.data ?? [];
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
    if (event.last_error) return true;
    const processingStartedMs = new Date(event.processing_started_at).getTime();
    return Number.isFinite(processingStartedMs) && Date.now() - processingStartedMs > STRIPE_EVENT_CLAIM_STALE_MS;
  });
  const failedPanels = [
    result.error && 'orders',
    inventoryResult.error && 'inventory',
    notificationResult.error && 'fulfilment notifications',
    metaDeliveryResult.error && 'Meta delivery status',
    stripeEventResult.error && 'Stripe webhook failures',
  ].filter(Boolean) as string[];
  const truncatedPanels = [
    result.truncated && 'orders',
    notificationResult.truncated && 'fulfilment notifications',
    metaDeliveryResult.truncated && 'Meta delivery status',
  ].filter(Boolean) as string[];

  const paid = orders.filter((o:any)=>o.payment_status === 'paid');
  const active = orders.filter((o:any)=>!['closed','cancelled','payment_failed'].includes(o.fulfilment_status));
  const revenue = paid.reduce((sum:number,o:any)=>sum + Number(o.amount_sgd || 0), 0);
  const revenue30 = paid.filter((o:any)=>withinDays(o.created_at,30)).reduce((sum:number,o:any)=>sum + Number(o.amount_sgd || 0), 0);
  const esimRevenue = paid.filter(isEsim).reduce((sum:number,o:any)=>sum + Number(o.amount_sgd || 0), 0);
  const wifiRevenue = paid.filter((o:any)=>!isEsim(o)).reduce((sum:number,o:any)=>sum + Number(o.amount_sgd || 0), 0);

  const customerMap = new Map<string, any>();
  for (const o of paid) {
    const key = customerKey(o);
    if (!key) continue;
    const current = customerMap.get(key) || {name:o.customer_name,email:o.email,phone:o.phone,orders:0,revenue:0,last:o.created_at,products:new Set<string>()};
    current.orders += 1;
    current.revenue += Number(o.amount_sgd || 0);
    current.products.add(isEsim(o) ? 'eSIM' : 'Pocket WiFi');
    if (String(o.created_at || '') > String(current.last || '')) current.last = o.created_at;
    customerMap.set(key,current);
  }
  const customers = Array.from(customerMap.values()).sort((a,b)=>String(b.last).localeCompare(String(a.last)));
  const repeatCustomers = customers.filter(c=>c.orders > 1);

  const wifiDispatchExceptions = active.filter((o:any) => {
    if (isEsim(o)) return false;
    const days = daysFromToday(o.travel_start);
    return typeof days === 'number' && days <= 2 && !['dispatched','with_customer','return_due','returned'].includes(o.fulfilment_status);
  });
  const esimExceptions = active.filter((o:any) => {
    if (!isEsim(o)) return false;
    const days = daysFromToday(o.travel_start);
    return typeof days === 'number' && days <= 2 && !['fulfilled','closed'].includes(o.fulfilment_status);
  });
  const returnExceptions = active.filter((o:any) => {
    if (isEsim(o)) return false;
    const days = daysFromToday(o.travel_end);
    return typeof days === 'number' && days < -5 && !['returned','closed'].includes(o.fulfilment_status);
  });

  return <main className="wrap section legal" style={{maxWidth:1280}}>
    <span className="eyebrow">QY Roam Operations & CRM</span>
    <h1 style={{marginBottom:8}}>Sales, orders and customers</h1>
    <p style={{marginTop:0,color:'#64748b'}}>One operating view for Pocket WiFi and travel eSIM. Data is sourced from paid Stripe orders persisted in Supabase.</p>

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
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(190px,1fr))',gap:14}}>
          <div style={cardStyle}><small>Paid revenue</small><div style={metricStyle}>{money(revenue)}</div><small>{paid.length} paid orders</small></div>
          <div style={cardStyle}><small>Revenue · last 30 days</small><div style={metricStyle}>{money(revenue30)}</div><small>rolling 30-day sales</small></div>
          <div style={cardStyle}><small>Active orders</small><div style={metricStyle}>{active.length}</div><small>requiring operational tracking</small></div>
          <div style={cardStyle}><small>Customers</small><div style={metricStyle}>{customers.length}</div><small>{repeatCustomers.length} repeat customers</small></div>
          <div style={cardStyle}><small>eSIM revenue</small><div style={metricStyle}>{money(esimRevenue)}</div><small>{paid.filter(isEsim).length} paid orders</small></div>
          <div style={cardStyle}><small>Pocket WiFi revenue</small><div style={metricStyle}>{money(wifiRevenue)}</div><small>{paid.filter((o:any)=>!isEsim(o)).length} paid orders</small></div>
        </div>
      </section>

      <section id="fulfilment" style={{marginTop:28}}>
        <h2>Fulfilment attention</h2>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:14}}>
          <div style={cardStyle}><small>WiFi dispatch exceptions</small><div style={metricStyle}>{wifiDispatchExceptions.length}</div><small>departing within 2 days / unresolved</small></div>
          <div style={cardStyle}><small>eSIM fulfilment exceptions</small><div style={metricStyle}>{esimExceptions.length}</div><small>departing within 2 days / unresolved</small></div>
          <div style={cardStyle}><small>Overdue WiFi returns</small><div style={metricStyle}>{returnExceptions.length}</div><small>more than 5 days past trip end</small></div>
          <div style={cardStyle}><small>Ops email exceptions</small><div style={metricStyle}>{notificationExceptions.length}</div><small>paid Stripe-order notifications not confirmed sent</small></div>
          <div style={cardStyle}><small>Meta CAPI exceptions</small><div style={metricStyle}>{metaDeliveryExceptions.length}</div><small>consented purchases not confirmed delivered</small></div>
          <div style={cardStyle}><small>Stripe webhook exceptions</small><div style={metricStyle}>{webhookFailures.length}</div><small>failed or abandoned events awaiting a signed retry</small></div>
        </div>
        {webhookFailures.length > 0 && <div role="alert" style={{...cardStyle,borderColor:'#dc2626',background:'#fef2f2',marginTop:14}}>
          <strong>Payment processing needs attention.</strong>
          <div style={{marginTop:6}}>Stripe will retry these events automatically. Check the order and delivery ledgers before asking a customer to pay again.</div>
          <ul>{webhookFailures.slice(0,10).map((failure:any)=><li key={failure.event_id}><code>{failure.event_type}</code>{failure.stripe_session_id && <> · session <code>{failure.stripe_session_id}</code></>} · attempt {failure.attempts} · {String(failure.last_error||'Processing worker stopped before completion').slice(0,180)}</li>)}</ul>
        </div>}
      </section>
    </>}

    <section id="orders" style={{marginTop:34}}>
      <h2>Orders</h2>
      {supabase && orders.length === 0 && <p>No orders yet.</p>}
      {orders.length > 0 && <div style={{overflowX:'auto',...cardStyle,padding:0}}><table style={{width:'100%',borderCollapse:'collapse',minWidth:1040}}>
        <thead><tr style={{background:'#f8fafc'}}><th align="left" style={{padding:'12px 10px'}}>Order</th><th align="left">Customer</th><th align="left">Product / trip</th><th align="left">Payment</th><th align="left">Amount</th><th align="left">Ops email</th><th align="left">Meta CAPI</th><th align="left">Fulfilment</th></tr></thead>
        <tbody>{orders.map((o:any)=>{
          const flag = tripFlag(o);
          const product = isEsim(o) ? 'eSIM' : 'Pocket WiFi';
          const notification:any = notificationBySession.get(o.stripe_session_id);
          const metaDelivery:any = metaDeliveryBySession.get(o.stripe_session_id);
          // The recovery endpoint retries both delivery ledgers idempotently.
          // Expose it for a missing/failed Meta event even after the ops email
          // was successfully sent, which is the common post-Stripe-retry case.
          const canRetryNotifications = o.payment_status === 'paid' && isStripeCheckoutOrder(o) && (
            (fulfilmentNotificationActionable(o.product_type, o.fulfilment_status) && notification?.status !== 'sent') ||
            (metaCapiConfigured && o.measurement_consent === 'accepted' && metaDelivery?.status !== 'sent')
          );
          return <tr key={o.id} style={{borderTop:'1px solid #e5e8ed',verticalAlign:'top'}}>
            <td style={{padding:'14px 10px'}}><strong>{String(o.stripe_session_id || o.id).slice(-10)}</strong><br/><small>{o.created_at ? new Date(o.created_at).toLocaleDateString('en-SG') : ''}</small></td>
            <td style={{padding:'14px 8px'}}>{o.customer_name || '-'}<br/><small>{o.phone || '-'}</small>{o.email && <><br/><small>{o.email}</small></>}</td>
            <td style={{padding:'14px 8px'}}><strong>{product}</strong>{o.plan_name && <><br/><small>{o.plan_name}</small></>}{isEsim(o) && o.plan_id && <><br/><small>Plan ID: {o.plan_id}</small></>}{isEsim(o) && o.data_allowance && <><br/><small>Data: {o.data_allowance}</small></>}<br/>{o.country || '-'}<br/><small>{o.travel_start || '-'} → {o.travel_end || '-'}</small>{flag && <><br/><small><strong>{flag}</strong></small></>}</td>
            <td style={{padding:'14px 8px'}}>{o.payment_status || '-'}</td>
            <td style={{padding:'14px 8px'}}><strong>{money(o.amount_sgd)}</strong></td>
            <td style={{padding:'14px 8px'}}>{notification?.status === 'sent' ? '✓ Sent' : notification ? `⚠ ${notification.status}` : o.payment_status === 'paid' ? '⚠ Not recorded' : '-'}{notification?.last_error && <><br/><small>{String(notification.last_error).slice(0,120)}</small></>}</td>
            <td style={{padding:'14px 8px'}}>{metaDelivery?.status === 'sent' ? '✓ Sent' : !metaCapiConfigured && o.measurement_consent === 'accepted' ? 'CAPI unavailable' : metaDelivery ? `⚠ ${metaDelivery.status}` : o.payment_status === 'paid' ? 'Not requested / not recorded' : '-'}{metaDelivery?.last_error && <><br/><small>{String(metaDelivery.last_error).slice(0,120)}</small></>}</td>
            <td style={{padding:'14px 8px'}}>{o.return_disposition && <small>Return: {String(o.return_disposition).replaceAll('_',' ')}</small>}{isEsim(o) && o.digital_delivery_reference && <small>{isSafeDigitalDeliveryReference(o.digital_delivery_reference) ? 'Delivery audit reference recorded' : '⚠ Unsafe legacy delivery value hidden — review support record'}</small>}<AdminOrderActions id={o.id} initialStatus={o.fulfilment_status} productType={o.product_type} courierTracking={o.courier_tracking} returnTracking={o.return_tracking} digitalDeliveryReference={isSafeDigitalDeliveryReference(o.digital_delivery_reference) ? o.digital_delivery_reference : ''} inventoryItemId={o.inventory_item_id} inventoryItems={inventoryItems} canRetryNotifications={canRetryNotifications}/></td>
          </tr>;
        })}</tbody>
      </table></div>}
    </section>

    <section id="customers" style={{marginTop:34}}>
      <h2>Customer CRM</h2>
      <p style={{color:'#64748b'}}>Customer history is aggregated from paid orders. This is the first CRM layer; lead stages, notes, tasks and WhatsApp history can be added next.</p>
      {customers.length > 0 && <div style={{overflowX:'auto',...cardStyle,padding:0}}><table style={{width:'100%',borderCollapse:'collapse',minWidth:760}}>
        <thead><tr style={{background:'#f8fafc'}}><th align="left" style={{padding:'12px 10px'}}>Customer</th><th align="left">Products</th><th align="left">Orders</th><th align="left">Lifetime value</th><th align="left">Last purchase</th></tr></thead>
        <tbody>{customers.slice(0,200).map((c:any,idx:number)=><tr key={`${c.email || c.phone || c.name}-${idx}`} style={{borderTop:'1px solid #e5e8ed'}}>
          <td style={{padding:'14px 10px'}}><strong>{c.name || '-'}</strong><br/><small>{c.email || '-'}</small><br/><small>{c.phone || '-'}</small></td>
          <td>{Array.from(c.products).join(' + ')}</td>
          <td>{c.orders}{c.orders > 1 ? ' · Repeat' : ''}</td>
          <td><strong>{money(c.revenue)}</strong></td>
          <td>{c.last ? new Date(c.last).toLocaleDateString('en-SG') : '-'}</td>
        </tr>)}</tbody>
      </table></div>}
    </section>

    <p style={{marginTop:28}}><strong>Access:</strong> this page and its admin API are protected by application middleware in production.</p>
  </main>;
}
