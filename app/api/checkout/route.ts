import { NextResponse as FrameworkNextResponse } from 'next/server';
import type Stripe from 'stripe';
import { createStripeClient } from '../../../lib/stripeClient';
import { applyPromoCents, normalisePromoCode, promoIsActive } from '../../../lib/promotions';
import { getWifiPlan, WIFI_BENCHMARK } from '../../../lib/wifiPlans';
import { getSupabaseAdmin } from '../../../lib/supabaseAdmin';
import { parseExactIsoDate, validCheckoutRequestId } from '../../../lib/checkoutValidation';
import { hasOrderIntegritySigningConfig, QY_ROAM_PROVENANCE_METADATA_KEY, signedQyRoamProvenance, validQyRoamProvenance } from '../../../lib/orderProvenance';
import { operationalConfig } from '../../../lib/operationalConfig';
import { operationalIsoDate, operationalIsoDateAfter } from '../../../lib/operationalDate';
import { hasRequiredFulfilmentEmailConfig, hasRequiredPaymentSchema, hasRequiredPocketWifiFulfilmentSchema, hasRequiredStripeCheckoutConfig, hasRequiredStripeWebhookConfig } from '../../../lib/productionReadiness';
import { stripeEventMatchesConfiguredMode } from '@/lib/stripeCheckoutConfig';
import { hasIdentityRequestContentEncoding, InvalidRequestBodyLengthError, isJsonRequestContentType, readLimitedRequestText, RequestBodyTimeoutError, RequestBodyTooLargeError } from '../../../lib/requestBody';
import { checkoutAttemptLimited, checkoutGloballyLimited } from '@/lib/checkoutRateLimit';
import { metaAttributionFromRequest } from '@/lib/metaAttribution';
import { checkoutAttemptExpiresAt } from '@/lib/checkoutExpiry';
import { checkoutSiteOrigin } from '@/lib/siteOrigin';
import { pocketWifiRentalCents } from '@/lib/pocketWifiPricing';
import { safeStripeCheckoutUrl } from '@/lib/stripeCheckoutUrl';
import { durableOrderMatchesPaidSession } from '@/lib/durableOrderSnapshot';
import { validStripeCheckoutSessionIdForMode } from '@/lib/stripeSessionId';
import { stripeWebhookCheckoutSessionMatchesSnapshot } from '@/lib/stripeWebhookObject';
import { tryAcquireCheckoutConcurrency, tryAcquireCheckoutUpload } from '@/lib/checkoutConcurrency';
import { scanActivePocketWifiStripeHolds } from '@/lib/pocketWifiStripeHolds';
import { stripeMeasurementConsentDowngrade } from '@/lib/stripeMeasurementConsent';

export const runtime = 'nodejs';

// Checkout responses describe request validity, live operational readiness,
// inventory and payment capabilities. None are safe to retain at a browser,
// proxy or CDN: even an early 4xx/503 can become stale and block a later valid
// attempt. Route every response through one boundary so new return paths are
// non-cacheable by default instead of relying on each branch to remember it.
const NextResponse = {
  json(body: unknown, init: ResponseInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Cache-Control', 'no-store');
    return FrameworkNextResponse.json(body, { ...init, headers });
  },
};

const MAX_BODY_BYTES=4096;
const CHECKOUT_BODY_TIMEOUT_MS=15_000;

type RequestedPocketWifi = {
  country:string; start:string; end:string; days:number; daily:number;
  rentalBeforePromo:number; promoCode:string; promoDiscount:number; courierFee:number;
  expiresAtSeconds:number;
};

// Stripe idempotency keys intentionally outlive a Checkout Session. A retry
// must identify the full server-priced booking, not merely its travel dates.
function matchesRequestedPocketWifi(session:Stripe.Checkout.Session,requestId:string,requested:RequestedPocketWifi,origin:string) {
  const expectedAmount=requested.rentalBeforePromo-requested.promoDiscount+requested.courierFee;
  return session.mode==='payment' &&
    // The paid-order boundary requires Stripe's recorded terms acceptance.
    // Stripe can replay an older Session for a durable idempotency key, so
    // verify that the payment capability actually collects that acceptance
    // before re-signing or returning its URL. Otherwise a legacy open Session
    // could accept payment and then be rejected by the webhook after charge.
    session.consent_collection?.terms_of_service==='required' &&
    // The paid-order boundary also requires a routable Singapore address and
    // customer phone number before operations can dispatch a router. A
    // durable Stripe idempotency key can replay a Session created by an older
    // release, so prove that capability collected both fields before signing
    // it, linking scarce inventory, or returning its payment URL. Otherwise a
    // customer could be charged successfully only for the webhook to reject
    // the order as undeliverable.
    session.phone_number_collection?.enabled===true &&
    session.shipping_address_collection?.allowed_countries?.length===1 &&
    session.shipping_address_collection.allowed_countries[0]==='SG' &&
    // The Session is also the customer's post-payment navigation contract.
    // Stripe idempotency can replay an older or dashboard-edited capability;
    // never re-sign and expose it when success would bypass QY Roam's durable
    // confirmation flow or cancellation would leave the current storefront.
    session.success_url===`${origin}/success?session_id={CHECKOUT_SESSION_ID}` &&
    session.cancel_url===`${origin}/?checkout=cancelled` &&
    session.metadata?.source==='qyroam.com' &&
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
    // The webhook independently validates this snapshot before recording a
    // paid order. Keep retries on the same boundary so a session modified in
    // Stripe cannot be re-signed and exposed when its amount field happens
    // to still match the requested booking.
    session.metadata?.checkout_amount_cents===String(expectedAmount) &&
    session.currency?.toLowerCase()==='sgd' && session.amount_total===expectedAmount &&
    // The database reservation expires at this exact browser-attempt
    // boundary. A Stripe URL that remained payable for longer could outlive
    // its stock hold and sell the same physical router twice.
    session.expires_at===requested.expiresAtSeconds;
}

