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
 const capi=Boolean(process.env.META_CAPI_TOKEN);
 const site=Boolean(process.env.NEXT_PUBLIC_SITE_URL||'https://qyroam.com');
 const paidReady=stripe&&webhook&&dbOk&&smtp&&pixel&&capi;
 return <main className="wrap section legal" style={{maxWidth:1100}}><span className="eyebrow">Launch control</span><h1>Production readiness</h1><p style={{color:'#64748b'}}>Safe configuration check only. Secret values are never displayed.</p><div style={{...card,marginTop:20}}><h2 style={{marginTop:0}}>{paidReady?'Paid acquisition ready':'Paid acquisition has blockers'}</h2><Row label="Stripe checkout" ok={stripe} note="Server-side Stripe credential"/><Row label="Stripe webhook" ok={webhook} note="Required for signed payment confirmation and order processing"/><Row label="Order database" ok={dbOk} note="Supabase order persistence and operating platform"/><Row label="Fulfilment email" ok={smtp} note="Human fulfilment notification transport"/><Row label="Meta Pixel" ok={pixel} note="Consent-gated browser measurement"/><Row label="Meta CAPI" ok={capi} note="Server-side Purchase measurement"/><Row label="Production URL" ok={site} note="qyroam.com event source"/></div><div style={{...card,marginTop:16}}><strong>Spend guardrail</strong><p style={{marginBottom:0}}>Paid campaigns remain an approval-gated operational action. Launch budget ceiling: S$10/day.</p></div></main>;
}
