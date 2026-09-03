const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');

// Keep this focused production-boundary test dependency-free. The repository
// already ships TypeScript, so Node can load the same catalogue and validator
// modules used by the webhook instead of testing a duplicate implementation.
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true
    },
    fileName: filename
  });
  module._compile(output.outputText, filename);
};

const { ESIM_PLANS, ESIM_PROMO } = require('../lib/esimPlans.ts');
const { LAUNCH_PROMO } = require('../lib/promotions.ts');
const { validateQyRoamSession } = require('../lib/qyRoamSession.ts');
const { parseExactIsoDate, validCheckoutRequestId } = require('../lib/checkoutValidation.ts');
const { operationalIsoDate, operationalIsoDateAfter } = require('../lib/operationalDate.ts');
const { WIFI_BENCHMARK, WIFI_PLANS } = require('../lib/wifiPlans.ts');
const { allowedFulfilmentStatuses, validFulfilmentTransition } = require('../lib/orderLifecycle.ts');
const { operationalConfig } = require('../lib/operationalConfig.ts');

process.env.ORDER_INTEGRITY_SECRET = 'order-integrity-test-secret-that-is-at-least-32-characters';
const { signedQyRoamProvenance } = require('../lib/orderProvenance.ts');

// The success page, booking-status page, and Stripe webhook must all use this
// same validator rather than trusting the QY Roam source marker by itself.
const bookingPage = fs.readFileSync(require.resolve('../app/booking/page.tsx'), 'utf8');
const adminOrderRoute = fs.readFileSync(require.resolve('../app/api/admin/orders/[id]/route.ts'), 'utf8');
const adminOrderActions = fs.readFileSync(require.resolve('../components/AdminOrderActions.tsx'), 'utf8');
const esimCheckoutRoute = fs.readFileSync(require.resolve('../app/api/esim-checkout/route.ts'), 'utf8');
const wifiCheckoutRoute = fs.readFileSync(require.resolve('../app/api/checkout/route.ts'), 'utf8');
const availabilityRoute = fs.readFileSync(require.resolve('../app/api/availability/route.ts'), 'utf8');
const esimPage = fs.readFileSync(require.resolve('../app/esim/page.tsx'), 'utf8');
const homePage = fs.readFileSync(require.resolve('../app/page.tsx'), 'utf8');
const adminOpsRoute = fs.readFileSync(require.resolve('../app/api/admin/ops/route.ts'), 'utf8');
const productionReadiness = fs.readFileSync(require.resolve('../lib/productionReadiness.ts'), 'utf8');
const operationalDate = fs.readFileSync(require.resolve('../lib/operationalDate.ts'), 'utf8');
const smtpClient = fs.readFileSync(require.resolve('../lib/smtp.ts'), 'utf8');
const webhookRoute = fs.readFileSync(require.resolve('../app/api/stripe-webhook/route.ts'), 'utf8');
const successPage = fs.readFileSync(require.resolve('../app/success/page.tsx'), 'utf8');
const metaPurchase = fs.readFileSync(require.resolve('../components/MetaPurchase.tsx'), 'utf8');
const metaClient = fs.readFileSync(require.resolve('../lib/metaClient.ts'), 'utf8');
const adminPage = fs.readFileSync(require.resolve('../app/admin/page.tsx'), 'utf8');
const schema = fs.readFileSync(require.resolve('../supabase/schema.sql'), 'utf8');

const requestId = 'checkout_request_123456';

function esimSession(plan = ESIM_PLANS[0]) {
  const session = {
    id: 'cs_test_esim',
    currency: 'sgd',
    amount_total: Math.max(50, Math.round(plan.qyPriceSgd * 100)),
    metadata: {
      source: 'qyroam.com',
      product_type: 'esim',
      checkout_request_id: requestId,
      plan_id: plan.id,
      plan_name: `${plan.destination} · ${plan.days} days`,
      country: plan.destination,
      promo_code: ESIM_PROMO.code,
      benchmark_price_sgd: plan.benchmarkPriceSgd.toFixed(2),
      promo_discount_percent: String(ESIM_PROMO.percent)
    }
  };
  session.metadata.checkout_amount_cents = String(session.amount_total);
  session.metadata.qyroam_provenance = signedQyRoamProvenance(session.id, session.metadata);
  return session;
}

