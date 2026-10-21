import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { runAdminDashboardWork } from '@/lib/adminDashboardConcurrency';
import { InventoryAdjustForm, InventoryCreateForm, InventoryStatusForm } from '@/components/AdminOpsForms';
import { formatSingaporeTimestamp } from '@/lib/singaporeTimestamp';
import { validatedCheckoutReservation, validatedInventoryItem, validatedInventoryMovement } from '@/lib/inventoryAdminRow';
export const dynamic='force-dynamic';
const card={border:'1px solid #e4e8ef',borderRadius:16,padding:18,background:'#fff'} as const;
// Supabase limits a single response. The inventory ledger is audit evidence
// for dispatches, returns and stock corrections, so showing only the newest
// page without saying so could hide the exact movement an operator needs to
// reconcile. Keep the server-rendered screen bounded, but make that boundary
// explicit instead of treating a partial history as complete.
const INVENTORY_MOVEMENT_PAGE_SIZE=250;
const INVENTORY_MOVEMENT_MAX_ROWS=5_000;
const INVENTORY_ITEM_PAGE_SIZE=250;
const INVENTORY_ITEM_MAX_ROWS=5_000;
const RESERVATION_PAGE_SIZE=250;
const RESERVATION_MAX_ROWS=5_000;
const RESERVATION_HANDOFF_GRACE_MS=4*24*60*60*1000;
type MovementPageResult={data:any[];error:any;truncated:boolean};
type InventoryItemPageResult={data:any[];error:any;truncated:boolean};
type ReservationPageResult={data:any[];error:any;truncated:boolean};

async function loadInventoryItemPages(db:NonNullable<ReturnType<typeof getSupabaseAdmin>>):Promise<InventoryItemPageResult>{
 const data:any[]=[];
 const seenIds=new Set<number>();
 let afterId:number|null=null;
 const fetchPage=(limit:number)=>{
  let query=db.from('inventory_items').select('*').order('id').limit(limit);
  if(afterId!==null) query=query.gt('id',afterId);
  return query;
 };
 for(let loaded=0;loaded<INVENTORY_ITEM_MAX_ROWS;loaded+=INVENTORY_ITEM_PAGE_SIZE){
  const result=await fetchPage(INVENTORY_ITEM_PAGE_SIZE);
  if(result.error) return {data:[],error:result.error,truncated:false};
  if(!Array.isArray(result.data)||result.data.length>INVENTORY_ITEM_PAGE_SIZE) return {data:[],error:new Error('Inventory register returned an invalid page'),truncated:false};
  const page=result.data;
  let previousId=afterId;
  for(const row of page){
   const id=row?.id;
   if(!Number.isSafeInteger(id)||id<=0||seenIds.has(id)||(previousId!==null&&id<=previousId)) return {data:[],error:new Error('Inventory register returned an invalid or duplicate identity'),truncated:false};
   seenIds.add(id);
   previousId=id;
  }
  data.push(...page);
  if(page.length<INVENTORY_ITEM_PAGE_SIZE) return {data,error:null,truncated:false};
  const nextId=page[page.length-1]?.id;
  if(!Number.isSafeInteger(nextId)||nextId<=0||nextId===afterId) return {data:[],error:new Error('Inventory register returned an invalid pagination cursor'),truncated:false};
  afterId=nextId;
 }
 // As with the movement ledger, distinguish a full final page from an
 // actually truncated register. Inventory totals must never quietly describe
 // only the first response when the physical fleet grows beyond this view.
 const beyond=await fetchPage(1);
 if(beyond.error) return {data:[],error:beyond.error,truncated:false};
 if(!Array.isArray(beyond.data)||beyond.data.length>1) return {data:[],error:new Error('Inventory register returned an invalid truncation probe'),truncated:false};
 if(beyond.data.length>0){
  const id=beyond.data[0]?.id;
  if(!Number.isSafeInteger(id)||id<=0||seenIds.has(id)||(afterId!==null&&id<=afterId)) return {data:[],error:new Error('Inventory register returned an invalid truncation probe'),truncated:false};
 }
 return {data,error:null,truncated:beyond.data.length>0};
}

