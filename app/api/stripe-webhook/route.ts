import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createStripeClient } from '../../../lib/stripeClient';
import crypto from 'crypto';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { isSafeSmtpMailbox, sendSmtpMail } from '@/lib/smtp';
import { getMetaCapiToken, hasRequiredMetaCapiPurchaseConfig } from '@/lib/runtimeConfig';
import { validateQyRoamSession } from '@/lib/qyRoamSession';
import { validCheckoutRequestId } from '@/lib/checkoutValidation';
import { validQyRoamProvenance } from '@/lib/orderProvenance';
import { hasRequiredStripeCheckoutConfig } from '@/lib/productionReadiness';
import { stripeEventMatchesConfiguredMode } from '@/lib/stripeCheckoutConfig';
import { getEsimPlan } from '@/lib/esimPlans';
import { fulfilmentNotificationActionable, STRIPE_EVENT_CLAIM_STALE_MS } from '@/lib/orderLifecycle';
import { validStripeCheckoutSessionId } from '@/lib/stripeSessionId';
import { validStripeEventId } from '@/lib/stripeEventId';
import { validStripeEventCreated } from '@/lib/stripeEventCreated';

export const runtime = 'nodejs';

// Stripe Checkout events are small, but this is a public endpoint and the
// signature cannot be checked until the exact raw payload has been read. Keep
// the memory used by an invalid request bounded rather than relying on a proxy
// body-size setting that may differ between production environments.
const MAX_STRIPE_WEBHOOK_BODY_BYTES = 1_000_000;
// Headers are ordinarily capped by the reverse proxy, but this public route
// must remain safe when it is reached through a different proxy or directly
// in an application runtime. Stripe's signed header is compact ASCII; reject
// an oversized or control-character-bearing value before handing it to the
// SDK's signature parser.
const MAX_STRIPE_SIGNATURE_HEADER_BYTES = 8_192;
// Do not let a peer that sends headers and then stalls its upload pin a
// webhook worker indefinitely. Stripe will retry a timed-out delivery, while
// the bounded body size below continues to protect memory for completed reads.
const STRIPE_WEBHOOK_BODY_TIMEOUT_MS = 15_000;

class StripeWebhookBodyTimeoutError extends Error {}

function validStripeSignatureHeader(value: string | null) {
  return value && value.length <= MAX_STRIPE_SIGNATURE_HEADER_BYTES && /^[\x20-\x7e]+$/.test(value)
    ? value
    : null;
}

async function readStripeWebhookBody(req: Request): Promise<Buffer> {
  const contentLength = req.headers.get('content-length');
  if (contentLength !== null) {
    // Do not let a malformed header quietly bypass the early rejection. The
    // stream limit below remains the authority when a proxy omits this header.
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_STRIPE_WEBHOOK_BODY_BYTES) {
      throw new RangeError('Stripe webhook payload is too large');
    }
  }

  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const bodyTimeout = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new StripeWebhookBodyTimeoutError('Stripe webhook body timed out'));
      // Cancelling wakes a pending read in compliant runtimes before the
      // timeout is surfaced. Reject first: cancellation can resolve the
      // pending read as done, which must not turn an expired deadline into an
      // accepted empty body. Do not await it here: a broken peer must not
      // extend the deadline while its stream is being torn down.
      void reader.cancel().catch(() => undefined);
    }, STRIPE_WEBHOOK_BODY_TIMEOUT_MS);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), bodyTimeout]);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_STRIPE_WEBHOOK_BODY_BYTES) {
        await reader.cancel();
        throw new RangeError('Stripe webhook payload is too large');
      }
      chunks.push(value);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function sha256(value?: string | null) { return value ? crypto.createHash('sha256').update(value).digest('hex') : undefined; }
function normalizeEmail(value?: string | null) { return value?.trim().toLowerCase(); }
function normalizePhone(value?: string | null) { if (!value) return undefined; const digits=value.replace(/\D/g,''); return digits||undefined; }
function fulfilmentMessageId(sessionId:string) { return `<qyroam-${crypto.createHash('sha256').update(sessionId).digest('hex').slice(0,32)}@qyroam.com>`; }

// Stripe Checkout normally guarantees the fields requested when the Session
// was created, but the signed completion event is the final hand-off into
// operations. Do not create an apparently fulfilable paid order if that
// hand-off is incomplete. In particular, an eSIM without an email address has
// no digital delivery destination, while a Pocket WiFi order needs both a
// Singapore delivery address and a phone number for courier coordination.
// This runs after the event claim so any anomaly is retained in stripe_events
// with the affected Checkout Session id for operator recovery.
function paidFulfilmentDetailsIssue(session:Stripe.Checkout.Session,productType:'esim'|'pocket_wifi') {
  if(session.payment_status!=='paid') return null;
  const email=session.customer_details?.email?.trim();
  // Stripe Checkout validates its email field, but this is the final
  // fulfilment boundary and can also process historical or manually repaired
  // Checkout Sessions. Require the same safe mailbox shape used by the SMTP
  // transport so an eSIM order is never presented to staff as deliverable
  // when its only customer contact cannot receive a fulfilment email.
  if(!isSafeSmtpMailbox(email)) return 'Paid order is missing a valid customer email';
  if(productType==='esim') return null;
  const phone=normalizePhone(session.customer_details?.phone);
  if(!phone||phone.length<7||phone.length>15) return 'Paid Pocket WiFi order is missing a valid customer phone number';
  const shipping=session.shipping_details?.address;
  if(shipping?.country!=='SG'||!shipping.line1?.trim()||!shipping.postal_code?.trim()) {
    return 'Paid Pocket WiFi order is missing a complete Singapore delivery address';
  }
  return null;
}

