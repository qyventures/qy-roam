import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import crypto from 'crypto';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
export const runtime='nodejs';
function sha256(value?:string|null){return value?crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex'):undefined;}
async function sendMetaPurchase(session:Stripe.Checkout.Session){
 if(session.metadata?.measurement_consent!=='accepted') return;
 const token=process.env.META_CAPI_TOKEN,pixel=process.env.NEXT_PUBLIC_META_PIXEL_ID;if(!token||!pixel)return;
 const email=session.customer_details?.email,phone=session.customer_details?.phone,value=(session.amount_total||0)/100,eventId=`stripe_${session.id}`;
 const payload={data:[{event_name:'Purchase',event_time:Math.floor(Date.now()/1000),action_source:'website',event_source_url:`${process.env.NEXT_PUBLIC_SITE_URL||'https://qyroam.com'}/success`,event_id:eventId,user_data:{em:email?[sha256(email)]:undefined,ph:phone?[sha256(phone)]:undefined},custom_data:{currency:'SGD',value,order_id:session.id}}]};
 const response=await fetch(`https://graph.facebook.com/v21.0/${pixel}/events?access_token=${encodeURIComponent(token)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
 if(!response.ok) console.error('meta_capi_error',response.status,await response.text());
}
export async function POST(req:Request){
 const key=process.env.STRIPE_SECRET_KEY,webhookSecret=process.env.STRIPE_WEBHOOK_SECRET;if(!key||!webhookSecret)return NextResponse.json({error:'Webhook configuration incomplete'},{status:503});
 const stripe=new Stripe(key,{apiVersion:'2024-06-20'}),signature=req.headers.get('stripe-signature'),raw=await req.text();let event:Stripe.Event;
 try{event=stripe.webhooks.constructEvent(raw,signature||'',webhookSecret);}catch{return NextResponse.json({error:'Invalid signature'},{status:400});}
 if(event.type==='checkout.session.completed'){
  const session=event.data.object as Stripe.Checkout.Session,supabase=getSupabaseAdmin();
  if(supabase){const {error}=await supabase.from('orders').upsert({stripe_session_id:session.id,payment_status:session.payment_status,customer_name:session.customer_details?.name,email:session.customer_details?.email,phone:session.customer_details?.phone,amount_sgd:(session.amount_total||0)/100,country:session.metadata?.country,travel_start:session.metadata?.start||null,travel_end:session.metadata?.end||null,fulfilment_status:'paid',shipping_address:session.shipping_details?.address||null,updated_at:new Date().toISOString()},{onConflict:'stripe_session_id'});if(error)console.error('order_upsert_error',error);}
  await sendMetaPurchase(session);
 }
 return NextResponse.json({received:true});
}