async function loadMovementPages(db:NonNullable<ReturnType<typeof getSupabaseAdmin>>):Promise<MovementPageResult>{
 const data:any[]=[];
 const seenIds=new Set<number>();
 let beforeId:number|null=null;
 const fetchPage=(limit:number)=>{
  let query=db.from('inventory_movements').select('*').order('id',{ascending:false}).limit(limit);
  if(beforeId!==null) query=query.lt('id',beforeId);
  return query;
 };
 for(let loaded=0;loaded<INVENTORY_MOVEMENT_MAX_ROWS;loaded+=INVENTORY_MOVEMENT_PAGE_SIZE){
  const result=await fetchPage(INVENTORY_MOVEMENT_PAGE_SIZE);
  if(result.error) return {data:[],error:result.error,truncated:false};
  if(!Array.isArray(result.data)||result.data.length>INVENTORY_MOVEMENT_PAGE_SIZE) return {data:[],error:new Error('Inventory movement ledger returned an invalid page'),truncated:false};
  const page=result.data;
  let previousId=beforeId;
  for(const row of page){
   const id=row?.id;
   if(!Number.isSafeInteger(id)||id<=0||seenIds.has(id)||(previousId!==null&&id>=previousId)) return {data:[],error:new Error('Inventory movement ledger returned an invalid or duplicate identity'),truncated:false};
   seenIds.add(id);
   previousId=id;
  }
  data.push(...page);
  if(page.length<INVENTORY_MOVEMENT_PAGE_SIZE) return {data,error:null,truncated:false};
  const nextId=page[page.length-1]?.id;
  if(!Number.isSafeInteger(nextId)||nextId<=0||nextId===beforeId) return {data:[],error:new Error('Inventory movement ledger returned an invalid pagination cursor'),truncated:false};
  beforeId=nextId;
 }
 // A full final page alone does not prove there is another movement. Check one
 // additional row so the warning means history was actually omitted, rather
 // than appearing forever when the ledger happens to contain exactly 5,000.
 const beyond=await fetchPage(1);
 if(beyond.error) return {data:[],error:beyond.error,truncated:false};
 if(!Array.isArray(beyond.data)||beyond.data.length>1) return {data:[],error:new Error('Inventory movement ledger returned an invalid truncation probe'),truncated:false};
 if(beyond.data.length>0){
  const id=beyond.data[0]?.id;
  if(!Number.isSafeInteger(id)||id<=0||seenIds.has(id)||(beforeId!==null&&id>=beforeId)) return {data:[],error:new Error('Inventory movement ledger returned an invalid truncation probe'),truncated:false};
 }
 return {data,error:null,truncated:beyond.data.length>0};
}