function wifiSession(plan = WIFI_PLANS[0]) {
  const days = 4;
  const rental = Math.max(1000, Math.round(plan.daily * days * 100));
  const discount = Math.floor((rental * LAUNCH_PROMO.percent) / 100);
  const session = {
    id: 'cs_test_wifi',
    currency: 'sgd',
    amount_total: rental - discount,
    metadata: {
      source: 'qyroam.com',
      product_type: 'pocket_wifi',
      checkout_request_id: requestId,
      plan_name: `${plan.country} Pocket WiFi`,
      country: plan.country,
      start: '2026-09-10',
      end: '2026-09-13',
      days: String(days),
      daily_rate_sgd: plan.daily.toFixed(2),
      benchmark_provider: WIFI_BENCHMARK.provider,
      benchmark_rate_sgd: plan.benchmarkRateSgd.toFixed(2),
      benchmark_verified_on: WIFI_BENCHMARK.verifiedOn,
      rental_before_promo_sgd: (rental / 100).toFixed(2),
      promo_code: LAUNCH_PROMO.code,
      promo_discount_sgd: (discount / 100).toFixed(2),
      courier_fee_sgd: '0.00'
    }
  };
  session.metadata.checkout_amount_cents = String(session.amount_total);
  session.metadata.qyroam_provenance = signedQyRoamProvenance(session.id, session.metadata);
  return session;
}

test('accepts every server-authored eSIM catalogue session', () => {
  for (const plan of ESIM_PLANS) assert.deepEqual(validateQyRoamSession(esimSession(plan)), { valid: true, productType: 'esim' });
});

test('rejects eSIM amount, identity, and catalogue metadata tampering', () => {
  for (const mutate of [
    (s) => { s.amount_total += 1; },
    (s) => { s.metadata.product_type = 'pocket_wifi'; },
    (s) => { s.metadata.checkout_request_id = 'short'; },
    (s) => { s.metadata.plan_name = 'Different plan'; },
    (s) => { s.metadata.benchmark_price_sgd = '0.01'; },
    (s) => { s.metadata.promo_discount_percent = '99'; }
  ]) {
    const session = esimSession();
    mutate(session);
    assert.equal(validateQyRoamSession(session).valid, false);
  }
});

test('accepts every server-authored Pocket WiFi catalogue session', () => {
  for (const plan of WIFI_PLANS) assert.deepEqual(validateQyRoamSession(wifiSession(plan)), { valid: true, productType: 'pocket_wifi' });
});

test('rejects Pocket WiFi amount, dates, promo, and catalogue tampering', () => {
  for (const mutate of [
    (s) => { s.amount_total -= 1; },
    (s) => { s.metadata.end = '2026-09-14'; },
    (s) => { s.metadata.promo_code = 'NOTREAL'; },
    (s) => { s.metadata.daily_rate_sgd = '0.01'; },
    (s) => { s.metadata.courier_fee_sgd = '-1.00'; }
  ]) {
    const session = wifiSession();
    mutate(session);
    assert.equal(validateQyRoamSession(session).valid, false);
  }
});

test('ignores sessions outside the QY Roam checkout boundary', () => {
  const session = esimSession();
  session.metadata.source = 'another-store';
  assert.equal(validateQyRoamSession(session).valid, false);
});

test('rejects unsigned, copied, and session-id-replayed checkout provenance', () => {
  const unsigned = esimSession();
  delete unsigned.metadata.qyroam_provenance;
  assert.equal(validateQyRoamSession(unsigned).valid, false);

  const unrelated = esimSession();
  unrelated.id = 'cs_test_unrelated_session';
  unrelated.metadata.qyroam_provenance = signedQyRoamProvenance(unrelated.id, unrelated.metadata);
  const copied = esimSession();
  copied.metadata.qyroam_provenance = unrelated.metadata.qyroam_provenance;
  assert.equal(validateQyRoamSession(copied).valid, false);

  const replayed = esimSession();
  replayed.id = 'cs_test_other_session';
  assert.equal(validateQyRoamSession(replayed).valid, false);
});

