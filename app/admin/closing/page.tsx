import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { ClosingForm } from '@/components/AdminOpsForms';
import { runAdminDashboardWork } from '@/lib/adminDashboardConcurrency';
import { validatedClosingPeriodRow } from '@/lib/closingPeriodRow';
export const dynamic='force-dynamic';
const card={border:'1px solid #e4e8ef',borderRadius:16,padding:18,background:'#fff'} as const;
const CLOSING_PERIOD_DISPLAY_LIMIT=24;
const money=(cents:number)=>`S$${(cents/100).toFixed(2)}`;
export default async function ClosingPage(){
 const db=getSupabaseAdmin();
 const periodsResult=db?await runAdminDashboardWork(
  async()=>db.from('closing_periods').select('*').order('period_end',{ascending:false}).order('id',{ascending:false}).limit(CLOSING_PERIOD_DISPLAY_LIMIT+1),
  {data:null,error:new Error('Admin dashboard is busy')},
 ):null;
 const rawPeriods=periodsResult?.data??[];
 const historyTruncated=rawPeriods.length>CLOSING_PERIOD_DISPLAY_LIMIT;
 const periodRows=rawPeriods.slice(0,CLOSING_PERIOD_DISPLAY_LIMIT).map(validatedClosingPeriodRow);
 const periods=periodRows.filter((row):row is NonNullable<typeof row>=>row!==null);
 const periodsUnavailable=Boolean(periodsResult?.error);
 const malformed=periodRows.some(row=>row===null);
 const reportingIncomplete=periodsUnavailable||historyTruncated||malformed;
 const open=periods.filter(x=>x.status==='open');
 const gp=periods.reduce((sum,x)=>sum+x.gross_profit_cents,0);
 const net=periods.reduce((sum,x)=>sum+x.net_sales_cents,0);
 const metric=(value:string|number)=>reportingIncomplete?'—':value;
 return <main className="wrap section legal" style={{maxWidth:1280}}><span className="eyebrow">Closing</span><h1>Month-end closing & reconciliation</h1>{!db&&<div style={card}><strong>Database connection required.</strong></div>}{db&&<>{periodsUnavailable&&<div role="alert" style={{...card,borderColor:'#dc2626',background:'#fef2f2',marginBottom:20}}><strong>Closing-period data is currently unavailable.</strong><div style={{marginTop:6}}>Do not treat zero totals or an empty register as a reconciled position. Restore the database/schema connection and refresh before saving or locking a period.</div></div>}{malformed&&<div role="alert" style={{...card,borderColor:'#dc2626',background:'#fef2f2',marginBottom:20}}><strong>Closing-period data failed financial validation.</strong><div style={{marginTop:6}}>Headline totals are hidden and malformed rows are withheld. Reconcile period dates, lifecycle fields, and exact accounting equations before relying on this register.</div></div>}{historyTruncated&&<div role="alert" style={{...card,borderColor:'#d97706',background:'#fffbeb',marginBottom:20}}><strong>Closing history exceeds this operational view.</strong><div style={{marginTop:6}}>Only the newest {CLOSING_PERIOD_DISPLAY_LIMIT} periods are shown. Headline totals are hidden because they would not represent the complete register.</div></div>}<div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(190px,1fr))',gap:12}}><div style={card}><small>Open periods</small><h2>{metric(open.length)}</h2></div><div style={card}><small>Recorded periods</small><h2>{metric(periods.length)}</h2></div><div style={card}><small>Recorded net sales</small><h2>{metric(money(net))}</h2></div><div style={card}><small>Recorded gross profit</small><h2>{metric(money(gp))}</h2></div></div><ClosingForm/><p style={{marginTop:18,color:'#64748b'}}>Gross sales are calculated from paid QY Roam orders for the selected period. Staff enter refunds, payment fees and COGS before saving or locking the period.</p><h2 style={{marginTop:28}}>Closing register</h2>{periodsUnavailable?<p>Closing-period data is unavailable; no conclusion can be drawn from this page.</p>:periods.length===0?<p>No valid closing periods yet.</p>:<div style={{overflowX:'auto',...card}}><table style={{width:'100%',borderCollapse:'collapse',minWidth:980}}><thead><tr><th align="left">Period</th><th align="left">Status</th><th align="right">Gross sales</th><th align="right">Refunds</th><th align="right">Net sales</th><th align="right">Fees</th><th align="right">COGS</th><th align="right">Gross profit</th><th align="left">Closed by</th></tr></thead><tbody>{periods.map(p=><tr key={p.id} style={{borderTop:'1px solid #e5e7eb'}}><td>{p.period_start} → {p.period_end}</td><td>{p.status}</td><td align="right">{money(p.gross_sales_cents)}</td><td align="right">{money(p.refunds_cents)}</td><td align="right">{money(p.net_sales_cents)}</td><td align="right">{money(p.fees_cents)}</td><td align="right">{money(p.cogs_cents)}</td><td align="right"><strong>{money(p.gross_profit_cents)}</strong></td><td>{p.closed_by||'-'}</td></tr>)}</tbody></table></div>}</>}</main>;
}