async function loadReservationPages(db:NonNullable<ReturnType<typeof getSupabaseAdmin>>):Promise<ReservationPageResult>{
 const data:any[]=[];
 const seenRequestIds=new Set<string>();
 // Only a Stripe-linked reservation receives the four-day terminal-webhook
 // grace period. Unlinked attempts expire with their customer-facing Checkout
 // window; showing them for days would falsely imply that stock is committed.
 const now=new Date().toISOString();
 const cutoff=new Date(Date.now()-RESERVATION_HANDOFF_GRACE_MS).toISOString();
 const activeFilter=`and(stripe_session_id.is.null,expires_at.gt.${now}),and(stripe_session_id.not.is.null,expires_at.gt.${cutoff})`;
 let afterRequestId:string|null=null;
 const fetchPage=(limit:number)=>{
  let query=db.from('checkout_reservations').select('checkout_request_id,stripe_session_id,travel_start,travel_end,expires_at,created_at').or(activeFilter).order('checkout_request_id').limit(limit);
  if(afterRequestId!==null) query=query.gt('checkout_request_id',afterRequestId);
  return query;
 };
 for(let loaded=0;loaded<RESERVATION_MAX_ROWS;loaded+=RESERVATION_PAGE_SIZE){
  const result=await fetchPage(RESERVATION_PAGE_SIZE);
  if(result.error) return {data:[],error:result.error,truncated:false};
  if(!Array.isArray(result.data)||result.data.length>RESERVATION_PAGE_SIZE) return {data:[],error:new Error('Checkout reservation register returned an invalid page'),truncated:false};
  const page=result.data;
  let previousRequestId=afterRequestId;
  for(const row of page){
   const requestId=row?.checkout_request_id;
   if(typeof requestId!=='string'||!requestId||seenRequestIds.has(requestId)||(previousRequestId!==null&&requestId<=previousRequestId)) return {data:[],error:new Error('Checkout reservation register returned an invalid or duplicate identity'),truncated:false};
   seenRequestIds.add(requestId);
   previousRequestId=requestId;
  }
  data.push(...page);
  if(page.length<RESERVATION_PAGE_SIZE) return {data,error:null,truncated:false};
  const nextRequestId=page[page.length-1]?.checkout_request_id;
  if(typeof nextRequestId!=='string'||!nextRequestId||nextRequestId===afterRequestId) return {data:[],error:new Error('Checkout reservation register returned an invalid pagination cursor'),truncated:false};
  afterRequestId=nextRequestId;
 }
 const beyond=await fetchPage(1);
 if(beyond.error) return {data:[],error:beyond.error,truncated:false};
 if(!Array.isArray(beyond.data)||beyond.data.length>1) return {data:[],error:new Error('Checkout reservation register returned an invalid truncation probe'),truncated:false};
 if(beyond.data.length>0){
  const requestId=beyond.data[0]?.checkout_request_id;
  if(typeof requestId!=='string'||!requestId||seenRequestIds.has(requestId)||(afterRequestId!==null&&requestId<=afterRequestId)) return {data:[],error:new Error('Checkout reservation register returned an invalid truncation probe'),truncated:false};
 }
 return {data,error:null,truncated:beyond.data.length>0};
}

