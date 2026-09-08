import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { createStripeClient } from '../../../lib/stripeClient';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { parseExactIsoDate } from '@/lib/checkoutValidation';
import { operationalConfig } from '@/lib/operationalConfig';
import { operationalIsoDateAfter } from '@/lib/operationalDate';
import { validQyRoamProvenance } from '@/lib/orderProvenance';
import {
  hasRequiredFulfilmentEmailConfig,
  hasRequiredPaymentSchema,
  hasRequiredStripeCheckoutConfig,
  hasRequiredStripeWebhookConfig,
} from '@/lib/productionReadiness';
import { CHECKOUT_HOLD_WINDOW_SECONDS } from '@/lib/checkoutExpiry';

export const dynamic = 'force-dynamic';

// Availability is a purchase promise, rather than a rough stock estimate.
// Keep its unavailable response identical across prerequisite failures so the
// endpoint neither leaks configuration detail nor tells a traveller to begin
// a checkout that will be rejected before Stripe can create a payment page.
function unavailableAvailability() {
  return NextResponse.json({ available: false, remaining: 0, inventoryMode: 'unavailable', error: 'Live availability is temporarily unavailable. Please try again shortly or contact +65 8032 7183.' }, {
    status: 503,
    headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' },
  });
}

async function activeStripeHolds(stripe: Stripe, start: string, end: string) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff = nowSeconds - CHECKOUT_HOLD_WINDOW_SECONDS;
  let startingAfter: string | undefined;
  let holds = 0;
  const requestIds = new Set<string>();
  // Every still-valid QY Roam Checkout Session is an inventory hold. Do not cap
  // pagination within the hold window: an arbitrary page limit would report
  // stock that is already held when checkout volume exceeds that limit. QY Roam
  // creates short-lived sessions, so ask Stripe to omit historical open sessions
  // instead of scanning an account's entire Checkout history on every search.
  for (;;) {
    const sessions = await stripe.checkout.sessions.list({ status: 'open', limit: 100, created: { gte: cutoff }, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    for (const session of sessions.data) {
      // Session status is eventually consistent around expiry. Capacity must
      // follow the Checkout Session's actual expiry, not only its age.
      // Inventory holds must be as trustworthy as fulfilment. A source marker
      // alone is writable on manually-created Checkout Sessions in a shared
      // Stripe account and must not be able to make routers appear sold out.
      if (session.created < cutoff || !session.expires_at || session.expires_at <= nowSeconds || session.metadata?.source !== 'qyroam.com' || !validQyRoamProvenance(session.id, session.metadata)) continue;
      // Only explicitly identified router sessions can consume router stock.
      // Never infer Pocket WiFi from the absence of a product marker: a valid
      // signed session for another QY Roam flow must not make availability
      // appear lower than it is.
      if (session.metadata?.product_type !== 'pocket_wifi') continue;
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
  const [orders, reservations, saleableItems] = await Promise.all([
    supabase.from('orders').select('id', { count: 'exact', head: true })
      .eq('product_type', 'pocket_wifi')
      .eq('payment_status', 'paid')
      .lte('travel_start', end)
      .gte('travel_end', start)
      // Dispatch atomically removes an assigned router from quantity_on_hand.
      // The saleable-inventory query below already reflects that hand-off, so
      // excluding it here avoids double-counting. Keep legacy dispatched rows
      // with no assigned stock item committed: there is no evidence their
      // inventory was decremented. This mirrors the reservation RPC.
      .or('dispatched_at.is.null,inventory_item_id.is.null')
      .or('fulfilment_status.not.in.(cancelled,payment_failed,returned,closed),and(fulfilment_status.eq.cancelled,dispatched_at.not.is.null,returned_at.is.null,inventory_item_id.is.null)'),
    supabase.from('checkout_reservations').select('checkout_request_id')
      .gt('expires_at', now)
      .lte('travel_start', end)
      .gte('travel_end', start),
    // The configured fleet size is a safety cap, not evidence that a router
    // is physically dispatchable. Keep the public availability promise tied
    // to the same available-status, on-hand inventory pool used at dispatch.
    supabase.from('inventory_items').select('quantity_on_hand')
      .eq('product_type', 'pocket_wifi')
      .eq('status', 'available')
      .gt('quantity_on_hand', 0),
  ]);
  if (orders.error) throw orders.error;
  if (reservations.error) throw reservations.error;
  if (saleableItems.error) throw saleableItems.error;

  // A checkout session normally has a matching reservation. Count that session
  // once via Stripe, then add only reservations that have no open session yet.
  const unlinkedReservations = (reservations.data || []).filter(
    ({ checkout_request_id }) => !stripeHoldRequestIds.has(checkout_request_id),
  ).length;
  return {
    committed: (orders.count || 0) + unlinkedReservations,
    saleableInventory: (saleableItems.data || []).reduce((total, item) => total + Number(item.quantity_on_hand || 0), 0),
  };
}

export async function GET(req: NextRequest) {
  const start = parseExactIsoDate(req.nextUrl.searchParams.get('start'));
  const end = parseExactIsoDate(req.nextUrl.searchParams.get('end'));
  if (!start || !end || end < start) return NextResponse.json({ available: false, error: 'Valid start and end dates are required.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });

  const config = operationalConfig();
  if (!config) return NextResponse.json({ available: false, remaining: 0, inventoryMode: 'unavailable', error: 'Live availability is temporarily unavailable. Please try again shortly or contact +65 8032 7183.' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' } });
  const minLeadDays = config.minDeliveryLeadDays;
  const earliest = operationalIsoDateAfter(minLeadDays);
  const rentalDays = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
  if (start.toISOString().slice(0, 10) < earliest) return NextResponse.json({ available: false, error: `Please book at least ${minLeadDays} day${minLeadDays === 1 ? '' : 's'} before departure.` }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  if (rentalDays < 1 || rentalDays > 90) return NextResponse.json({ available: false, error: 'Bookings must be between 1 and 90 days.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });

  // Availability is a promise that a customer can proceed to payment. Match
  // every non-request-specific checkout prerequisite before calculating stock:
  // missing webhook, fulfilment, or signing configuration used to leave the
  // product shown as available even though checkout had to refuse the order.
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const orderIntegritySecret = process.env.ORDER_INTEGRITY_SECRET;
  if (!stripeKey || !hasRequiredStripeCheckoutConfig() || !orderIntegritySecret || orderIntegritySecret.length < 32 ||
    !hasRequiredStripeWebhookConfig() || !hasRequiredFulfilmentEmailConfig() || !getSupabaseAdmin()) {
    return unavailableAvailability();
  }

  // The same cached, fail-closed post-payment schema check prevents an
  // incomplete migration from showing a purchasable router only for checkout
  // to reject it moments later.
  if (!await hasRequiredPaymentSchema()) {
    return unavailableAvailability();
  }

  const inventory = config.pocketWifiInventory;

  const from = start.toISOString().slice(0, 10);
  const to = end.toISOString().slice(0, 10);
  try {
    const stripeHolds = await activeStripeHolds(createStripeClient(stripeKey), from, to);
    const inventoryState = await committedInventory(from, to, stripeHolds.requestIds);
    const committed = inventoryState.committed + stripeHolds.holds;
    // This must mirror qy_reserve_pocket_wifi: the lower of the configured
    // operating cap and current saleable stock is the only capacity we can
    // truthfully show to a customer.
    const effectiveInventory = Math.min(inventory, inventoryState.saleableInventory);
    const remaining = Math.max(0, effectiveInventory - committed);
    return NextResponse.json({ available: remaining > 0, remaining, inventoryMode: 'live', temporaryHolds: stripeHolds.holds }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('availability check failed', error);
    return NextResponse.json({ available: false, remaining: 0, inventoryMode: 'unavailable', error: 'Live availability is temporarily unavailable. Please try again shortly or contact +65 8032 7183.' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' } });
  }
}
