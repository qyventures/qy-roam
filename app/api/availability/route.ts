import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { parseExactIsoDate } from '@/lib/checkoutValidation';
import { operationalConfig } from '@/lib/operationalConfig';

export const dynamic = 'force-dynamic';

const HOLD_MINUTES = 30;

async function activeStripeHolds(stripe: Stripe, start: string, end: string) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff = nowSeconds - HOLD_MINUTES * 60;
  let startingAfter: string | undefined;
  let holds = 0;
  const requestIds = new Set<string>();
  // Every still-valid QY Roam Checkout Session is an inventory hold. Do not cap
  // pagination: an arbitrary page limit would report stock that is already held
  // when checkout volume exceeds that limit.
  for (;;) {
    const sessions = await stripe.checkout.sessions.list({ status: 'open', limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    for (const session of sessions.data) {
      // Session status is eventually consistent around expiry. Capacity must
      // follow the Checkout Session's actual expiry, not only its age.
      if (session.created < cutoff || !session.expires_at || session.expires_at <= nowSeconds || session.metadata?.source !== 'qyroam.com') continue;
      if (session.metadata?.product_type && session.metadata.product_type !== 'pocket_wifi') continue;
      const holdStart = session.metadata?.start;
      const holdEnd = session.metadata?.end;
      if (holdStart && holdEnd && holdStart <= end && holdEnd >= start) {
        holds += 1;
        const requestId = session.metadata?.checkout_request_id;
        if (requestId) requestIds.add(requestId);
      }
    }
    if (!sessions.has_more || sessions.data.length === 0) break;
    startingAfter = sessions.data[sessions.data.length - 1].id;
  }
  return { holds, requestIds };
}

async function committedInventory(start: string, end: string, stripeHoldRequestIds: Set<string>) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error('Supabase is not configured');

  const now = new Date().toISOString();
  const [orders, reservations] = await Promise.all([
    supabase.from('orders').select('id', { count: 'exact', head: true })
      .eq('product_type', 'pocket_wifi')
      .eq('payment_status', 'paid')
      .lte('travel_start', end)
      .gte('travel_end', start)
      // Keep legacy post-dispatch cancellations committed until a physical
      // return is recorded. New lifecycle rules prevent that transition, but
      // this protects capacity while older orders are still active. A returned
      // router is deliberately excluded: physical receipt, not later admin
      // closure, is the point at which it becomes rentable again.
      .or('fulfilment_status.not.in.(cancelled,payment_failed,returned,closed),and(fulfilment_status.eq.cancelled,dispatched_at.not.is.null,returned_at.is.null)'),
    supabase.from('checkout_reservations').select('checkout_request_id')
      .gt('expires_at', now)
      .lte('travel_start', end)
      .gte('travel_end', start),
  ]);
  if (orders.error) throw orders.error;
  if (reservations.error) throw reservations.error;

  // A checkout session normally has a matching reservation. Count that session
  // once via Stripe, then add only reservations that have no open session yet.
  const unlinkedReservations = (reservations.data || []).filter(
    ({ checkout_request_id }) => !stripeHoldRequestIds.has(checkout_request_id),
  ).length;
  return (orders.count || 0) + unlinkedReservations;
}

export async function GET(req: NextRequest) {
  const start = parseExactIsoDate(req.nextUrl.searchParams.get('start'));
  const end = parseExactIsoDate(req.nextUrl.searchParams.get('end'));
  if (!start || !end || end < start) return NextResponse.json({ available: false, error: 'Valid start and end dates are required.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });

  const now = new Date(); now.setUTCHours(0, 0, 0, 0);
  const config = operationalConfig();
  if (!config) return NextResponse.json({ available: false, remaining: 0, inventoryMode: 'unavailable', error: 'Live availability is temporarily unavailable. Please try again shortly or contact +65 8032 7183.' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' } });
  const minLeadDays = config.minDeliveryLeadDays;
  const earliest = new Date(now); earliest.setUTCDate(earliest.getUTCDate() + minLeadDays);
  const rentalDays = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
  if (start < earliest) return NextResponse.json({ available: false, error: `Please book at least ${minLeadDays} day${minLeadDays === 1 ? '' : 's'} before departure.` }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  if (rentalDays < 1 || rentalDays > 90) return NextResponse.json({ available: false, error: 'Bookings must be between 1 and 90 days.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });

  const inventory = config.pocketWifiInventory;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey || !getSupabaseAdmin()) return NextResponse.json({ available: false, remaining: 0, inventoryMode: 'unavailable', error: 'Live availability is not configured yet. Please try again shortly or contact +65 8032 7183.' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' } });

  const from = start.toISOString().slice(0, 10);
  const to = end.toISOString().slice(0, 10);
  try {
    const stripeHolds = await activeStripeHolds(new Stripe(stripeKey, { apiVersion: '2024-06-20' }), from, to);
    const booked = await committedInventory(from, to, stripeHolds.requestIds);
    const committed = booked + stripeHolds.holds;
    const remaining = Math.max(0, inventory - committed);
    return NextResponse.json({ available: remaining > 0, remaining, inventoryMode: 'live', temporaryHolds: stripeHolds.holds }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('availability check failed', error);
    return NextResponse.json({ available: false, remaining: 0, inventoryMode: 'unavailable', error: 'Live availability is temporarily unavailable. Please try again shortly or contact +65 8032 7183.' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' } });
  }
}