test('accepts only the immediately previous checkout-integrity key during a controlled rotation', () => {
  const current = process.env.ORDER_INTEGRITY_SECRET;
  const previous = 'previous-order-integrity-secret-that-is-at-least-32-characters';
  process.env.ORDER_INTEGRITY_SECRET_PREVIOUS = previous;
  try {
    const inFlight = esimSession();
    const fields = Object.keys(inFlight.metadata)
      .filter((key) => key !== 'qyroam_provenance')
      .sort()
      .map((key) => [key, inFlight.metadata[key]]);
    const digest = crypto.createHmac('sha256', previous)
      .update(JSON.stringify(['v2', inFlight.id, fields]))
      .digest('hex');
    inFlight.metadata.qyroam_provenance = `v2.${digest}`;
    assert.deepEqual(validateQyRoamSession(inFlight), { valid: true, productType: 'esim' });

    const newSession = esimSession();
    assert.notEqual(newSession.metadata.qyroam_provenance, inFlight.metadata.qyroam_provenance);
    const forged = esimSession();
    forged.metadata.qyroam_provenance = `v2.${crypto.createHmac('sha256', 'untrusted-secret-that-is-at-least-32-characters').update(JSON.stringify(['v2', forged.id, Object.keys(forged.metadata).filter((key) => key !== 'qyroam_provenance').sort().map((key) => [key, forged.metadata[key]])])).digest('hex')}`;
    assert.equal(validateQyRoamSession(forged).valid, false);
  } finally {
    delete process.env.ORDER_INTEGRITY_SECRET_PREVIOUS;
    process.env.ORDER_INTEGRITY_SECRET = current;
  }
});

test('accepts an authenticated historical price snapshot after a catalogue update', () => {
  const session = esimSession();
  // This represents a Checkout Session issued before a legitimate reprice.
  // Its v2 signature binds the amount snapshot and all order metadata.
  session.amount_total += 1;
  session.metadata.checkout_amount_cents = String(session.amount_total);
  session.metadata.qyroam_provenance = signedQyRoamProvenance(session.id, session.metadata);
  assert.deepEqual(validateQyRoamSession(session), { valid: true, productType: 'esim' });
});

test('accepts an authenticated historical eSIM plan after it is retired', () => {
  const plan = ESIM_PLANS[0];
  const session = esimSession(plan);
  ESIM_PLANS.splice(0, 1);
  try {
    assert.deepEqual(validateQyRoamSession(session), { valid: true, productType: 'esim' });
  } finally {
    ESIM_PLANS.unshift(plan);
  }
});

test('v2 provenance binds all checkout metadata, including same-priced travel dates', () => {
  const session = wifiSession();
  // Moving a four-day rental to another four-day period leaves the catalogue
  // price unchanged, so catalogue validation alone cannot detect this change.
  session.metadata.start = '2026-10-10';
  session.metadata.end = '2026-10-13';
  assert.equal(validateQyRoamSession(session).valid, false);
});

test('rejects legacy v1 provenance because it does not bind mutable order metadata', () => {
  const session = esimSession();
  const legacyPayload = ['v1', session.id, session.metadata.source, session.metadata.product_type, session.metadata.checkout_request_id].join('|');
  session.metadata.qyroam_provenance = `v1.${crypto.createHmac('sha256', process.env.ORDER_INTEGRITY_SECRET).update(legacyPayload).digest('hex')}`;
  assert.equal(validateQyRoamSession(session).valid, false);
});

test('booking status uses full checkout-session integrity validation', () => {
  assert.match(bookingPage, /validateQyRoamSession\(session\)/);
  assert.doesNotMatch(bookingPage, /qyRoamProductType\(session\)/);
});

test('checkout validation rejects normalized and malformed calendar dates', () => {
  assert.equal(parseExactIsoDate('2026-09-10')?.toISOString().slice(0, 10), '2026-09-10');
  for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-9-10', '', null]) {
    assert.equal(parseExactIsoDate(value), null);
  }
  const session = wifiSession();
  session.metadata.start = '2026-02-29';
  session.metadata.end = '2026-03-04';
  assert.equal(validateQyRoamSession(session).valid, false);
});

test('Pocket WiFi booking dates follow the Singapore operational calendar', () => {
  // 16:30 UTC is already 00:30 the following day in Singapore.
  const singaporeEarlyMorning = new Date('2026-09-01T16:30:00.000Z');
  assert.equal(operationalIsoDate(singaporeEarlyMorning), '2026-09-02');
  assert.equal(operationalIsoDateAfter(2, singaporeEarlyMorning), '2026-09-04');
  assert.match(wifiCheckoutRoute, /const today=operationalIsoDate\(\)/);
  assert.match(wifiCheckoutRoute, /const minLeadDays=config\.minDeliveryLeadDays, earliest=operationalIsoDateAfter\(minLeadDays\)/);
  assert.match(availabilityRoute, /const earliest = operationalIsoDateAfter\(minLeadDays\)/);
  assert.match(homePage, /const earliestStart = operationalIsoDateAfter\(DELIVERY_LEAD_DAYS\)/);
  assert.match(operationalDate, /OPERATIONAL_TIME_ZONE = 'Asia\/Singapore'/);
});

