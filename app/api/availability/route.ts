import { NextRequest, NextResponse as FrameworkNextResponse } from 'next/server';
import type Stripe from 'stripe';
import { createStripeClient } from '../../../lib/stripeClient';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { parseExactIsoDate } from '@/lib/checkoutValidation';
import { operationalConfig } from '@/lib/operationalConfig';
import { operationalIsoDateAfter } from '@/lib/operationalDate';
import { hasOrderIntegritySigningConfig } from '@/lib/orderProvenance';
import {
  hasRequiredFulfilmentEmailConfig,
  hasRequiredPaymentSchema,
  hasRequiredPocketWifiFulfilmentSchema,
  hasRequiredStripeCheckoutConfig,
  hasRequiredStripeWebhookConfig,
} from '@/lib/productionReadiness';
import { availabilityAttemptLimited, availabilityGloballyLimited } from '@/lib/checkoutRateLimit';
import { tryAcquireAvailabilityConcurrency } from '@/lib/availabilityConcurrency';
import { scanActivePocketWifiStripeHolds } from '@/lib/pocketWifiStripeHolds';
import { MAX_POCKET_WIFI_RENTAL_DAYS, pocketWifiRentalDays } from '@/lib/pocketWifiRentalPeriod';
import { exactRpcRow } from '@/lib/exactRpcRow';

export const dynamic = 'force-dynamic';

// Every response from this route is a live inventory/date promise. Make its
// non-cacheable contract structural so a newly added validation, overload, or
// failure branch cannot leave a stale positive result (or transient outage)
// in a browser or intermediary cache.
const NextResponse = {
  json(body: unknown, init: ResponseInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Cache-Control', 'no-store');
    return FrameworkNextResponse.json(body, { ...init, headers });
  },
};

// A live availability lookup performs a Stripe hold scan and an atomic database
// snapshot. Keep ordinary date-picker retries responsive while preventing the
// public endpoint from becoming an unbounded provider-work amplifier. This is
// deliberately separate from the stricter checkout limiter because checking
// a date range is safe to repeat a little more often than opening payment.
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

async function activeStripeHolds(stripe: Stripe, stripeKey: string, start: string, end: string) {
  let holds = 0;
  const requestIds = new Set<string>();
  await scanActivePocketWifiStripeHolds(stripe, stripeKey, ({ session, start: holdStart, end: holdEnd }) => {
      if (holdStart <= end && holdEnd >= start) {
        holds += 1;
        const requestId = session.metadata?.checkout_request_id;
        if (requestId) requestIds.add(requestId);
      }
  });
  return { holds, requestIds };
}

async function committedInventory(start: string, end: string, stripeHoldRequestIds: Set<string>, configuredInventory: number) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error('Supabase is not configured');
  const snapshot = await supabase.rpc('qy_pocket_wifi_availability_snapshot', {
    p_travel_start: start,
    p_travel_end: end,
    p_inventory: configuredInventory,
    p_stripe_hold_request_ids: [...stripeHoldRequestIds],
  });
  if (snapshot.error) throw snapshot.error;
  // This SECURITY DEFINER RPC owns the atomic stock promise and is defined to
  // return exactly one row. Never turn an empty or multi-row response caused
  // by schema/PostgREST drift into a plausible availability result by taking
  // its first row; checkout must fail closed until the contract is restored.
  const row = exactRpcRow(snapshot.data);
  const committed = Number(row?.committed);
  const saleableInventory = Number(row?.saleable_inventory);
  if (!Number.isSafeInteger(committed) || committed < 0 ||
    !Number.isSafeInteger(saleableInventory) || saleableInventory < 0 || saleableInventory > configuredInventory) {
    throw new Error('Pocket WiFi availability snapshot is invalid');
  }
  return { committed, saleableInventory };
}

