import { NextResponse } from 'next/server';
import Stripe from 'stripe';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return NextResponse.json({ error: 'Payment configuration incomplete.' }, { status: 503 });

    const stripe = new Stripe(key, { apiVersion: '2024-06-20' });
    const body = await req.json();
    const country = String(body.country || 'Travel destination');
    const start = String(body.start || '');
    const end = String(body.end || '');
    const days = Math.max(1, Number(body.days || 1));
    const daily = Math.max(0, Number(body.daily || 0));
    const rentalAmount = Math.max(1000, Math.round(daily * days * 100));
    const courierFee = Math.max(0, Math.round(Number(process.env.COURIER_FEE_SGD || '0') * 100));

    const origin = process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin;
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      {
        quantity: 1,
        price_data: {
          currency: 'sgd',
          unit_amount: rentalAmount,
          product_data: {
            name: `QY Roam Pocket WiFi — ${country}`,
            description: `${start} to ${end} · ${days} day${days === 1 ? '' : 's'}`
          }
        }
      }
    ];

    if (courierFee > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: 'sgd',
          unit_amount: courierFee,
          product_data: { name: 'Singapore courier delivery & return handling' }
        }
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      automatic_payment_methods: { enabled: true },
      billing_address_collection: 'required',
      shipping_address_collection: { allowed_countries: ['SG'] },
      phone_number_collection: { enabled: true },
      customer_creation: 'always',
      success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?checkout=cancelled`,
      metadata: { country, start, end, days: String(days), source: 'qyroam.com' },
      consent_collection: { terms_of_service: 'required' }
    });

    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error('checkout_error', error);
    return NextResponse.json({ error: 'Unable to start checkout.' }, { status: 500 });
  }
}
