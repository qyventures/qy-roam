import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { ClosingForm } from '@/components/AdminOpsForms';
export const dynamic='force-dynamic';
const card={border:'1px solid #e4e8ef',borderRadius:16,padding:18,background:'#fff'} as const;
const money=(v:any)=>`S$${Number(v||0).toFixed(2)}`;
export default async function ClosingPage(){
 const db=getSupabaseAdmin();
 const periods=db?((await db.from('closing_periods').select('*').order('period_end',{ascending:false}).limit(24)).data??[]):[];
 const open=periods.filter((x:any)=>x.status==='open');
 const gp=periods.reduce((s:any,x:any)=>s+Number(x.gross_profit_sgd||0),0);
 const net=periods.reduce((s:any,x:any)=>s+Number(x.net_sales_sgd||0),0);
 return <main className="wrap section legal" style={{maxWidth:1280}}><span className="eyebrow">Closing</span><h1>Month-end closing & reconciliation</h1>{!db&&<div style={card}><strong>Database connection required.</strong></div>}{db&&<><div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(190px,1fr))',gap:12}}><div style={card}><small>Open periods</small><h2>{open.length}</h2></div><div style={card}><small>Recorded periods</small><h2>{periods.length}</h2></div><div style={card}><small>Recorded net sales</small><h2>{money(net)}</h2></div><div style={card}><small>Recorded gross profit</small><h2>{money(gp)}</h2></div></div><ClosingForm/><p style={{marginTop:18,color:'#64748b'}}>Gross sales are calculated from paid QY Roam orders for the selected period. Staff enter refunds, payment fees and COGS before saving or locking the period.</p><h2 style={{marginTop:28}}>Closing register</h2>{periods.length===0?<p>No closing periods yet.</p>:<div style={{overflowX:'auto',...card}}><table style={{width:'100%',borderCollapse:'collapse',minWidth:980}}><thead><tr><th align="left">Period</th><th align="left">Status</th><th align="right">Gross sales</th><th align="right">Refunds</th><th align="right">Net sales</th><th align="right">Fees</th><th align="right">COGS</th><th align="right">Gross profit</th><th align="left">Closed by</th></tr></thead><tbody>{periods.map((p:any)=><tr key={p.id} style={{borderTop:'1px solid #e5e7eb'}}><td>{p.period_start} → {p.period_end}</td><td>{p.status}</td><td align="right">{money(p.gross_sales_sgd)}</td><td align="right">{money(p.refunds_sgd)}</td><td align="right">{money(p.net_sales_sgd)}</td><td align="right">{money(p.fees_sgd)}</td><td align="right">{money(p.cogs_sgd)}</td><td align="right"><strong>{money(p.gross_profit_sgd)}</strong></td><td>{p.closed_by||'-'}</td></tr>)}</tbody></table></div>}</>}</main>;
}