// A valid Stripe signature authenticates the event payload, but order state
// still has to agree with the event that carries it. In particular, never
// acknowledge an asynchronous success with an unpaid snapshot: doing so would
// mark that event processed without creating a paid fulfilment obligation.
// Failing closed also keeps malformed or unexpectedly-versioned terminal
// events in Stripe's retry/alert flow instead of silently weakening the order
// ledger. `checkout.session.completed` may legitimately be unpaid while a
// delayed payment method is still settling.
function stripeCheckoutEventStateIssue(eventType:Stripe.Event.Type,session:Stripe.Checkout.Session) {
  if(eventType==='checkout.session.expired') {
    return session.status==='expired'&&session.payment_status!=='paid'
      ? null
      : 'Expired event does not contain an expired unpaid Checkout Session';
  }
  if(session.status!=='complete') return 'Terminal checkout event does not contain a complete Checkout Session';
  if(eventType==='checkout.session.async_payment_succeeded'&&session.payment_status!=='paid') {
    return 'Asynchronous payment success does not contain a paid Checkout Session';
  }
  if(eventType==='checkout.session.async_payment_failed'&&session.payment_status==='paid') {
    return 'Asynchronous payment failure contains a paid Checkout Session';
  }
  return null;
}
const DELIVERY_TIMEOUT_MS=20_000;
// Delivery ledgers are normally protected by a non-null database timestamp,
// but a partially migrated or manually repaired record can still contain an
// invalid value. Treat that lease as abandoned instead of leaving a paid
// order permanently unrecoverable: ownership is still acquired with the
// status-and-timestamp compare-and-swap below, so this does not permit two
// healthy workers to send the same delivery concurrently.
const DELIVERY_LEASE_STALE_MS=15*60_000;

function deliveryLeaseIsStale(updatedAt: string | null | undefined) {
  const updatedAtMs=updatedAt ? new Date(updatedAt).getTime() : Number.NaN;
  return !Number.isFinite(updatedAtMs)||Date.now()-updatedAtMs>DELIVERY_LEASE_STALE_MS;
}
// Meta and an optional SMTP relay return tiny JSON responses. Bound their
// bodies as well as the request deadline: a misbehaving upstream must not be
// able to consume an unbounded amount of webhook-worker memory while we only
// need a short diagnostic snippet for the retry record.
const MAX_DELIVERY_RESPONSE_BODY_BYTES=64 * 1024;

