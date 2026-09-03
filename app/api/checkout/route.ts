import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { createStripeClient } from '../../../lib/stripeClient';
import { applyPromoCents, normalisePromoCode } from '../../../lib/promotions';
import { getWifiPlan, WIFI_BENCHMARK } from '../../../lib/wifiPlans';
import { getSupabaseAdmin } from '../../../lib/supabaseAdmin';
import { parseExactIsoDate, validCheckoutRequestId } from '../../../lib/checkoutValidation';
import { QY_ROAM_PROVENANCE_METADATA_KEY, signedQyRoamProvenance, validQyRoamProvenance } from '../../../lib/orderProvenance';
import { operationalConfig } from '../../../lib/operationalConfig';
import { operationalIsoDate, operationalIsoDateAfter } from '../../../lib/operationalDate';
import { hasRequiredFulfilmentEmailConfig, hasRequiredPaymentSchema } from '../../../lib/productionReadiness';

export const runtime = 'nodejs';

const MAX_BODY_BYTES=4096;
const WINDOW_MS=60_000;
const MAX_ATTEMPTS=12;
const HOLD_MINUTES=30;
const attempts=new Map<string,{count:number;reset:number}>();

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
type RequestedPocketWifi = {
  country:string; start:string; end:string; days:number; daily:number;
  rentalBeforePromo:number; promoCode:string; promoDiscount:number; courierFee:number;
};

// Stripe idempotency keys intentionally outlive a Checkout Session. A retry
// must identify the full server-priced booking, not merely its travel dates.
function matchesRequestedPocketWifi(session:Stripe.Checkout.Session,requestId:string,requested:RequestedPocketWifi) {
  const expectedAmount=requested.rentalBeforePromo-requested.promoDiscount+requested.courierFee;
  return session.metadata?.source==='qyroam.com' &&
    session.metadata?.product_type==='pocket_wifi' &&
    session.metadata?.checkout_request_id===requestId &&
    session.metadata?.country===requested.country &&
    session.metadata?.start===requested.start &&
    session.metadata?.end===requested.end &&
    session.metadata?.days===String(requested.days) &&
    session.metadata?.plan_name===`${requested.country} Pocket WiFi` &&
    session.metadata?.daily_rate_sgd===requested.daily.toFixed(2) &&
    session.metadata?.benchmark_provider===WIFI_BENCHMARK.provider &&
    session.metadata?.benchmark_rate_sgd===getWifiPlan(requested.country)?.benchmarkRateSgd.toFixed(2) &&
    session.metadata?.benchmark_verified_on===WIFI_BENCHMARK.verifiedOn &&
    session.metadata?.rental_before_promo_sgd===(requested.rentalBeforePromo/100).toFixed(2) &&
    session.metadata?.promo_code===requested.promoCode &&
    session.metadata?.promo_discount_sgd===(requested.promoDiscount/100).toFixed(2) &&
    session.metadata?.courier_fee_sgd===(requested.courierFee/100).toFixed(2) &&
    session.currency?.toLowerCase()==='sgd' && session.amount_total===expectedAmount;
}