test('checkout request ids use the same production boundary everywhere', () => {
  assert.equal(validCheckoutRequestId(requestId), requestId);
  for (const value of ['short', 'contains spaces 123456', 'bad/slashes/123456', 'x'.repeat(81)]) {
    assert.equal(validCheckoutRequestId(value), null);
  }
});

test('eSIM checkout never redirects a reused idempotency key to another plan', () => {
  assert.match(esimCheckoutRoute, /function matchesRequestedEsim/);
  assert.match(esimCheckoutRoute, /session\.metadata\?\.plan_id === plan\.id/);
  assert.match(esimCheckoutRoute, /checkoutRequestConflict: true/);
  assert.match(esimCheckoutRoute, /if \(!matchesRequestedEsim\(session, requestId, plan\)\)/);
  assert.match(esimPage, /data\.checkoutExpired \|\| data\.checkoutRequestConflict/);
  assert.match(esimCheckoutRoute, /checkout_amount_cents: String\(amount\)/);
});

test('eSIM checkout fails closed when its durable post-payment order boundary is unavailable', () => {
  assert.match(esimCheckoutRoute, /hasRequiredEsimOrderSchema/);
  assert.match(esimCheckoutRoute, /if \(!await hasRequiredEsimOrderSchema\(\)\)/);
  assert.match(esimCheckoutRoute, /status: 503/);
  assert.match(productionReadiness, /const REQUIRED_ESIM_ORDER_SCHEMA = REQUIRED_PAYMENT_SCHEMA\.slice\(0, 4\)/);
  assert.match(productionReadiness, /export async function hasRequiredEsimOrderSchema\(\)/);
});

test('post-payment readiness checks every webhook-persisted delivery field', () => {
  // A table-only (or partial-column) probe can pass before an additive schema
  // migration is deployed. Checkout must fail closed rather than accepting a
  // payment whose webhook cannot persist its retry and deduplication state.
  assert.match(productionReadiness, /customer_name,email,phone,amount_sgd,product_type,plan_name,country/);
  assert.match(productionReadiness, /last_attempt_at,sent_at,last_error/);
  assert.match(productionReadiness, /status,event_time,attempts,last_attempt_at,sent_at,last_error,updated_at/);
});

test('checkout never exposes payment when human fulfilment email is not configured', () => {
  assert.match(esimCheckoutRoute, /hasRequiredFulfilmentEmailConfig/);
  assert.match(esimCheckoutRoute, /if \(!hasRequiredFulfilmentEmailConfig\(\)\)/);
  assert.match(wifiCheckoutRoute, /if\(!hasRequiredFulfilmentEmailConfig\(\)\)/);
  assert.match(productionReadiness, /export function hasRequiredFulfilmentEmailConfig\(\)/);
  assert.match(productionReadiness, /ORDER_FULFILMENT_EMAIL \|\| process\.env\.FULFILMENT_TO/);
});

test('payment-readiness checks coalesce healthy checkout probes without caching failures', () => {
  assert.match(productionReadiness, /const READINESS_CACHE_MS = 15_000/);
  assert.match(productionReadiness, /let paymentSchemaCheckInFlight: Promise<boolean> \| null = null/);
  assert.match(productionReadiness, /if \(Date\.now\(\) < paymentSchemaReadyUntil\) return true/);
  assert.match(productionReadiness, /if \(!paymentSchemaCheckInFlight\)/);
  assert.match(productionReadiness, /if \(ready\) paymentSchemaReadyUntil = Date\.now\(\) \+ READINESS_CACHE_MS/);
  assert.match(productionReadiness, /let esimOrderSchemaCheckInFlight: Promise<boolean> \| null = null/);
  assert.match(productionReadiness, /if \(Date\.now\(\) < esimOrderSchemaReadyUntil\) return true/);
  assert.match(productionReadiness, /if \(!esimOrderSchemaCheckInFlight\)/);
});

test('Pocket WiFi checkout fails closed when its paid-order schema is unavailable', () => {
  assert.match(wifiCheckoutRoute, /hasRequiredPaymentSchema/);
  assert.match(wifiCheckoutRoute, /if\(!await hasRequiredPaymentSchema\(\)\)/);
  assert.match(wifiCheckoutRoute, /Pocket WiFi ordering is temporarily unavailable/);
  assert.match(wifiCheckoutRoute, /'Retry-After':'30'/);
});