async function readDeliveryResponseBody(response: Response) {
  const contentLength=response.headers.get('content-length');
  if(contentLength!==null&&(!/^\d+$/.test(contentLength)||Number(contentLength)>MAX_DELIVERY_RESPONSE_BODY_BYTES)) {
    throw new RangeError('Delivery response body is too large');
  }
  if(!response.body) return '';
  const reader=response.body.getReader();
  const chunks:Uint8Array[]=[];
  let total=0;
  try {
    for (;;) {
      const {done,value}=await reader.read();
      if(done) break;
      if(!value) continue;
      total+=value.byteLength;
      if(total>MAX_DELIVERY_RESPONSE_BODY_BYTES) {
        // Do not wait for an upstream that ignores cancellation; the request
        // deadline remains in force and the caller will retry safely.
        void reader.cancel().catch(()=>undefined);
        throw new RangeError('Delivery response body is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks,total).toString('utf8');
}

async function postJsonWithTimeout(url:string,body:unknown,timeoutMs=DELIVERY_TIMEOUT_MS){
  const controller=new AbortController();
  const deadline=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    // Both the optional SMTP relay payload and Meta URL contain credentials.
    // Following a redirect would resend those values to a different endpoint,
    // and can turn a harmless relay typo into a paid-order data leak. Treat a
    // redirect as a failed retryable delivery instead.
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal,redirect:'error'});
    // Consume the response while the deadline is still active. A provider that
    // sends headers and then stalls its body must not hold the webhook open.
    const responseBody=await readDeliveryResponseBody(response);
    return {ok:response.ok,status:response.status,responseBody};
  }finally{
    clearTimeout(deadline);
  }
}

function metaPurchaseConfigured(session: Stripe.Checkout.Session) {
  return session.payment_status === 'paid' &&
    session.metadata?.measurement_consent === 'accepted' &&
    hasRequiredMetaCapiPurchaseConfig();
}

async function sendMetaPurchase(session: Stripe.Checkout.Session, eventTime: number) {
  const token=getMetaCapiToken(), pixel=process.env.NEXT_PUBLIC_META_PIXEL_ID;
  if (!token || !pixel) throw new Error('Meta CAPI is not configured');
  const email=normalizeEmail(session.customer_details?.email), phone=normalizePhone(session.customer_details?.phone);
  const userData:Record<string,string|string[]>={}; if(email) userData.em=[sha256(email)!]; if(phone) userData.ph=[sha256(phone)!];
  const fbp=session.metadata?.meta_fbp, fbc=session.metadata?.meta_fbc, clientUserAgent=session.metadata?.meta_client_user_agent, clientIp=session.metadata?.meta_client_ip;
  // fbp/fbc are Meta's opaque browser identifiers, not hashed PII arrays.
  if(fbp) userData.fbp=fbp; if(fbc) userData.fbc=fbc;
  const productType=session.metadata?.product_type||'pocket_wifi';
  const contentId=productType==='esim' ? `esim:${session.metadata?.plan_id||''}` : `pocket_wifi:${session.metadata?.country||''}`;
  const payload={data:[{event_name:'Purchase',event_time:eventTime,action_source:'website',event_source_url:`${process.env.NEXT_PUBLIC_SITE_URL||'https://qyroam.com'}/success`,event_id:`stripe_${session.id}`,user_data:{...userData,...(clientUserAgent?{client_user_agent:clientUserAgent}:{}),...(clientIp?{client_ip_address:clientIp}:{})},custom_data:{currency:'SGD',value:(session.amount_total||0)/100,order_id:session.id,content_type:'product',content_ids:[contentId],contents:[{id:contentId,quantity:1}],content_category:productType==='esim'?'Travel eSIM':'Pocket WiFi'}}]};
  const response=await postJsonWithTimeout(`https://graph.facebook.com/v21.0/${pixel}/events?access_token=${encodeURIComponent(token)}`,payload);
  // Provider responses are not a safe diagnostic channel: an intermediary
  // can echo request data or credentials. The error is persisted in the
  // operator-visible retry ledger and logged by the webhook, so retain only
  // the actionable HTTP status rather than copying an untrusted body into
  // either durable operations data or application logs.
  if(!response.ok) throw new Error(`Meta CAPI failed (${response.status})`);
}

async function sendHumanFulfilmentEmail(session: Stripe.Checkout.Session) {
  if(session.payment_status!=='paid') return;
  const host=process.env.SMTP_HOST?.trim(), port=Number(process.env.SMTP_PORT||'587'), secure=process.env.SMTP_SECURE==='true'||port===465, user=process.env.SMTP_USER?.trim(), pass=process.env.SMTP_PASS, from=(process.env.SMTP_FROM||user||'').trim(), to=(process.env.ORDER_FULFILMENT_EMAIL||process.env.FULFILMENT_TO||'').trim();
  if(!host||!user||!pass||!from||!to) throw new Error('SMTP fulfilment email is not configured');
  const productType=session.metadata?.product_type;
  if(productType!=='esim'&&productType!=='pocket_wifi') throw new Error('Unknown or missing product_type on paid order');
  // Webhook processing applies this guard before it creates the order, but
  // fulfilment retries can be initiated later from the protected admin route.
  // Keep the same boundary next to the actual outbound hand-off so a legacy
  // or manually repaired order cannot turn incomplete customer/delivery data
  // into an apparently actionable fulfilment alert.
  const fulfilmentDetailsIssue=paidFulfilmentDetailsIssue(session,productType);
  if(fulfilmentDetailsIssue) throw new Error(fulfilmentDetailsIssue);
  const isEsim=productType==='esim', destination=session.metadata?.country||'', planName=session.metadata?.plan_name||'', planId=session.metadata?.plan_id||'', esimPlan=isEsim?getEsimPlan(planId):undefined, dataAllowance=session.metadata?.data_allowance||esimPlan?.data||'', start=session.metadata?.start||'', end=session.metadata?.end||'', customer=session.customer_details, amount=((session.amount_total||0)/100).toFixed(2), shipping=session.shipping_details?.address, messageId=fulfilmentMessageId(session.id);
  const shippingText=shipping?[shipping.line1,shipping.line2,shipping.city,shipping.state,shipping.postal_code,shipping.country].filter(Boolean).join(', '):'Not applicable / not supplied';
  const subject=`[QY Roam] Paid ${isEsim?'eSIM':'Pocket WiFi'} order — ${destination||planName||session.id}`;
  const text=['A paid QY Roam order requires human fulfilment.','',`Order reference: ${session.id}`,`Product: ${isEsim?'Travel eSIM':'Pocket WiFi'}`,`Destination: ${destination||'-'}`,`Plan: ${planName||'-'}`,...(isEsim?[`Plan ID: ${planId||'-'}`,`Data allowance: ${dataAllowance||'-'}`]:[]),`Travel dates: ${start||'-'}${end?` to ${end}`:''}`,`Amount paid: S$${amount}`,`Promo code: ${session.metadata?.promo_code||'-'}`,'',`Customer name: ${customer?.name||'-'}`,`Email: ${customer?.email||'-'}`,`Phone: ${customer?.phone||'-'}`,`Delivery address: ${shippingText}`,'',isEsim?'Action: Please process the eSIM manually and send the QR code / activation instructions to the customer.':'Action: Please prepare and fulfil the Pocket WiFi order according to the travel dates and delivery details.','','Customer support: +65 8032 7183'].join('\n');
  const relayUrl=process.env.SMTP_RELAY_URL, relaySecret=process.env.SMTP_RELAY_SECRET;
  if(relayUrl&&relaySecret){
    const response=await postJsonWithTimeout(relayUrl,{relay_secret:relaySecret,smtp_host:host,smtp_port:port,smtp_user:user,smtp_pass:pass,from,to,subject,text,message_id:messageId});
    // Do not persist or log a relay response body. A relay failure may echo
    // this credential-bearing request, while the status code is sufficient
    // for a retrying webhook and for staff to identify the failing transport.
    if(!response.ok) throw new Error(`SMTP relay failed (${response.status})`);
    return;
  }
  await sendSmtpMail({host,port,secure,user,pass,from,to,subject,text,messageId,timeoutMs:DELIVERY_TIMEOUT_MS});
}

async function persistSession(session:Stripe.Checkout.Session,eventType:Stripe.Event.Type,eventCreated:number){
  const supabase=getSupabaseAdmin(); if(!supabase) throw new Error('Order persistence unavailable');
  const paid=session.payment_status==='paid', failed=eventType==='checkout.session.async_payment_failed';
  const productType=session.metadata?.product_type;
  if(productType!=='esim'&&productType!=='pocket_wifi') throw new Error('Unknown or missing product_type on Stripe session');
  const defaultPaidStatus=productType==='esim'?'awaiting_fulfilment':'paid';
  const paymentConfirmedAt=new Date(eventCreated*1000).toISOString();
  const measurementConsent=session.metadata?.measurement_consent==='accepted'?'accepted':'essential';
  const esimPlan=productType==='esim'?getEsimPlan(session.metadata?.plan_id):undefined;
  const orderSnapshot={stripe_session_id:session.id,payment_status:session.payment_status,customer_name:session.customer_details?.name,email:session.customer_details?.email,phone:session.customer_details?.phone,amount_sgd:(session.amount_total||0)/100,product_type:productType,plan_id:session.metadata?.plan_id||null,plan_name:session.metadata?.plan_name||null,data_allowance:session.metadata?.data_allowance||esimPlan?.data||null,country:session.metadata?.country,travel_start:session.metadata?.start||null,travel_end:session.metadata?.end||null,measurement_consent:measurementConsent,shipping_address:session.shipping_details?.address||null};

  if(productType==='pocket_wifi'){
    // Persist the durable inventory commitment and retire its temporary hold
    // under the same database advisory lock used by checkout reservations.
    // Without this boundary, an expired hold could be deleted by a new
    // checkout in the instant before this paid order became visible, selling
    // the same physical router twice. Awaiting asynchronous payments are also
    // durable commitments until Stripe reports failure.
    const persisted=await supabase.rpc('qy_persist_stripe_pocket_wifi_order',{
      p_stripe_session_id:session.id,
      p_payment_status:session.payment_status,
      p_customer_name:orderSnapshot.customer_name,
      p_email:orderSnapshot.email,
      p_phone:orderSnapshot.phone,
      p_amount_sgd:orderSnapshot.amount_sgd,
      p_plan_name:orderSnapshot.plan_name,
      p_country:orderSnapshot.country,
      p_travel_start:orderSnapshot.travel_start,
      p_travel_end:orderSnapshot.travel_end,
      p_measurement_consent:measurementConsent,
      p_shipping_address:orderSnapshot.shipping_address,
      p_payment_confirmed_at:paid?paymentConfirmedAt:null,
      p_payment_failed:failed,
      p_checkout_request_id:session.metadata?.checkout_request_id||null,
    });
    if(persisted.error) throw persisted.error;
    const persistedOrder=Array.isArray(persisted.data)?persisted.data[0]:persisted.data;
    if(!persistedOrder?.stripe_session_id) throw new Error('Pocket WiFi order persistence returned no order');
    return;
  }

  // Stripe can deliver distinct events for one Checkout Session concurrently,
  // while an operator may advance fulfilment at the same time. Use the current
  // payment and fulfilment values as an optimistic-concurrency token. A stale
  // webhook then retries from the new row instead of overwriting `packing`,
  // `fulfilled`, dispatch/return progress, or a newer paid payment snapshot.
  for(let attempt=0;attempt<5;attempt+=1){
    const existing=await supabase.from('orders').select('payment_status,fulfilment_status,payment_confirmed_at').eq('stripe_session_id',session.id).maybeSingle();
    if(existing.error) throw existing.error;
    const current=existing.data?.fulfilment_status;
    if(!paid&&existing.data?.payment_status==='paid') return;
    const fulfilment=paid?(current&&!['awaiting_payment','payment_failed'].includes(current)?current:defaultPaidStatus):failed?(current&&!['awaiting_payment','payment_failed'].includes(current)?current:'payment_failed'):(current||'awaiting_payment');
    // Retain the first signed payment time so CAPI recovery uses one stable
    // event timestamp even when a later paid event refreshes customer details.
    const confirmedAt=paid?(existing.data?.payment_confirmed_at||paymentConfirmedAt):(existing.data?.payment_confirmed_at||null);
    const order={...orderSnapshot,fulfilment_status:fulfilment,payment_confirmed_at:confirmedAt,updated_at:new Date().toISOString()};

    if(!existing.data){
      const inserted=await supabase.from('orders').insert(order);
      if(!inserted.error) return;
      // Another event inserted the row after our read. Re-read it so all of
      // the same paid and fulfilment-state guards apply to the retry.
      if(inserted.error.code==='23505') continue;
      throw inserted.error;
    }

    let update=supabase.from('orders').update(order)
      .eq('stripe_session_id',session.id)
      .eq('fulfilment_status',existing.data.fulfilment_status);
    update=existing.data.payment_status===null
      ? update.is('payment_status',null)
      : update.eq('payment_status',existing.data.payment_status);
    const updated=await update.select('stripe_session_id');
    if(updated.error) throw updated.error;
    if(updated.data?.length===1) return;
  }
  throw new Error('Order changed repeatedly while applying Stripe event');
}

type EventClaim =
  | { status: 'claimed'; processingStartedAt: string }
  | { status: 'processed' }
  | { status: 'in_progress' };

async function claimOnce(supabase:ReturnType<typeof getSupabaseAdmin>, id:string, type:string, sessionId:string):Promise<EventClaim> {
  if(!supabase) throw new Error('Persistence unavailable');
  const processingStartedAt=new Date().toISOString();
  const claimed=await supabase.from('stripe_events').insert({event_id:id,event_type:type,stripe_session_id:sessionId,processing_started_at:processingStartedAt});
  if(claimed.error?.code==='23505'){
    const existing=await supabase.from('stripe_events').select('event_type,stripe_session_id,processed_at,processing_started_at,last_error,attempts').eq('event_id',id).maybeSingle();
    if(existing.error) throw existing.error;
    // An event id is Stripe's idempotency identity, so every observation of
    // that id must describe the same event and Checkout Session. Never let a
    // corrupt/imported ledger row turn a different signed paid event into an
    // acknowledged duplicate, and never rewrite that row while reclaiming a
    // stale lease. Failing closed keeps Stripe retrying and makes the mismatch
    // visible to operations for reconciliation.
    if(!existing.data||existing.data.event_type!==type||existing.data.stripe_session_id!==sessionId){
      throw new Error('Stripe event idempotency identity mismatch');
    }
    if(existing.data?.processed_at) return {status:'processed'};
    const previousStartedAt=existing.data?.processing_started_at;
    const previousStartedMs=previousStartedAt ? new Date(previousStartedAt).getTime() : Number.NaN;
    // A settled failure is no longer in flight and can be retried immediately.
    // Otherwise retain the stale lease for a worker that may still complete.
    if(!existing.data?.last_error&&(!previousStartedAt||!Number.isFinite(previousStartedMs)||Date.now()-previousStartedMs<=STRIPE_EVENT_CLAIM_STALE_MS)) return {status:'in_progress'};

    // A process can die after inserting the event but before completing it. Reclaim
    // only the exact stale version so concurrent Stripe retries cannot both proceed.
    const reclaimed=await supabase.from('stripe_events')
      .update({event_type:type,stripe_session_id:sessionId,processing_started_at:processingStartedAt,last_error:null,attempts:Number(existing.data?.attempts||1)+1})
      .eq('event_id',id)
      .is('processed_at',null)
      .eq('processing_started_at',previousStartedAt)
      .select('event_id');
    if(reclaimed.error) throw reclaimed.error;
    return reclaimed.data?.length===1 ? {status:'claimed',processingStartedAt} : {status:'in_progress'};
  }
  if(claimed.error) throw claimed.error;
  return {status:'claimed',processingStartedAt};
}

async function recordEventFailure(supabase:NonNullable<ReturnType<typeof getSupabaseAdmin>>,eventId:string,processingStartedAt:string,error:unknown){
  const message=error instanceof Error?error.message:'Stripe webhook processing failed';
  // Keep the claim as an operational audit record, but mark it settled so the
  // next signed Stripe retry can reclaim it immediately rather than waiting
  // for the abandoned-worker timeout. The ownership predicate prevents an old
  // worker from overwriting a newer retry's claim.
  const failedAt=new Date().toISOString();
  const failed=await supabase.from('stripe_events')
    .update({last_failed_at:failedAt,last_error:message.slice(0,500)})
    .eq('event_id',eventId)
    .eq('processing_started_at',processingStartedAt)
    .is('processed_at',null)
    .select('event_id');
  if(failed.error||failed.data?.length!==1) console.error('stripe_webhook_failure_record_error',failed.error||'event claim ownership was lost');
}

// An expired Checkout Session can otherwise occupy the durable reservation
// until its original timeout. Stripe's event is signed, but this application
// may share an account with other products, so require the same server-issued
// provenance used for live inventory holds before releasing anything.
async function releaseExpiredPocketWifiReservation(supabase:NonNullable<ReturnType<typeof getSupabaseAdmin>>, session:Stripe.Checkout.Session) {
  const requestId=validCheckoutRequestId(session.metadata?.checkout_request_id);
  if(!requestId||session.metadata?.source!=='qyroam.com'||session.metadata?.product_type!=='pocket_wifi'||!validQyRoamProvenance(session.id,session.metadata)) return;
  // A reservation can be linked only to this Checkout Session. The predicate
  // protects a newer recovery attempt if an old expiry event is delivered late.
  const released=await supabase.from('checkout_reservations')
    .delete()
    .eq('checkout_request_id',requestId)
    .or(`stripe_session_id.is.null,stripe_session_id.eq.${session.id}`);
  if(released.error) throw released.error;
}

// Delayed payment can create an awaiting-payment order before Stripe later
// expires the Checkout Session. Do not leave it looking actionable once the
// signed terminal event arrives. Stripe's payment_status remains its canonical
// snapshot; only the provisional fulfilment state is closed. The narrow
// predicate prevents an out-of-order expiry event from changing a paid,
// cancelled, or otherwise operator-handled order.
async function closeExpiredAwaitingPaymentOrder(supabase:NonNullable<ReturnType<typeof getSupabaseAdmin>>, session:Stripe.Checkout.Session) {
  if(!validQyRoamProvenance(session.id,session.metadata)) return;
  const expired=await supabase.from('orders')
    .update({fulfilment_status:'payment_failed',updated_at:new Date().toISOString()})
    .eq('stripe_session_id',session.id)
    .eq('fulfilment_status','awaiting_payment')
    .or('payment_status.is.null,payment_status.neq.paid');
  if(expired.error) throw expired.error;
}

export async function deliverFulfilmentNotification(supabase:NonNullable<ReturnType<typeof getSupabaseAdmin>>, session:Stripe.Checkout.Session){
  // Stripe may retry a paid event after its original email attempt failed.
  // Operations can legitimately cancel, return, close, or digitally fulfil
  // the order before that retry arrives. Re-read the durable lifecycle at the
  // shared delivery boundary (used by both webhook and admin recovery) so an
  // old event cannot create a stale instruction to send a router or eSIM.
  // This check intentionally precedes creation/claiming of the notification
  // row: skipped deliveries are not failures and must not remain as a false
  // pending exception on the operations dashboard.
  const order=await supabase.from('orders')
    .select('payment_status,product_type,fulfilment_status')
    .eq('stripe_session_id',session.id)
    .maybeSingle();
  if(order.error) throw order.error;
  if(!order.data) throw new Error('Paid order is missing before fulfilment notification delivery');
  if(order.data.payment_status!=='paid'||!fulfilmentNotificationActionable(order.data.product_type,order.data.fulfilment_status)) return;
  if(order.data.product_type!==session.metadata?.product_type) throw new Error('Stored order product does not match its Stripe session');

  let existing=await supabase.from('fulfilment_notifications').select('status,updated_at,attempts').eq('stripe_session_id',session.id).maybeSingle();
  if(existing.error) throw existing.error;
  if(existing.data?.status==='sent') return;
  if(!existing.data){
    const created=await supabase.from('fulfilment_notifications').insert({stripe_session_id:session.id,status:'pending'});
    if(created.error?.code!=='23505'&&created.error) throw created.error;
    existing=await supabase.from('fulfilment_notifications').select('status,updated_at,attempts').eq('stripe_session_id',session.id).single();
    if(existing.error) throw existing.error;
    if(existing.data?.status==='sent') return;
  }
  const notification=existing.data!;
  const staleSending=notification.status==='sending'&&deliveryLeaseIsStale(notification.updated_at);
  if(notification.status==='sending'&&!staleSending) throw new Error('Fulfilment notification is already being sent');
  const now=new Date().toISOString();
  const attempt=await supabase.from('fulfilment_notifications').update({status:'sending',attempts:Number(notification.attempts||0)+1,last_attempt_at:now,last_error:null,updated_at:now}).eq('stripe_session_id',session.id).eq('status',notification.status).eq('updated_at',notification.updated_at).select('stripe_session_id');
  if(attempt.error) throw attempt.error;
  if(attempt.data?.length!==1) throw new Error('Fulfilment notification was claimed by another delivery attempt');
  try{
    await sendHumanFulfilmentEmail(session);
    // The sending lease can be reclaimed after a timed-out worker. Only its
    // owner may settle it: an older worker must never mark a newer delivery
    // sent (or later reset it to pending in the catch below).
    const sentAt=new Date().toISOString();
    const sent=await supabase.from('fulfilment_notifications').update({status:'sent',sent_at:sentAt,updated_at:sentAt}).eq('stripe_session_id',session.id).eq('status','sending').eq('updated_at',now).select('stripe_session_id');
    if(sent.error) throw sent.error;
    if(sent.data?.length!==1) throw new Error('Fulfilment notification delivery lease was lost');
  }catch(error){
    const message=error instanceof Error?error.message:'SMTP delivery failed';
    // Keep a newer worker's lease intact if this worker was reclaimed while
    // its provider call was still in flight.
    const failed=await supabase.from('fulfilment_notifications').update({status:'pending',last_error:message.slice(0,500),updated_at:new Date().toISOString()}).eq('stripe_session_id',session.id).eq('status','sending').eq('updated_at',now).select('stripe_session_id');
    if(failed.error) console.error('fulfilment_notification_failure_record_error',failed.error);
    throw error;
  }
}

export async function deliverMetaPurchase(supabase:NonNullable<ReturnType<typeof getSupabaseAdmin>>, session:Stripe.Checkout.Session,eventTime:number){
  if(!metaPurchaseConfigured(session)) return;
  // A Meta timeout can leave us unable to tell whether Meta accepted the
  // event. Keep Stripe's signed event time on the delivery record so every
  // retry presents exactly the same Purchase identity to Meta for dedupe.
  const requestedEventTime=Math.floor(eventTime);
  if(!Number.isSafeInteger(requestedEventTime)||requestedEventTime<=0) throw new Error('Invalid Meta Purchase event time');
  let existing=await supabase.from('meta_purchase_deliveries').select('status,updated_at,attempts,event_time').eq('stripe_session_id',session.id).maybeSingle();
  if(existing.error) throw existing.error;
  if(existing.data?.status==='sent') return;
  if(!existing.data){
    const created=await supabase.from('meta_purchase_deliveries').insert({stripe_session_id:session.id,status:'pending',event_time:requestedEventTime});
    if(created.error?.code!=='23505'&&created.error) throw created.error;
    existing=await supabase.from('meta_purchase_deliveries').select('status,updated_at,attempts,event_time').eq('stripe_session_id',session.id).single();
    if(existing.error) throw existing.error;
    if(existing.data?.status==='sent') return;
  }
  const delivery=existing.data!;
  const persistedEventTime=Number(delivery.event_time);
  const metaEventTime=Number.isSafeInteger(persistedEventTime)&&persistedEventTime>0 ? persistedEventTime : requestedEventTime;
  const staleSending=delivery.status==='sending'&&deliveryLeaseIsStale(delivery.updated_at);
  if(delivery.status==='sending'&&!staleSending) throw new Error('Meta purchase delivery is already being sent');
  const now=new Date().toISOString();
  // `event_time` also backfills records made before this column existed.
  // The optimistic updated_at predicate ensures two retries cannot choose
  // different timestamps for the same delivery.
  const attempt=await supabase.from('meta_purchase_deliveries').update({status:'sending',event_time:metaEventTime,attempts:Number(delivery.attempts||0)+1,last_attempt_at:now,last_error:null,updated_at:now}).eq('stripe_session_id',session.id).eq('status',delivery.status).eq('updated_at',delivery.updated_at).select('stripe_session_id,event_time');
  if(attempt.error) throw attempt.error;
  if(attempt.data?.length!==1) throw new Error('Meta purchase delivery was claimed by another attempt');
  try{
    await sendMetaPurchase(session,Number(attempt.data[0].event_time));
    const sentAt=new Date().toISOString();
    // As with SMTP, do not let a stale CAPI worker settle a lease that a
    // newer retry has reclaimed. Meta's event_id deduplicates the provider
    // event, while this predicate preserves an accurate local delivery state.
    const sent=await supabase.from('meta_purchase_deliveries').update({status:'sent',sent_at:sentAt,updated_at:sentAt}).eq('stripe_session_id',session.id).eq('status','sending').eq('updated_at',now).select('stripe_session_id');
    if(sent.error) throw sent.error;
    if(sent.data?.length!==1) throw new Error('Meta purchase delivery lease was lost');
  }catch(error){
    const message=error instanceof Error?error.message:'Meta CAPI delivery failed';
    const failed=await supabase.from('meta_purchase_deliveries').update({status:'pending',last_error:message.slice(0,500),updated_at:new Date().toISOString()}).eq('stripe_session_id',session.id).eq('status','sending').eq('updated_at',now).select('stripe_session_id');
    if(failed.error) console.error('meta_purchase_failure_record_error',failed.error);
    throw error;
  }
}

export async function deliverPaidOrderSideEffects(supabase:NonNullable<ReturnType<typeof getSupabaseAdmin>>, session:Stripe.Checkout.Session,eventTime:number){
  // Human fulfilment and consented analytics have independent durable ledgers.
  // Attempt both even when one provider is unavailable: serial delivery would
  // let a persistent SMTP outage indefinitely suppress an otherwise valid CAPI
  // Purchase (and vice versa). Each delivery remains retry-safe on Stripe's
  // next attempt, while any failure still keeps the event itself unprocessed.
  const results=await Promise.allSettled([
    deliverFulfilmentNotification(supabase,session),
    deliverMetaPurchase(supabase,session,eventTime),
  ]);
  const failures=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected');
  if(failures.length) throw new AggregateError(failures.map((failure)=>failure.reason),'One or more paid-order deliveries failed');
}

export async function POST(req:Request){
  const key=process.env.STRIPE_SECRET_KEY,webhookSecret=process.env.STRIPE_WEBHOOK_SECRET; if(!hasRequiredStripeCheckoutConfig()||!key||!webhookSecret) return NextResponse.json({error:'Webhook configuration incomplete'},{status:503});
  const stripe=createStripeClient(key); let event:Stripe.Event;
  let payload:Buffer;
  try { payload=await readStripeWebhookBody(req); }
  catch(error) {
    if (error instanceof RangeError) return NextResponse.json({error:'Webhook payload too large'},{status:413});
    if (error instanceof StripeWebhookBodyTimeoutError) return NextResponse.json({error:'Webhook payload timed out'},{status:408});
    return NextResponse.json({error:'Invalid webhook payload'},{status:400});
  }
  const stripeSignature=validStripeSignatureHeader(req.headers.get('stripe-signature'));
  if(!stripeSignature) return NextResponse.json({error:'Invalid signature'},{status:400});
  try{event=stripe.webhooks.constructEvent(payload,stripeSignature,webhookSecret);}catch{return NextResponse.json({error:'Invalid signature'},{status:400});}
  // A valid signature authenticates bytes, not the runtime shape supplied by
  // an SDK/API-version edge case. Validate the event identity before using it
  // in logs or as the primary key of the durable retry ledger. This mirrors
  // the Checkout Session id boundary below and prevents an unbounded or
  // control-character-bearing identifier from polluting operations data.
  const stripeEventId=validStripeEventId(event.id);
  if(!stripeEventId) {
    console.error('stripe_webhook_invalid_event_id');
    return NextResponse.json({error:'Invalid Stripe event identifier'},{status:400});
  }
  // A webhook secret is scoped to a Stripe endpoint but its value does not
  // encode test versus live mode. Prevent an accidentally configured test
  // endpoint from creating operational orders, sending fulfilment email, or
  // reporting CAPI revenue while this service is using a live API key (and
  // likewise prevent live events from entering a local/test installation).
  if(!stripeEventMatchesConfiguredMode(key,event.livemode)){
    console.error('stripe_webhook_mode_mismatch',{eventId:stripeEventId,eventLivemode:event.livemode});
    return NextResponse.json({error:'Stripe event mode mismatch'},{status:400});
  }
  if(!['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired'].includes(event.type)) return NextResponse.json({received:true});
  const eventSession=event.data.object as Stripe.Checkout.Session, supabase=getSupabaseAdmin(); if(!supabase) return NextResponse.json({error:'Persistence unavailable'},{status:503});
  // QY Roam can share a Stripe account with other products. A broad Checkout
  // webhook subscription must acknowledge their sessions without creating an
  // order, sending fulfilment email, or filling this app's idempotency ledger.
  // Both QY Roam checkout routes set this server-controlled marker.
  if(eventSession.metadata?.source!=='qyroam.com') return NextResponse.json({received:true,ignored:true});
  // The event is Stripe-signed, but retain the same bounded identifier
  // boundary used by customer-facing recovery pages before an SDK call or a
  // durable ledger write. This protects the worker from an unexpected API
  // version/object shape and prevents an invalid event object from becoming a
  // retrying operational record with an unbounded identifier.
  const eventSessionId=validStripeCheckoutSessionId(eventSession.id);
  if(!eventSessionId){
    console.error('stripe_webhook_invalid_session_id',{eventId:stripeEventId});
    return NextResponse.json({error:'Invalid Checkout Session identifier'},{status:400});
  }
  // Stripe signs the event snapshot, but fetch the Checkout Session again
  // before using it as an order or delivery record. This keeps a delayed
  // terminal event from persisting incomplete customer/shipping fields that
  // can occur in an event payload across API-version changes, and gives every
  // fulfilment/CAPI retry one current Stripe-owned snapshot. The signed event
  // type and its created time remain the authority for the transition and the
  // original Purchase timestamp respectively.
  let session: Stripe.Checkout.Session;
  try {
    session=await stripe.checkout.sessions.retrieve(eventSessionId);
  } catch (error) {
    // A temporary Stripe read failure must remain retryable rather than
    // acknowledging a paid order whose durable fulfilment record we cannot
    // safely reconstruct from a complete Checkout Session.
    console.error('stripe_webhook_session_retrieve_error',{eventId:stripeEventId,sessionId:eventSessionId});
    return NextResponse.json({error:'Unable to retrieve Checkout Session'},{status:500});
  }
  // The signed event selects the Checkout Session to process; the refreshed
  // object only supplies its current customer and payment fields. Keep those
  // roles separate. A malformed SDK response, a test double, or an
  // integration defect must never let a different Session (or a different
  // Stripe mode) inherit this event's authority and reach persistence or
  // fulfilment side effects.
  if(session.id!==eventSessionId||session.livemode!==event.livemode){
    console.error('stripe_webhook_session_identity_mismatch',{
      eventId:stripeEventId,
      eventSessionId,
      retrievedSessionId:session.id,
      eventLivemode:event.livemode,
      retrievedLivemode:session.livemode,
    });
    return NextResponse.json({error:'Retrieved Checkout Session does not match webhook event'},{status:500});
  }
  // The retrieved Session is the freshest source for customer, shipping,
  // metadata, and amount fields, but it must not change what this particular
  // signed event says happened. A delayed retry of an initially-unpaid
  // `checkout.session.completed` can arrive after a later asynchronous
  // payment has succeeded; using the refreshed `paid` state would backdate
  // payment_confirmed_at and the Meta Purchase to the older completion event.
  // Keep the signed snapshot authoritative for transition state. Expiry is
  // deliberately checked against the refreshed Session as well, because an
  // out-of-order expiry must never release a reservation that is now paid.
  const eventStateSession=event.type==='checkout.session.expired'?session:eventSession;
  const eventStateIssue=stripeCheckoutEventStateIssue(event.type,eventStateSession);
  if(event.type==='checkout.session.expired'){
    // Expiry does not persist a paid order, but it still writes to the event
    // ledger and can release inventory or close a provisional order. The
    // public source marker alone is not an authority: this Stripe account may
    // be shared, and a lookalike Session must not be able to pollute the
    // idempotency ledger. Legitimate checkouts receive this server-only HMAC
    // before their URL is exposed.
    if(!validQyRoamProvenance(session.id,session.metadata)){
      console.error('stripe_webhook_expiry_integrity_error',{sessionId:session.id});
      return NextResponse.json({received:true,ignored:true});
    }
    const eventClaimId=`stripe:${stripeEventId}`;
    let claimStartedAt:string|undefined;
    try{
      const claim=await claimOnce(supabase,eventClaimId,event.type,session.id);
      if(claim.status==='processed') return NextResponse.json({received:true,duplicate:true});
      if(claim.status==='in_progress') return NextResponse.json({error:'Event is still processing'},{status:500});
      claimStartedAt=claim.processingStartedAt;
      if(eventStateIssue) throw new Error(`Stripe event state validation failed: ${eventStateIssue}`);
      await releaseExpiredPocketWifiReservation(supabase,session);
      await closeExpiredAwaitingPaymentOrder(supabase,session);
      const completed=await supabase.from('stripe_events').update({processed_at:new Date().toISOString()}).eq('event_id',eventClaimId).eq('processing_started_at',claimStartedAt).is('processed_at',null).select('event_id');
      if(completed.error) throw completed.error;
      if(completed.data?.length!==1) throw new Error('Stripe event claim ownership was lost');
    }catch(error){
      console.error('stripe_webhook_expiry_processing_error',error);
      if(claimStartedAt) await recordEventFailure(supabase,eventClaimId,claimStartedAt,error);
      return NextResponse.json({error:'Processing failed'},{status:500});
    }
    return NextResponse.json({received:true});
  }
  const eventClaimId=`stripe:${stripeEventId}`;
  let claimStartedAt:string|undefined;
  try{
    const claim=await claimOnce(supabase,eventClaimId,event.type,session.id);
    if(claim.status==='processed') return NextResponse.json({received:true,duplicate:true});
    if(claim.status==='in_progress') return NextResponse.json({error:'Event is still processing'},{status:500});
    claimStartedAt=claim.processingStartedAt;
    // Claim before the validation boundary. A signed QY Roam event that has
    // become malformed due to configuration drift or an unexpected Stripe
    // snapshot must remain visible in the durable recovery ledger; otherwise
    // it only exists in Stripe's finite retry history and staff cannot
    // reconcile the affected paid order after those retries stop.
    if(eventStateIssue) {
      console.error('stripe_webhook_event_state_error',{eventId:stripeEventId,sessionId:session.id,reason:eventStateIssue});
      throw new Error(`Stripe event state validation failed: ${eventStateIssue}`);
    }
    // `event.created` is carried into both the durable payment-confirmation
    // record and Meta's Purchase event. Validate it after claiming the event
    // so a signed but malformed timestamp is retained as an actionable
    // webhook exception instead of producing an invalid/future order time.
    const eventCreated=validStripeEventCreated(event.created);
    if(!eventCreated) {
      console.error('stripe_webhook_invalid_event_created',{eventId:stripeEventId,sessionId:session.id});
      throw new Error('Invalid Stripe event timestamp');
    }
    // Combine current fulfilment details with the signed event's payment and
    // Checkout state. In particular, an unpaid completion remains an
    // awaiting-payment order even if the Session became paid before this
    // retry; the distinct signed async-success event owns that later payment
    // timestamp and its downstream Purchase attribution.
    const sessionForEvent={
      ...session,
      status:eventSession.status,
      payment_status:eventSession.payment_status,
    } as Stripe.Checkout.Session;
    const validation=validateQyRoamSession(sessionForEvent);
    if(!validation.valid){
      // Never persist or fulfil a malformed order. The claimed event is
      // marked failed below so it is visible and safely retryable.
      console.error('stripe_webhook_order_integrity_error',{sessionId:session.id,reason:validation.reason});
      throw new Error(`Order integrity validation failed: ${validation.reason}`);
    }
    const fulfilmentDetailsIssue=paidFulfilmentDetailsIssue(sessionForEvent,validation.productType);
    if(fulfilmentDetailsIssue) throw new Error(fulfilmentDetailsIssue);
    await persistSession(sessionForEvent,event.type,eventCreated);
    // Pocket WiFi persistence atomically replaces the temporary reservation
    // with the durable order commitment inside qy_persist_stripe_pocket_wifi_order.
    if(event.type!=='checkout.session.async_payment_failed'&&sessionForEvent.payment_status==='paid'){
      // Use the signed Stripe event timestamp: the Checkout Session may have
      // been created well before an asynchronous payment actually succeeded.
      await deliverPaidOrderSideEffects(supabase,sessionForEvent,eventCreated);
    }
    const completed=await supabase.from('stripe_events').update({processed_at:new Date().toISOString()}).eq('event_id',eventClaimId).eq('processing_started_at',claimStartedAt).is('processed_at',null).select('event_id');
    if(completed.error)throw completed.error;
    if(completed.data?.length!==1) throw new Error('Stripe event claim ownership was lost');
  }catch(error){
    console.error('stripe_webhook_processing_error',error);
    if(claimStartedAt) await recordEventFailure(supabase,eventClaimId,claimStartedAt,error);
    return NextResponse.json({error:'Processing failed'},{status:500});
  }
  return NextResponse.json({received:true});
}
