import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import AdminOrderActions from '@/components/AdminOrderActions';

export const dynamic = 'force-dynamic';

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
  const result = supabase
    ? await supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(500)
    : { data: [] as any[] };
  const orders: any[] = result.data ?? [];

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
        </div>
      </section>
    </>}

    <section id="orders" style={{marginTop:34}}>
      <h2>Orders</h2>
      {supabase && orders.length === 0 && <p>No orders yet.</p>}
      {orders.length > 0 && <div style={{overflowX:'auto',...cardStyle,padding:0}}><table style={{width:'100%',borderCollapse:'collapse',minWidth:920}}>
        <thead><tr style={{background:'#f8fafc'}}><th align="left" style={{padding:'12px 10px'}}>Order</th><th align="left">Customer</th><th align="left">Product / trip</th><th align="left">Payment</th><th align="left">Amount</th><th align="left">Fulfilment</th></tr></thead>
        <tbody>{orders.map((o:any)=>{
          const flag = tripFlag(o);
          const product = isEsim(o) ? 'eSIM' : 'Pocket WiFi';
          return <tr key={o.id} style={{borderTop:'1px solid #e5e8ed',verticalAlign:'top'}}>
            <td style={{padding:'14px 10px'}}><strong>{String(o.stripe_session_id || o.id).slice(-10)}</strong><br/><small>{o.created_at ? new Date(o.created_at).toLocaleDateString('en-SG') : ''}</small></td>
            <td style={{padding:'14px 8px'}}>{o.customer_name || '-'}<br/><small>{o.phone || '-'}</small>{o.email && <><br/><small>{o.email}</small></>}</td>
            <td style={{padding:'14px 8px'}}><strong>{product}</strong>{o.plan_name && <><br/><small>{o.plan_name}</small></>}<br/>{o.country || '-'}<br/><small>{o.travel_start || '-'} → {o.travel_end || '-'}</small>{flag && <><br/><small><strong>{flag}</strong></small></>}</td>
            <td style={{padding:'14px 8px'}}>{o.payment_status || '-'}</td>
            <td style={{padding:'14px 8px'}}><strong>{money(o.amount_sgd)}</strong></td>
            <td style={{padding:'14px 8px'}}><AdminOrderActions id={o.id} initialStatus={o.fulfilment_status} productType={o.product_type} courierTracking={o.courier_tracking} returnTracking={o.return_tracking}/></td>
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