test('Pocket WiFi checkout retries bind the complete server-priced booking', () => {
  assert.match(wifiCheckoutRoute, /function matchesRequestedPocketWifi/);
  assert.match(wifiCheckoutRoute, /session\.metadata\?\.promo_code===requested\.promoCode/);
  assert.match(wifiCheckoutRoute, /session\.metadata\?\.courier_fee_sgd===\(requested\.courierFee\/100\)\.toFixed\(2\)/);
  assert.match(wifiCheckoutRoute, /const sameBooking=matchesRequestedPocketWifi\(session,requestId,requested\)/);
  assert.match(wifiCheckoutRoute, /checkoutRequestConflict:true/);
  assert.match(homePage, /data\.checkoutExpired \|\| data\.checkoutRequestConflict/);
  assert.match(wifiCheckoutRoute, /checkout_amount_cents:String\(rentalAmount\+courierFee\)/);
});

test('Pocket WiFi payment URLs require a durable matching reservation link', () => {
  assert.match(wifiCheckoutRoute, /async function linkReservationToSession/);
  assert.match(wifiCheckoutRoute, /stripe_session_id\.is\.null,stripe_session_id\.eq\.\$\{sessionId\}/);
  assert.match(wifiCheckoutRoute, /if\(!await linkReservationToSession\(supabase,requestId,existing\.id\)\)/);
  assert.match(wifiCheckoutRoute, /if\(!await linkReservationToSession\(supabase,requestId,session\.id\)\)/);
  assert.match(wifiCheckoutRoute, /Live reservation confirmation is temporarily unavailable/);
});