export async function GET(req: NextRequest) {
  let releaseAvailability: (() => void) | null = null;
  try {
  // Apply the bounded per-client ingress limit before parsing any attacker-
  // controlled query values. Malformed dates are cheap and must never spend
  // the shared provider-work budget below, but returning before this guard
  // would also make them completely unthrottled and leave this public route
  // available as an avoidable CPU/response amplifier.
  if (availabilityAttemptLimited(req)) {
    return NextResponse.json({ available: false, error: 'Too many availability checks. Please try again shortly.' }, {
      status: 429,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' },
    });
  }
  // A repeated date key is ambiguous: URLSearchParams#get silently selects
  // the first value, while callers, proxies, or future client code may select
  // the last. Availability is a purchase promise used immediately before
  // checkout, so never quote stock for a range whose wire representation has
  // more than one interpretation. This also keeps cheap malformed requests
  // ahead of the process-wide Stripe/Supabase work budget below.
  const startValues = req.nextUrl.searchParams.getAll('start');
  const endValues = req.nextUrl.searchParams.getAll('end');
  const start = startValues.length === 1 ? parseExactIsoDate(startValues[0]) : null;
  const end = endValues.length === 1 ? parseExactIsoDate(endValues[0]) : null;
  if (!start || !end || end < start) return NextResponse.json({ available: false, error: 'Valid start and end dates are required.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });

  const config = operationalConfig();
  if (!config) return NextResponse.json({ available: false, remaining: 0, inventoryMode: 'unavailable', error: 'Live availability is temporarily unavailable. Please try again shortly or contact +65 8032 7183.' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' } });
  const minLeadDays = config.minDeliveryLeadDays;
  const earliest = operationalIsoDateAfter(minLeadDays);
  const rentalDays = pocketWifiRentalDays(start, end);
  // These two values are public booking terms rather than secrets. Return
  // them even for an invalid date request so a browser built with an older
  // default can immediately correct its picker after operations changes a
  // delivery lead time. The amount itself is still calculated exclusively by
  // the checkout route.
  const bookingTerms = {
    minDeliveryLeadDays: minLeadDays,
    courierFeeSgd: config.courierFeeCents / 100,
  };
  if (start.toISOString().slice(0, 10) < earliest) return NextResponse.json({ available: false, ...bookingTerms, error: `Please book at least ${minLeadDays} day${minLeadDays === 1 ? '' : 's'} before departure.` }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  if (rentalDays < 1 || rentalDays > MAX_POCKET_WIFI_RENTAL_DAYS) return NextResponse.json({ available: false, ...bookingTerms, error: `Bookings must be between 1 and ${MAX_POCKET_WIFI_RENTAL_DAYS} days.` }, { status: 400, headers: { 'Cache-Control': 'no-store' } });

  // Only a currently bookable range can proceed to configuration, schema,
  // Stripe, or Supabase checks. Count that provider-capable request against
  // the allocation-free shared ceiling so cheap rejected ranges cannot deny
  // live availability to all shoppers on this process.
  if (availabilityGloballyLimited()) {
    return NextResponse.json({ available: false, error: 'Too many availability checks. Please try again shortly.' }, {
      status: 429,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' },
    });
  }

  // Rate limiting bounds starts over time, but slow Stripe or Supabase calls
  // can still overlap. Do not queue excess live inventory promises in this
  // process: the browser can retry this read-only request without creating a
  // payment capability or changing stock.
  releaseAvailability = tryAcquireAvailabilityConcurrency();
  if (!releaseAvailability) {
    return NextResponse.json({ available: false, error: 'Live availability is busy. Please try again shortly.' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' },
    });
  }

  // Availability is a promise that a customer can proceed to payment. Match
  // every non-request-specific checkout prerequisite before calculating stock:
  // missing webhook, fulfilment, or signing configuration used to leave the
  // product shown as available even though checkout had to refuse the order.
  // Availability calls Stripe too. Canonicalise exactly as checkout and the
  // readiness guard do, otherwise a harmless formatted secret can make stock
  // appear unavailable even though the release health check is green.
  const stripeKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!stripeKey || !hasRequiredStripeCheckoutConfig() || !hasOrderIntegritySigningConfig() ||
    !hasRequiredStripeWebhookConfig() || !hasRequiredFulfilmentEmailConfig() || !getSupabaseAdmin()) {
    return unavailableAvailability();
  }

  // The same cached, fail-closed post-payment schema check prevents an
  // incomplete migration from showing a purchasable router only for checkout
  // to reject it moments later.
  if (!await hasRequiredPaymentSchema()) {
    return unavailableAvailability();
  }
  // Availability is a purchase promise. Match checkout's physical-custody
  // gate so a partial deployment cannot advertise a router that it refuses
  // before payment because the dispatch/return transaction is unavailable.
  if (!await hasRequiredPocketWifiFulfilmentSchema()) {
    return unavailableAvailability();
  }

  const inventory = config.pocketWifiInventory;

  const from = start.toISOString().slice(0, 10);
  const to = end.toISOString().slice(0, 10);
  try {
    const stripeHolds = await activeStripeHolds(createStripeClient(stripeKey), stripeKey, from, to);
    const inventoryState = await committedInventory(from, to, stripeHolds.requestIds, inventory);
    const committed = inventoryState.committed + stripeHolds.holds;
    // This must mirror qy_reserve_pocket_wifi: the lower of the configured
    // operating cap and current saleable stock is the only capacity we can
    // truthfully show to a customer.
    const effectiveInventory = Math.min(inventory, inventoryState.saleableInventory);
    const remaining = Math.max(0, effectiveInventory - committed);
    // The Stripe scan and atomic inventory snapshot can straddle Singapore
    // midnight. Do not publish a positive stock promise after the delivery
    // lead-time boundary has advanced beyond the requested start date; the
    // immediately following checkout would correctly reject that promise.
    if (from < operationalIsoDateAfter(minLeadDays)) {
      return NextResponse.json({ available: false, ...bookingTerms, bookingWindowChanged: true, error: `Please book at least ${minLeadDays} day${minLeadDays === 1 ? '' : 's'} before departure.` }, {
        status: 409,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    return NextResponse.json({ available: remaining > 0, remaining, inventoryMode: 'live', temporaryHolds: stripeHolds.holds, ...bookingTerms }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    // Stripe and PostgREST errors can include upstream response text. This is
    // a public capacity path, so keep the log useful for alerting without
    // turning provider diagnostics into a place that can retain credentials,
    // customer data, or implementation details.
    console.error('availability_check_failed');
    return NextResponse.json({ available: false, remaining: 0, inventoryMode: 'unavailable', error: 'Live availability is temporarily unavailable. Please try again shortly or contact +65 8032 7183.' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' } });
  }
  } catch {
    // Prerequisite and schema checks normally fail closed themselves, but a
    // provider SDK/runtime regression can still reject unexpectedly before
    // the narrower inventory-query catch above. Keep that failure inside the
    // same public availability contract so the storefront can retry safely
    // instead of receiving Next's generic, potentially ambiguous 500 page.
    console.error('availability_check_failed');
    return unavailableAvailability();
  } finally {
    releaseAvailability?.();
  }
}