export default async function InventoryPage(){
 const db=getSupabaseAdmin();
 // Empty inventory is meaningful; a failed query is not. Keep these states
 // separate so staff never decide a router is available (or missing) from a
 // silently empty register during a database/schema incident.
 const unavailable={data:[] as any[],error:new Error('Inventory database is not configured'),truncated:false};
 const [itemsResult,movesResult,reservationsResult]=db
   ?await runAdminDashboardWork(()=>Promise.all([
      loadInventoryItemPages(db),
      loadMovementPages(db),
      loadReservationPages(db),
    ]),[unavailable,unavailable,unavailable])
   :[unavailable,unavailable,unavailable];
 // Page on immutable identities for correctness, then restore the useful
 // operator-facing order after the complete bounded result is in memory.
 const itemRows=(itemsResult.data??[]).map(validatedInventoryItem);
 const movementRows=(movesResult.data??[]).map(validatedInventoryMovement);
 const reservationRows=(reservationsResult.data??[]).map(validatedCheckoutReservation);
 const items=itemRows.filter((row):row is NonNullable<typeof row>=>row!==null).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''))||a.id-b.id);
 const moves=movementRows.filter((row):row is NonNullable<typeof row>=>row!==null).sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.id-a.id);
 const reservations=reservationRows.filter((row):row is NonNullable<typeof row>=>row!==null).sort((a,b)=>a.expires_at.localeCompare(b.expires_at)||a.checkout_request_id.localeCompare(b.checkout_request_id));
 // Reuse the existing unavailable-state rendering for malformed provider
 // data. Operators must not see a partial ledger as an empty or complete one.
 if(itemRows.some(row=>row===null)) itemsResult.error=new Error('Inventory register contains malformed data');
 if(movementRows.some(row=>row===null)) movesResult.error=new Error('Inventory movement ledger contains malformed data');
 if(reservationRows.some(row=>row===null)) reservationsResult.error=new Error('Checkout reservation register contains malformed data');
 const failedPanels=[itemsResult.error&&'inventory register',movesResult.error&&'movement audit trail',reservationsResult.error&&'checkout reservation register'].filter(Boolean) as string[];
 // Stock totals and mutation selectors are operational authorities, not best-
 // effort summaries. A failed or bounded/truncated item read cannot prove
 // that a zero means no stock, nor that the rendered selector contains every
 // asset. Keep all item-derived decisions unavailable until the complete
 // register has been read successfully.
 const inventoryRegisterComplete=!itemsResult.error&&!itemsResult.truncated&&!itemRows.some(row=>row===null);
 const available=items.reduce((sum,x)=>sum+x.quantity_on_hand,0);
 const saleablePocketWifi=items.filter(x=>x.product_type==='pocket_wifi'&&x.status==='available').reduce((sum,x)=>sum+x.quantity_on_hand,0);
 const quarantinedPocketWifi=items.filter(x=>x.product_type==='pocket_wifi'&&x.status!=='available').reduce((sum,x)=>sum+x.quantity_on_hand,0);
 const low=items.filter(x=>x.quantity_on_hand<=x.reorder_level);
 const valueCents=items.reduce((sum,x)=>sum+x.quantity_on_hand*x.unit_cost_cents,0);
 const value=valueCents/100;
 const now=Date.now();
 return <main className="wrap section legal" style={{maxWidth:1280}}><span className="eyebrow">Inventory</span><h1>Pocket WiFi & stock control</h1>{!db&&<div style={card}><strong>Database connection required.</strong></div>}{db&&<>{failedPanels.length>0&&<div role="alert" style={{...card,borderColor:'#dc2626',background:'#fef2f2',marginBottom:20}}><strong>Operational inventory data is currently unavailable: {failedPanels.join(', ')}.</strong><div style={{marginTop:6}}>Do not treat empty lists or totals as current stock. Restore the database/schema connection and refresh before dispatching, receiving or accepting a booking.</div></div>}{itemsResult.truncated&&<div role="alert" style={{...card,borderColor:'#b45309',background:'#fffbeb',marginBottom:20}}><strong>Inventory register needs archiving or a dedicated asset view.</strong><div style={{marginTop:6}}>This screen loaded its first {INVENTORY_ITEM_MAX_ROWS.toLocaleString()} inventory records but stopped before the full register could be reviewed. Do not treat the stock totals, asset count, or device selector as complete until the older records are available.</div></div>}{movesResult.truncated&&<div role="alert" style={{...card,borderColor:'#b45309',background:'#fffbeb',marginBottom:20}}><strong>Inventory movement history needs archiving or a dedicated audit view.</strong><div style={{marginTop:6}}>This screen loaded its first {INVENTORY_MOVEMENT_MAX_ROWS.toLocaleString()} newest movements but stopped before the full ledger could be reviewed. Do not treat this list as complete when reconciling an older dispatch, return or adjustment.</div></div>}{reservationsResult.truncated&&<div role="alert" style={{...card,borderColor:'#b45309',background:'#fffbeb',marginBottom:20}}><strong>Checkout reservation view is incomplete.</strong><div style={{marginTop:6}}>More than {RESERVATION_MAX_ROWS.toLocaleString()} capacity holds are protected. Do not use this list to reconcile availability until the full register can be reviewed.</div></div>}<div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:12}}><div style={card}><small>Saleable Pocket WiFi units</small><h2>{inventoryRegisterComplete?saleablePocketWifi:'—'}</h2><small>available status only</small></div><div style={card}><small>Protected checkout holds</small><h2>{reservationsResult.error||reservationsResult.truncated?'—':reservations.length}</h2><small>open checkout + webhook handoff</small></div><div style={card}><small>Quarantined Pocket WiFi units</small><h2>{inventoryRegisterComplete?quarantinedPocketWifi:'—'}</h2><small>not available for dispatch</small></div><div style={card}><small>Total units</small><h2>{inventoryRegisterComplete?available:'—'}</h2></div><div style={card}><small>SKUs / assets</small><h2>{inventoryRegisterComplete?items.length:'—'}</h2></div><div style={card}><small>Low-stock alerts</small><h2>{inventoryRegisterComplete?low.length:'—'}</h2></div><div style={card}><small>Stock value</small><h2>{inventoryRegisterComplete?`S$${value.toFixed(2)}`:'—'}</h2></div></div><h2 style={{marginTop:28}}>Checkout capacity holds</h2><p style={{color:'#64748b'}}>Open checkout attempts hold capacity until their payment window ends. Only Stripe-linked attempts remain protected during the four-day webhook handoff period; releasing one without reconciling Stripe could oversell a router.</p>{!reservationsResult.error&&!reservationsResult.truncated&&(reservations.length===0?<p>No protected checkout holds.</p>:<div style={{overflowX:'auto',...card}}><table style={{width:'100%',borderCollapse:'collapse',minWidth:920}}><thead><tr><th align="left">Travel</th><th align="left">State</th><th align="left">Checkout request</th><th align="left">Stripe session</th><th align="left">Checkout expiry</th><th align="left">Created</th></tr></thead><tbody>{reservations.map((r:any)=>{const open=new Date(r.expires_at).getTime()>now;return <tr key={r.checkout_request_id} style={{borderTop:'1px solid #e5e7eb'}}><td>{r.travel_start} → {r.travel_end}</td><td><strong>{open?'Checkout open':r.stripe_session_id?'Webhook handoff':'Unconfirmed handoff'}</strong></td><td><code>{r.checkout_request_id}</code></td><td>{r.stripe_session_id?<code>{r.stripe_session_id}</code>:'Not linked'}</td><td>{formatSingaporeTimestamp(r.expires_at)}</td><td>{formatSingaporeTimestamp(r.created_at)}</td></tr>})}</tbody></table></div>)}{inventoryRegisterComplete&&<><InventoryCreateForm/><InventoryAdjustForm items={items}/><InventoryStatusForm items={items}/></>}<h2 style={{marginTop:28}}>Inventory register</h2>{inventoryRegisterComplete&&(items.length===0?<p>No inventory items yet.</p>:<div style={{overflowX:'auto',...card}}><table style={{width:'100%',borderCollapse:'collapse',minWidth:820}}><thead><tr><th align="left">SKU</th><th align="left">Item</th><th align="left">Type</th><th align="left">Status</th><th align="right">Qty</th><th align="right">Reorder</th><th align="right">Unit cost</th><th align="left">Location</th></tr></thead><tbody>{items.map((x:any)=><tr key={x.id} style={{borderTop:'1px solid #e5e7eb'}}><td>{x.sku}</td><td>{x.name}</td><td>{x.product_type}</td><td>{x.status}</td><td align="right">{x.quantity_on_hand}</td><td align="right">{x.reorder_level}</td><td align="right">S${Number(x.unit_cost_sgd||0).toFixed(2)}</td><td>{x.location||'-'}</td></tr>)}</tbody></table></div>)}<h2 style={{marginTop:28}}>Movement audit trail</h2>{!movesResult.error&&!movesResult.truncated&&(moves.length===0?<p>No stock movements yet.</p>:<div style={{overflowX:'auto',...card}}><table style={{width:'100%',minWidth:760}}><thead><tr><th align="left">Date</th><th align="left">Item ID</th><th align="left">Type</th><th align="right">Qty</th><th align="left">Reference</th><th align="left">Notes</th></tr></thead><tbody>{moves.map((m:any)=><tr key={m.id}><td>{formatSingaporeTimestamp(m.created_at)}</td><td>{m.inventory_item_id}</td><td>{m.movement_type}</td><td align="right">{m.quantity}</td><td>{m.reference||'-'}</td><td>{m.notes||'-'}</td></tr>)}</tbody></table></div>)}</>}</main>;
}