async function activeStripeHolds(stripe:Stripe,stripeKey:string,start:string,end:string,requestId:string|null,requested:RequestedPocketWifi,origin:string) {
  let holds=0;
  const requestIds:string[]=[];
  let existingUrl:string|null=null;
  let existingSessionId:string|null=null;
  let existingSessionSnapshot:Pick<Stripe.Checkout.Session,'id'|'livemode'|'created'>|null=null;
  let requestConflict=false;
  let matchingRequestSessions=0;
  await scanActivePocketWifiStripeHolds(stripe,stripeKey,({session,sessionId,start:holdStart,end:holdEnd})=>{
      if(requestId&&session.metadata?.checkout_request_id===requestId){
        const sameBooking=matchesRequestedPocketWifi(session,requestId,requested,origin);
        matchingRequestSessions+=1;
        // A browser attempt can own exactly one Stripe payment capability.
        // Keep conflict detection monotonic across every page: a later
        // matching row must never erase an earlier mismatched or duplicate
        // Session. Multiple authenticated open Sessions with one request id
        // are operationally ambiguous even when their booking snapshots are
        // identical, because only one can be linked to the durable
        // reservation while either URL could still accept payment.
        if(!sameBooking||matchingRequestSessions>1){
          requestConflict=true;
        }else{
          existingUrl=session.url;
          existingSessionId=sessionId;
          existingSessionSnapshot={id:sessionId,livemode:session.livemode,created:session.created};
        }
        if(sameBooking&&matchingRequestSessions===1){
          // This one unambiguous Session is represented by the caller's
          // reservation, so it must not consume capacity twice. Still finish
          // the bounded scan: later pages can reveal duplicate/conflicting
          // capabilities or holds whose reservation write is absent.
          return;
        }
        // A conflicting or duplicate capability is not safely represented by
        // this caller's single reservation. Fall through and count any date
        // overlap like another Stripe hold, in addition to refusing recovery.
      }
      if(holdStart<=end&&holdEnd>=start){
        holds+=1;
        const holdRequestId=validCheckoutRequestId(session.metadata?.checkout_request_id);
        if(holdRequestId) requestIds.push(holdRequestId);
      }
  });
  return {holds,requestIds,existingUrl,existingSessionId,existingSessionSnapshot,requestConflict};
}

// A Stripe Checkout URL is only safe to expose once its durable inventory hold
// is tied to that exact session.  This also repairs the small interruption
// window between session creation and the original link on a client retry.
async function linkReservationToSession(supabase:NonNullable<ReturnType<typeof getSupabaseAdmin>>,requestId:string,sessionId:string,requested:RequestedPocketWifi) {
  // Make the final payment-capability hand-off a database authority. In
  // particular, the RPC checks expiry using the database clock in the same
  // statement that writes the link; a slow Stripe request cannot attach and
  // expose a payment URL after its inventory reservation has already ended.
  const linked=await supabase.rpc('qy_link_pocket_wifi_reservation',{
    p_checkout_request_id:requestId,
    p_stripe_session_id:sessionId,
    p_travel_start:requested.start,
    p_travel_end:requested.end,
    p_expires_at:new Date(requested.expiresAtSeconds*1000).toISOString(),
  });
  if(linked.error) throw linked.error;
  return linked.data===true;
}

