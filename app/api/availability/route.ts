import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';

export const dynamic = 'force-dynamic';

const HOLD_MINUTES = 30;
const QY_OPS_URL = 'https://cqyhqbzrgkckalbowhrx.supabase.co';
const QY_OPS_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNxeWhxYnpyZ2tja2FsYm93aHJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4OTI0NDIsImV4cCI6MjEwMzQ2ODQ0Mn0.rzPO2wUxnGc37RTMdtsc9Mo9UE5F5RcIkOJkBke6dR4';

function parseDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function activeStripeHolds(stripe: Stripe, start: string, end: string) {
  const cutoff = Math.floor(Date.now() / 1000) - HOLD_MINUTES * 60;
  let startingAfter: string | undefined;
  let holds = 0;
  for (let page = 0; page < 5; page += 1) {
    const sessions = await stripe.checkout.sessions.list({ status: 'open', limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    for (const session of sessions.data) {
      if (session.created < cutoff || session.metadata?.source !== 'qyroam.com') continue;
      if (session.metadata?.product_type && session.metadata.product_type !== 'pocket_wifi') continue;
      const holdStart = session.metadata?.start;
      const holdEnd = session.metadata?.end;
      if (holdStart && holdEnd && holdStart <= end && holdEnd >= start) holds += 1;
    }
    if (!sessions.has_more || sessions.data.length === 0) break;
    startingAfter = sessions.data[sessions.data.length - 1].id;
  }
  return holds;
}

async function committedOrders(start: string, end: string) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supabaseUrl && serviceKey) {
    const url = new URL('/rest/v1/orders', supabaseUrl);
    url.searchParams.set('select', 'id');
    url.searchParams.set('product_type', 'eq.pocket_wifi');
    url.searchParams.set('payment_status', 'eq.paid');
    url.searchParams.set('travel_start', `lte.${end}`);
    url.searchParams.set('travel_end', `gte.${start}`);
    url.searchParams.set('fulfilment_status', 'not.in.(cancelled,payment_failed,closed)');
    const res = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }, cache: 'no-store' });
    if (!res.ok) throw new Error(`Supabase ${res.status}`);
    return ((await res.json()) as unknown[]).length;
  }

  const edge = new URL('/functions/v1/qy-roam-availability', QY_OPS_URL);
  edge.searchParams.set('start', start);
  edge.searchParams.set('end', end);
  const res = await fetch(edge, { headers: { apikey: QY_OPS_ANON, Authorization: `Bearer ${QY_OPS_ANON}` }, cache: 'no-store' });
  if (!res.ok) throw new Error(`QY Ops availability ${res.status}`);
  const body = (await res.json()) as { committed?: number };
  return Math.max(0, Number(body.committed || 0));
}

export async function GET(req: NextRequest) {
  const start = parseDate(req.nextUrl.searchParams.get('start'));
  const end = parseDate(req.nextUrl.searchParams.get('end'));
  if (!start || !end || end < start) return NextResponse.json({ available: false, error: 'Valid start and end dates are required.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });

  const now = new Date(); now.setUTCHours(0, 0, 0, 0);
  const minLeadDays = Math.max(0, Number.parseInt(process.env.MIN_DELIVERY_LEAD_DAYS || '2', 10) || 0);
  const earliest = new Date(now); earliest.setUTCDate(earliest.getUTCDate() + minLeadDays);
  const rentalDays = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
  if (start < earliest) return NextResponse.json({ available: false, error: `Please book at least ${minLeadDays} day${minLeadDays === 1 ? '' : 's'} before departure.` }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  if (rentalDays < 1 || rentalDays > 90) return NextResponse.json({ available: false, error: 'Bookings must be between 1 and 90 days.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });

  const inventory = Math.max(0, Number(process.env.POCKET_WIFI_INVENTORY || '10') || 0);
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return NextResponse.json({ available: false, remaining: 0, inventoryMode: 'unavailable', error: 'Live availability is not configured yet. Please try again shortly or contact +65 8032 7183.' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' } });

  const from = start.toISOString().slice(0, 10);
  const to = end.toISOString().slice(0, 10);
  try {
    const [booked, holds] = await Promise.all([committedOrders(from, to), activeStripeHolds(new Stripe(stripeKey, { apiVersion: '2024-06-20' }), from, to)]);
    const committed = booked + holds;
    const remaining = Math.max(0, inventory - committed);
    return NextResponse.json({ available: remaining > 0, remaining, inventoryMode: 'live', temporaryHolds: holds }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('availability check failed', error);
    return NextResponse.json({ available: false, remaining: 0, inventoryMode: 'unavailable', error: 'Live availability is temporarily unavailable. Please try again shortly or contact +65 8032 7183.' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' } });
  }
}
