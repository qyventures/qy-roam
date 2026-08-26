import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import AdminOrderActions from '@/components/AdminOrderActions';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const supabase = getSupabaseAdmin();
  const result = supabase
    ? await supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(100)
    : { data: [] as any[] };
  const orders: any[] = result.data ?? [];

  const active = orders.filter((o:any)=>!['closed','cancelled'].includes(o.fulfilment_status));
  const revenue = orders.filter((o:any)=>o.payment_status === 'paid').reduce((sum:number,o:any)=>sum + Number(o.amount_sgd || 0), 0);

  return <main className="wrap section legal">
    <span className="eyebrow">Operations</span><h1>QY Roam Orders</h1>
    {!supabase && <p>Order database is not configured yet.</p>}
    {supabase && <p><strong>{active.length}</strong> active orders · <strong>{orders.length}</strong> recent orders · <strong>S${revenue.toFixed(2)}</strong> paid revenue</p>}
    {supabase && orders.length === 0 && <p>No paid orders yet.</p>}
    {orders.length > 0 && <div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse'}}>
      <thead><tr><th align="left">Order</th><th align="left">Customer</th><th align="left">Trip</th><th align="left">Amount</th><th align="left">Fulfilment</th></tr></thead>
      <tbody>{orders.map((o:any)=><tr key={o.id} style={{borderTop:'1px solid #e5e8ed',verticalAlign:'top'}}>
        <td style={{padding:'14px 8px'}}>{String(o.stripe_session_id).slice(-10)}</td>
        <td style={{padding:'14px 8px'}}>{o.customer_name}<br/><small>{o.phone}</small></td>
        <td style={{padding:'14px 8px'}}>{o.country}<br/><small>{o.travel_start} → {o.travel_end}</small></td>
        <td style={{padding:'14px 8px'}}>S${Number(o.amount_sgd).toFixed(2)}</td>
        <td style={{padding:'14px 8px'}}><AdminOrderActions id={o.id} initialStatus={o.fulfilment_status} courierTracking={o.courier_tracking} returnTracking={o.return_tracking}/></td>
      </tr>)}</tbody>
    </table></div>}
    <p><strong>Access:</strong> this page and its admin API are protected by the application middleware in production.</p>
  </main>;
}
