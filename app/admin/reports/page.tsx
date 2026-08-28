import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
export const dynamic='force-dynamic';
const card={border:'1px solid #e4e8ef',borderRadius:16,padding:18,background:'#fff'} as const;
const money=(v:any)=>`S$${Number(v||0).toFixed(2)}`;
export default async function ReportsPage(){
 const db=getSupabaseAdmin();
 const rows=db?((await db.from('sales_daily_summary').select('*').order('sales_date',{ascending:false}).limit(120)).data??[]):[];
 const revenue=rows.reduce((s:any,x:any)=>s+Number(x.revenue_sgd||0),0);
 const orders=rows.reduce((s:any,x:any)=>s+Number(x.paid_orders||0),0);
 const wifi=rows.filter((x:any)=>x.product_type==='pocket_wifi').reduce((s:any,x:any)=>s+Number(x.revenue_sgd||0),0);
 const esim=rows.filter((x:any)=>x.product_type==='esim').reduce((s:any,x:any)=>s+Number(x.revenue_sgd||0),0);
 return <main className="wrap section legal" style={{maxWidth:1280}}><span className="eyebrow">Reports</span><h1>Sales & performance reporting</h1>{!db&&<div style={card}><strong>Database connection required.</strong></div>}{db&&<><div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:12}}><div style={card}><small>Reported revenue</small><h2>{money(revenue)}</h2></div><div style={card}><small>Paid orders</small><h2>{orders}</h2></div><div style={card}><small>Pocket WiFi</small><h2>{money(wifi)}</h2></div><div style={card}><small>eSIM</small><h2>{money(esim)}</h2></div><div style={card}><small>Average order value</small><h2>{money(orders?revenue/orders:0)}</h2></div></div><h2 style={{marginTop:28}}>Daily sales</h2>{rows.length===0?<p>No sales data yet.</p>:<div style={{overflowX:'auto',...card}}><table style={{width:'100%',borderCollapse:'collapse',minWidth:680}}><thead><tr><th align="left">Date</th><th align="left">Product</th><th align="right">Orders</th><th align="right">Revenue</th><th align="right">AOV</th></tr></thead><tbody>{rows.map((r:any,i:number)=><tr key={`${r.sales_date}-${r.product_type}-${i}`} style={{borderTop:'1px solid #e5e7eb'}}><td>{r.sales_date}</td><td>{r.product_type}</td><td align="right">{r.paid_orders}</td><td align="right">{money(r.revenue_sgd)}</td><td align="right">{money(r.avg_order_value_sgd)}</td></tr>)}</tbody></table></div>}</>}</main>;
}
