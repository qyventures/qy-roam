import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const supabase = getSupabaseAdmin();
  const { data: orders = [] } = supabase
    ? await supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(100)
    : { data: [] as any[] };

  return <main className="wrap section legal">
    <span className="eyebrow">Operations</span><h1>QY Roam Orders</h1>
    {!supabase && <p>Order database is not configured yet.</p>}
    {supabase && orders.length === 0 && <p>No paid orders yet.</p>}
    {orders.length > 0 && <div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse'}}>
      <thead><tr><th align="left">Order</th><th align="left">Customer</th><th align="left">Trip</th><th align="left">Amount</th><th align="left">Status</th></tr></thead>
      <tbody>{orders.map((o:any)=><tr key={o.id} style={{borderTop:'1px solid #e5e8ed'}}>
        <td style={{padding:'14px 8px'}}>{String(o.stripe_session_id).slice(-10)}</td>
        <td style={{padding:'14px 8px'}}>{o.customer_name}<br/><small>{o.phone}</small></td>
        <td style={{padding:'14px 8px'}}>{o.country}<br/><small>{o.travel_start} → {o.travel_end}</small></td>
        <td style={{padding:'14px 8px'}}>S${Number(o.amount_sgd).toFixed(2)}</td>
        <td style={{padding:'14px 8px'}}>{o.fulfilment_status}</td>
      </tr>)}</tbody>
    </table></div>}
    <p><strong>Security note:</strong> this route must be protected by reverse-proxy authentication or application auth before production exposure.</p>
  </main>;
}
