import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import crypto from 'crypto';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { sendSmtpMail } from '@/lib/smtp';

export const runtime = 'nodejs';

function sha256(value?: string | null) { return value ? crypto.createHash('sha256').update(value).digest('hex') : undefined; }
function normalizeEmail(value?: string | null) { return value?.trim().toLowerCase(); }
function normalizePhone(value?: string | null) { if (!value) return undefined; const digits=value.replace(/\D/g,''); return digits||undefined; }

async function sendMetaPurchase(session: Stripe.Checkout.Session) {
  if (session.payment_status !== 'paid' || session.metadata?.measurement_consent !== 'accepted') return;
  const token=process.env.META_CAPI_TOKEN, pixel=process.env.NEXT_PUBLIC_META_PIXEL_ID;
  if (!token || !pixel) return;
  const email=normalizeEmail(session.customer_details?.email), phone=normalizePhone(session.customer_details?.phone);
  const userData:Record<string,string[]>={}; if(email) userData.em=[sha256(email)!]; if(phone) userData.ph=[sha256(phone)!];
  const payload={data:[{event_name:'Purchase',event_time:Math.floor(Date.now()/1000),action_source:'website',event_source_url:`${process.env.NEXT_PUBLIC_SITE_URL||'https://qyroam.com'}/success`,event_id:`stripe_${session.id}`,user_data:userData,custom_data:{currency:'SGD',value:(session.amount_total||0)/100,order_id:session.id,content_type:session.metadata?.product_type||'pocket_wifi'}}]};
  const response=await fetch(`https://graph.facebook.com/v21.0/${pixel}/events?access_token=${encodeURIComponent(token)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(!response.ok) console.error('meta_capi_error',response.status,await response.text());
}

async function sendHumanFulfilmentEmail(session: Stripe.Checkout.Session) {
  if(session.payment_status!=='paid') return;
  const host=process.env.SMTP_HOST, port=Number(process.env.SMTP_PORT||'587'), secure=process.env.SMTP_SECURE==='true'||port===465, user=process.env.SMTP_USER, pass=process.env.SMTP_PASS, from=process.env.SMTP_FROM||user, to=process.env.ORDER_FULFILMENT_EMAIL||'enquiries@sgsimshop.com';
  if(!host||!user||!pass||!from) throw new Error('SMTP fulfilment email is not configured');
  const productType=session.metadata?.product_type||'pocket_wifi', isEsim=productType==='esim', destination=session.metadata?.country||'', planName=session.metadata?.plan_name||'', start=session.metadata?.start||'', end=session.metadata?.end||'', customer=session.customer_details, amount=((session.amount_total||0)/100).toFixed(2), shipping=session.shipping_details?.address;
  const shippingText=shipping?[shipping.line1,shipping.line2,shipping.city,shipping.state,shipping.postal_code,shipping.country].filter(Boolean).join(', '):'Not applicable / not supplied';
  const subject=`[QY Roam] Paid ${isEsim?'eSIM':'Pocket WiFi'} order — ${destination||planName||session.id}`;
  const text=['A paid QY Roam order requires human fulfilment.','',`Order reference: ${session.id}`,`Product: ${isEsim?'Travel eSIM':'Pocket WiFi'}`,`Destination: ${destination||'-'}`,`Plan: ${planName||'-'}`,`Travel dates: ${start||'-'}${end?` to ${end}`:''}`,`Amount paid: S$${amount}`,`Promo code: ${session.metadata?.promo_code||'-'}`,'',`Customer name: ${customer?.name||'-'}`,`Email: ${customer?.email||'-'}`,`Phone: ${customer?.phone||'-'}`,`Delivery address: ${shippingText}`,'',isEsim?'Action: Please process the eSIM manually and send the QR code / activation instructions to the customer.':'Action: Please prepare and fulfil the Pocket WiFi order according to the travel dates and delivery details.','','Customer support: +65 8032 7183'].join('\n');
  await sendSmtpMail({host,port,secure,user,pass,from,to,subject,text});
}

async function persistSession(session:Stripe.Checkout.Session,eventType:Stripe.Event.Type){
  const supabase=getSupabaseAdmin(); if(!supabase) throw new Error('Order persistence unavailable');
  const paid=session.payment_status==='paid', failed=eventType==='checkout.session.async_payment_failed';
  const existing=await supabase.from('orders').select('fulfilment_status').eq('stripe_session_id',session.id).maybeSingle(); if(existing.error) throw existing.error;
  const current=existing.data?.fulfilment_status, productType=session.metadata?.product_type||'pocket_wifi';
  const defaultPaidStatus=productType==='esim'?'awaiting_fulfilment':'paid';
  const fulfilment=paid?(current&&!['awaiting_payment','payment_failed'].includes(current)?current:defaultPaidStatus):failed?(current&&!['awaiting_payment','payment_failed'].includes(current)?current:'payment_failed'):(current||'awaiting_payment');
  const {error}=await supabase.from('orders').upsert({stripe_session_id:session.id,payment_status:session.payment_status,customer_name:session.customer_details?.name,email:session.customer_details?.email,phone:session.customer_details?.phone,amount_sgd:(session.amount_total||0)/100,product_type:productType,plan_name:session.metadata?.plan_name||null,country:session.metadata?.country,travel_start:session.metadata?.start||null,travel_end:session.metadata?.end||null,fulfilment_status:fulfilment,shipping_address:session.shipping_details?.address||null,updated_at:new Date().toISOString()},{onConflict:'stripe_session_id'}); if(error) throw error;
}

async function claimOnce(supabase:ReturnType<typeof getSupabaseAdmin>, id:string, type:string) {
  if(!supabase) throw new Error('Persistence unavailable');
  const claimed=await supabase.from('stripe_events').insert({event_id:id,event_type:type});
  if(claimed.error?.code==='23505') return false;
  if(claimed.error) throw claimed.error;
  return true;
}

async function deliverFulfilmentNotification(supabase:NonNullable<ReturnType<typeof getSupabaseAdmin>>, session:Stripe.Checkout.Session){
  const existing=await supabase.from('fulfilment_notifications').select('status').eq('stripe_session_id',session.id).maybeSingle();
  if(existing.error) throw existing.error;
  if(existing.data?.status==='sent') return;
  if(!existing.data){
    const created=await supabase.from('fulfilment_notifications').insert({stripe_session_id:session.id,status:'pending'});
    if(created.error?.code!=='23505'&&created.error) throw created.error;
    if(created.error?.code==='23505'){
      const raced=await supabase.from('fulfilment_notifications').select('status').eq('stripe_session_id',session.id).single();
      if(raced.error) throw raced.error;
      if(raced.data?.status==='sent') return;
    }
  }
  const attempt=await supabase.from('fulfilment_notifications').update({status:'sending',last_attempt_at:new Date().toISOString(),last_error:null,updated_at:new Date().toISOString()}).eq('stripe_session_id',session.id).neq('status','sent');
  if(attempt.error) throw attempt.error;
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

export async function POST(req:Request){
  const key=process.env.STRIPE_SECRET_KEY,webhookSecret=process.env.STRIPE_WEBHOOK_SECRET; if(!key||!webhookSecret) return NextResponse.json({error:'Webhook configuration incomplete'},{status:503});
  const stripe=new Stripe(key,{apiVersion:'2024-06-20'}); let event:Stripe.Event;
  try{event=stripe.webhooks.constructEvent(await req.text(),req.headers.get('stripe-signature')||'',webhookSecret);}catch{return NextResponse.json({error:'Invalid signature'},{status:400});}
  if(!['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed'].includes(event.type)) return NextResponse.json({received:true});
  const session=event.data.object as Stripe.Checkout.Session, supabase=getSupabaseAdmin(); if(!supabase) return NextResponse.json({error:'Persistence unavailable'},{status:503});
  const eventClaimId=`stripe:${event.id}`;
  try{
    if(!(await claimOnce(supabase,eventClaimId,event.type))) return NextResponse.json({received:true,duplicate:true});
    await persistSession(session,event.type);
    if(event.type!=='checkout.session.async_payment_failed'&&session.payment_status==='paid'){
      await deliverFulfilmentNotification(supabase,session);
      await sendMetaPurchase(session);
    }
    const completed=await supabase.from('stripe_events').update({processed_at:new Date().toISOString()}).eq('event_id',eventClaimId);if(completed.error)throw completed.error;
  }catch(error){console.error('stripe_webhook_processing_error',error);await supabase.from('stripe_events').delete().eq('event_id',eventClaimId);return NextResponse.json({error:'Processing failed'},{status:500});}
  return NextResponse.json({received:true});
}