async function activeStripeHolds(stripe:Stripe,start:string,end:string,requestId:string|null,requested:RequestedPocketWifi) {
  const nowSeconds=Math.floor(Date.now()/1000);
  const cutoff=nowSeconds-(HOLD_MINUTES*60);
  let startingAfter:string|undefined;
  let holds=0;
  const requestIds:string[]=[];
  // Every still-valid QY Roam Checkout Session is an inventory hold. Do not cap
  // pagination here: stopping after an arbitrary number of pages can undercount
  // holds during a busy period and oversell the final routers.
  for(;;){
    const sessions=await stripe.checkout.sessions.list({status:'open',limit:100,...(startingAfter?{starting_after:startingAfter}:{})});
    for(const session of sessions.data){
      // Stripe normally removes expired sessions from the "open" list, but
      // expiry is the inventory boundary. Check it explicitly so a session
      // expired early (or retained briefly by the API) cannot block a router.
      // Do not let a manually-created lookalike session in a shared Stripe
      // account consume scarce router capacity. Holds use the same
      // server-authored provenance boundary as paid-order fulfilment.
      if(session.created<cutoff||!session.expires_at||session.expires_at<=nowSeconds||session.metadata?.source!=='qyroam.com'||!validQyRoamProvenance(session.id,session.metadata)) continue;
      // A signed QY Roam session is not necessarily a router reservation.
      // Require the explicit server-authored product identity; treating an
      // absent type as Pocket WiFi could reserve stock for another product
      // during a metadata migration or an operational recovery.
      if(session.metadata?.product_type!=='pocket_wifi') continue;
      if(requestId&&session.metadata?.checkout_request_id===requestId){
        const sameBooking=matchesRequestedPocketWifi(session,requestId,requested);
        return {holds,requestIds,existingUrl:sameBooking?session.url:null,existingSessionId:sameBooking?session.id:null,requestConflict:!sameBooking};
      }
      const holdStart=session.metadata?.start, holdEnd=session.metadata?.end;
      if(holdStart&&holdEnd&&holdStart<=end&&holdEnd>=start){
        holds+=1;
        const holdRequestId=validCheckoutRequestId(session.metadata?.checkout_request_id);
        if(holdRequestId) requestIds.push(holdRequestId);
      }
    }
    if(!sessions.has_more||sessions.data.length===0) break;
    startingAfter=sessions.data[sessions.data.length-1].id;
  }
  return {holds,requestIds,existingUrl:null,existingSessionId:null,requestConflict:false};
}

// A Stripe Checkout URL is only safe to expose once its durable inventory hold
// is tied to that exact session.  This also repairs the small interruption
// window between session creation and the original link on a client retry.
async function linkReservationToSession(supabase:NonNullable<ReturnType<typeof getSupabaseAdmin>>,requestId:string,sessionId:string) {
  const linked=await supabase.from('checkout_reservations')
    .update({stripe_session_id:sessionId})
    .eq('checkout_request_id',requestId)
    // Never overwrite a reservation that has somehow been linked to another
    // session. Repeating the same link is intentionally idempotent.
    .or(`stripe_session_id.is.null,stripe_session_id.eq.${sessionId}`)
    .select('checkout_request_id')
    .maybeSingle();
  if(linked.error) throw linked.error;
  return Boolean(linked.data);
}

