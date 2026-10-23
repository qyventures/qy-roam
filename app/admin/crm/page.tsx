import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { ActivityForm, CustomerCreateForm, OpportunityForm, OpportunityStage } from '@/components/AdminOpsForms';
import { runAdminDashboardWork } from '@/lib/adminDashboardConcurrency';
import { formatSingaporeDate, formatSingaporeTimestamp } from '@/lib/singaporeTimestamp';
import { validatedCrmActivity, validatedCrmCustomer, validatedCrmOpportunity } from '@/lib/crmRow';
export const dynamic='force-dynamic';
const card={border:'1px solid #e4e8ef',borderRadius:16,padding:18,background:'#fff'} as const;
const moneyFromCents=(cents:number)=>`S$${(cents/100).toFixed(2)}`;
// CRM headline totals drive follow-up and pipeline decisions, so a single
// PostgREST response cap must not silently turn them into partial totals.
// Keep rendering bounded, but surface the bound explicitly if it is reached.
const CRM_PAGE_SIZE=250;
const CRM_MAX_ROWS=5_000;
type PagedResult={data:any[];error:any;truncated:boolean};
async function loadCrmPages(fetchPage:(after:number|null,limit:number)=>PromiseLike<{data:any[]|null;error:any}>):Promise<PagedResult>{
 const data:any[]=[];
 const seenIds=new Set<number>();
 let after:number|null=null;
 for(let loaded=0;loaded<CRM_MAX_ROWS;loaded+=CRM_PAGE_SIZE){
  const result=await fetchPage(after,CRM_PAGE_SIZE);
  if(result.error)return {data:[],error:result.error,truncated:false};
  // These rows drive customer follow-up and weighted-pipeline decisions.
  // Treat a malformed PostgREST page, a response beyond the requested range,
  // or an identity repeated across keyset pages as unavailable data. The
  // immutable id cursor prevents concurrent inserts, deletes, and ordinary CRM
  // updates from shifting a later page and silently hiding operational work.
  if(!Array.isArray(result.data)||result.data.length>CRM_PAGE_SIZE)return {data:[],error:new Error('CRM ledger returned an invalid page'),truncated:false};
  const page=result.data;
  for(const row of page){
   const id=row?.id;
   if(!Number.isSafeInteger(id)||id<=0||seenIds.has(id))return {data:[],error:new Error('CRM ledger returned an invalid or duplicate identity'),truncated:false};
   seenIds.add(id);
  }
  data.push(...page);
  if(page.length<CRM_PAGE_SIZE)return {data,error:null,truncated:false};
  const next=page[page.length-1]?.id;
  if(!Number.isSafeInteger(next)||next<=0||next===after)return {data:[],error:new Error('CRM ledger returned an invalid pagination cursor'),truncated:false};
  after=next;
 }
 // A full last page can be the complete data set. Check for one additional
 // row before declaring customer or follow-up work hidden, and treat a failed
 // completeness probe as unavailable data rather than safe partial totals.
 const beyond=await fetchPage(after,1);
 if(beyond.error)return {data:[],error:beyond.error,truncated:false};
 if(!Array.isArray(beyond.data)||beyond.data.length>1)return {data:[],error:new Error('CRM ledger returned an invalid truncation probe'),truncated:false};
 return {data,error:null,truncated:beyond.data.length>0};
}
function newestFirst(a:any,b:any,field:string){
 const aTime=typeof a?.[field]==='string'?Date.parse(a[field]):Number.NaN;
 const bTime=typeof b?.[field]==='string'?Date.parse(b[field]):Number.NaN;
 const safeATime=Number.isFinite(aTime)?aTime:Number.NEGATIVE_INFINITY;
 const safeBTime=Number.isFinite(bTime)?bTime:Number.NEGATIVE_INFINITY;
 return safeBTime-safeATime||Number(b?.id||0)-Number(a?.id||0);
}
export default async function CrmPage(){
 const db=getSupabaseAdmin();
 const busyResult={data:[],error:new Error('Admin dashboard is busy'),truncated:false};
 const [customersResult,oppsResult,actsResult]=db?await runAdminDashboardWork((signal)=>Promise.all([
  loadCrmPages((after,limit)=>{let query=db.from('customers').select('*').order('id',{ascending:false}).limit(limit);if(after!==null)query=query.lt('id',after);return query.abortSignal(signal);}),
  loadCrmPages((after,limit)=>{let query=db.from('sales_opportunities').select('*').order('id',{ascending:false}).limit(limit);if(after!==null)query=query.lt('id',after);return query.abortSignal(signal);}),
  loadCrmPages((after,limit)=>{let query=db.from('crm_activities').select('*').order('id',{ascending:false}).limit(limit);if(after!==null)query=query.lt('id',after);return query.abortSignal(signal);}),
 ]),[busyResult,busyResult,busyResult]):[null,null,null];
 // IDs provide a stable pagination boundary; restore the recency-oriented
 // presentation only after each complete bounded ledger has been assembled.
 const customerRows:any[]=(customersResult?.data??[]).sort((a:any,b:any)=>newestFirst(a,b,'last_order_at'));
 const opportunityRows:any[]=(oppsResult?.data??[]).sort((a:any,b:any)=>newestFirst(a,b,'updated_at'));
 const activityRows:any[]=(actsResult?.data??[]).sort((a:any,b:any)=>newestFirst(a,b,'created_at'));
 const unavailablePanels=[customersResult?.error&&'customers',oppsResult?.error&&'sales pipeline',actsResult?.error&&'CRM activity'].filter(Boolean) as string[];
 const truncatedPanels=[customersResult?.truncated&&'customers',oppsResult?.truncated&&'sales pipeline',actsResult?.truncated&&'CRM activity'].filter(Boolean) as string[];
 const validatedCustomers=customerRows.map(validatedCrmCustomer);
 const validatedOpportunities=opportunityRows.map(validatedCrmOpportunity);
 const validatedActivities=activityRows.map(validatedCrmActivity);
 const malformedPanels=[validatedCustomers.some(row=>row===null)&&'customers',validatedOpportunities.some(row=>row===null)&&'sales pipeline',validatedActivities.some(row=>row===null)&&'CRM activity'].filter(Boolean) as string[];
 const customers=validatedCustomers.filter((row):row is NonNullable<typeof row>=>row!==null);
 const opps=validatedOpportunities.filter((row):row is NonNullable<typeof row>=>row!==null);
 const acts=validatedActivities.filter((row):row is NonNullable<typeof row>=>row!==null);
 const metricsIncomplete=unavailablePanels.length>0||truncatedPanels.length>0||malformedPanels.length>0;
 const pipelineCents=opps.filter((x:any)=>!['won','lost'].includes(x.stage)).reduce((sum:number,x:any)=>sum+Math.round(x.expected_value_cents*x.probability_basis_points/10_000),0);
 const due=acts.filter((a:any)=>a.due_at&&!a.completed_at&&new Date(a.due_at).getTime()<=Date.now()+7*86400000).length;
 const metric=(value:string|number)=>metricsIncomplete?'—':value;
 return <main className="wrap section legal" style={{maxWidth:1280}}><span className="eyebrow">CRM</span><h1>Customers, follow-ups & sales pipeline</h1>{!db&&<div style={card}><strong>Database connection required.</strong></div>}{db&&<>{unavailablePanels.length>0&&<div role="alert" style={{...card,borderColor:'#dc2626',background:'#fef2f2',marginBottom:20}}><strong>CRM data is currently unavailable: {unavailablePanels.join(', ')}.</strong><div style={{marginTop:6}}>Do not treat zero totals or empty lists as current. Restore the database/schema connection and refresh before acting on a customer, follow-up or pipeline decision.</div></div>}{truncatedPanels.length>0&&<div role="alert" style={{...card,borderColor:'#d97706',background:'#fffbeb',marginBottom:20}}><strong>CRM view limit reached: {truncatedPanels.join(', ')}.</strong><div style={{marginTop:6}}>The page loaded the newest {CRM_MAX_ROWS.toLocaleString('en-SG')} rows in each named area. Headline totals are hidden and lists may be incomplete; archive or export older records before relying on them.</div></div>}{malformedPanels.length>0&&<div role="alert" style={{...card,borderColor:'#dc2626',background:'#fef2f2',marginBottom:20}}><strong>CRM contains malformed financial data: {malformedPanels.join(', ')}.</strong><div style={{marginTop:6}}>Headline totals are hidden and affected rows are withheld. Reconcile the database before making a customer, pipeline or campaign decision.</div></div>}<div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:12}}><div style={card}><small>Customers</small><h2>{metric(customers.length)}</h2></div><div style={card}><small>Open opportunities</small><h2>{metric(opps.filter((x:any)=>!['won','lost'].includes(x.stage)).length)}</h2></div><div style={card}><small>Weighted pipeline</small><h2>{metric(moneyFromCents(pipelineCents))}</h2></div><div style={card}><small>Follow-ups due ≤7 days</small><h2>{metric(due)}</h2></div></div><CustomerCreateForm/><ActivityForm customers={customers}/><OpportunityForm customers={customers}/><h2 style={{marginTop:28}}>Customers</h2>{customersResult?.error?<p>Customer data is unavailable; no conclusion can be drawn from this page.</p>:customers.length===0?<p>No valid CRM customers yet.</p>:<div style={{overflowX:'auto',...card}}><table style={{width:'100%',borderCollapse:'collapse',minWidth:820}}><thead><tr><th align="left">Customer</th><th align="left">Status</th><th align="left">Source</th><th align="right">Orders</th><th align="right">LTV</th><th align="left">Last order</th></tr></thead><tbody>{customers.map((c:any)=><tr key={c.id} style={{borderTop:'1px solid #e5e7eb'}}><td><strong>{c.name||'-'}</strong><br/><small>{c.email||c.phone||'-'}</small></td><td>{c.status}</td><td>{c.source||'-'}</td><td align="right">{c.total_orders}</td><td align="right">{moneyFromCents(c.lifetime_value_cents)}</td><td>{formatSingaporeDate(c.last_order_at, '-')}</td></tr>)}</tbody></table></div>}<h2 style={{marginTop:28}}>Sales pipeline</h2>{oppsResult?.error?<p>Sales pipeline data is unavailable; no conclusion can be drawn from this page.</p>:opps.length===0?<p>No valid opportunities yet.</p>:<div style={{overflowX:'auto',...card}}><table style={{width:'100%',borderCollapse:'collapse',minWidth:980}}><thead><tr><th align="left">Opportunity</th><th align="left">Stage / probability</th><th align="left">Product</th><th align="right">Value</th><th align="left">Expected close</th><th align="left">Owner</th></tr></thead><tbody>{opps.map((o:any)=><tr key={o.id} style={{borderTop:'1px solid #e5e7eb'}}><td>{o.title}</td><td><OpportunityStage id={o.id} stage={o.stage} probability={o.probability_basis_points/100}/></td><td>{o.product_type||'-'}</td><td align="right">{moneyFromCents(o.expected_value_cents)}</td><td>{o.expected_close_date||'-'}</td><td>{o.owner||'-'}</td></tr>)}</tbody></table></div>}<h2 style={{marginTop:28}}>Recent CRM activity</h2>{actsResult?.error?<p>CRM activity is unavailable; no conclusion can be drawn from this page.</p>:acts.length===0?<p>No CRM activity yet.</p>:<div style={{overflowX:'auto',...card}}><table style={{width:'100%',minWidth:840}}><thead><tr><th align="left">Created</th><th align="left">Type</th><th align="left">Subject</th><th align="left">Detail</th><th align="left">Due</th><th align="left">Owner</th></tr></thead><tbody>{acts.map((a:any)=><tr key={a.id}><td>{formatSingaporeTimestamp(a.created_at)}</td><td>{a.activity_type}</td><td>{a.subject||'-'}</td><td>{a.detail||'-'}</td><td>{formatSingaporeTimestamp(a.due_at, '-')}</td><td>{a.owner||'-'}</td></tr>)}</tbody></table></div>}</>}</main>;
}
