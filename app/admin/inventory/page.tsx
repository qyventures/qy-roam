import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
export const dynamic='force-dynamic';
const card={border:'1px solid #e4e8ef',borderRadius:16,padding:18,background:'#fff'} as const;
export default async function InventoryPage(){
 const db=getSupabaseAdmin();
 const items=db?((await db.from('inventory_items').select('*').order('name')).data??[]):[];
 const available=items.reduce((s:any,x:any)=>s+Number(x.quantity_on_hand||0),0);
 const low=items.filter((x:any)=>Number(x.quantity_on_hand||0)<=Number(x.reorder_level||0));
 return <main className="wrap section legal" style={{maxWidth:1280}}><span className="eyebrow">Inventory</span><h1>Pocket WiFi & stock control</h1>{!db&&<div style={card}><strong>Database connection required.</strong></div>}{db&&<><div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:12}}><div style={card}><small>Total units</small><h2>{available}</h2></div><div style={card}><small>SKUs / assets</small><h2>{items.length}</h2></div><div style={card}><small>Low-stock alerts</small><h2>{low.length}</h2></div></div><h2 style={{marginTop:28}}>Inventory register</h2>{items.length===0?<p>No inventory items yet.</p>:<div style={{overflowX:'auto',...card}}><table style={{width:'100%',borderCollapse:'collapse',minWidth:760}}><thead><tr><th align="left">SKU</th><th align="left">Item</th><th align="left">Type</th><th align="left">Status</th><th align="right">Qty</th><th align="right">Reorder</th><th align="left">Location</th></tr></thead><tbody>{items.map((x:any)=><tr key={x.id} style={{borderTop:'1px solid #e5e7eb'}}><td>{x.sku}</td><td>{x.name}</td><td>{x.product_type}</td><td>{x.status}</td><td align="right">{x.quantity_on_hand}</td><td align="right">{x.reorder_level}</td><td>{x.location||'-'}</td></tr>)}</tbody></table></div>}</>}</main>;
}