export async function POST(req: Request) {
 try {
  if(limited(req)) return NextResponse.json({error:'Too many checkout attempts. Please try again shortly.'},{status:429,headers:{'Retry-After':'60'}});
  const type=req.headers.get('content-type')||''; if(!type.toLowerCase().startsWith('application/json')) return NextResponse.json({error:'Expected JSON request.'},{status:415});
  const length=Number(req.headers.get('content-length')||0); if(length>MAX_BODY_BYTES) return NextResponse.json({error:'Request too large.'},{status:413});
  const key=process.env.STRIPE_SECRET_KEY; if(!key) return NextResponse.json({error:'Payment configuration incomplete.'},{status:503});
  if(!process.env.ORDER_INTEGRITY_SECRET||process.env.ORDER_INTEGRITY_SECRET.length<32) return NextResponse.json({error:'Order configuration incomplete.'},{status:503});
  if(!hasRequiredFulfilmentEmailConfig()) return NextResponse.json({error:'Pocket WiFi ordering is temporarily unavailable. Please try again shortly or contact +65 8032 7183.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'30'}});
  const config=operationalConfig(); if(!config) return NextResponse.json({error:'Order configuration incomplete.'},{status:503});
  const raw=await req.text(); if(new TextEncoder().encode(raw).length>MAX_BODY_BYTES) return NextResponse.json({error:'Request too large.'},{status:413});
  let body:Record<string,unknown>; try { body=JSON.parse(raw); } catch { return NextResponse.json({error:'Invalid request.'},{status:400}); }
  const requestId=validCheckoutRequestId(body.checkoutRequestId);
  if(!requestId) return NextResponse.json({error:'Invalid checkout request.'},{status:400});
  const country=String(body.country||''); const wifiPlan=getWifiPlan(country); const daily=wifiPlan?.daily; const startDate=parseExactIsoDate(body.start); const endDate=parseExactIsoDate(body.end);
  if(!wifiPlan||!daily||!startDate||!endDate||endDate<startDate) return NextResponse.json({error:'Please select a valid destination and travel period.'},{status:400});
  // A reservation alone is not enough: once payment succeeds, the webhook
  // needs the orders and delivery/idempotency ledgers as well. Do this before
  // creating a payable Stripe Session so an incomplete migration cannot leave
  // a paid router booking unrecorded or unfulfillable.
  if(!await hasRequiredPaymentSchema()) return NextResponse.json({error:'Pocket WiFi ordering is temporarily unavailable. Please try again shortly or contact +65 8032 7183.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'30'}});
  // Delivery is operated in Singapore. UTC midnight can still be the previous
  // calendar day in Singapore, which would incorrectly accept a past date or
  // shorten the advertised lead time during the local early morning.
  const today=operationalIsoDate();
  const start=String(body.start), end=String(body.end);
  if(start<today) return NextResponse.json({error:'Travel start date cannot be in the past.'},{status:400});
  const minLeadDays=config.minDeliveryLeadDays, earliest=operationalIsoDateAfter(minLeadDays);
  if(start<earliest) return NextResponse.json({error:`Please book at least ${minLeadDays} day${minLeadDays===1?'':'s'} before departure so we can arrange delivery. Contact +65 8032 7183 for urgent trips.`},{status:400});
  const days=Math.floor((endDate.getTime()-startDate.getTime())/86400000)+1; if(days<1||days>90) return NextResponse.json({error:'Bookings must be between 1 and 90 days.'},{status:400});
  const stripe=createStripeClient(key);
  const inventory=config.pocketWifiInventory;
  if(inventory<1) return NextResponse.json({error:'Pocket WiFi is sold out for these dates. Please choose different dates or contact +65 8032 7183.'},{status:409,headers:{'Cache-Control':'no-store'}});
  const rentalBeforePromo=Math.max(1000,Math.round(daily*days*100));
  const promo=applyPromoCents(rentalBeforePromo, body.promoCode);
  const rentalAmount=promo.amountCents;
  const courierFee=config.courierFeeCents;
  const requested={country,start,end,days,daily,rentalBeforePromo,promoCode:promo.promoCode,promoDiscount:promo.discountCents,courierFee};
  const holdState=await activeStripeHolds(stripe,start,end,requestId,requested);
  if(holdState.requestConflict) return NextResponse.json({error:'This checkout attempt belongs to different booking details. Please refresh and try again.',checkoutRequestConflict:true},{status:409,headers:{'Cache-Control':'no-store'}});
  const supabase=getSupabaseAdmin();
  if(!supabase) return NextResponse.json({error:'Live reservation is temporarily unavailable. Please try again shortly or contact +65 8032 7183.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'30'}});
  if(holdState.existingUrl&&holdState.existingSessionId){
    // A retry can find a session created just before a process interruption.
    // Repair its provenance before returning its URL, rather than allowing an
    // unsigned session to reach payment.
    const existing=await stripe.checkout.sessions.retrieve(holdState.existingSessionId);
    const metadata={...existing.metadata} as Record<string,string>;
    const provenance=signedQyRoamProvenance(existing.id,metadata);
    if(metadata[QY_ROAM_PROVENANCE_METADATA_KEY]!==provenance){
      await stripe.checkout.sessions.update(existing.id,{metadata:{[QY_ROAM_PROVENANCE_METADATA_KEY]:provenance}});
    }
    if(!await linkReservationToSession(supabase,requestId,existing.id)){
      // Do not redirect a retry to payment when its durable reservation was
      // lost or points to a different Stripe session. Keeping the open Stripe
      // Session unexposed preserves capacity until an operator can investigate.
      return NextResponse.json({error:'Live reservation confirmation is temporarily unavailable. Please try again shortly or contact +65 8032 7183.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'30'}});
    }
    return NextResponse.json({url:holdState.existingUrl},{headers:{'Cache-Control':'no-store'}});
  }
  const expiresAt=new Date(Date.now()+HOLD_MINUTES*60_000).toISOString();
  const reservation=await supabase.rpc('qy_reserve_pocket_wifi',{
    p_checkout_request_id:requestId,
    p_travel_start:start,
    p_travel_end:end,
    p_inventory:inventory,
    p_expires_at:expiresAt,
    p_stripe_hold_count:holdState.holds,
    p_stripe_hold_request_ids:holdState.requestIds
  });
  if(reservation.error) throw reservation.error;
  const reserved=reservation.data?.[0]?.reserved===true;
  if(!reserved) return NextResponse.json({error:'Pocket WiFi is sold out or currently reserved for these dates. Please try different dates or contact +65 8032 7183.'},{status:409,headers:{'Cache-Control':'no-store'}});
  const origin=siteOrigin(req);
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[]=[{quantity:1,price_data:{currency:'sgd',unit_amount:rentalAmount,product_data:{name:`QY Roam Pocket WiFi — ${country}`,description:`${start} to ${end} · ${days} day${days===1?'':'s'}${promo.discountCents>0?` · ${normalisePromoCode(body.promoCode)} applied`:''}`}}}];
  if(courierFee>0) lineItems.push({quantity:1,price_data:{currency:'sgd',unit_amount:courierFee,product_data:{name:'Singapore courier delivery & return handling'}}});
  let session:Stripe.Checkout.Session;
  try{
    session=await stripe.checkout.sessions.create({mode:'payment',line_items:lineItems,expires_at:Math.floor(new Date(expiresAt).getTime()/1000),billing_address_collection:'required',shipping_address_collection:{allowed_countries:['SG']},phone_number_collection:{enabled:true},customer_creation:'always',success_url:`${origin}/success?session_id={CHECKOUT_SESSION_ID}`,cancel_url:`${origin}/?checkout=cancelled`,metadata:{product_type:'pocket_wifi',plan_name:`${country} Pocket WiFi`,country,start,end,days:String(days),daily_rate_sgd:daily.toFixed(2),benchmark_provider:WIFI_BENCHMARK.provider,benchmark_rate_sgd:wifiPlan.benchmarkRateSgd.toFixed(2),benchmark_verified_on:WIFI_BENCHMARK.verifiedOn,rental_before_promo_sgd:(rentalBeforePromo/100).toFixed(2),promo_code:promo.promoCode,promo_discount_sgd:(promo.discountCents/100).toFixed(2),courier_fee_sgd:(courierFee/100).toFixed(2),checkout_amount_cents:String(rentalAmount+courierFee),checkout_request_id:requestId,source:'qyroam.com',measurement_consent:body.measurementConsent===true?'accepted':'essential'},consent_collection:{terms_of_service:'required'}},{idempotencyKey:`qyroam_wifi_${requestId}`});
  }catch(error){
    // A network failure is ambiguous: Stripe may have created a payable
    // session before its response was lost. Releasing the reservation here
    // would make that session an uncounted router hold and could oversell the
    // final device. Keep it until its short expiry (or Stripe's signed terminal
    // event). Retrying the same idempotency key repairs the session provenance
    // and links this existing reservation before its URL is returned.
    throw error;
  }
  // The open-session lookup above intentionally sees only active Stripe
  // holds. An idempotency key can also replay a completed or expired Session,
  // so validate the response from the create call itself before linking the
  // newly-created reservation or returning any checkout state to the browser.
  if(!matchesRequestedPocketWifi(session,requestId,requested)){
    const released=await supabase.from('checkout_reservations').delete().eq('checkout_request_id',requestId).is('stripe_session_id',null);
    if(released.error) throw released.error;
    return NextResponse.json({error:'This checkout attempt belongs to different booking details. Please refresh and try again.',checkoutRequestConflict:true},{status:409,headers:{'Cache-Control':'no-store'}});
  }
  // The id-specific provenance is written before the checkout URL is exposed.
  // Retrying the same idempotency key also repairs a session if a process died
  // between Stripe creation and this metadata update.
  const metadata={...session.metadata} as Record<string,string>;
  const provenance=signedQyRoamProvenance(session.id,metadata);
  if(metadata[QY_ROAM_PROVENANCE_METADATA_KEY]!==provenance){
    try { await stripe.checkout.sessions.update(session.id,{metadata:{[QY_ROAM_PROVENANCE_METADATA_KEY]:provenance}}); }
    catch(error){
      // This update can fail after Stripe created a usable Checkout Session.
      // As above, retain capacity rather than creating an uncounted payable
      // session. A same-key retry will re-read the session and finish signing
      // and linking it; expiry/terminal webhook events release the hold.
      throw error;
    }
  }
  // A completed paid Session may be returned when a browser retries after its
  // original response was lost. Do not send the customer back to Stripe or
  // hold capacity unnecessarily after the webhook has already persisted the
  // order. If persistence is still catching up, link the reservation first so
  // the terminal webhook can release it once it records the paid booking.
  if(session.status==='complete'&&session.payment_status==='paid'){
    const order=await supabase.from('orders').select('payment_status').eq('stripe_session_id',session.id).maybeSingle();
    if(order.error) throw order.error;
    if(order.data?.payment_status==='paid'){
      const released=await supabase.from('checkout_reservations').delete().eq('checkout_request_id',requestId).is('stripe_session_id',null);
      if(released.error) throw released.error;
    }else if(!await linkReservationToSession(supabase,requestId,session.id)){
      return NextResponse.json({error:'Live reservation confirmation is temporarily unavailable. Please try again shortly or contact +65 8032 7183.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'30'}});
    }
    return NextResponse.json({completed:true,sessionId:session.id},{headers:{'Cache-Control':'no-store'}});
  }
  // Stripe retains idempotency keys after a Checkout Session expires. A client
  // retry using that key can therefore receive the old session, whose URL is
  // null. Do not link its new inventory reservation or report a false success.
  // The browser receives an explicit recoverable signal and creates a fresh
  // checkout request id for the next attempt.
  if(session.status==='expired'){
    const released=await supabase.from('checkout_reservations').delete().eq('checkout_request_id',requestId).is('stripe_session_id',null);
    if(released.error) console.error('checkout_expired_reservation_release_error',released.error);
    return NextResponse.json({error:'This secure checkout session has expired. Please try again to start a new one.',checkoutExpired:true},{status:409,headers:{'Cache-Control':'no-store'}});
  }
  // A completed asynchronous payment may not yet be paid. Preserve its
  // reservation and let the signed terminal webhook decide when stock can be
  // released, rather than turning a payment-in-progress retry into an
  // uncounted router booking.
  if(session.status!=='open'||!session.url){
    if(!await linkReservationToSession(supabase,requestId,session.id)) return NextResponse.json({error:'Live reservation confirmation is temporarily unavailable. Please try again shortly or contact +65 8032 7183.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'30'}});
    return NextResponse.json({error:'Your payment is still being confirmed. Please wait for confirmation before trying again.',paymentPending:true},{status:409,headers:{'Cache-Control':'no-store'}});
  }
  if(!await linkReservationToSession(supabase,requestId,session.id)){
    // Fail closed: a payment URL without a durable session-to-reservation
    // relationship cannot safely be reconciled by fulfilment or inventory.
    return NextResponse.json({error:'Live reservation confirmation is temporarily unavailable. Please try again shortly or contact +65 8032 7183.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'30'}});
  }
  return NextResponse.json({url:session.url},{headers:{'Cache-Control':'no-store'}});
 } catch(error){ console.error('checkout_error',error); return NextResponse.json({error:'Unable to start checkout.'},{status:500}); }
}
