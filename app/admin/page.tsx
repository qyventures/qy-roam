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

export default async function AdminPage() {
  const supabase = getSupabaseAdmin();
  const result = supabase
    ? await supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(100)
    : { data: [] as any[] };
  const orders: any[] = result.data ?? [];

  const active = orders.filter((o:any)=>!['closed','cancelled','payment_failed'].includes(o.fulfilment_status));
  const revenue = orders.filter((o:any)=>o.payment_status === 'paid').reduce((sum:number,o:any)=>sum + Number(o.amount_sgd || 0), 0);
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

  return <main className="wrap section legal">
    <span className="eyebrow">Operations</span><h1>QY Roam Orders</h1>
    {!supabase && <p>Order database is not configured yet.</p>}
    {supabase && <>
      <p><strong>{active.length}</strong> active orders · <strong>{orders.length}</strong> recent orders · <strong>S${revenue.toFixed(2)}</strong> paid revenue</p>
      {(wifiDispatchExceptions.length > 0 || esimExceptions.length > 0 || returnExceptions.length > 0) && <p><strong>Attention:</strong> {wifiDispatchExceptions.length} WiFi dispatch exception{wifiDispatchExceptions.length === 1 ? '' : 's'} · {esimExceptions.length} eSIM fulfilment exception{esimExceptions.length === 1 ? '' : 's'} · {returnExceptions.length} overdue WiFi return{returnExceptions.length === 1 ? '' : 's'}</p>}
    </>}
    {supabase && orders.length === 0 && <p>No paid orders yet.</p>}
    {orders.length > 0 && <div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse'}}>
      <thead><tr><th align="left">Order</th><th align="left">Customer</th><th align="left">Product / trip</th><th align="left">Amount</th><th align="left">Fulfilment</th></tr></thead>
      <tbody>{orders.map((o:any)=>{
        const flag = tripFlag(o);
        const product = isEsim(o) ? 'eSIM' : 'Pocket WiFi';
        return <tr key={o.id} style={{borderTop:'1px solid #e5e8ed',verticalAlign:'top'}}>
          <td style={{padding:'14px 8px'}}>{String(o.stripe_session_id).slice(-10)}</td>
          <td style={{padding:'14px 8px'}}>{o.customer_name}<br/><small>{o.phone}</small>{o.email && <><br/><small>{o.email}</small></>}</td>
          <td style={{padding:'14px 8px'}}><strong>{product}</strong>{o.plan_name && <><br/><small>{o.plan_name}</small></>}<br/>{o.country}<br/><small>{o.travel_start} → {o.travel_end}</small>{flag && <><br/><small><strong>{flag}</strong></small></>}</td>
          <td style={{padding:'14px 8px'}}>S${Number(o.amount_sgd).toFixed(2)}</td>
          <td style={{padding:'14px 8px'}}><AdminOrderActions id={o.id} initialStatus={o.fulfilment_status} courierTracking={o.courier_tracking} returnTracking={o.return_tracking}/></td>
        </tr>;
      })}</tbody>
    </table></div>}
    <p><strong>Access:</strong> this page and its admin API are protected by the application middleware in production.</p>
  </main>;
}
