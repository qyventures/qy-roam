import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { createStripeClient } from '../../../lib/stripeClient';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { parseExactIsoDate } from '@/lib/checkoutValidation';
import { operationalConfig } from '@/lib/operationalConfig';
import { operationalIsoDateAfter } from '@/lib/operationalDate';
import { hasOrderIntegritySigningConfig, validQyRoamProvenance } from '@/lib/orderProvenance';
import {
  hasRequiredFulfilmentEmailConfig,
  hasRequiredPaymentSchema,
  hasRequiredPocketWifiFulfilmentSchema,
  hasRequiredStripeCheckoutConfig,
  hasRequiredStripeWebhookConfig,
} from '@/lib/productionReadiness';
import { MAX_STRIPE_HOLD_SCAN_PAGES, STRIPE_HOLD_SCAN_WINDOW_SECONDS } from '@/lib/checkoutExpiry';
import { AVAILABILITY_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS, createCheckoutAttemptLimiter, createGlobalAttemptLimiter } from '@/lib/checkoutRateLimit';
import { stripeEventMatchesConfiguredMode } from '@/lib/stripeCheckoutConfig';
import { validStripeCheckoutSessionIdForMode } from '@/lib/stripeSessionId';

export const dynamic = 'force-dynamic';

// A live availability lookup performs a Stripe hold scan and an atomic database
// snapshot. Keep ordinary date-picker retries responsive while preventing the
// public endpoint from becoming an unbounded provider-work amplifier. This is
// deliberately separate from the stricter checkout limiter because checking
// a date range is safe to repeat a little more often than opening payment.
const limited = createCheckoutAttemptLimiter(60_000, 30);
const globallyLimited = createGlobalAttemptLimiter(60_000, AVAILABILITY_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS);

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
  const nowSeconds = Math.floor(Date.now() / 1000);
  // Checkout expiry is based on a browser timestamp that may be slightly
  // ahead of this server. Include that accepted skew so availability cannot
  // omit a Session that is still open during the final minute of its life.
  const cutoff = nowSeconds - STRIPE_HOLD_SCAN_WINDOW_SECONDS;
  let startingAfter: string | undefined;
  let pagesScanned = 0;
  let holds = 0;
  const requestIds = new Set<string>();
  // Every still-valid QY Roam Checkout Session is an inventory hold. Scan the
  // short hold window within the shared, fail-closed page ceiling below: an
  // incomplete scan must report unavailable rather than overstate stock. QY
  // Roam creates short-lived sessions, so Stripe omits historical sessions
  // before this bounded account-level scan begins.
  for (;;) {
    if (pagesScanned >= MAX_STRIPE_HOLD_SCAN_PAGES) {
      // A partial result would overstate availability. Fail closed so a noisy
      // shared Stripe account cannot turn this public endpoint into unbounded
      // provider work or cause the last router to be oversold.
      throw new Error('Stripe Pocket WiFi hold scan exceeded its safe page limit');
    }
    const sessions = await stripe.checkout.sessions.list({ status: 'open', limit: 100, created: { gte: cutoff }, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    pagesScanned += 1;
    for (const session of sessions.data) {
      // The final list row also becomes the next provider pagination cursor.
      // Fail this inventory promise closed if Stripe ever returns an
      // unexpected identity instead of sending unbounded runtime data back in
      // a follow-up API request or into provenance verification.
      const sessionId = validStripeCheckoutSessionIdForMode(session.id, session.livemode);
      if (!sessionId) throw new Error('Stripe returned an invalid Checkout Session identifier');
      // Session status is eventually consistent around expiry. Capacity must
      // follow the Checkout Session's actual expiry, not only its age.
      // Inventory holds must be as trustworthy as fulfilment. A source marker
      // alone is writable on manually-created Checkout Sessions in a shared
      // Stripe account and must not be able to make routers appear sold out.
      // The configured API credential normally scopes list results to one
      // Stripe mode, but availability is a customer-facing stock promise.
      // Apply the same live/test boundary as Checkout before an upstream
      // response can consume inventory capacity.
      if (!stripeEventMatchesConfiguredMode(stripeKey, session.livemode)) continue;
      if (session.metadata?.source !== 'qyroam.com' || !validQyRoamProvenance(sessionId, session.metadata)) continue;
      // Only explicitly identified router sessions can consume router stock.
      // Never infer Pocket WiFi from the absence of a product marker: a valid
      // signed session for another QY Roam flow must not make availability
      // appear lower than it is.
      if (session.metadata?.product_type !== 'pocket_wifi') continue;
      if (session.mode !== 'payment' ||
        !Number.isSafeInteger(session.created) || session.created < cutoff ||
        !Number.isSafeInteger(session.expires_at) || session.expires_at! <= session.created) {
        throw new Error('Stripe returned an invalid authenticated Pocket WiFi hold lifecycle');
      }
      if (session.expires_at <= nowSeconds) continue;
      const holdStart = session.metadata?.start;
      const holdEnd = session.metadata?.end;
      const holdStartDate = parseExactIsoDate(holdStart);
      const holdEndDate = parseExactIsoDate(holdEnd);
      if (!holdStartDate || !holdEndDate || holdEndDate < holdStartDate) {
        throw new Error('Stripe returned invalid dates for an authenticated Pocket WiFi hold');
      }
      if (holdStart! <= end && holdEnd! >= start) {
        holds += 1;
        const requestId = session.metadata?.checkout_request_id;
        if (requestId) requestIds.add(requestId);
      }
    }
    if (!sessions.has_more) break;
    // `has_more` without a row cannot provide the next cursor. Returning the
    // partial count would make availability optimistic and could invite a
    // checkout for inventory held on an unread provider page.
    if (sessions.data.length === 0) throw new Error('Stripe Pocket WiFi hold scan returned an empty continuation page');
    // Every returned row, including this cursor, was validated above.
    const cursor = sessions.data[sessions.data.length - 1];
    startingAfter = validStripeCheckoutSessionIdForMode(cursor.id, cursor.livemode)!;
  }
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
  const row = Array.isArray(snapshot.data) ? snapshot.data[0] : snapshot.data;
  const committed = Number(row?.committed);
  const saleableInventory = Number(row?.saleable_inventory);
  if (!Number.isSafeInteger(committed) || committed < 0 ||
    !Number.isSafeInteger(saleableInventory) || saleableInventory < 0 || saleableInventory > configuredInventory) {
    throw new Error('Pocket WiFi availability snapshot is invalid');
  }
  return { committed, saleableInventory };
}

export async function GET(req: NextRequest) {
  // Apply the bounded per-client ingress limit before parsing any attacker-
  // controlled query values. Malformed dates are cheap and must never spend
  // the shared provider-work budget below, but returning before this guard
  // would also make them completely unthrottled and leave this public route
  // available as an avoidable CPU/response amplifier.
  if (limited(req)) {
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
  const rentalDays = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
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
  if (rentalDays < 1 || rentalDays > 90) return NextResponse.json({ available: false, ...bookingTerms, error: 'Bookings must be between 1 and 90 days.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });

  // Only a currently bookable range can proceed to configuration, schema,
  // Stripe, or Supabase checks. Count that provider-capable request against
  // the allocation-free shared ceiling so cheap rejected ranges cannot deny
  // live availability to all shoppers on this process.
  if (globallyLimited()) {
    return NextResponse.json({ available: false, error: 'Too many availability checks. Please try again shortly.' }, {
      status: 429,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' },
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
    return NextResponse.json({ available: remaining > 0, remaining, inventoryMode: 'live', temporaryHolds: stripeHolds.holds, ...bookingTerms }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    // Stripe and PostgREST errors can include upstream response text. This is
    // a public capacity path, so keep the log useful for alerting without
    // turning provider diagnostics into a place that can retain credentials,
    // customer data, or implementation details.
    console.error('availability_check_failed');
    return NextResponse.json({ available: false, remaining: 0, inventoryMode: 'unavailable', error: 'Live availability is temporarily unavailable. Please try again shortly or contact +65 8032 7183.' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' } });
  }
}
