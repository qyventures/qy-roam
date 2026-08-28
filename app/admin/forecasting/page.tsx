import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
export const dynamic='force-dynamic';
const card={border:'1px solid #e4e8ef',borderRadius:16,padding:18,background:'#fff'} as const;
const money=(v:any)=>`S$${Number(v||0).toFixed(2)}`;
export default async function ForecastingPage(){
 const db=getSupabaseAdmin();
 const forecasts=db?((await db.from('forecasts').select('*').order('forecast_month')).data??[]):[];
 const daily=db?((await db.from('sales_daily_summary').select('*').order('sales_date',{ascending:false}).limit(60)).data??[]):[];
 const recentRevenue=daily.reduce((s:any,x:any)=>s+Number(x.revenue_sgd||0),0);
 const uniqueDays=new Set(daily.map((x:any)=>x.sales_date)).size;
 const runRate=uniqueDays?recentRevenue/uniqueDays*30:0;
 const weighted=forecasts.reduce((s:any,x:any)=>s+Number(x.forecast_revenue_sgd||0),0);
 return <main className="wrap section legal" style={{maxWidth:1280}}><span className="eyebrow">Forecasting</span><h1>Demand & revenue forecast</h1>{!db&&<div style={card}><strong>Database connection required.</strong></div>}{db&&<><div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(190px,1fr))',gap:12}}><div style={card}><small>30-day run-rate</small><h2>{money(runRate)}</h2></div><div style={card}><small>Saved forecast revenue</small><h2>{money(weighted)}</h2></div><div style={card}><small>Forecast lines</small><h2>{forecasts.length}</h2></div></div><p style={{marginTop:18,color:'#64748b'}}>Run-rate uses recent paid sales. Saved forecasts can be used for management overrides, seasonality and inventory planning.</p><h2 style={{marginTop:28}}>Forecast plan</h2>{forecasts.length===0?<p>No saved forecast yet.</p>:<div style={{overflowX:'auto',...card}}><table style={{width:'100%',borderCollapse:'collapse',minWidth:760}}><thead><tr><th align="left">Month</th><th align="left">Product</th><th align="right">Orders</th><th align="right">Revenue</th><th align="right">Units</th><th align="left">Method</th></tr></thead><tbody>{forecasts.map((f:any)=><tr key={f.id} style={{borderTop:'1px solid #e5e7eb'}}><td>{f.forecast_month}</td><td>{f.product_type}</td><td align="right">{f.forecast_orders}</td><td align="right">{money(f.forecast_revenue_sgd)}</td><td align="right">{f.forecast_units}</td><td>{f.method}</td></tr>)}</tbody></table></div>}</>}</main>;
}
