import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import crypto from 'crypto';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';

function sha256(value?: string | null) {
  return value ? crypto.createHash('sha256').update(value).digest('hex') : undefined;
}

function normalizeEmail(value?: string | null) {
  return value?.trim().toLowerCase();
}

function normalizePhone(value?: string | null) {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, '');
  return digits || undefined;
}

async function sendMetaPurchase(session: Stripe.Checkout.Session) {
  if (session.payment_status !== 'paid' || session.metadata?.measurement_consent !== 'accepted') return;
  const token = process.env.META_CAPI_TOKEN;
  const pixel = process.env.NEXT_PUBLIC_META_PIXEL_ID;
  if (!token || !pixel) return;

  const email = normalizeEmail(session.customer_details?.email);
  const phone = normalizePhone(session.customer_details?.phone);
  const userData: Record<string, string[]> = {};
  if (email) userData.em = [sha256(email)!];
  if (phone) userData.ph = [sha256(phone)!];

  const payload = { data: [{
    event_name: 'Purchase', event_time: Math.floor(Date.now()/1000), action_source: 'website',
    event_source_url: `${process.env.NEXT_PUBLIC_SITE_URL || 'https://qyroam.com'}/success`,
    event_id: `stripe_${session.id}`,
    user_data: userData,
    custom_data: { currency: 'SGD', value: (session.amount_total || 0)/100, order_id: session.id },
  }] };
  const response = await fetch(`https://graph.facebook.com/v21.0/${pixel}/events?access_token=${encodeURIComponent(token)}`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)
  });
  if (!response.ok) console.error('meta_capi_error', response.status, await response.text());
}

async function persistSession(session: Stripe.Checkout.Session, eventType: Stripe.Event.Type) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error('Order persistence unavailable');
  const paid = session.payment_status === 'paid';
  const failed = eventType === 'checkout.session.async_payment_failed';
  const existing = await supabase.from('orders').select('fulfilment_status').eq('stripe_session_id', session.id).maybeSingle();
  if (existing.error) throw existing.error;
  const current = existing.data?.fulfilment_status;
  // Never regress an order already being fulfilled when Stripe retries a webhook.
  const fulfilment = paid
    ? (current && !['awaiting_payment','payment_failed'].includes(current) ? current : 'paid')
    : failed
      ? (current && !['awaiting_payment','payment_failed'].includes(current) ? current : 'payment_failed')
      : (current || 'awaiting_payment');
  const { error } = await supabase.from('orders').upsert({
    stripe_session_id:session.id, payment_status:session.payment_status,
    customer_name:session.customer_details?.name, email:session.customer_details?.email, phone:session.customer_details?.phone,
    amount_sgd:(session.amount_total||0)/100, country:session.metadata?.country,
    travel_start:session.metadata?.start||null, travel_end:session.metadata?.end||null,
    fulfilment_status:fulfilment, shipping_address:session.shipping_details?.address||null, updated_at:new Date().toISOString(),
  }, {onConflict:'stripe_session_id'});
  if (error) throw error;
}

export async function POST(req: Request) {
  const key=process.env.STRIPE_SECRET_KEY, webhookSecret=process.env.STRIPE_WEBHOOK_SECRET;
  if (!key || !webhookSecret) return NextResponse.json({error:'Webhook configuration incomplete'},{status:503});
  const stripe=new Stripe(key,{apiVersion:'2024-06-20'});
  let event:Stripe.Event;
  try { event=stripe.webhooks.constructEvent(await req.text(),req.headers.get('stripe-signature')||'',webhookSecret); }
  catch { return NextResponse.json({error:'Invalid signature'},{status:400}); }

  if (!['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed'].includes(event.type)) return NextResponse.json({received:true});
  const session=event.data.object as Stripe.Checkout.Session;
  const supabase=getSupabaseAdmin();
  if (!supabase) return NextResponse.json({error:'Persistence unavailable'},{status:503});

  const claimed=await supabase.from('stripe_events').insert({event_id:event.id,event_type:event.type});
  if (claimed.error?.code === '23505') return NextResponse.json({received:true,duplicate:true});
  if (claimed.error) { console.error('stripe_event_claim_error',claimed.error); return NextResponse.json({error:'Persistence unavailable'},{status:500}); }

  try {
    await persistSession(session, event.type);
    if (event.type !== 'checkout.session.async_payment_failed') await sendMetaPurchase(session);
    const completed = await supabase.from('stripe_events').update({processed_at:new Date().toISOString()}).eq('event_id',event.id);
    if (completed.error) throw completed.error;
  } catch (error) {
    console.error('stripe_webhook_processing_error',error);
    await supabase.from('stripe_events').delete().eq('event_id',event.id);
    return NextResponse.json({error:'Processing failed'},{status:500});
  }
  return NextResponse.json({received:true});
}
