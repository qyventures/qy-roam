import { getMetaCapiToken } from '@/lib/runtimeConfig';
import { hasRequiredFulfilmentEmailConfig, hasRequiredOperationsSchema, hasRequiredPaymentSchema, hasRequiredStripeWebhookConfig } from '@/lib/productionReadiness';
import { operationalConfig } from '@/lib/operationalConfig';

export const dynamic = 'force-dynamic';

const card={border:'1px solid #e4e8ef',borderRadius:16,padding:18,background:'#fff'} as const;
function Row({label,ok,note}:{label:string,ok:boolean,note:string}){return <div style={{display:'grid',gridTemplateColumns:'minmax(180px,1fr) 100px minmax(240px,2fr)',gap:12,padding:'12px 0',borderTop:'1px solid #eef1f5',alignItems:'center'}}><strong>{label}</strong><span style={{fontWeight:800}}>{ok?'✓ Ready':'⚠ Blocked'}</span><span style={{color:'#64748b'}}>{note}</span></div>}

function isProductionSiteUrl(value?:string){
 try{const url=new URL(value||'');return url.protocol==='https:'&&['qyroam.com','www.qyroam.com'].includes(url.hostname);}catch{return false;}
}
function hasLiveStripeSecret(value?:string){return Boolean(value?.startsWith('sk_live_')||value?.startsWith('rk_live_'));}
function hasOrderIntegritySecret(value?:string){return Boolean(value&&value.length>=32);}

export default async function LaunchPage(){
 const [paymentDbOk, operationsDbOk]=await Promise.all([hasRequiredPaymentSchema(),hasRequiredOperationsSchema()]);
 const config=operationalConfig();
 const stripe=hasLiveStripeSecret(process.env.STRIPE_SECRET_KEY);
 const webhook=hasRequiredStripeWebhookConfig();
 const smtp=hasRequiredFulfilmentEmailConfig();
 const pixel=Boolean(process.env.NEXT_PUBLIC_META_PIXEL_ID);
 const capi=Boolean(getMetaCapiToken());
 const site=isProductionSiteUrl(process.env.NEXT_PUBLIC_SITE_URL);
 const orderIntegrity=hasOrderIntegritySecret(process.env.ORDER_INTEGRITY_SECRET);
 // These are the public checkout prerequisites, not merely a partial database probe.
 const storefrontReady=stripe&&webhook&&site&&orderIntegrity&&paymentDbOk&&smtp;
 const wifiInventory=Boolean(config&&config.pocketWifiInventory>0);
 const esimReady=storefrontReady;
 const wifiReady=storefrontReady&&wifiInventory;
 const paidReady=esimReady&&wifiReady&&pixel&&capi;
 const storefrontBlockers=[!stripe&&'live Stripe credential',!webhook&&'Stripe webhook signing secret',!site&&'production HTTPS site URL',!orderIntegrity&&'order-integrity signing secret',!paymentDbOk&&'payment database schema',!smtp&&'fulfilment email transport',!wifiInventory&&'Pocket WiFi saleable-capacity setting'].filter(Boolean) as string[];
 const paidBlockers=[...storefrontBlockers,!pixel&&'Meta Pixel ID',!capi&&'Meta CAPI token'].filter(Boolean) as string[];
 return <main className="wrap section legal" style={{maxWidth:1100}}><span className="eyebrow">Launch control</span><h1>Production readiness</h1><p style={{color:'#64748b'}}>Safe configuration check only. Secret values are never displayed. Checkout status reflects the gates enforced before a customer can pay.</p>
 <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))',gap:14,marginTop:20}}><div style={card}><small>eSIM checkout</small><h2 style={{margin:'6px 0'}}>{esimReady?'✓ Ready':'⚠ Blocked'}</h2><span style={{color:'#64748b'}}>Payment, durable order record and fulfilment alert.</span></div><div style={card}><small>Pocket WiFi checkout</small><h2 style={{margin:'6px 0'}}>{wifiReady?'✓ Ready':'⚠ Blocked'}</h2><span style={{color:'#64748b'}}>eSIM prerequisites plus configured router capacity.</span></div><div style={card}><small>Paid acquisition</small><h2 style={{margin:'6px 0'}}>{paidReady?'✓ Ready':'⚠ Hold'}</h2><span style={{color:'#64748b'}}>{paidReady?'Storefront, fulfilment and measurement controls ready.':`${paidBlockers.length} production blocker${paidBlockers.length===1?'':'s'} remaining.`}</span></div></div>
 <div style={{...card,marginTop:16}}><h2 style={{marginTop:0}}>Launch checklist</h2><Row label="Live Stripe checkout" ok={stripe} note="Live server-side Stripe credential"/><Row label="Stripe webhook" ok={webhook} note="Required for signed payment confirmation and durable order processing"/><Row label="Order integrity" ok={orderIntegrity} note="Server-only Checkout Session provenance signing"/><Row label="Production URL" ok={site} note="HTTPS qyroam.com or www.qyroam.com origin for Stripe redirects"/><Row label="Payment database schema" ok={paymentDbOk} note="Orders plus Stripe idempotency, fulfilment and Meta delivery ledgers"/><Row label="Fulfilment email" ok={smtp} note="Paid-order alert to QY operations for manual fulfilment"/><Row label="Pocket WiFi capacity" ok={wifiInventory} note="Positive configured router capacity required for Pocket WiFi checkout"/><Row label="Operations database schema" ok={operationsDbOk} note="Inventory, admin reporting, CRM, forecasting and closing records"/><Row label="Meta Pixel" ok={pixel} note="Consent-gated browser measurement"/><Row label="Meta CAPI" ok={capi} note="Server-side Purchase measurement"/></div>
 {!esimReady&&<div style={{...card,marginTop:16}}><strong>Storefront checkout blockers</strong><p style={{marginBottom:0}}>{storefrontBlockers.filter((blocker)=>blocker!=='Pocket WiFi saleable-capacity setting').join(' · ')||'Investigate checkout configuration.'}</p></div>}
 {!wifiReady&&esimReady&&<div style={{...card,marginTop:16}}><strong>Pocket WiFi checkout blocker</strong><p style={{marginBottom:0}}>Set a positive, accurate Pocket WiFi capacity before accepting router bookings.</p></div>}
 {!paidReady&&<div style={{...card,marginTop:16}}><strong>Paid-launch blockers</strong><p style={{marginBottom:0}}>{paidBlockers.join(' · ')}</p></div>}
 <div style={{...card,marginTop:16}}><strong>Spend guardrail</strong><p style={{marginBottom:0}}>Paid campaigns remain approval-gated. Hard launch ceiling: S$10/day. Do not scale until a controlled live payment confirms payment → order → fulfilment notification → measurement end to end.</p></div>
 <div style={{...card,marginTop:16}}><strong>Pricing controls</strong><p style={{marginBottom:0}}>Pocket WiFi QY10: 10% off rental component through 30 Sep 2026. eSIM: only advertise a price advantage where a current comparable public benchmark has been verified; server pricing remains authoritative.</p></div></main>;
}
