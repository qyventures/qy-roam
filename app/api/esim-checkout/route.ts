import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { ESIM_PROMO, getEsimPlan } from '../../../lib/esimPlans';

export const runtime = 'nodejs';

function siteOrigin(req: Request) {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) {
    try { return new URL(configured).origin; }
    catch { throw new Error('Invalid NEXT_PUBLIC_SITE_URL'); }
  }
  if (process.env.NODE_ENV === 'production') throw new Error('NEXT_PUBLIC_SITE_URL is required in production');
  return new URL(req.url).origin;
}

export async function POST(req: Request) {
  try {
    if (!(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
      return NextResponse.json({ error: 'Expected JSON request.' }, { status: 415 });
    }

    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return NextResponse.json({ error: 'Payment configuration incomplete.' }, { status: 503 });

    const body = await req.json() as Record<string, unknown>;
    const plan = getEsimPlan(body.planId);
    if (!plan) return NextResponse.json({ error: 'Please select a valid eSIM plan.' }, { status: 400 });

    const promoCode = String(body.promoCode || '').trim().toUpperCase();
    if (promoCode && promoCode !== ESIM_PROMO.code) {
      return NextResponse.json({ error: 'Invalid eSIM promo code.' }, { status: 400 });
    }

    const stripe = new Stripe(key, { apiVersion: '2024-06-20' });
    const origin = siteOrigin(req);
    const amount = Math.max(50, Math.round(plan.qyPriceSgd * 100));

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'sgd',
          unit_amount: amount,
          product_data: {
            name: `QY Roam eSIM — ${plan.destination}`,
            description: `${plan.days} days · ${plan.data} · ${ESIM_PROMO.percent}% launch discount applied`
          }
        }
      }],
      billing_address_collection: 'required',
      phone_number_collection: { enabled: true },
      customer_creation: 'always',
      // Digital eSIM fulfilment must never request or depend on courier/shipping data.
      // product_type is set explicitly below so the webhook cannot consume router stock.
      success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/esim?checkout=cancelled`,
      metadata: {
        product_type: 'esim',
        plan_id: plan.id,
        plan_name: `${plan.destination} · ${plan.days} days`,
        country: plan.destination,
        promo_code: ESIM_PROMO.code,
        benchmark_price_sgd: plan.benchmarkPriceSgd.toFixed(2),
        promo_discount_percent: String(ESIM_PROMO.percent),
        source: 'qyroam.com',
        measurement_consent: body.measurementConsent === true ? 'accepted' : 'essential'
      },
      consent_collection: { terms_of_service: 'required' }
    });

    return NextResponse.json({ url: session.url }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('esim_checkout_error', error);
    return NextResponse.json({ error: 'Unable to start eSIM checkout.' }, { status: 500 });
  }
}