test('ambiguous Stripe creation failures retain the Pocket WiFi reservation', () => {
  // A Stripe timeout can happen after Checkout created a payable session. The
  // reservation must remain the capacity boundary until retry/expiry resolves
  // that ambiguity; deleting it here would permit an uncounted router sale.
  assert.match(wifiCheckoutRoute, /A network failure is ambiguous: Stripe may have created a payable/);
  assert.match(wifiCheckoutRoute, /Keep it until its short expiry \(or Stripe's signed terminal/);
  assert.doesNotMatch(wifiCheckoutRoute, /checkout_reservation_release_error/);
  assert.doesNotMatch(wifiCheckoutRoute, /checkout_provenance_reservation_release_error/);
});

test('Pocket WiFi dispatch requires an operationally available inventory item at the database boundary', () => {
  assert.match(schema, /and status = 'available'/);
  assert.match(schema, /selected Pocket WiFi inventory item is not available for dispatch/);
  assert.match(adminOrderRoute, /not available for dispatch/);
  assert.match(adminPage, /quantity_on_hand,status/);
  assert.match(adminOrderActions, /item\.status === 'available'/);
});

test('operational pricing and inventory configuration is strict and fail-closed', () => {
  const saved = {
    inventory: process.env.POCKET_WIFI_INVENTORY,
    leadDays: process.env.MIN_DELIVERY_LEAD_DAYS,
    courierFee: process.env.COURIER_FEE_SGD,
  };
  try {
    delete process.env.POCKET_WIFI_INVENTORY;
    delete process.env.MIN_DELIVERY_LEAD_DAYS;
    delete process.env.COURIER_FEE_SGD;
    assert.deepEqual(operationalConfig(), { pocketWifiInventory: 10, minDeliveryLeadDays: 2, courierFeeCents: 0 });

    process.env.POCKET_WIFI_INVENTORY = '12';
    process.env.MIN_DELIVERY_LEAD_DAYS = '0';
    process.env.COURIER_FEE_SGD = '4.50';
    assert.deepEqual(operationalConfig(), { pocketWifiInventory: 12, minDeliveryLeadDays: 0, courierFeeCents: 450 });

    for (const [key, value] of [
      ['POCKET_WIFI_INVENTORY', 'Infinity'],
      ['MIN_DELIVERY_LEAD_DAYS', '-1'],
      ['COURIER_FEE_SGD', '1.234'],
    ]) {
      process.env.POCKET_WIFI_INVENTORY = '10';
      process.env.MIN_DELIVERY_LEAD_DAYS = '2';
      process.env.COURIER_FEE_SGD = '0';
      process.env[key] = value;
      assert.equal(operationalConfig(), null);
    }
  } finally {
    for (const [key, value] of Object.entries({
      POCKET_WIFI_INVENTORY: saved.inventory,
      MIN_DELIVERY_LEAD_DAYS: saved.leadDays,
      COURIER_FEE_SGD: saved.courierFee,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Pocket WiFi fulfilment follows a dispatch and return lifecycle', () => {
  assert.deepEqual(allowedFulfilmentStatuses('pocket_wifi', 'paid'), ['paid', 'packing', 'dispatched', 'cancelled']);
  assert.equal(validFulfilmentTransition('pocket_wifi', 'paid', 'returned'), false);
  assert.equal(validFulfilmentTransition('pocket_wifi', 'dispatched', 'returned'), true);
  assert.equal(validFulfilmentTransition('pocket_wifi', 'dispatched', 'cancelled'), false);
  assert.equal(validFulfilmentTransition('pocket_wifi', 'with_customer', 'cancelled'), false);
  assert.equal(validFulfilmentTransition('pocket_wifi', 'return_due', 'cancelled'), false);
  assert.equal(validFulfilmentTransition('pocket_wifi', 'returned', 'with_customer'), false);
  assert.equal(validFulfilmentTransition('pocket_wifi', 'returned', 'closed'), true);
  assert.equal(validFulfilmentTransition('pocket_wifi', 'closed', 'packing'), false);
});

test('Pocket WiFi capacity retains legacy post-dispatch cancellations until return', () => {
  const schema = fs.readFileSync(require.resolve('../supabase/schema.sql'), 'utf8');
  assert.match(schema, /fulfilment_status = 'cancelled' and dispatched_at is not null and returned_at is null/);
  assert.match(availabilityRoute, /fulfilment_status\.eq\.cancelled,dispatched_at\.not\.is\.null,returned_at\.is\.null/);
  assert.match(schema, /fulfilment_status not in \('cancelled', 'payment_failed', 'returned', 'closed'\)/);
  assert.match(availabilityRoute, /fulfilment_status\.not\.in\.\(cancelled,payment_failed,returned,closed\)/);
});

test('Pocket WiFi availability only counts Checkout Sessions that are still unexpired', () => {
  const checkoutRoute = fs.readFileSync(require.resolve('../app/api/checkout/route.ts'), 'utf8');
  for (const source of [checkoutRoute, availabilityRoute]) {
    assert.match(source, /session\.expires_at\s*<=\s*nowSeconds/);
    assert.match(source, /!session\.expires_at/);
  }
});

test('Pocket WiFi holds require server-issued checkout provenance', () => {
  const checkoutRoute = fs.readFileSync(require.resolve('../app/api/checkout/route.ts'), 'utf8');
  for (const source of [checkoutRoute, availabilityRoute]) {
    assert.match(source, /validQyRoamProvenance\(session\.id,\s*session\.metadata\)/);
  }
});

test('manual orders cannot bypass paid-order lifecycle, pricing, or WiFi capacity fields', () => {
  assert.match(adminOpsRoute, /\['paid', 'unpaid', 'pending', 'failed'\]\.includes\(paymentStatus\)/);
  assert.match(adminOpsRoute, /function money\(value: unknown\)/);
  assert.match(adminOpsRoute, /parseExactIsoDate\(startRaw\)/);
  assert.match(adminOpsRoute, /New orders must start in their initial fulfilment status/);
  assert.match(adminOpsRoute, /Pocket WiFi orders require a destination and valid travel start and end dates/);
});

test('manual paid Pocket WiFi orders use the same atomic capacity boundary as checkout', () => {
  const schema = fs.readFileSync(require.resolve('../supabase/schema.sql'), 'utf8');
  assert.match(adminOpsRoute, /product === 'pocket_wifi' && paymentStatus === 'paid'/);
  assert.match(adminOpsRoute, /qy_create_manual_pocket_wifi_order/);
  assert.match(adminOpsRoute, /p_inventory: config\.pocketWifiInventory/);
  assert.match(schema, /create or replace function public\.qy_create_manual_pocket_wifi_order/);
  assert.match(schema, /pg_advisory_xact_lock\(hashtext\('qy_roam_pocket_wifi_checkout'\)\)/);
  assert.match(schema, /from public\.checkout_reservations/);
  assert.match(schema, /Pocket WiFi is sold out or reserved for these travel dates/);
});

test('eSIM lifecycle cannot use router statuses or reopen closed orders', () => {
  assert.deepEqual(allowedFulfilmentStatuses('esim', 'awaiting_fulfilment'), ['awaiting_fulfilment', 'fulfilled', 'cancelled']);
  assert.equal(validFulfilmentTransition('esim', 'awaiting_fulfilment', 'dispatched'), false);
  assert.equal(validFulfilmentTransition('esim', 'fulfilled', 'closed'), true);
  assert.equal(validFulfilmentTransition('esim', 'closed', 'awaiting_fulfilment'), false);
});

test('admin fulfilment writes reject stale concurrent order state', () => {
  assert.match(adminOrderRoute, /\.eq\('fulfilment_status', existing\.data\.fulfilment_status\)/);
  assert.match(adminOrderRoute, /\.eq\('payment_status', 'paid'\)/);
  assert.match(adminOrderRoute, /Order changed since it was loaded/);
});

test('Pocket WiFi dispatch and return require a recorded operational reference', () => {
  assert.match(adminOrderRoute, /status === 'dispatched' && !courierTracking/);
  assert.match(adminOrderRoute, /status === 'returned' && !returnTracking/);
  assert.match(adminOrderRoute, /required before dispatching a Pocket WiFi order/);
  assert.match(adminOrderRoute, /required before marking a Pocket WiFi order returned/);
  assert.match(adminOrderActions, /status === 'dispatched' && !courier\.trim\(\)/);
  assert.match(adminOrderActions, /status === 'returned' && !returned\.trim\(\)/);
});

test('Pocket WiFi dispatch and return atomically reconcile the assigned stock item', () => {
  const schema = fs.readFileSync(require.resolve('../supabase/schema.sql'), 'utf8');
  assert.match(schema, /add column if not exists inventory_item_id bigint references public\.inventory_items/);
  assert.match(schema, /create or replace function public\.qy_transition_pocket_wifi_order/);
  assert.match(schema, /movement_type, quantity, reference, notes\)\s*\n    values \(v_item_id, 'dispatch', -1/);
  assert.match(schema, /movement_type, quantity, reference, notes\)\s*\n    values \(v_item_id, 'return', 1/);
  assert.match(adminOrderRoute, /rpc\('qy_transition_pocket_wifi_order'/);
  assert.match(adminOrderActions, /Select the Pocket WiFi inventory item being dispatched/);
});

test('production readiness verifies the deployed Pocket WiFi dispatch and return contract', () => {
  assert.match(productionReadiness, /inventory_item_id,courier_tracking,return_tracking,dispatched_at,returned_at/);
  assert.match(productionReadiness, /database\.rpc\('qy_transition_pocket_wifi_order'/);
  assert.match(productionReadiness, /database\.rpc\('qy_adjust_inventory'/);
  assert.match(productionReadiness, /p_order_id: 0/);
  assert.match(productionReadiness, /p_item_id: 0/);
  assert.match(productionReadiness, /production_operations_inventory_rpc_check_failed/);
});

test('Pocket WiFi receipt cannot create stock unless the outbound hand-off was recorded', () => {
  assert.match(schema, /Pocket WiFi order cannot be returned without a recorded dispatch/);
  assert.match(schema, /if v_order\.dispatched_at is null then raise exception 'Pocket WiFi order cannot be returned without a recorded dispatch'/);
  assert.match(adminOrderRoute, /cannot be returned without a recorded dispatch/);
});

test('admin actions advance their transition baseline after each save', () => {
  assert.match(adminOrderActions, /allowedFulfilmentStatuses\(productType, currentStatus\)/);
  assert.match(adminOrderActions, /setCurrentStatus\(result\.fulfilment_status\)/);
});

test('admin order visibility fails loudly instead of presenting a database failure as no orders', () => {
  assert.match(adminPage, /await Promise\.all\(\[/);
  assert.match(adminPage, /const failedPanels = \[/);
  assert.match(adminPage, /Operational data is currently unavailable:/);
  assert.match(adminPage, /Do not treat empty panels as no orders/);
});

test('admin can safely resume failed paid-order notifications', () => {
  assert.match(adminOrderRoute, /export async function POST/);
  assert.match(adminOrderRoute, /validateQyRoamSession\(session\)/);
  assert.match(adminOrderRoute, /await deliverFulfilmentNotification\(supabase, session\)/);
  assert.match(adminOrderRoute, /await deliverMetaPurchase\(supabase, session/);
  assert.match(adminOrderActions, /Retry order notifications/);
});

test('Meta Purchase retries preserve one durable event timestamp for deduplication', () => {
  const schema = fs.readFileSync(require.resolve('../supabase/schema.sql'), 'utf8');
  assert.match(schema, /event_time bigint check \(event_time is null or event_time > 0\)/);
  assert.match(schema, /payment_confirmed_at timestamptz/);
  assert.match(webhookRoute, /insert\(\{stripe_session_id:session\.id,status:'pending',event_time:requestedEventTime\}\)/);
  assert.match(webhookRoute, /async function persistSession\(session:Stripe\.Checkout\.Session,eventType:Stripe\.Event\.Type,eventCreated:number\)/);
  assert.match(webhookRoute, /payment_confirmed_at:confirmedAt/);
  assert.match(webhookRoute, /await sendMetaPurchase\(session,Number\(attempt\.data\[0\]\.event_time\)\)/);
  assert.match(adminOrderRoute, /select\('stripe_session_id,payment_status,payment_confirmed_at'\)/);
  assert.match(adminOrderRoute, /const metaEventTime=Number\.isFinite\(confirmedAtMs\)/);
  assert.match(adminOrderRoute, /await deliverMetaPurchase\(supabase, session, metaEventTime\)/);
  assert.doesNotMatch(adminOrderRoute, /Math\.floor\(Date\.now\(\) \/ 1000\)/);
});

test('consented browser and CAPI Purchases share a stable deduplication identity', () => {
  assert.match(successPage, /<MetaPurchase sessionId=\{sessionId\}/);
  assert.match(successPage, /measurementConsent=\{measurementConsent\}/);
  assert.match(metaPurchase, /metaMeasurementAllowed\(\)/);
  assert.match(metaPurchase, /qyroam_meta_purchase_/);
  assert.match(metaPurchase, /eventID: `stripe_\$\{sessionId\}`/);
  assert.match(metaPurchase, /content_ids: \[contentId\]/);
  assert.match(metaClient, /trackMetaWhenReady/);
  assert.match(metaClient, /attemptsLeft = 20/);
  assert.match(webhookRoute, /event_id:`stripe_\$\{session\.id\}`/);
  assert.match(webhookRoute, /content_ids:\[contentId\]/);
  assert.match(webhookRoute, /content_type:'product'/);
});

test('fulfilment email retries retain one safe per-order message identity', () => {
  assert.match(webhookRoute, /function fulfilmentMessageId\(sessionId:string\)/);
  assert.match(webhookRoute, /message_id:messageId/);
  assert.match(webhookRoute, /messageId,timeoutMs:DELIVERY_TIMEOUT_MS/);
  assert.match(smtpClient, /messageId\?: string/);
  assert.match(smtpClient, /\^<\[A-Za-z0-9\._-\]\+@\[A-Za-z0-9\.-\]\+>\$/);
  assert.match(smtpClient, /Message-ID: \$\{safeMessageId\(options\.messageId\)\}/);
});

test('Stripe webhook bounds raw payload memory before signature verification', () => {
  assert.match(webhookRoute, /const MAX_STRIPE_WEBHOOK_BODY_BYTES = 1_000_000/);
  assert.match(webhookRoute, /async function readStripeWebhookBody\(req: Request\): Promise<Buffer>/);
  assert.match(webhookRoute, /Number\(contentLength\) > MAX_STRIPE_WEBHOOK_BODY_BYTES/);
  assert.match(webhookRoute, /total > MAX_STRIPE_WEBHOOK_BODY_BYTES/);
  assert.match(webhookRoute, /Webhook payload too large/);
  assert.match(webhookRoute, /stripe\.webhooks\.constructEvent\(payload,req\.headers\.get\('stripe-signature'\)/);
});

test('expired authenticated Pocket WiFi sessions promptly release only their matching reservation', () => {
  const webhookRoute = fs.readFileSync(require.resolve('../app/api/stripe-webhook/route.ts'), 'utf8');
  assert.match(webhookRoute, /'checkout\.session\.expired'/);
  assert.match(webhookRoute, /async function releaseExpiredPocketWifiReservation/);
  assert.match(webhookRoute, /session\.metadata\?\.product_type!=='pocket_wifi'/);
  assert.match(webhookRoute, /validQyRoamProvenance\(session\.id,session\.metadata\)/);
  assert.match(webhookRoute, /\.eq\('checkout_request_id',requestId\)/);
  assert.match(webhookRoute, /stripe_session_id\.is\.null,stripe_session_id\.eq\.\$\{session\.id\}/);
  assert.match(webhookRoute, /if\(event\.type==='checkout\.session\.expired'\)/);
  assert.match(webhookRoute, /await releaseExpiredPocketWifiReservation\(supabase,session\)/);
});

test('only the matching Pocket WiFi terminal event can release a checkout reservation', () => {
  const webhookRoute = fs.readFileSync(require.resolve('../app/api/stripe-webhook/route.ts'), 'utf8');
  // eSIM and Pocket WiFi have separate Stripe idempotency namespaces, so the
  // shared request-id syntax alone must never make an eSIM payment release a
  // router held by another checkout.
  assert.match(webhookRoute, /validation\.productType==='pocket_wifi'/);
  assert.match(webhookRoute, /\.eq\('checkout_request_id',checkoutRequestId\)\s*\.eq\('stripe_session_id',session\.id\)/);
});
