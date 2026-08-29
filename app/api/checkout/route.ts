import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { applyPromoCents, normalisePromoCode } from '../../../lib/promotions';
import { getWifiPlan, WIFI_BENCHMARK } from '../../../lib/wifiPlans';

export const runtime = 'nodejs';

const MAX_BODY_BYTES=4096;
const WINDOW_MS=60_000;
const MAX_ATTEMPTS=12;
const HOLD_MINUTES=30;
const QY_OPS_URL='https://cqyhqbzrgkckalbowhrx.supabase.co';
const QY_OPS_ANON='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNxeWhxYnpyZ2tja2FsYm93aHJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4OTI0NDIsImV4cCI6MjEwMzQ2ODQ0Mn0.rzPO2wUxnGc37RTMdtsc9Mo9UE5F5RcIkOJkBke6dR4';
const attempts=new Map<string,{count:number;reset:number}>();

function parseDate(value: unknown) { const text=String(value||''); if(!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null; const date=new Date(`${text}T00:00:00Z`); return Number.isNaN(date.getTime())?null:date; }
function siteOrigin(req: Request) {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) { try { return new URL(configured).origin; } catch { throw new Error('Invalid NEXT_PUBLIC_SITE_URL'); } }
  if (process.env.NODE_ENV === 'production') throw new Error('NEXT_PUBLIC_SITE_URL is required in production');
  return new URL(req.url).origin;
}
function clientKey(req: Request) { return (req.headers.get('cf-connecting-ip')||req.headers.get('x-real-ip')||req.headers.get('x-forwarded-for')?.split(',')[0]||'unknown').trim(); }
function limited(req: Request) {
  const key=clientKey(req), now=Date.now(), current=attempts.get(key);
  if(!current||current.reset<=now){ attempts.set(key,{count:1,reset:now+WINDOW_MS}); return false; }
  current.count+=1;
  if(attempts.size>5000) for(const [k,v] of attempts) if(v.reset<=now) attempts.delete(k);
  return current.count>MAX_ATTEMPTS;
}
async function bookedInventoryCount(start:string,end:string) {
  const supabaseUrl=process.env.SUPABASE_URL, serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(supabaseUrl&&serviceKey){
    const url=new URL('/rest/v1/orders',supabaseUrl);
    url.searchParams.set('select','id');
    url.searchParams.set('product_type','eq.pocket_wifi');
    url.searchParams.set('payment_status','eq.paid');
    url.searchParams.set('travel_start',`lte.${end}`);
    url.searchParams.set('travel_end',`gte.${start}`);
    url.searchParams.set('fulfilment_status','not.in.(cancelled,payment_failed,closed)');
    const res=await fetch(url,{headers:{apikey:serviceKey,Authorization:`Bearer ${serviceKey}`},cache:'no-store'});
    if(!res.ok) throw new Error(`Inventory lookup failed (${res.status})`);
    return ((await res.json()) as unknown[]).length;
  }
  const edge=new URL('/functions/v1/qy-roam-availability',QY_OPS_URL);
  edge.searchParams.set('start',start); edge.searchParams.set('end',end);
  const res=await fetch(edge,{headers:{apikey:QY_OPS_ANON,Authorization:`Bearer ${QY_OPS_ANON}`},cache:'no-store'});
  if(!res.ok) throw new Error(`QY Ops inventory lookup failed (${res.status})`);
  const body=(await res.json()) as {committed?:number};
  return Math.max(0,Number(body.committed||0));
}
async function activeStripeHolds(stripe:Stripe,start:string,end:string) {
  const cutoff=Math.floor(Date.now()/1000)-(HOLD_MINUTES*60);
  let startingAfter:string|undefined;
  let holds=0;
  // Match the availability endpoint's pagination so checkout cannot oversell when
  // Stripe has more than 100 open sessions during a busy launch period.
  for(let page=0;page<5;page+=1){
    const sessions=await stripe.checkout.sessions.list({status:'open',limit:100,...(startingAfter?{starting_after:startingAfter}:{})});
    for(const session of sessions.data){
      if(session.created<cutoff||session.metadata?.source!=='qyroam.com') continue;
      if(session.metadata?.product_type && session.metadata.product_type!=='pocket_wifi') continue;
      const holdStart=session.metadata?.start, holdEnd=session.metadata?.end;
      if(holdStart&&holdEnd&&holdStart<=end&&holdEnd>=start) holds+=1;
    }
    if(!sessions.has_more||sessions.data.length===0) break;
    startingAfter=sessions.data[sessions.data.length-1].id;
  }
  return holds;
}

