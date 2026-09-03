import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import crypto from 'crypto';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { sendSmtpMail } from '@/lib/smtp';
import { getMetaCapiToken } from '@/lib/runtimeConfig';
import { validateQyRoamSession } from '@/lib/qyRoamSession';
import { validCheckoutRequestId } from '@/lib/checkoutValidation';
import { validQyRoamProvenance } from '@/lib/orderProvenance';

export const runtime = 'nodejs';

// Stripe Checkout events are small, but this is a public endpoint and the
// signature cannot be checked until the exact raw payload has been read. Keep
// the memory used by an invalid request bounded rather than relying on a proxy
// body-size setting that may differ between production environments.
const MAX_STRIPE_WEBHOOK_BODY_BYTES = 1_000_000;

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
  try {
    for (;;) {
      const { done, value } = await reader.read();
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
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function sha256(value?: string | null) { return value ? crypto.createHash('sha256').update(value).digest('hex') : undefined; }
function normalizeEmail(value?: string | null) { return value?.trim().toLowerCase(); }
function normalizePhone(value?: string | null) { if (!value) return undefined; const digits=value.replace(/\D/g,''); return digits||undefined; }
function fulfilmentMessageId(sessionId:string) { return `<qyroam-${crypto.createHash('sha256').update(sessionId).digest('hex').slice(0,32)}@qyroam.com>`; }
const DELIVERY_TIMEOUT_MS=20_000;

async function postJsonWithTimeout(url:string,body:unknown,timeoutMs=DELIVERY_TIMEOUT_MS){
  const controller=new AbortController();
  const deadline=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
    // Consume the response while the deadline is still active. A provider that
    // sends headers and then stalls its body must not hold the webhook open.
    const responseBody=await response.text();
    return {ok:response.ok,status:response.status,responseBody};
  }finally{
    clearTimeout(deadline);
  }
}

function metaPurchaseConfigured(session: Stripe.Checkout.Session) {
  return session.payment_status === 'paid' &&
    session.metadata?.measurement_consent === 'accepted' &&
    Boolean(getMetaCapiToken() && process.env.NEXT_PUBLIC_META_PIXEL_ID);
}

async function sendMetaPurchase(session: Stripe.Checkout.Session, eventTime: number) {
  const token=getMetaCapiToken(), pixel=process.env.NEXT_PUBLIC_META_PIXEL_ID;
  if (!token || !pixel) throw new Error('Meta CAPI is not configured');
  const email=normalizeEmail(session.customer_details?.email), phone=normalizePhone(session.customer_details?.phone);
  const userData:Record<string,string[]>={}; if(email) userData.em=[sha256(email)!]; if(phone) userData.ph=[sha256(phone)!];
  const productType=session.metadata?.product_type||'pocket_wifi';
  const contentId=productType==='esim' ? `esim:${session.metadata?.plan_id||''}` : `pocket_wifi:${session.metadata?.country||''}`;
  const payload={data:[{event_name:'Purchase',event_time:eventTime,action_source:'website',event_source_url:`${process.env.NEXT_PUBLIC_SITE_URL||'https://qyroam.com'}/success`,event_id:`stripe_${session.id}`,user_data:userData,custom_data:{currency:'SGD',value:(session.amount_total||0)/100,order_id:session.id,content_type:'product',content_ids:[contentId],contents:[{id:contentId,quantity:1}],content_category:productType==='esim'?'Travel eSIM':'Pocket WiFi'}}]};
  const response=await postJsonWithTimeout(`https://graph.facebook.com/v21.0/${pixel}/events?access_token=${encodeURIComponent(token)}`,payload);
  if(!response.ok) throw new Error(`Meta CAPI failed (${response.status}): ${response.responseBody.slice(0,300)}`);
}

async function sendHumanFulfilmentEmail(session: Stripe.Checkout.Session) {
  if(session.payment_status!=='paid') return;
  const host=process.env.SMTP_HOST, port=Number(process.env.SMTP_PORT||'587'), secure=process.env.SMTP_SECURE==='true'||port===465, user=process.env.SMTP_USER, pass=process.env.SMTP_PASS, from=process.env.SMTP_FROM||user, to=process.env.ORDER_FULFILMENT_EMAIL||process.env.FULFILMENT_TO||'enquiries@sgsimshop.com';
  if(!host||!user||!pass||!from) throw new Error('SMTP fulfilment email is not configured');
  const productType=session.metadata?.product_type;
  if(productType!=='esim'&&productType!=='pocket_wifi') throw new Error('Unknown or missing product_type on paid order');
  const isEsim=productType==='esim', destination=session.metadata?.country||'', planName=session.metadata?.plan_name||'', start=session.metadata?.start||'', end=session.metadata?.end||'', customer=session.customer_details, amount=((session.amount_total||0)/100).toFixed(2), shipping=session.shipping_details?.address, messageId=fulfilmentMessageId(session.id);
  const shippingText=shipping?[shipping.line1,shipping.line2,shipping.city,shipping.state,shipping.postal_code,shipping.country].filter(Boolean).join(', '):'Not applicable / not supplied';
  const subject=`[QY Roam] Paid ${isEsim?'eSIM':'Pocket WiFi'} order — ${destination||planName||session.id}`;
  const text=['A paid QY Roam order requires human fulfilment.','',`Order reference: ${session.id}`,`Product: ${isEsim?'Travel eSIM':'Pocket WiFi'}`,`Destination: ${destination||'-'}`,`Plan: ${planName||'-'}`,`Travel dates: ${start||'-'}${end?` to ${end}`:''}`,`Amount paid: S$${amount}`,`Promo code: ${session.metadata?.promo_code||'-'}`,'',`Customer name: ${customer?.name||'-'}`,`Email: ${customer?.email||'-'}`,`Phone: ${customer?.phone||'-'}`,`Delivery address: ${shippingText}`,'',isEsim?'Action: Please process the eSIM manually and send the QR code / activation instructions to the customer.':'Action: Please prepare and fulfil the Pocket WiFi order according to the travel dates and delivery details.','','Customer support: +65 8032 7183'].join('\n');
  const relayUrl=process.env.SMTP_RELAY_URL, relaySecret=process.env.SMTP_RELAY_SECRET;
  if(relayUrl&&relaySecret){
    const response=await postJsonWithTimeout(relayUrl,{relay_secret:relaySecret,smtp_host:host,smtp_port:port,smtp_user:user,smtp_pass:pass,from,to,subject,text,message_id:messageId});
    if(!response.ok) throw new Error(`SMTP relay failed (${response.status}): ${response.responseBody.slice(0,300)}`);
    return;
  }
  await sendSmtpMail({host,port,secure,user,pass,from,to,subject,text,messageId,timeoutMs:DELIVERY_TIMEOUT_MS});
}

async function persistSession(session:Stripe.Checkout.Session,eventType:Stripe.Event.Type,eventCreated:number){
  const supabase=getSupabaseAdmin(); if(!supabase) throw new Error('Order persistence unavailable');
  const paid=session.payment_status==='paid', failed=eventType==='checkout.session.async_payment_failed';
  const existing=await supabase.from('orders').select('payment_status,fulfilment_status,payment_confirmed_at').eq('stripe_session_id',session.id).maybeSingle(); if(existing.error) throw existing.error;
  const current=existing.data?.fulfilment_status, productType=session.metadata?.product_type;
  if(productType!=='esim'&&productType!=='pocket_wifi') throw new Error('Unknown or missing product_type on Stripe session');
  const defaultPaidStatus=productType==='esim'?'awaiting_fulfilment':'paid';
  const fulfilment=paid?(current&&!['awaiting_payment','payment_failed'].includes(current)?current:defaultPaidStatus):failed?(current&&!['awaiting_payment','payment_failed'].includes(current)?current:'payment_failed'):(current||'awaiting_payment');
  // A Checkout Session can be created well before an asynchronous payment is
  // confirmed. Retain the first signed event time so a later protected retry
  // has a stable payment timestamp for Meta CAPI rather than falling back to
  // session creation time. Never replace an existing value with a later,
  // duplicate webhook event.
  const confirmedAt=paid
    ? (existing.data?.payment_confirmed_at || new Date(eventCreated*1000).toISOString())
    : (existing.data?.payment_confirmed_at || null);
  const order={stripe_session_id:session.id,payment_status:session.payment_status,customer_name:session.customer_details?.name,email:session.customer_details?.email,phone:session.customer_details?.phone,amount_sgd:(session.amount_total||0)/100,product_type:productType,plan_name:session.metadata?.plan_name||null,country:session.metadata?.country,travel_start:session.metadata?.start||null,travel_end:session.metadata?.end||null,fulfilment_status:fulfilment,payment_confirmed_at:confirmedAt,shipping_address:session.shipping_details?.address||null,updated_at:new Date().toISOString()};

  // Checkout events can arrive out of order. Once a session is recorded as paid,
  // an older `completed` snapshot or a late async failure must not make inventory
  // available again. The database-side filter also closes the race between this
  // read and a concurrent paid-event write.
  if(existing.data){
    if(!paid&&existing.data.payment_status==='paid') return;
    let update=supabase.from('orders').update(order).eq('stripe_session_id',session.id);
    if(!paid) update=update.or('payment_status.is.null,payment_status.neq.paid');
    const {error}=await update;
    if(error) throw error;
    return;
  }

  const inserted=await supabase.from('orders').insert(order);
  if(!inserted.error) return;
  // A concurrent event may have created the row after our initial read. Paid
  // events may overwrite it; unpaid events remain guarded against paid rows.
  if(inserted.error.code!=='23505') throw inserted.error;
  let update=supabase.from('orders').update(order).eq('stripe_session_id',session.id);
  if(!paid) update=update.or('payment_status.is.null,payment_status.neq.paid');
  const {error}=await update;
  if(error) throw error;
}

type EventClaim =
  | { status: 'claimed'; processingStartedAt: string }
  | { status: 'processed' }
  | { status: 'in_progress' };

const EVENT_CLAIM_STALE_MS = 30 * 60_000;

async function claimOnce(supabase:ReturnType<typeof getSupabaseAdmin>, id:string, type:string):Promise<EventClaim> {
  if(!supabase) throw new Error('Persistence unavailable');
  const processingStartedAt=new Date().toISOString();
  const claimed=await supabase.from('stripe_events').insert({event_id:id,event_type:type,processing_started_at:processingStartedAt});
  if(claimed.error?.code==='23505'){
    const existing=await supabase.from('stripe_events').select('processed_at,processing_started_at').eq('event_id',id).maybeSingle();
    if(existing.error) throw existing.error;
    if(existing.data?.processed_at) return {status:'processed'};
    const previousStartedAt=existing.data?.processing_started_at;
    const previousStartedMs=previousStartedAt ? new Date(previousStartedAt).getTime() : Number.NaN;
    if(!previousStartedAt||!Number.isFinite(previousStartedMs)||Date.now()-previousStartedMs<=EVENT_CLAIM_STALE_MS) return {status:'in_progress'};

    // A process can die after inserting the event but before completing it. Reclaim
    // only the exact stale version so concurrent Stripe retries cannot both proceed.
    const reclaimed=await supabase.from('stripe_events')
      .update({event_type:type,processing_started_at:processingStartedAt})
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
  const staleSending=notification.status==='sending'&&Date.now()-new Date(notification.updated_at).getTime()>15*60_000;
  if(notification.status==='sending'&&!staleSending) throw new Error('Fulfilment notification is already being sent');
  const now=new Date().toISOString();
  const attempt=await supabase.from('fulfilment_notifications').update({status:'sending',attempts:Number(notification.attempts||0)+1,last_attempt_at:now,last_error:null,updated_at:now}).eq('stripe_session_id',session.id).eq('status',notification.status).eq('updated_at',notification.updated_at).select('stripe_session_id');
  if(attempt.error) throw attempt.error;
  if(attempt.data?.length!==1) throw new Error('Fulfilment notification was claimed by another delivery attempt');
  try{
    await sendHumanFulfilmentEmail(session);
    const sent=await supabase.from('fulfilment_notifications').update({status:'sent',sent_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('stripe_session_id',session.id);
    if(sent.error) throw sent.error;
  }catch(error){
    const message=error instanceof Error?error.message:'SMTP delivery failed';
    await supabase.from('fulfilment_notifications').update({status:'pending',last_error:message.slice(0,500),updated_at:new Date().toISOString()}).eq('stripe_session_id',session.id);
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
  const staleSending=delivery.status==='sending'&&Date.now()-new Date(delivery.updated_at).getTime()>15*60_000;
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
    const sent=await supabase.from('meta_purchase_deliveries').update({status:'sent',sent_at:sentAt,updated_at:sentAt}).eq('stripe_session_id',session.id).eq('status','sending');
    if(sent.error) throw sent.error;
  }catch(error){
    const message=error instanceof Error?error.message:'Meta CAPI delivery failed';
    await supabase.from('meta_purchase_deliveries').update({status:'pending',last_error:message.slice(0,500),updated_at:new Date().toISOString()}).eq('stripe_session_id',session.id).eq('status','sending');
    throw error;
  }
}

export async function POST(req:Request){
  const key=process.env.STRIPE_SECRET_KEY,webhookSecret=process.env.STRIPE_WEBHOOK_SECRET; if(!key||!webhookSecret) return NextResponse.json({error:'Webhook configuration incomplete'},{status:503});
  const stripe=new Stripe(key,{apiVersion:'2024-06-20'}); let event:Stripe.Event;
  let payload:Buffer;
  try { payload=await readStripeWebhookBody(req); }
  catch(error) {
    if (error instanceof RangeError) return NextResponse.json({error:'Webhook payload too large'},{status:413});
    return NextResponse.json({error:'Invalid webhook payload'},{status:400});
  }
  try{event=stripe.webhooks.constructEvent(payload,req.headers.get('stripe-signature')||'',webhookSecret);}catch{return NextResponse.json({error:'Invalid signature'},{status:400});}
  if(!['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired'].includes(event.type)) return NextResponse.json({received:true});
  const session=event.data.object as Stripe.Checkout.Session, supabase=getSupabaseAdmin(); if(!supabase) return NextResponse.json({error:'Persistence unavailable'},{status:503});
  // QY Roam can share a Stripe account with other products. A broad Checkout
  // webhook subscription must acknowledge their sessions without creating an
  // order, sending fulfilment email, or filling this app's idempotency ledger.
  // Both QY Roam checkout routes set this server-controlled marker.
  if(session.metadata?.source!=='qyroam.com') return NextResponse.json({received:true,ignored:true});
  if(event.type==='checkout.session.expired'){
    const eventClaimId=`stripe:${event.id}`;
    let claimStartedAt:string|undefined;
    try{
      const claim=await claimOnce(supabase,eventClaimId,event.type);
      if(claim.status==='processed') return NextResponse.json({received:true,duplicate:true});
      if(claim.status==='in_progress') return NextResponse.json({error:'Event is still processing'},{status:500});
      claimStartedAt=claim.processingStartedAt;
      await releaseExpiredPocketWifiReservation(supabase,session);
      await closeExpiredAwaitingPaymentOrder(supabase,session);
      const completed=await supabase.from('stripe_events').update({processed_at:new Date().toISOString()}).eq('event_id',eventClaimId).eq('processing_started_at',claimStartedAt).is('processed_at',null).select('event_id');
      if(completed.error) throw completed.error;
      if(completed.data?.length!==1) throw new Error('Stripe event claim ownership was lost');
    }catch(error){
      console.error('stripe_webhook_expiry_processing_error',error);
      if(claimStartedAt) await supabase.from('stripe_events').delete().eq('event_id',eventClaimId).eq('processing_started_at',claimStartedAt).is('processed_at',null);
      return NextResponse.json({error:'Processing failed'},{status:500});
    }
    return NextResponse.json({received:true});
  }
  const validation=validateQyRoamSession(session);
  if(!validation.valid){
    // Never persist or fulfil a malformed digital order. Returning a failure is
    // intentional: Stripe will retry and surface the delivery failure instead
    // of silently losing a legitimate order that needs operator attention.
    console.error('stripe_webhook_order_integrity_error',{sessionId:session.id,reason:validation.reason});
    return NextResponse.json({error:'Order integrity validation failed'},{status:500});
  }
  const eventClaimId=`stripe:${event.id}`;
  let claimStartedAt:string|undefined;
  try{
    const claim=await claimOnce(supabase,eventClaimId,event.type);
    if(claim.status==='processed') return NextResponse.json({received:true,duplicate:true});
    if(claim.status==='in_progress') return NextResponse.json({error:'Event is still processing'},{status:500});
    claimStartedAt=claim.processingStartedAt;
    await persistSession(session,event.type,event.created);
    // A paid or failed terminal event supersedes the temporary checkout hold.
    // Keeping pending async-payment reservations until expiry prevents the same
    // router being sold while Stripe is still confirming payment.
    if(validation.productType==='pocket_wifi'&&(session.payment_status==='paid'||event.type==='checkout.session.async_payment_failed')){
      const checkoutRequestId=session.metadata?.checkout_request_id;
      if(checkoutRequestId){
        // eSIM and Pocket WiFi Checkout Sessions deliberately use different
        // Stripe idempotency namespaces, but a caller can still reuse the
        // same client request id across them. Only a terminal event for this
        // exact router session may release its durable inventory hold.
        const released=await supabase.from('checkout_reservations').delete()
          .eq('checkout_request_id',checkoutRequestId)
          .eq('stripe_session_id',session.id);
        if(released.error) throw released.error;
      }
    }
    if(event.type!=='checkout.session.async_payment_failed'&&session.payment_status==='paid'){
      await deliverFulfilmentNotification(supabase,session);
      // Use the signed Stripe event timestamp: the Checkout Session may have
      // been created well before an asynchronous payment actually succeeded.
      await deliverMetaPurchase(supabase,session,event.created);
    }
    const completed=await supabase.from('stripe_events').update({processed_at:new Date().toISOString()}).eq('event_id',eventClaimId).eq('processing_started_at',claimStartedAt).is('processed_at',null).select('event_id');
    if(completed.error)throw completed.error;
    if(completed.data?.length!==1) throw new Error('Stripe event claim ownership was lost');
  }catch(error){
    console.error('stripe_webhook_processing_error',error);
    // Delete only the claim owned by this invocation. A stale worker must never
    // erase a newer retry's reclaimed lease.
    if(claimStartedAt) await supabase.from('stripe_events').delete().eq('event_id',eventClaimId).eq('processing_started_at',claimStartedAt).is('processed_at',null);
    return NextResponse.json({error:'Processing failed'},{status:500});
  }
  return NextResponse.json({received:true});
}
