import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { InventoryAdjustForm, InventoryCreateForm, InventoryStatusForm } from '@/components/AdminOpsForms';
export const dynamic='force-dynamic';
const card={border:'1px solid #e4e8ef',borderRadius:16,padding:18,background:'#fff'} as const;
// Supabase limits a single response. The inventory ledger is audit evidence
// for dispatches, returns and stock corrections, so showing only the newest
// page without saying so could hide the exact movement an operator needs to
// reconcile. Keep the server-rendered screen bounded, but make that boundary
// explicit instead of treating a partial history as complete.
const INVENTORY_MOVEMENT_PAGE_SIZE=250;
const INVENTORY_MOVEMENT_MAX_ROWS=5_000;
type MovementPageResult={data:any[];error:any;truncated:boolean};

async function loadMovementPages(db:NonNullable<ReturnType<typeof getSupabaseAdmin>>):Promise<MovementPageResult>{
 const data:any[]=[];
 for(let from=0;from<INVENTORY_MOVEMENT_MAX_ROWS;from+=INVENTORY_MOVEMENT_PAGE_SIZE){
  const result=await db.from('inventory_movements').select('*').order('created_at',{ascending:false}).order('id',{ascending:false}).range(from,from+INVENTORY_MOVEMENT_PAGE_SIZE-1);
  if(result.error) return {data:[],error:result.error,truncated:false};
  const page=result.data||[];
  data.push(...page);
  if(page.length<INVENTORY_MOVEMENT_PAGE_SIZE) return {data,error:null,truncated:false};
 }
 // A full final page alone does not prove there is another movement. Check one
 // additional row so the warning means history was actually omitted, rather
 // than appearing forever when the ledger happens to contain exactly 5,000.
 const beyond=await db.from('inventory_movements').select('id').order('created_at',{ascending:false}).order('id',{ascending:false}).range(INVENTORY_MOVEMENT_MAX_ROWS,INVENTORY_MOVEMENT_MAX_ROWS);
 if(beyond.error) return {data:[],error:beyond.error,truncated:false};
 return {data,error:null,truncated:(beyond.data||[]).length>0};
}

export default async function InventoryPage(){
 const db=getSupabaseAdmin();
 // Empty inventory is meaningful; a failed query is not. Keep these states
 // separate so staff never decide a router is available (or missing) from a
 // silently empty register during a database/schema incident.
 const unavailable={data:[] as any[],error:new Error('Inventory database is not configured'),truncated:false};
 const [itemsResult,movesResult]=db
   ?await Promise.all([
      db.from('inventory_items').select('*').order('name'),
      loadMovementPages(db),
    ])
   :[unavailable,unavailable];
 const items:any[]=itemsResult.data??[];
 const moves:any[]=movesResult.data??[];
 const failedPanels=[itemsResult.error&&'inventory register',movesResult.error&&'movement audit trail'].filter(Boolean) as string[];
 const available=items.reduce((s:number,x:any)=>s+Number(x.quantity_on_hand||0),0);
 const saleablePocketWifi=items.filter((x:any)=>x.product_type==='pocket_wifi'&&x.status==='available').reduce((s:number,x:any)=>s+Number(x.quantity_on_hand||0),0);
 const quarantinedPocketWifi=items.filter((x:any)=>x.product_type==='pocket_wifi'&&x.status!=='available').reduce((s:number,x:any)=>s+Number(x.quantity_on_hand||0),0);
 const low=items.filter((x:any)=>Number(x.quantity_on_hand||0)<=Number(x.reorder_level||0));
 const value=items.reduce((s:any,x:any)=>s+Number(x.quantity_on_hand||0)*Number(x.unit_cost_sgd||0),0);
 return <main className="wrap section legal" style={{maxWidth:1280}}><span className="eyebrow">Inventory</span><h1>Pocket WiFi & stock control</h1>{!db&&<div style={card}><strong>Database connection required.</strong></div>}{db&&<>{failedPanels.length>0&&<div role="alert" style={{...card,borderColor:'#dc2626',background:'#fef2f2',marginBottom:20}}><strong>Operational inventory data is currently unavailable: {failedPanels.join(', ')}.</strong><div style={{marginTop:6}}>Do not treat empty lists or totals as current stock. Restore the database/schema connection and refresh before dispatching, receiving or accepting a booking.</div></div>}{movesResult.truncated&&<div role="alert" style={{...card,borderColor:'#b45309',background:'#fffbeb',marginBottom:20}}><strong>Inventory movement history needs archiving or a dedicated audit view.</strong><div style={{marginTop:6}}>This screen loaded its first {INVENTORY_MOVEMENT_MAX_ROWS.toLocaleString()} newest movements but stopped before the full ledger could be reviewed. Do not treat this list as complete when reconciling an older dispatch, return or adjustment.</div></div>}<div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:12}}><div style={card}><small>Saleable Pocket WiFi units</small><h2>{saleablePocketWifi}</h2><small>available status only</small></div><div style={card}><small>Quarantined Pocket WiFi units</small><h2>{quarantinedPocketWifi}</h2><small>not available for dispatch</small></div><div style={card}><small>Total units</small><h2>{available}</h2></div><div style={card}><small>SKUs / assets</small><h2>{items.length}</h2></div><div style={card}><small>Low-stock alerts</small><h2>{low.length}</h2></div><div style={card}><small>Stock value</small><h2>S${value.toFixed(2)}</h2></div></div><InventoryCreateForm/><InventoryAdjustForm items={items}/><InventoryStatusForm items={items}/><h2 style={{marginTop:28}}>Inventory register</h2>{items.length===0?<p>No inventory items yet.</p>:<div style={{overflowX:'auto',...card}}><table style={{width:'100%',borderCollapse:'collapse',minWidth:820}}><thead><tr><th align="left">SKU</th><th align="left">Item</th><th align="left">Type</th><th align="left">Status</th><th align="right">Qty</th><th align="right">Reorder</th><th align="right">Unit cost</th><th align="left">Location</th></tr></thead><tbody>{items.map((x:any)=><tr key={x.id} style={{borderTop:'1px solid #e5e7eb'}}><td>{x.sku}</td><td>{x.name}</td><td>{x.product_type}</td><td>{x.status}</td><td align="right">{x.quantity_on_hand}</td><td align="right">{x.reorder_level}</td><td align="right">S${Number(x.unit_cost_sgd||0).toFixed(2)}</td><td>{x.location||'-'}</td></tr>)}</tbody></table></div>}<h2 style={{marginTop:28}}>Movement audit trail</h2>{moves.length===0?<p>No stock movements yet.</p>:<div style={{overflowX:'auto',...card}}><table style={{width:'100%',minWidth:760}}><thead><tr><th align="left">Date</th><th align="left">Item ID</th><th align="left">Type</th><th align="right">Qty</th><th align="left">Reference</th><th align="left">Notes</th></tr></thead><tbody>{moves.map((m:any)=><tr key={m.id}><td>{new Date(m.created_at).toLocaleString('en-SG')}</td><td>{m.inventory_item_id}</td><td>{m.movement_type}</td><td align="right">{m.quantity}</td><td>{m.reference||'-'}</td><td>{m.notes||'-'}</td></tr>)}</tbody></table></div>}</>}</main>;
}
