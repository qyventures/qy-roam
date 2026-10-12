import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { ForecastForm } from '@/components/AdminOpsForms';
import { validatedForecastRow } from '@/lib/forecastRow';
import { validatedSalesReportRow } from '@/lib/salesReportRow';
import { operationalIsoDateAfter } from '@/lib/operationalDate';
import { runAdminDashboardWork } from '@/lib/adminDashboardConcurrency';
export const dynamic='force-dynamic';
const card={border:'1px solid #e4e8ef',borderRadius:16,padding:18,background:'#fff'} as const;
const FORECAST_MAX_ROWS=5_000;
const DAILY_MAX_ROWS=60;
const money=(cents:number)=>`S$${(cents/100).toFixed(2)}`;
export default async function ForecastingPage(){
 const db=getSupabaseAdmin();
 const busyResult={data:null,error:new Error('Admin dashboard is busy')};
 const [forecastResult,dailyResult]=db?await runAdminDashboardWork(()=>Promise.all([
  db.from('forecasts').select('id,forecast_month,product_type,forecast_orders,forecast_revenue_sgd,forecast_units,method,notes').order('forecast_month').order('id').limit(FORECAST_MAX_ROWS+1),
  db.from('sales_daily_summary').select('sales_date,product_type,paid_orders,revenue_sgd').gte('sales_date',operationalIsoDateAfter(-29)).order('sales_date',{ascending:false}).order('product_type').limit(DAILY_MAX_ROWS+1),
 ]),[busyResult,busyResult]):[null,null];
 const forecastRows=forecastResult?.data??[];
 const dailyRows=dailyResult?.data??[];
 const forecasts=forecastRows.slice(0,FORECAST_MAX_ROWS).map(validatedForecastRow);
 const daily=dailyRows.slice(0,DAILY_MAX_ROWS).map(validatedSalesReportRow);
 const forecastMalformed=forecasts.some(row=>row===null);
 const dailyMalformed=daily.some(row=>row===null);
 const safeForecasts=forecasts.filter((row):row is NonNullable<typeof row>=>row!==null);
 const safeDaily=daily.filter((row):row is NonNullable<typeof row>=>row!==null);
 const forecastTruncated=forecastRows.length>FORECAST_MAX_ROWS;
 const dailyTruncated=dailyRows.length>DAILY_MAX_ROWS;
 const unavailablePanels=[forecastResult?.error&&'saved forecast plan',dailyResult?.error&&'recent paid sales'].filter(Boolean) as string[];
 const reportingIncomplete=unavailablePanels.length>0||forecastMalformed||dailyMalformed||forecastTruncated||dailyTruncated;
 const recentRevenueCents=safeDaily.reduce((sum,row)=>sum+row.revenue_cents,0);
 const savedCents=safeForecasts.reduce((sum,row)=>sum+row.forecast_revenue_cents,0);
 const units=safeForecasts.reduce((sum,row)=>sum+row.forecast_units,0);
 return <main className="wrap section legal" style={{maxWidth:1280}}><span className="eyebrow">Forecasting</span><h1>Demand & revenue forecast</h1>{!db&&<div style={card}><strong>Database connection required.</strong></div>}{db&&<>{unavailablePanels.length>0&&<div role="alert" style={{...card,borderColor:'#dc2626',background:'#fef2f2',marginBottom:20}}><strong>Forecast inputs are currently unavailable: {unavailablePanels.join(', ')}.</strong><div style={{marginTop:6}}>Do not treat zero values or an empty plan as current. Restore the database/schema connection and refresh before changing demand, inventory or spend assumptions.</div></div>}{(forecastMalformed||dailyMalformed)&&<div role="alert" style={{...card,borderColor:'#dc2626',background:'#fef2f2',marginBottom:20}}><strong>Forecast inputs contain malformed financial data.</strong><div style={{marginTop:6}}>Reconcile the database rows before using this page for inventory, revenue or campaign decisions.</div></div>}{(forecastTruncated||dailyTruncated)&&<div role="alert" style={{...card,borderColor:'#b45309',background:'#fffbeb',marginBottom:20}}><strong>Forecast inputs exceed the bounded reporting view.</strong><div style={{marginTop:6}}>The totals below are withheld because the saved plan or trailing 30-day sales window is incomplete.</div></div>}<div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(190px,1fr))',gap:12}}><div style={card}><small>Paid revenue · trailing 30 calendar days</small><h2>{reportingIncomplete?'—':money(recentRevenueCents)}</h2></div><div style={card}><small>Saved forecast revenue</small><h2>{reportingIncomplete?'—':money(savedCents)}</h2></div><div style={card}><small>Forecast units</small><h2>{reportingIncomplete?'—':units}</h2></div><div style={card}><small>Forecast lines</small><h2>{reportingIncomplete?'—':safeForecasts.length}</h2></div></div><ForecastForm/><p style={{marginTop:18,color:'#64748b'}}>Trailing revenue uses paid sales from the latest 30 Singapore calendar days. Saved forecasts are management overrides for seasonality, campaigns and inventory planning.</p><h2 style={{marginTop:28}}>Forecast plan</h2>{forecastResult?.error?<p>Forecast plan is unavailable; no conclusion can be drawn from this page.</p>:forecastMalformed?<p>Forecast plan contains malformed rows and is withheld pending reconciliation.</p>:safeForecasts.length===0?<p>No saved forecast yet.</p>:<div style={{overflowX:'auto',...card}}><table style={{width:'100%',borderCollapse:'collapse',minWidth:820}}><thead><tr><th align="left">Month</th><th align="left">Product</th><th align="right">Orders</th><th align="right">Revenue</th><th align="right">Units</th><th align="left">Method</th><th align="left">Notes</th></tr></thead><tbody>{safeForecasts.map(f=><tr key={f.id} style={{borderTop:'1px solid #e5e7eb'}}><td>{f.forecast_month}</td><td>{f.product_type}</td><td align="right">{f.forecast_orders}</td><td align="right">{money(f.forecast_revenue_cents)}</td><td align="right">{f.forecast_units}</td><td>{f.method}</td><td>{f.notes||'-'}</td></tr>)}</tbody></table></div>}</>}</main>;
}