export async function POST(req: Request) {
 let releaseCheckout: (()=>void)|null=null;
 try {
  // Keep malformed or repeatedly abusive traffic on the per-client ingress
  // boundary, but do not let it consume the instance-wide Stripe work budget.
  // Running the global limiter before basic validation lets cheap invalid
  // POSTs deny Checkout to every legitimate traveller on this process.
  if(checkoutAttemptLimited(req)) return NextResponse.json({error:'Too many checkout attempts. Please try again shortly.'},{status:429,headers:{'Cache-Control':'no-store','Retry-After':'60'}});
  if(!isJsonRequestContentType(req.headers.get('content-type'))) return NextResponse.json({error:'Expected JSON request.'},{status:415});
  // Keep the body-size and exact Content-Length boundary independent of
  // proxy/runtime decompression behaviour. Checkout clients send a tiny JSON
  // document and have no reason to use a content coding.
  if(!hasIdentityRequestContentEncoding(req.headers.get('content-encoding'))) return NextResponse.json({error:'Unsupported request content encoding.'},{status:415});
  // Match the readiness guard, which permits harmless deployment whitespace.
  // Passing the untrimmed secret to Stripe would otherwise make health look
  // ready while every checkout creation fails authentication.
  const key=process.env.STRIPE_SECRET_KEY?.trim(); if(!hasRequiredStripeCheckoutConfig()||!key) return NextResponse.json({error:'Payment configuration incomplete.'},{status:503});
  if(!hasOrderIntegritySigningConfig()) return NextResponse.json({error:'Order configuration incomplete.'},{status:503});
  if(!hasRequiredStripeWebhookConfig()) return NextResponse.json({error:'Pocket WiFi ordering is temporarily unavailable. Please try again shortly or contact +65 8032 7183.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'30'}});
  if(!hasRequiredFulfilmentEmailConfig()) return NextResponse.json({error:'Pocket WiFi ordering is temporarily unavailable. Please try again shortly or contact +65 8032 7183.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'30'}});
  const config=operationalConfig(); if(!config) return NextResponse.json({error:'Order configuration incomplete.'},{status:503});
  // Nginx streams this body so the absolute application deadline remains
  // effective. Cap simultaneous pre-validation uploads independently from
  // the smaller Stripe/Supabase work pool reached after parsing.
  const releaseUpload=tryAcquireCheckoutUpload();
  if(!releaseUpload) return NextResponse.json({error:'Checkout is busy. Please try again shortly.'},{status:503,headers:{'Retry-After':'5'}});
  let raw:string;
  try { raw=await readLimitedRequestText(req,MAX_BODY_BYTES,CHECKOUT_BODY_TIMEOUT_MS); }
  catch(error) {
    if(error instanceof RequestBodyTooLargeError) return NextResponse.json({error:'Request too large.'},{status:413});
    if(error instanceof InvalidRequestBodyLengthError) return NextResponse.json({error:'Invalid request.'},{status:400});
    if(error instanceof RequestBodyTimeoutError) return NextResponse.json({error:'Request timed out. Please try again.'},{status:408});
    return NextResponse.json({error:'Invalid request.'},{status:400});
  } finally { releaseUpload(); }
  let body:Record<string,unknown>;
  try {
    const parsed:unknown=JSON.parse(raw);
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)) throw new Error('Invalid JSON object');
    body=parsed as Record<string,unknown>;
  } catch { return NextResponse.json({error:'Invalid request.'},{status:400}); }
  const requestId=validCheckoutRequestId(body.checkoutRequestId);
  if(!requestId) return NextResponse.json({error:'Invalid checkout request.'},{status:400});
  const expiresAtSeconds=checkoutAttemptExpiresAt(body.checkoutAttemptCreatedAt);
  if(!expiresAtSeconds) return NextResponse.json({error:'This checkout attempt has expired. Please refresh and try again.',checkoutExpired:true},{status:409,headers:{'Cache-Control':'no-store'}});
  const country=String(body.country||''); const wifiPlan=getWifiPlan(country); const daily=wifiPlan?.daily; const startDate=parseExactIsoDate(body.start); const endDate=parseExactIsoDate(body.end);
  if(!wifiPlan||!daily||!startDate||!endDate||endDate<startDate) return NextResponse.json({error:'Please select a valid destination and travel period.'},{status:400});
  // Delivery is operated in Singapore. UTC midnight can still be the previous
  // calendar day in Singapore, which would incorrectly accept a past date or
  // shorten the advertised lead time during the local early morning.
  const today=operationalIsoDate();
  const start=String(body.start), end=String(body.end);
  if(start<today) return NextResponse.json({error:'Travel start date cannot be in the past.'},{status:400});
  const minLeadDays=config.minDeliveryLeadDays, earliest=operationalIsoDateAfter(minLeadDays);
  if(start<earliest) return NextResponse.json({error:`Please book at least ${minLeadDays} day${minLeadDays===1?'':'s'} before departure so we can arrange delivery. Contact +65 8032 7183 for urgent trips.`},{status:400});
  const days=Math.floor((endDate.getTime()-startDate.getTime())/86400000)+1; if(days<1||days>90) return NextResponse.json({error:'Bookings must be between 1 and 90 days.'},{status:400});
  // Resolve the deployment-controlled redirect origin before any Stripe read
  // or inventory reservation. A malformed production URL is deterministic:
  // no Checkout Session can be created safely. Discovering it only after the
  // reservation RPC would leave one unlinked router hold per failed request
  // until expiry, allowing configuration drift to consume all saleable
  // capacity even though Stripe was never asked to create a payment page.
  const origin=checkoutSiteOrigin(req.url);
  // Everything after this complete cheap request-validation boundary can
  // perform schema, Stripe, or Supabase work and belongs in the shared
  // overload budget. Invalid traffic remains isolated by the limiter above.
  if(checkoutGloballyLimited()) return NextResponse.json({error:'Too many checkout attempts. Please try again shortly.'},{status:429,headers:{'Cache-Control':'no-store','Retry-After':'60'}});
  // Rate limiting bounds starts over time; it does not bound simultaneous
  // Stripe and database calls when dependencies are slow. Share a small
  // non-queueing admission budget with eSIM checkout so overload sheds work
  // promptly while this request's durable idempotency identity stays intact.
  releaseCheckout=tryAcquireCheckoutConcurrency();
  if(!releaseCheckout) return NextResponse.json({error:'Checkout is busy. Please try again shortly.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'5'}});
  // A reservation alone is not enough: once payment succeeds, the webhook
  // needs the orders and delivery/idempotency ledgers as well. Do this before
  // creating a payable Stripe Session so an incomplete migration cannot leave
  // a paid router booking unrecorded or unfulfillable.
  if(!await hasRequiredPaymentSchema()) return NextResponse.json({error:'Pocket WiFi ordering is temporarily unavailable. Please try again shortly or contact +65 8032 7183.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'30'}});
  // A router sale creates a physical-custody obligation. Do not expose a
  // payment page against a partial deployment that can reserve stock but
  // cannot safely dispatch or receive the assigned device afterwards.
  if(!await hasRequiredPocketWifiFulfilmentSchema()) return NextResponse.json({error:'Pocket WiFi ordering is temporarily unavailable. Please try again shortly or contact +65 8032 7183.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'30'}});
  const stripe=createStripeClient(key);
  const inventory=config.pocketWifiInventory;
  if(inventory<1) return NextResponse.json({error:'Pocket WiFi is sold out for these dates. Please choose different dates or contact +65 8032 7183.'},{status:409,headers:{'Cache-Control':'no-store'}});
  const rentalBeforePromo=pocketWifiRentalCents(daily,days);
  const promo=applyPromoCents(rentalBeforePromo, body.promoCode);
  const rentalAmount=promo.amountCents;
  const courierFee=config.courierFeeCents;
  // Availability is the customer's price-review boundary. Bind checkout to
  // the exact cent total rendered from that quote so a courier-fee or promo
  // change in a long-lived tab cannot open Stripe at an amount the customer
  // has not reviewed. This value is not pricing authority: the server still
  // calculates every component independently and accepts only exact agreement.
  const expectedTotalCents=body.expectedTotalCents;
  if(typeof expectedTotalCents!=='number'||!Number.isSafeInteger(expectedTotalCents)||expectedTotalCents<0) return NextResponse.json({error:'Please check live availability and review the current total before payment.'},{status:400});
  if(expectedTotalCents!==rentalAmount+courierFee) return NextResponse.json({error:'The booking price has changed. Please check availability and review the updated total before payment.',priceChanged:true},{status:409,headers:{'Cache-Control':'no-store'}});
  const requested={country,start,end,days,daily,rentalBeforePromo,promoCode:promo.promoCode,promoDiscount:promo.discountCents,courierFee,expiresAtSeconds};
  const holdState=await activeStripeHolds(stripe,key,start,end,requestId,requested,origin);
  if(holdState.requestConflict) return NextResponse.json({error:'This checkout attempt belongs to different booking details. Please refresh and try again.',checkoutRequestConflict:true},{status:409,headers:{'Cache-Control':'no-store'}});
  const supabase=getSupabaseAdmin();
  if(!supabase) return NextResponse.json({error:'Live reservation is temporarily unavailable. Please try again shortly or contact +65 8032 7183.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'30'}});
  if(holdState.existingUrl&&holdState.existingSessionId&&holdState.existingSessionSnapshot){
    // A retry can find a session created just before a process interruption.
    // Retrieve it again because payment or expiry can race the preceding list
    // call. The fresh state, not the URL snapshot from that list, determines
    // whether the browser may return to Checkout.
    let existing=await stripe.checkout.sessions.retrieve(holdState.existingSessionId);
    // This object can release a reservation, confirm a paid order, or expose a
    // payment URL. Require it to remain bound to the exact hold selected above.
    if(!stripeWebhookCheckoutSessionMatchesSnapshot(holdState.existingSessionSnapshot,existing)){
      console.error('checkout_session_identity_mismatch',{expectedSessionId:holdState.existingSessionId,retrievedSessionId:existing.id});
      return NextResponse.json({error:'Secure checkout confirmation is temporarily unavailable. Please try again shortly.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'10'}});
    }
    // The Stripe credential normally scopes this read to one mode, but this
    // is a payment-capability boundary. Do not re-sign or return a session if
    // an unexpected SDK/provider response crosses the configured mode.
    if(!stripeEventMatchesConfiguredMode(key,existing.livemode)){
      console.error('checkout_session_mode_mismatch',{sessionId:existing.id});
      return NextResponse.json({error:'Secure checkout confirmation is temporarily unavailable. Please try again shortly.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'10'}});
    }
    if(!matchesRequestedPocketWifi(existing,requestId,requested,origin)){
      return NextResponse.json({error:'This checkout attempt belongs to different booking details. Please refresh and try again.',checkoutRequestConflict:true},{status:409,headers:{'Cache-Control':'no-store'}});
    }
    const consentDowngrade=stripeMeasurementConsentDowngrade(existing.metadata,body.measurementConsent);
    if(consentDowngrade){
      const updated=await stripe.checkout.sessions.update(existing.id,{metadata:consentDowngrade});
      if(!stripeWebhookCheckoutSessionMatchesSnapshot(existing,updated)||
        !stripeEventMatchesConfiguredMode(key,updated.livemode)||
        !matchesRequestedPocketWifi(updated,requestId,requested,origin)){
        console.error('checkout_consent_downgrade_mismatch',{expectedSessionId:existing.id});
        return NextResponse.json({error:'Secure checkout confirmation is temporarily unavailable. Please try again shortly.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'10'}});
      }
      existing=updated;
    }
    const metadata={...existing.metadata} as Record<string,string>;
    const provenance=signedQyRoamProvenance(existing.id,metadata);
    if(metadata[QY_ROAM_PROVENANCE_METADATA_KEY]!==provenance){
      // The previous request may have stopped after Session creation but
      // before this write completed. Use Stripe's update response as the new
      // authority instead of continuing with the unsigned object retrieved
      // above: that stale object must never release stock, confirm payment,
      // or expose a payable URL.
      const updated=await stripe.checkout.sessions.update(existing.id,{metadata:{[QY_ROAM_PROVENANCE_METADATA_KEY]:provenance}});
      if(!stripeWebhookCheckoutSessionMatchesSnapshot(existing,updated)||
        !stripeEventMatchesConfiguredMode(key,updated.livemode)||
        !matchesRequestedPocketWifi(updated,requestId,requested,origin)){
        console.error('checkout_recovered_session_mismatch',{expectedSessionId:existing.id});
        return NextResponse.json({error:'Secure checkout confirmation is temporarily unavailable. Please try again shortly.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'10'}});
      }
      existing=updated;
    }
    // A successful metadata update is not sufficient by itself. Confirm the
    // exact id-bound signature on the object that controls all subsequent
    // reservation and customer redirect decisions.
    if(!validQyRoamProvenance(existing.id,existing.metadata)){
      console.error('checkout_provenance_confirmation_error',{sessionId:existing.id});
      return NextResponse.json({error:'Secure checkout confirmation is temporarily unavailable. Please try again shortly.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'10'}});
    }
    if(existing.status==='complete'&&existing.payment_status==='paid'){
      // The signed terminal webhook normally removes this hold. Keep it linked
      // if order persistence is still catching up, or remove only this exact
      // session's hold once the paid order is durable.
      const order=await supabase.from('orders').select('stripe_session_id,payment_status,product_type,amount_sgd,plan_id,plan_name,data_allowance,country,travel_start,travel_end,measurement_consent').eq('stripe_session_id',existing.id).maybeSingle();
      if(order.error) throw order.error;
      if(durableOrderMatchesPaidSession(order.data,existing,'pocket_wifi')){
        const released=await supabase.from('checkout_reservations').delete()
          .eq('checkout_request_id',requestId)
          .eq('stripe_session_id',existing.id);
        if(released.error) throw released.error;
      }else{
        if(!await linkReservationToSession(supabase,requestId,existing.id,requested)){
          return NextResponse.json({error:'Live reservation confirmation is temporarily unavailable. Please try again shortly or contact +65 8032 7183.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'30'}});
        }
        // Stripe has accepted payment, but customer confirmation is only safe
        // once the signed webhook has made the paid booking durable. Retain
        // the exact session-linked reservation while that hand-off catches up
        // and ask the idempotent browser retry to poll rather than presenting
        // a successful order that operations cannot yet see or fulfil.
        return NextResponse.json({error:'Your payment is confirmed and your order is still being recorded. Please wait a moment and try again.',paymentPending:true},{status:409,headers:{'Cache-Control':'no-store','Retry-After':'3'}});
      }
      return NextResponse.json({completed:true,sessionId:existing.id},{headers:{'Cache-Control':'no-store'}});
    }
    if(existing.status==='complete'&&existing.payment_status==='unpaid'){
      const order=await supabase.from('orders').select('payment_status,fulfilment_status').eq('stripe_session_id',existing.id).maybeSingle();
      if(order.error) throw order.error;
      // Stripe's terminal failure state remains `unpaid`; the webhook records
      // the durable outcome in our fulfilment lifecycle as `payment_failed`.
      // Wait for that ledger transition before rotating the browser's
      // idempotency key, otherwise a delayed async success could be abandoned.
      if(order.data?.payment_status==='unpaid'&&order.data?.fulfilment_status==='payment_failed'){
        return NextResponse.json({error:'This payment attempt was unsuccessful. Please try again with a new secure checkout.',paymentFailed:true},{status:409,headers:{'Cache-Control':'no-store'}});
      }
    }
    if(existing.status==='expired'){
      // Expiry makes the payment URL unusable. Release only the reservation
      // that is unlinked or belongs to this exact expired session; a newer
      // recovery attempt must remain untouched.
      const released=await supabase.from('checkout_reservations').delete()
        .eq('checkout_request_id',requestId)
        .or(`stripe_session_id.is.null,stripe_session_id.eq.${existing.id}`);
      if(released.error) console.error('checkout_expired_reservation_release_error');
      return NextResponse.json({error:'This secure checkout session has expired. Please try again to start a new one.',checkoutExpired:true},{status:409,headers:{'Cache-Control':'no-store'}});
    }
    if(!await linkReservationToSession(supabase,requestId,existing.id,requested)){
      // Do not redirect a retry to payment when its durable reservation was
      // lost or points to a different Stripe session. Keeping the open Stripe
      // Session unexposed preserves capacity until an operator can investigate.
      return NextResponse.json({error:'Live reservation confirmation is temporarily unavailable. Please try again shortly or contact +65 8032 7183.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'30'}});
    }
    const existingCheckoutUrl=safeStripeCheckoutUrl(existing.url);
    if(existing.status!=='open'||!existingCheckoutUrl){
      if(existing.status==='open'&&existing.url){
        console.error('checkout_url_invalid',{sessionId:existing.id});
        return NextResponse.json({error:'Secure checkout confirmation is temporarily unavailable. Please try again shortly.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'10'}});
      }
      return NextResponse.json({error:'Your payment is still being confirmed. Please wait for confirmation before trying again.',paymentPending:true},{status:409,headers:{'Cache-Control':'no-store','Retry-After':'3'}});
    }
    return NextResponse.json({url:existingCheckoutUrl},{headers:{'Cache-Control':'no-store'}});
  }
  const expiresAt=new Date(expiresAtSeconds*1000).toISOString();
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
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[]=[{quantity:1,price_data:{currency:'sgd',unit_amount:rentalAmount,product_data:{name:`QY Roam Pocket WiFi — ${country}`,description:`${start} to ${end} · ${days} day${days===1?'':'s'}${promo.discountCents>0?` · ${normalisePromoCode(body.promoCode)} applied`:''}`}}}];
  if(courierFee>0) lineItems.push({quantity:1,price_data:{currency:'sgd',unit_amount:courierFee,product_data:{name:'Singapore courier delivery & return handling'}}});
  // Stripe and database work above can straddle Singapore midnight. Recheck
  // the operational booking cutoff after the reservation is acquired and at
  // the final payment-capability boundary; otherwise a request that was valid
  // at 23:59 could create a newly ineligible booking after the required lead
  // date advances. This reservation is still unlinked, so it is safe to
  // release without touching an earlier Stripe-backed attempt.
  if(start<operationalIsoDateAfter(minLeadDays)){
    const released=await supabase.from('checkout_reservations').delete().eq('checkout_request_id',requestId).is('stripe_session_id',null);
    if(released.error) throw released.error;
    return NextResponse.json({error:`Please book at least ${minLeadDays} day${minLeadDays===1?'':'s'} before departure so we can arrange delivery. Contact +65 8032 7183 for urgent trips.`,bookingWindowChanged:true},{status:409,headers:{'Cache-Control':'no-store'}});
  }
  // Readiness, hold scans and the reservation RPC can take time after the
  // original expiry validation. Since `expires_at` must remain stable for
  // Stripe idempotency, fail this attempt cleanly rather than submitting an
  // expiry that has become too close for Stripe to accept.
  if(checkoutAttemptExpiresAt(body.checkoutAttemptCreatedAt)!==expiresAtSeconds){
    const released=await supabase.from('checkout_reservations').delete().eq('checkout_request_id',requestId).is('stripe_session_id',null);
    if(released.error) throw released.error;
    return NextResponse.json({error:'This checkout attempt has expired. Please try again to start a new one.',checkoutExpired:true},{status:409,headers:{'Cache-Control':'no-store'}});
  }
  // Promotion eligibility was calculated before provider-backed hold scans
  // and the atomic reservation call. Re-authorise a discounted price at the
  // final Stripe boundary so a request that crosses the Singapore campaign
  // cutoff cannot create a new, already-expired promotional payment link.
  // Only this still-unlinked reservation belongs to the aborted creation.
  if(promo.discountCents>0&&!promoIsActive()){
    const released=await supabase.from('checkout_reservations').delete().eq('checkout_request_id',requestId).is('stripe_session_id',null);
    if(released.error) throw released.error;
    return NextResponse.json({error:'This promotion has ended. Please refresh to see the current price.',pricingExpired:true},{status:409,headers:{'Cache-Control':'no-store'}});
  }
  let session:Stripe.Checkout.Session;
  try{
    session=await stripe.checkout.sessions.create({mode:'payment',line_items:lineItems,expires_at:expiresAtSeconds,billing_address_collection:'required',shipping_address_collection:{allowed_countries:['SG']},phone_number_collection:{enabled:true},customer_creation:'always',success_url:`${origin}/success?session_id={CHECKOUT_SESSION_ID}`,cancel_url:`${origin}/?checkout=cancelled`,metadata:{product_type:'pocket_wifi',plan_name:`${country} Pocket WiFi`,country,start,end,days:String(days),daily_rate_sgd:daily.toFixed(2),benchmark_provider:WIFI_BENCHMARK.provider,benchmark_rate_sgd:wifiPlan.benchmarkRateSgd.toFixed(2),benchmark_verified_on:WIFI_BENCHMARK.verifiedOn,rental_before_promo_sgd:(rentalBeforePromo/100).toFixed(2),promo_code:promo.promoCode,promo_discount_sgd:(promo.discountCents/100).toFixed(2),courier_fee_sgd:(courierFee/100).toFixed(2),checkout_amount_cents:String(rentalAmount+courierFee),checkout_request_id:requestId,source:'qyroam.com',measurement_consent:body.measurementConsent===true?'accepted':'essential',...(body.measurementConsent===true?metaAttributionFromRequest(body.attribution,req.headers.get('user-agent'),req.headers.get('x-real-ip')):{})},consent_collection:{terms_of_service:'required'}},{idempotencyKey:`qyroam_wifi_${requestId}`});
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
  const createdSessionId=validStripeCheckoutSessionIdForMode(session.id,session.livemode);
  if(!createdSessionId){
    console.error('checkout_session_id_invalid');
    return NextResponse.json({error:'Secure checkout confirmation is temporarily unavailable. Please try again shortly.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'10'}});
  }
  if(!stripeEventMatchesConfiguredMode(key,session.livemode)){
    // Preserve the unlinked reservation. A response that fails this
    // credential-mode boundary must never be exposed or treated as a safe
    // checkout session, and releasing its capacity could oversell a session
    // whose creation outcome is otherwise ambiguous.
    console.error('checkout_session_mode_mismatch',{sessionId:session.id});
    return NextResponse.json({error:'Secure checkout confirmation is temporarily unavailable. Please try again shortly.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'10'}});
  }
  if(!matchesRequestedPocketWifi(session,requestId,requested,origin)){
    const released=await supabase.from('checkout_reservations').delete().eq('checkout_request_id',requestId).is('stripe_session_id',null);
    if(released.error) throw released.error;
    return NextResponse.json({error:'This checkout attempt belongs to different booking details. Please refresh and try again.',checkoutRequestConflict:true},{status:409,headers:{'Cache-Control':'no-store'}});
  }
  const consentDowngrade=stripeMeasurementConsentDowngrade(session.metadata,body.measurementConsent);
  if(consentDowngrade){
    const updated=await stripe.checkout.sessions.update(createdSessionId,{metadata:consentDowngrade});
    if(!stripeWebhookCheckoutSessionMatchesSnapshot(session,updated)||
      !stripeEventMatchesConfiguredMode(key,updated.livemode)||
      !matchesRequestedPocketWifi(updated,requestId,requested,origin)){
      console.error('checkout_consent_downgrade_mismatch',{expectedSessionId:createdSessionId});
      return NextResponse.json({error:'Secure checkout confirmation is temporarily unavailable. Please try again shortly.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'10'}});
    }
    session=updated;
  }
  // The id-specific provenance is written before the checkout URL is exposed.
  // Retrying the same idempotency key also repairs a session if a process died
  // between Stripe creation and this metadata update.
  const metadata={...session.metadata} as Record<string,string>;
  const provenance=signedQyRoamProvenance(createdSessionId,metadata);
  if(metadata[QY_ROAM_PROVENANCE_METADATA_KEY]!==provenance){
    try { await stripe.checkout.sessions.update(createdSessionId,{metadata:{[QY_ROAM_PROVENANCE_METADATA_KEY]:provenance}}); }
    catch(error){
      // This update can fail after Stripe created a usable Checkout Session.
      // As above, retain capacity rather than creating an uncounted payable
      // session. A same-key retry will re-read the session and finish signing
      // and linking it; expiry/terminal webhook events release the hold.
      throw error;
    }
  }
  // Stripe can replay the original response to the idempotent create call
  // even when that Checkout Session was paid or expired in another tab. Read
  // the current object after signing it, and make every redirect/reservation
  // decision from that fresh state. This also proves the id-bound provenance
  // update is visible before exposing a URL that can create a paid inventory
  // obligation.
  const currentSession=await stripe.checkout.sessions.retrieve(createdSessionId);
  // Keep the fresh response bound to the idempotent create result before it
  // can confirm payment, mutate this booking's reservation, or expose a URL.
  if(!stripeWebhookCheckoutSessionMatchesSnapshot(session,currentSession)){
    console.error('checkout_session_identity_mismatch',{expectedSessionId:createdSessionId,retrievedSessionId:currentSession.id});
    return NextResponse.json({error:'Secure checkout confirmation is temporarily unavailable. Please try again shortly.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'10'}});
  }
  if(!stripeEventMatchesConfiguredMode(key,currentSession.livemode)){
    console.error('checkout_session_mode_mismatch',{sessionId:currentSession.id});
    return NextResponse.json({error:'Secure checkout confirmation is temporarily unavailable. Please try again shortly.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'10'}});
  }
  if(!matchesRequestedPocketWifi(currentSession,requestId,requested,origin)){
    // The reservation has not been linked yet, so only this unlinked attempt
    // is safe to release. A mismatched Stripe response must never inherit the
    // requested booking's stock hold.
    const released=await supabase.from('checkout_reservations').delete().eq('checkout_request_id',requestId).is('stripe_session_id',null);
    if(released.error) throw released.error;
    return NextResponse.json({error:'This checkout attempt belongs to different booking details. Please refresh and try again.',checkoutRequestConflict:true},{status:409,headers:{'Cache-Control':'no-store'}});
  }
  if(!validQyRoamProvenance(currentSession.id,currentSession.metadata)){
    console.error('checkout_provenance_confirmation_error',{sessionId:currentSession.id});
    return NextResponse.json({error:'Secure checkout confirmation is temporarily unavailable. Please try again shortly.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'10'}});
  }
  // A completed paid Session may be returned when a browser retries after its
  // original response was lost. Do not send the customer back to Stripe or
  // hold capacity unnecessarily after the webhook has already persisted the
  // order. If persistence is still catching up, link the reservation first so
  // the terminal webhook can release it once it records the paid booking.
  if(currentSession.status==='complete'&&currentSession.payment_status==='paid'){
    const order=await supabase.from('orders').select('stripe_session_id,payment_status,product_type,amount_sgd,plan_id,plan_name,data_allowance,country,travel_start,travel_end,measurement_consent').eq('stripe_session_id',currentSession.id).maybeSingle();
    if(order.error) throw order.error;
    // Only an exact durable commercial snapshot can turn an idempotent
    // checkout replay into a completed-order response. A mismatched imported
    // or repaired row must remain on the safe reconciliation path instead of
    // contradicting the stricter success and booking pages.
    if(durableOrderMatchesPaidSession(order.data,currentSession,'pocket_wifi')){
      // The normal terminal webhook releases this hold. A lost response can
      // make this replay observe the paid order after persistence but before
      // that cleanup finished. Release only the reservation bound to this
      // exact paid Checkout Session: deleting an unlinked row here could
      // otherwise free a later recovery attempt that reused the request id.
      const released=await supabase.from('checkout_reservations').delete()
        .eq('checkout_request_id',requestId)
        .eq('stripe_session_id',currentSession.id);
      if(released.error) throw released.error;
    }else{
      if(!await linkReservationToSession(supabase,requestId,currentSession.id,requested)){
        return NextResponse.json({error:'Live reservation confirmation is temporarily unavailable. Please try again shortly or contact +65 8032 7183.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'30'}});
      }
      // Do not let an idempotent Stripe replay outrun webhook persistence.
      // The linked hold continues protecting physical capacity, while the
      // retryable response prevents an undurable booking from being shown as
      // completed to the traveller.
      return NextResponse.json({error:'Your payment is confirmed and your order is still being recorded. Please wait a moment and try again.',paymentPending:true},{status:409,headers:{'Cache-Control':'no-store','Retry-After':'3'}});
    }
    return NextResponse.json({completed:true,sessionId:currentSession.id},{headers:{'Cache-Control':'no-store'}});
  }
  // Stripe Checkout is terminal after an asynchronous payment failure. Only
  // rotate the durable browser idempotency key after the signed webhook has
  // recorded that failure; before then, preserving the attempt protects an
  // in-flight payment and its linked inventory reservation.
  if(currentSession.status==='complete'&&currentSession.payment_status==='unpaid'){
    const order=await supabase.from('orders').select('payment_status,fulfilment_status').eq('stripe_session_id',currentSession.id).maybeSingle();
    if(order.error) throw order.error;
    if(order.data?.payment_status==='unpaid'&&order.data?.fulfilment_status==='payment_failed'){
      return NextResponse.json({error:'This payment attempt was unsuccessful. Please try again with a new secure checkout.',paymentFailed:true},{status:409,headers:{'Cache-Control':'no-store'}});
    }
  }
  // Stripe retains idempotency keys after a Checkout Session expires. A client
  // retry using that key can therefore receive the old session, whose URL is
  // null. Do not link its new inventory reservation or report a false success.
  // The browser receives an explicit recoverable signal and creates a fresh
  // checkout request id for the next attempt.
  if(currentSession.status==='expired'){
    const released=await supabase.from('checkout_reservations').delete().eq('checkout_request_id',requestId).is('stripe_session_id',null);
    if(released.error) console.error('checkout_expired_reservation_release_error');
    return NextResponse.json({error:'This secure checkout session has expired. Please try again to start a new one.',checkoutExpired:true},{status:409,headers:{'Cache-Control':'no-store'}});
  }
  // A completed asynchronous payment may not yet be paid. Preserve its
  // reservation and let the signed terminal webhook decide when stock can be
  // released, rather than turning a payment-in-progress retry into an
  // uncounted router booking.
  const checkoutUrl=safeStripeCheckoutUrl(currentSession.url);
  if(currentSession.status!=='open'||!checkoutUrl){
    if(!await linkReservationToSession(supabase,requestId,currentSession.id,requested)) return NextResponse.json({error:'Live reservation confirmation is temporarily unavailable. Please try again shortly or contact +65 8032 7183.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'30'}});
    if(currentSession.status==='open'&&currentSession.url){
      console.error('checkout_url_invalid',{sessionId:currentSession.id});
      return NextResponse.json({error:'Secure checkout confirmation is temporarily unavailable. Please try again shortly.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'10'}});
    }
    return NextResponse.json({error:'Your payment is still being confirmed. Please wait for confirmation before trying again.',paymentPending:true},{status:409,headers:{'Cache-Control':'no-store','Retry-After':'3'}});
  }
  if(!await linkReservationToSession(supabase,requestId,currentSession.id,requested)){
    // Fail closed: a payment URL without a durable session-to-reservation
    // relationship cannot safely be reconciled by fulfilment or inventory.
    return NextResponse.json({error:'Live reservation confirmation is temporarily unavailable. Please try again shortly or contact +65 8032 7183.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'30'}});
  }
  return NextResponse.json({url:checkoutUrl},{headers:{'Cache-Control':'no-store'}});
 } catch {
  // This can catch a temporary Stripe or database dependency failure after a
  // request id was accepted. The id is a durable idempotency boundary, so
  // customers can retry safely; expose a retryable, non-cacheable outage
  // instead of a generic server error that may be retained by an intermediary.
  console.error('checkout_error');
  return NextResponse.json(
    {error:'Pocket WiFi checkout is temporarily unavailable. Please try again shortly.'},
    {status:503,headers:{'Cache-Control':'no-store','Retry-After':'10'}},
  );
 } finally {
  releaseCheckout?.();
 }
}
