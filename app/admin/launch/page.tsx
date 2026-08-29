import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const card={border:'1px solid #e4e8ef',borderRadius:16,padding:18,background:'#fff'} as const;
function Row({label,ok,note}:{label:string,ok:boolean,note:string}){return <div style={{display:'grid',gridTemplateColumns:'minmax(180px,1fr) 100px minmax(240px,2fr)',gap:12,padding:'12px 0',borderTop:'1px solid #eef1f5',alignItems:'center'}}><strong>{label}</strong><span style={{fontWeight:800}}>{ok?'✓ Ready':'⚠ Blocked'}</span><span style={{color:'#64748b'}}>{note}</span></div>}

export default async function LaunchPage(){
 const db=getSupabaseAdmin();
 let dbOk=false;
 if(db){const r=await db.from('orders').select('id',{head:true,count:'exact'}).limit(1);dbOk=!r.error;}
 const stripe=Boolean(process.env.STRIPE_SECRET_KEY);
 const webhook=Boolean(process.env.STRIPE_WEBHOOK_SECRET);
 const smtp=Boolean(process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASS);
 const pixel=Boolean(process.env.NEXT_PUBLIC_META_PIXEL_ID);
 const capi=Boolean(process.env.META_CAPI_ACCESS_TOKEN);
 const site=true;
 const organicReady=stripe&&dbOk;
 const paidReady=organicReady&&webhook&&smtp&&pixel&&capi;
 const blockers=[!webhook&&'Stripe webhook signing secret',!smtp&&'fulfilment email transport',!pixel&&'Meta Pixel ID',!capi&&'Meta CAPI token'].filter(Boolean) as string[];
 return <main className="wrap section legal" style={{maxWidth:1100}}><span className="eyebrow">Launch control</span><h1>Production readiness</h1><p style={{color:'#64748b'}}>Safe configuration check only. Secret values are never displayed.</p>
 <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))',gap:14,marginTop:20}}><div style={card}><small>Direct / organic sales</small><h2 style={{margin:'6px 0'}}>{organicReady?'✓ Ready':'⚠ Blocked'}</h2><span style={{color:'#64748b'}}>Site, checkout and order database.</span></div><div style={card}><small>Paid acquisition</small><h2 style={{margin:'6px 0'}}>{paidReady?'✓ Ready':'⚠ Hold'}</h2><span style={{color:'#64748b'}}>{paidReady?'Measurement and fulfilment controls ready.':`${blockers.length} production blocker${blockers.length===1?'':'s'} remaining.`}</span></div></div>
 <div style={{...card,marginTop:16}}><h2 style={{marginTop:0}}>Launch checklist</h2><Row label="Stripe checkout" ok={stripe} note="Server-side Stripe credential"/><Row label="Stripe webhook" ok={webhook} note="Required for signed payment confirmation and durable order processing"/><Row label="Order database" ok={dbOk} note="Supabase order persistence and operating platform"/><Row label="Fulfilment email" ok={smtp} note="Paid-order alert to QY operations for manual fulfilment"/><Row label="Meta Pixel" ok={pixel} note="Consent-gated browser measurement"/><Row label="Meta CAPI" ok={capi} note="Server-side Purchase measurement"/><Row label="Production URL" ok={site} note="qyroam.com"/></div>
 {!paidReady&&<div style={{...card,marginTop:16}}><strong>Paid-launch blockers</strong><p style={{marginBottom:0}}>{blockers.length?blockers.join(' · '):'Core checkout/database configuration incomplete.'}</p></div>}
 <div style={{...card,marginTop:16}}><strong>Spend guardrail</strong><p style={{marginBottom:0}}>Paid campaigns remain approval-gated. Hard launch ceiling: S$10/day. Do not scale until a controlled live payment confirms payment → order → fulfilment notification → measurement end to end.</p></div>
 <div style={{...card,marginTop:16}}><strong>Pricing controls</strong><p style={{marginBottom:0}}>Pocket WiFi QY10: 10% off rental component through 30 Sep 2026. eSIM: only advertise a price advantage where a current comparable public benchmark has been verified; server pricing remains authoritative.</p></div></main>;
}
