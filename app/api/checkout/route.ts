import { NextResponse } from 'next/server';
import Stripe from 'stripe';

export const runtime = 'nodejs';

const DAILY_RATES: Record<string, number> = {
  Japan: 1.84,
  'South Korea': 1.84,
  Thailand: 1.84,
  Malaysia: 1.84,
  Indonesia: 1.84,
  Taiwan: 1.84,
  Vietnam: 1.84,
  Australia: 3.78,
  'United States': 3.78,
  'United Kingdom': 3.78
};

function parseDate(value: unknown) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function POST(req: Request) {
  try {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return NextResponse.json({ error: 'Payment configuration incomplete.' }, { status: 503 });

    const body = await req.json();
    const country = String(body.country || '');
    const daily = DAILY_RATES[country];
    const startDate = parseDate(body.start);
    const endDate = parseDate(body.end);
    if (!daily || !startDate || !endDate || endDate < startDate) {
      return NextResponse.json({ error: 'Please select a valid destination and travel period.' }, { status: 400 });
    }

    const days = Math.floor((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
    if (days < 1 || days > 90) {
      return NextResponse.json({ error: 'Bookings must be between 1 and 90 days.' }, { status: 400 });
    }

    const start = String(body.start);
    const end = String(body.end);
    const rentalAmount = Math.max(1000, Math.round(daily * days * 100));
    const courierFee = Math.max(0, Math.round(Number(process.env.COURIER_FEE_SGD || '0') * 100));
    const stripe = new Stripe(key, { apiVersion: '2024-06-20' });
    const origin = process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin;

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [{
      quantity: 1,
      price_data: {
        currency: 'sgd',
        unit_amount: rentalAmount,
        product_data: {
          name: `QY Roam Pocket WiFi — ${country}`,
          description: `${start} to ${end} · ${days} day${days === 1 ? '' : 's'}`
        }
      }
    }];

    if (courierFee > 0) lineItems.push({
      quantity: 1,
      price_data: {
        currency: 'sgd',
        unit_amount: courierFee,
        product_data: { name: 'Singapore courier delivery & return handling' }
      }
    });

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
      metadata: { country, start, end, days: String(days), daily_rate_sgd: daily.toFixed(2), source: 'qyroam.com' },
      consent_collection: { terms_of_service: 'required' }
    });

    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error('checkout_error', error);
    return NextResponse.json({ error: 'Unable to start checkout.' }, { status: 500 });
  }
}