export async function POST(req: Request) {
 try {
  if(limited(req)) return NextResponse.json({error:'Too many checkout attempts. Please try again shortly.'},{status:429,headers:{'Retry-After':'60'}});
  const type=req.headers.get('content-type')||''; if(!type.toLowerCase().startsWith('application/json')) return NextResponse.json({error:'Expected JSON request.'},{status:415});
  const length=Number(req.headers.get('content-length')||0); if(length>MAX_BODY_BYTES) return NextResponse.json({error:'Request too large.'},{status:413});
  const key=process.env.STRIPE_SECRET_KEY; if(!key) return NextResponse.json({error:'Payment configuration incomplete.'},{status:503});
  const raw=await req.text(); if(new TextEncoder().encode(raw).length>MAX_BODY_BYTES) return NextResponse.json({error:'Request too large.'},{status:413});
  let body:Record<string,unknown>; try { body=JSON.parse(raw); } catch { return NextResponse.json({error:'Invalid request.'},{status:400}); }
  const country=String(body.country||''); const wifiPlan=getWifiPlan(country); const daily=wifiPlan?.daily; const startDate=parseDate(body.start); const endDate=parseDate(body.end);
  if(!wifiPlan||!daily||!startDate||!endDate||endDate<startDate) return NextResponse.json({error:'Please select a valid destination and travel period.'},{status:400});
  const now=new Date(); now.setUTCHours(0,0,0,0); if(startDate<now) return NextResponse.json({error:'Travel start date cannot be in the past.'},{status:400});
  const minLeadDays=Math.max(0,Number.parseInt(process.env.MIN_DELIVERY_LEAD_DAYS||'2',10)||0); const earliest=new Date(now); earliest.setUTCDate(earliest.getUTCDate()+minLeadDays);
  if(startDate<earliest) return NextResponse.json({error:`Please book at least ${minLeadDays} day${minLeadDays===1?'':'s'} before departure so we can arrange delivery. Contact +65 8032 7183 for urgent trips.`},{status:400});
  const days=Math.floor((endDate.getTime()-startDate.getTime())/86400000)+1; if(days<1||days>90) return NextResponse.json({error:'Bookings must be between 1 and 90 days.'},{status:400});
  const start=String(body.start), end=String(body.end);
  const stripe=new Stripe(key,{apiVersion:'2024-06-20'});
  const inventory=Math.max(0,Number(process.env.POCKET_WIFI_INVENTORY||'10')||0);
  if(inventory<1) return NextResponse.json({error:'Pocket WiFi is sold out for these dates. Please choose different dates or contact +65 8032 7183.'},{status:409,headers:{'Cache-Control':'no-store'}});
  const booked=await bookedInventoryCount(start,end);
  const holds=await activeStripeHolds(stripe,start,end);
  if(booked+holds>=inventory) return NextResponse.json({error:booked>=inventory?'Pocket WiFi is sold out for these dates. Please choose different dates or contact +65 8032 7183.':'Pocket WiFi is currently being reserved by other customers for these dates. Please try again shortly or contact +65 8032 7183.'},{status:409,headers:{'Cache-Control':'no-store'}});
  const rentalBeforePromo=Math.max(1000,Math.round(daily*days*100));
  const promo=applyPromoCents(rentalBeforePromo, body.promoCode);
  const rentalAmount=promo.amountCents;
  const courierFee=Math.max(0,Math.round(Number(process.env.COURIER_FEE_SGD||'0')*100));
  const origin=siteOrigin(req);
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[]=[{quantity:1,price_data:{currency:'sgd',unit_amount:rentalAmount,product_data:{name:`QY Roam Pocket WiFi — ${country}`,description:`${start} to ${end} · ${days} day${days===1?'':'s'}${promo.discountCents>0?` · ${normalisePromoCode(body.promoCode)} applied`:''}`}}}];
  if(courierFee>0) lineItems.push({quantity:1,price_data:{currency:'sgd',unit_amount:courierFee,product_data:{name:'Singapore courier delivery & return handling'}}});
  const session=await stripe.checkout.sessions.create({mode:'payment',line_items:lineItems,expires_at:Math.floor(Date.now()/1000)+(HOLD_MINUTES*60),billing_address_collection:'required',shipping_address_collection:{allowed_countries:['SG']},phone_number_collection:{enabled:true},customer_creation:'always',success_url:`${origin}/success?session_id={CHECKOUT_SESSION_ID}`,cancel_url:`${origin}/?checkout=cancelled`,metadata:{product_type:'pocket_wifi',plan_name:`${country} Pocket WiFi`,country,start,end,days:String(days),daily_rate_sgd:daily.toFixed(2),benchmark_provider:WIFI_BENCHMARK.provider,benchmark_rate_sgd:wifiPlan.benchmarkRateSgd.toFixed(2),benchmark_verified_on:WIFI_BENCHMARK.verifiedOn,rental_before_promo_sgd:(rentalBeforePromo/100).toFixed(2),promo_code:promo.promoCode,promo_discount_sgd:(promo.discountCents/100).toFixed(2),source:'qyroam.com',measurement_consent:body.measurementConsent===true?'accepted':'essential'},consent_collection:{terms_of_service:'required'}});
  return NextResponse.json({url:session.url},{headers:{'Cache-Control':'no-store'}});
 } catch(error){ console.error('checkout_error',error); return NextResponse.json({error:'Unable to start checkout.'},{status:500}); }
}
