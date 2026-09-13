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
const { operationalIsoDate, operationalIsoDateAfter, operationalDaysFromToday } = require('../lib/operationalDate.ts');
const { POCKET_WIFI_RETURN_GRACE_DAYS } = require('../lib/pocketWifiReturns.ts');
const { WIFI_BENCHMARK, WIFI_PLANS } = require('../lib/wifiPlans.ts');
const { allowedFulfilmentStatuses, fulfilmentNotificationActionable, validFulfilmentTransition, STRIPE_EVENT_CLAIM_STALE_MS } = require('../lib/orderLifecycle.ts');
const { operationalConfig } = require('../lib/operationalConfig.ts');
const { validStripeCheckoutSessionId } = require('../lib/stripeSessionId.ts');
const { validStripeEventCreated, STRIPE_EVENT_CREATED_MAX_FUTURE_SECONDS } = require('../lib/stripeEventCreated.ts');
const { isJsonRequestContentType, readLimitedRequestText, RequestBodyTimeoutError, RequestBodyTooLargeError, InvalidRequestBodyLengthError } = require('../lib/requestBody.ts');
const { checkoutClientKey, createCheckoutAttemptLimiter } = require('../lib/checkoutRateLimit.ts');
const { hasRequiredStripeCheckoutConfig, stripeEventMatchesConfiguredMode } = require('../lib/stripeCheckoutConfig.ts');
const { metaAttributionFromRequest } = require('../lib/metaAttribution.ts');
const { CHECKOUT_PAYMENT_WINDOW_MINUTES, STRIPE_EXPIRY_SAFETY_SECONDS, CHECKOUT_HOLD_WINDOW_SECONDS, checkoutExpiresAt } = require('../lib/checkoutExpiry.ts');
const { checkoutSiteOrigin, isProductionQyRoamOrigin } = require('../lib/siteOrigin.ts');
const { hasRequiredMetaCapiPurchaseConfig } = require('../lib/runtimeConfig.ts');
const { metaMeasurementAllowed, setMetaMeasurementConsent } = require('../lib/metaClient.ts');
const { digitalDeliveryReferenceIssue, isSafeDigitalDeliveryReference } = require('../lib/digitalDeliveryReference.ts');
const { SUPABASE_REQUEST_TIMEOUT_MS, fetchSupabaseWithTimeout } = require('../lib/supabaseAdmin.ts');
const { checkoutAttempt, clearCheckoutAttempt, CHECKOUT_ATTEMPT_MAX_AGE_MS } = require('../lib/checkoutAttempt.ts');
const { safeHttpsDeliveryEndpoint } = require('../lib/deliveryEndpoint.ts');

process.env.ORDER_INTEGRITY_SECRET = 'order-integrity-test-secret-that-is-at-least-32-characters';
const { signedQyRoamProvenance } = require('../lib/orderProvenance.ts');

// The success page, booking-status page, and Stripe webhook must all use this
// same validator rather than trusting the QY Roam source marker by itself.
const bookingPage = fs.readFileSync(require.resolve('../app/booking/page.tsx'), 'utf8');
const adminOrderRoute = fs.readFileSync(require.resolve('../app/api/admin/orders/[id]/route.ts'), 'utf8');
const stripeEventId = fs.readFileSync(require.resolve('../lib/stripeEventId.ts'), 'utf8');
const adminOrderActions = fs.readFileSync(require.resolve('../components/AdminOrderActions.tsx'), 'utf8');
const esimCheckoutRoute = fs.readFileSync(require.resolve('../app/api/esim-checkout/route.ts'), 'utf8');
const wifiCheckoutRoute = fs.readFileSync(require.resolve('../app/api/checkout/route.ts'), 'utf8');
const availabilityRoute = fs.readFileSync(require.resolve('../app/api/availability/route.ts'), 'utf8');
const esimPage = fs.readFileSync(require.resolve('../app/esim/page.tsx'), 'utf8');
const homePage = fs.readFileSync(require.resolve('../app/page.tsx'), 'utf8');
const manualOrderForm = fs.readFileSync(require.resolve('../components/ManualOrderForm.tsx'), 'utf8');
const adminOpsForms = fs.readFileSync(require.resolve('../components/AdminOpsForms.tsx'), 'utf8');
const adminOpsRoute = fs.readFileSync(require.resolve('../app/api/admin/ops/route.ts'), 'utf8');
const productionReadiness = fs.readFileSync(require.resolve('../lib/productionReadiness.ts'), 'utf8');
const stripeCheckoutConfig = fs.readFileSync(require.resolve('../lib/stripeCheckoutConfig.ts'), 'utf8');
const operationalDate = fs.readFileSync(require.resolve('../lib/operationalDate.ts'), 'utf8');
const smtpClient = fs.readFileSync(require.resolve('../lib/smtp.ts'), 'utf8');
const webhookRoute = fs.readFileSync(require.resolve('../app/api/stripe-webhook/route.ts'), 'utf8');
const healthRoute = fs.readFileSync(require.resolve('../app/api/health/route.ts'), 'utf8');
const successPage = fs.readFileSync(require.resolve('../app/success/page.tsx'), 'utf8');
const metaPurchase = fs.readFileSync(require.resolve('../components/MetaPurchase.tsx'), 'utf8');
const metaClient = fs.readFileSync(require.resolve('../lib/metaClient.ts'), 'utf8');
const stripeClient = fs.readFileSync(require.resolve('../lib/stripeClient.ts'), 'utf8');
const metaAttribution = fs.readFileSync(require.resolve('../lib/metaAttribution.ts'), 'utf8');
const adminPage = fs.readFileSync(require.resolve('../app/admin/page.tsx'), 'utf8');
const inventoryPage = fs.readFileSync(require.resolve('../app/admin/inventory/page.tsx'), 'utf8');
const launchPage = fs.readFileSync(require.resolve('../app/admin/launch/page.tsx'), 'utf8');
const middleware = fs.readFileSync(require.resolve('../middleware.ts'), 'utf8');
const schema = fs.readFileSync(require.resolve('../supabase/schema.sql'), 'utf8');
const nextConfig = fs.readFileSync(require.resolve('../next.config.mjs'), 'utf8');
const supabaseAdmin = fs.readFileSync(require.resolve('../lib/supabaseAdmin.ts'), 'utf8');

const requestId = 'checkout_request_123456';

test('checkout attempt identity survives reloads without becoming permanently stale', () => {
  const previousWindow = global.window;
  const previousCrypto = global.crypto;
  const values = new Map();
  global.window = { sessionStorage: {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  } };
  global.crypto = { randomUUID: () => '12345678-1234-4234-8234-123456789abc' };
  try {
    const first = checkoutAttempt('esim', 'plan-a', null, 1_000_000);
    const afterReload = checkoutAttempt('esim', 'plan-a', null, 1_000_001);
    assert.deepEqual(afterReload, first);

    const changedSelection = checkoutAttempt('esim', 'plan-b', null, 1_000_002);
    assert.notEqual(changedSelection.fingerprint, first.fingerprint);

    const expired = checkoutAttempt('esim', 'plan-b', null, 1_000_002 + CHECKOUT_ATTEMPT_MAX_AGE_MS + 1);
    assert.ok(expired.createdAt > changedSelection.createdAt);
    clearCheckoutAttempt('esim');
    assert.equal(values.size, 0);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
    if (previousCrypto === undefined) delete global.crypto;
    else global.crypto = previousCrypto;
  }
});

test('optional Meta consent storage cannot block checkout in privacy-restricted browsers', () => {
  const previousWindow = global.window;
  global.window = {
    localStorage: {
      getItem() { throw new Error('Storage access denied'); },
      setItem() { throw new Error('Storage access denied'); },
    },
  };
  try {
    assert.equal(metaMeasurementAllowed(), false);
    assert.doesNotThrow(() => setMetaMeasurementConsent('accepted'));
    assert.equal(metaMeasurementAllowed(), true);
    assert.doesNotThrow(() => setMetaMeasurementConsent('essential'));
    assert.equal(metaMeasurementAllowed(), false);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

function esimSession(plan = ESIM_PLANS[0]) {
  const session = {
    id: 'cs_test_esim',
    mode: 'payment',
    payment_status: 'unpaid',
    currency: 'sgd',
    amount_total: Math.max(50, Math.round(plan.qyPriceSgd * 100)),
    metadata: {
      source: 'qyroam.com',
      product_type: 'esim',
      checkout_request_id: requestId,
      plan_id: plan.id,
      plan_name: `${plan.destination} · ${plan.days} days`,
      data_allowance: plan.data,
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
    mode: 'payment',
    payment_status: 'unpaid',
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
    (s) => { s.metadata.data_allowance = 'Different data package'; },
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

test('rejects non-payment Checkout modes even with valid signed order metadata', () => {
  for (const createSession of [esimSession, wifiSession]) {
    const session = createSession();
    session.mode = 'subscription';
    // The mode is a Stripe-owned field and intentionally not part of the
    // metadata HMAC. Validation must still protect the fulfilment boundary.
    assert.equal(validateQyRoamSession(session).valid, false);
  }
  // The same boundary applies before returning an idempotent Checkout URL and
  // while counting short-lived router reservations for availability.
  assert.match(esimCheckoutRoute, /return session\.mode === 'payment' &&/);
  assert.match(wifiCheckoutRoute, /return session\.mode==='payment' &&/);
  assert.match(wifiCheckoutRoute, /if\(session\.mode!=='payment'\|\|session\.created<cutoff/);
  assert.match(availabilityRoute, /if \(session\.mode !== 'payment' \|\| session\.created < cutoff/);
});

test('rejects unsupported Stripe payment states before order persistence', () => {
  const session = esimSession(ESIM_PLANS[0]);
  session.payment_status = 'no_payment_required';
  assert.deepEqual(validateQyRoamSession(session), {
    valid: false,
    reason: 'QY Roam order has an unsupported payment status',
  });

  assert.match(schema, /if p_payment_status not in \('paid', 'unpaid'\) then raise exception 'unsupported Stripe payment status'/);
  assert.match(schema, /if p_payment_failed and p_payment_status <> 'unpaid' then raise exception 'failed payment must be unpaid'/);
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

test('rejects even signed checkout amount snapshots that disagree with Stripe', () => {
  for (const createSession of [esimSession, wifiSession]) {
    const session = createSession();
    // This models a server-side session construction defect rather than a
    // third-party tamper attempt, so recompute the provenance after changing
    // the metadata. The payment amount remains Stripe's source of truth.
    session.metadata.checkout_amount_cents = String(session.amount_total + 1);
    session.metadata.qyroam_provenance = signedQyRoamProvenance(session.id, session.metadata);
    assert.equal(validateQyRoamSession(session).valid, false);
  }
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

test('accepts a signed legacy eSIM session opened before data allowance snapshots', () => {
  const session = esimSession();
  delete session.metadata.data_allowance;
  session.metadata.qyroam_provenance = signedQyRoamProvenance(session.id, session.metadata);
  assert.deepEqual(validateQyRoamSession(session), { valid: true, productType: 'esim' });
});

test('eSIM fulfilment preserves the exact plan identity and data allowance', () => {
  assert.match(esimCheckoutRoute, /data_allowance: plan\.data/);
  assert.match(esimCheckoutRoute, /session\.metadata\?\.data_allowance === plan\.data/);
  assert.match(webhookRoute, /plan_id:session\.metadata\?\.plan_id\|\|null/);
  assert.match(webhookRoute, /data_allowance:session\.metadata\?\.data_allowance\|\|esimPlan\?\.data\|\|null/);
  assert.match(webhookRoute, /`Plan ID: \$\{planId\|\|'-'\}`/);
  assert.match(webhookRoute, /`Data allowance: \$\{dataAllowance\|\|'-'\}`/);
  assert.match(productionReadiness, /product_type,plan_id,plan_name,data_allowance,country/);
  assert.match(schema, /alter table public\.orders add column if not exists plan_id text/);
  assert.match(schema, /alter table public\.orders add column if not exists data_allowance text/);
  assert.match(adminPage, /Plan ID: \{o\.plan_id\}/);
  assert.match(adminPage, /Data: \{o\.data_allowance\}/);
});

test('paid orders fail into the durable webhook recovery ledger when fulfilment contact data is incomplete', () => {
  assert.match(webhookRoute, /function paidFulfilmentDetailsIssue\(session:Stripe\.Checkout\.Session,productType:'esim'\|'pocket_wifi'\)/);
  assert.match(webhookRoute, /Paid order is missing a valid customer email/);
  assert.match(webhookRoute, /if\(!isSafeSmtpMailbox\(email\)\)/);
  assert.match(webhookRoute, /import \{ isSafeSmtpMailbox, sendSmtpMail \} from '@\/lib\/smtp';/);
  assert.match(webhookRoute, /Paid Pocket WiFi order is missing a valid customer phone number/);
  assert.match(webhookRoute, /shipping\?\.country!=='SG'/);
  assert.match(webhookRoute, /Paid Pocket WiFi order is missing a complete Singapore delivery address/);

  const paidValidationAt = webhookRoute.indexOf('const validation=validateQyRoamSession(sessionForEvent)');
  const paidClaimAt = webhookRoute.lastIndexOf("const eventClaimId=`stripe:${stripeEventId}`", paidValidationAt);
  const processing = webhookRoute.slice(
    paidClaimAt,
    webhookRoute.indexOf("return NextResponse.json({received:true});", paidValidationAt),
  );
  const claim = processing.indexOf('claimStartedAt=claim.processingStartedAt');
  const detailsGuard = processing.indexOf('paidFulfilmentDetailsIssue(sessionForEvent,validation.productType)');
  const persistence = processing.indexOf('await persistSession(sessionForEvent,event.type,eventCreated)');
  assert.ok(claim >= 0 && detailsGuard > claim, 'fulfilment validation must run after the durable event claim');
  assert.ok(persistence > detailsGuard, 'an incomplete paid order must not enter the order ledger');
  assert.match(processing, /if\(claimStartedAt\) await recordEventFailure\(supabase,eventClaimId,claimStartedAt,error\)/);
});

test('admin fulfilment recovery cannot bypass paid-order delivery-detail validation', () => {
  // A protected retry is a second entry point to the same outbound alert. The
  // shared mailer must retain the webhook's customer and courier-data gate so
  // legacy or manually repaired order rows cannot create a false fulfilment
  // task with missing contact or delivery details.
  const mailer = webhookRoute.slice(
    webhookRoute.indexOf('async function sendHumanFulfilmentEmail'),
    webhookRoute.indexOf('async function persistSession'),
  );
  assert.match(mailer, /const fulfilmentDetailsIssue=paidFulfilmentDetailsIssue\(session,productType\)/);
  assert.match(mailer, /if\(fulfilmentDetailsIssue\) throw new Error\(fulfilmentDetailsIssue\)/);
});

test('Stripe retries cannot revive fulfilment work after the order lifecycle has completed', () => {
  // Webhook and admin retries share this function. The durable order is the
  // authority for whether a human hand-off is still actionable; a historical
  // paid event must not ask staff to resend a fulfilled eSIM or returned,
  // closed, or cancelled router order.
  const delivery = webhookRoute.slice(
    webhookRoute.indexOf('export async function deliverFulfilmentNotification'),
    webhookRoute.indexOf('export async function deliverMetaPurchase'),
  );
  const lifecycleRead = delivery.indexOf(".select('payment_status,product_type,fulfilment_status')");
  const actionableGuard = delivery.indexOf('fulfilmentNotificationActionable(order.data.product_type,order.data.fulfilment_status)');
  const notificationClaim = delivery.indexOf(".from('fulfilment_notifications')");
  assert.ok(lifecycleRead >= 0, 'delivery must read the current durable order lifecycle');
  assert.ok(actionableGuard > lifecycleRead, 'delivery must validate the current lifecycle after reading it');
  assert.ok(notificationClaim > actionableGuard, 'a non-actionable order must be rejected before notification state is claimed');
  assert.match(delivery, /if\(!order\.data\) throw new Error\('Paid order is missing before fulfilment notification delivery'\)/);
  assert.match(delivery, /if\(order\.data\.product_type!==session\.metadata\?\.product_type\) throw new Error\('Stored order product does not match its Stripe session'\)/);
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

test('booking status requires a durable paid order before showing fulfilment progress', () => {
  // A Stripe-confirmed payment remains trustworthy, but a missing, provisional,
  // or unavailable order snapshot must not be rendered as the normal queued
  // fulfilment state.
  assert.match(bookingPage, /const orderLookupFailed = !supabase \|\| Boolean\(orderResult\?\.error\)/);
  assert.match(bookingPage, /select\('payment_status,fulfilment_status,/);
  assert.match(bookingPage, /const orderPersisted = order\?\.payment_status === 'paid'/);
  assert.match(bookingPage, /paid && !orderPersisted/);
  assert.match(bookingPage, /orderLookupFailed \? 'temporarily unable to verify' : 'still finalising'/);
  assert.match(bookingPage, /Please do not place a second order/);
});

test('success confirmation does not imply fulfilment is durable before the paid order snapshot exists', () => {
  // Stripe is the payment authority, but a paid session can reach this page
  // before the webhook has persisted it (or while the ledger is unavailable).
  // The recovery instruction must prevent a duplicate purchase in either case.
  assert.match(successPage, /getSupabaseAdmin/);
  assert.match(successPage, /let orderPersisted = false/);
  assert.match(successPage, /let orderLookupFailed = false/);
  assert.match(successPage, /select\('payment_status'\)/);
  assert.match(successPage, /orderPersisted = orderResult\.data\?\.payment_status === 'paid'/);
  assert.match(successPage, /orderPersisted \? 'Order confirmed' : 'Payment confirmed'/);
  assert.match(successPage, /Please do not place a second order/);
  assert.match(successPage, /orderLookupFailed \? 'temporarily unable to verify' : 'finalising'/);
});

test('customer confirmation views distinguish expired Checkout Sessions from delayed payment confirmation', () => {
  // An expired session cannot settle successfully. Presenting it as a delayed
  // payment encourages a customer to wait on an unrecoverable link instead of
  // deliberately starting a new idempotent checkout attempt.
  assert.match(successPage, /checkoutExpired = session\.status === 'expired'/);
  assert.match(successPage, /This secure checkout session has expired\./);
  assert.match(successPage, /sessionId && !checkoutExpired/);
  assert.match(bookingPage, /const checkoutExpired = session\.status === 'expired';/);
  assert.match(bookingPage, /This secure checkout session has expired/);
  assert.match(bookingPage, /checkoutExpired \? \(/);
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
  assert.match(homePage, /const earliestStart = operationalIsoDateAfter\(deliveryLeadDays\)/);
  assert.match(operationalDate, /OPERATIONAL_TIME_ZONE = 'Asia\/Singapore'/);
});

test('operations departure and return exceptions use Singapore date boundaries', () => {
  // This clock is still 11 September in UTC, but already 12 September in SG.
  // The result must not depend on the timezone configured on the app server.
  const singaporeMorning = new Date('2026-09-11T16:30:00.000Z');
  assert.equal(operationalDaysFromToday('2026-09-12', singaporeMorning), 0);
  assert.equal(operationalDaysFromToday('2026-09-13', singaporeMorning), 1);
  assert.equal(operationalDaysFromToday('2026-09-07', singaporeMorning), -POCKET_WIFI_RETURN_GRACE_DAYS);
  assert.equal(operationalDaysFromToday('2026-09-06', singaporeMorning), -(POCKET_WIFI_RETURN_GRACE_DAYS + 1));
  assert.equal(operationalDaysFromToday('2026-02-30', singaporeMorning), null);
  assert.match(adminPage, /operationalDaysFromToday/);
  assert.match(adminPage, /POCKET_WIFI_RETURN_GRACE_DAYS/);
  assert.match(bookingPage, /POCKET_WIFI_RETURN_GRACE_DAYS/);
});

test('Pocket WiFi availability publishes only validated public booking terms for checkout UX', () => {
  assert.match(availabilityRoute, /const bookingTerms = \{\s*minDeliveryLeadDays: minLeadDays,\s*courierFeeSgd: config\.courierFeeCents \/ 100,/s);
  assert.match(availabilityRoute, /available: remaining > 0, remaining, inventoryMode: 'live', temporaryHolds: stripeHolds\.holds, \.\.\.bookingTerms/);
  assert.match(homePage, /function validLeadDays\(value: unknown\)/);
  assert.match(homePage, /function validCourierFee\(value: unknown\)/);
  assert.match(homePage, /const payableTotal = subtotal \+ courierFeeSgd;/);
  assert.match(homePage, /Total due today: S\$\{payableTotal\.toFixed\(2\)\}/);
});

test('checkout request ids use the same production boundary everywhere', () => {
  assert.equal(validCheckoutRequestId(requestId), requestId);
  for (const value of ['short', 'contains spaces 123456', 'bad/slashes/123456', 'x'.repeat(81)]) {
    assert.equal(validCheckoutRequestId(value), null);
  }
});

test('JSON request content types require the exact JSON media type', () => {
  for (const value of ['application/json', 'Application/JSON', 'application/json; charset=utf-8']) {
    assert.equal(isJsonRequestContentType(value), true);
  }
  for (const value of [null, '', 'text/plain', 'application/jsonp', 'application/json-seq']) {
    assert.equal(isJsonRequestContentType(value), false);
  }
  for (const source of [wifiCheckoutRoute, esimCheckoutRoute, adminOpsRoute, adminOrderRoute]) {
    assert.match(source, /isJsonRequestContentType\(req\.headers\.get\('content-type'\)\)/);
    assert.doesNotMatch(source, /startsWith\('application\/json'\)/);
  }
});

test('checkout request bodies are bounded for chunked, malformed, and slow uploads', async () => {
  const complete = new Request('https://qyroam.test/api/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ checkoutRequestId: requestId }),
  });
  assert.equal(await readLimitedRequestText(complete, 4096, 100), JSON.stringify({ checkoutRequestId: requestId }));

  await assert.rejects(
    () => readLimitedRequestText(new Request('https://qyroam.test', { method: 'POST', headers: { 'content-length': '5000' }, body: 'x' }), 4096, 100),
    RequestBodyTooLargeError,
  );
  await assert.rejects(
    () => readLimitedRequestText(new Request('https://qyroam.test', { method: 'POST', headers: { 'content-length': 'not-a-number' }, body: 'x' }), 4096, 100),
    InvalidRequestBodyLengthError,
  );
  await assert.rejects(
    () => readLimitedRequestText(new Request('https://qyroam.test', { method: 'POST', body: '12345' }), 4, 100),
    RequestBodyTooLargeError,
  );
  const stalled = {
    headers: new Headers(),
    body: new ReadableStream({ pull() { return new Promise(() => {}); } }),
  };
  await assert.rejects(() => readLimitedRequestText(stalled, 4096, 20), RequestBodyTimeoutError);
});

test('both checkout endpoints use the bounded streaming body reader', () => {
  for (const source of [wifiCheckoutRoute, esimCheckoutRoute]) {
    assert.match(source, /readLimitedRequestText\(req,\s*MAX_BODY_BYTES,\s*CHECKOUT_BODY_TIMEOUT_MS\)/);
    assert.match(source, /RequestBodyTimeoutError/);
    assert.doesNotMatch(source, /await req\.text\(\)/);
  }
});

test('public checkout endpoints reject JSON primitives and arrays before reading order fields', () => {
  // JSON null, strings and arrays are syntactically valid but cannot be
  // checkout requests. Reject them here instead of letting a null property
  // read escape to the outer handler as a misleading server error.
  for (const source of [wifiCheckoutRoute, esimCheckoutRoute]) {
    assert.match(source, /!parsed\s*\|\|\s*typeof parsed\s*!==\s*['"]object['"]\s*\|\|\s*Array\.isArray\(parsed\)/);
    assert.match(source, /body\s*=\s*parsed\s+as\s+Record<string,\s*unknown>/);
  }
});

test('admin operational mutations bound and validate their JSON request bodies', () => {
  assert.match(adminOpsRoute, /readLimitedRequestText\(req,\s*MAX_ADMIN_OPS_BODY_BYTES,\s*ADMIN_OPS_BODY_TIMEOUT_MS\)/);
  assert.match(adminOpsRoute, /RequestBodyTimeoutError/);
  assert.match(adminOpsRoute, /Expected JSON request/);
  assert.match(adminOpsRoute, /Array\.isArray\(parsed\)/);
  assert.doesNotMatch(adminOpsRoute, /await req\.json\(\)/);
});

test('admin sales-period close totals every Supabase page instead of silently using its row cap', () => {
  assert.match(adminOpsRoute, /async function paidOrderGrossForPeriod/);
  assert.match(adminOpsRoute, /CLOSING_ORDER_PAGE_SIZE = 1_000/);
  assert.match(adminOpsRoute, /\.range\(offset, offset \+ CLOSING_ORDER_PAGE_SIZE - 1\)/);
  assert.match(adminOpsRoute, /if \(page\.length < CLOSING_ORDER_PAGE_SIZE\) return gross/);
  assert.match(adminOpsRoute, /if \(offset >= MAX_CLOSING_ORDERS\)/);
  assert.match(adminOpsRoute, /await paidOrderGrossForPeriod\(db, dates\.start!, dates\.end!\)/);
  assert.match(adminOpsRoute, /Period dates must be valid ISO dates with the end date on or after the start date/);
});

test('admin forecast replacement and financial inputs preserve approved operations data', () => {
  assert.match(adminOpsRoute, /function nonNegativeMoney\(value: unknown\)/);
  assert.match(adminOpsRoute, /function nonNegativeInteger\(value: unknown\)/);
  assert.match(adminOpsRoute, /parseExactIsoDate\(month\)/);
  assert.match(adminOpsRoute, /\['pocket_wifi', 'esim'\]\.includes\(product\)/);
  assert.match(adminOpsRoute, /\.upsert\(/);
  assert.match(adminOpsRoute, /onConflict: 'forecast_month,product_type'/);
  assert.doesNotMatch(adminOpsRoute, /from\('forecasts'\)\.delete\(\)/);
  assert.match(adminOpsRoute, /Refunds, fees and COGS must be non-negative amounts/);
});

test('accounting period saves are idempotent while open and immutable once closed', () => {
  assert.match(adminOpsRoute, /Accounting period lock must be a boolean choice/);
  assert.match(adminOpsRoute, /Closed accounting periods require an accountable operator name/);
  assert.match(adminOpsRoute, /rpc\('qy_record_closing_period'/);
  assert.doesNotMatch(adminOpsRoute, /from\('closing_periods'\)\.insert\(/);
  assert.match(schema, /create or replace function public\.qy_record_closing_period/);
  assert.match(schema, /qy_roam_closing_period:/);
  assert.match(schema, /closed accounting period cannot be replaced/);
  assert.match(productionReadiness, /qy_record_closing_period/);
});

test('admin order transitions bound and validate their JSON request bodies', () => {
  assert.match(adminOrderRoute, /readLimitedRequestText\(req,\s*MAX_ADMIN_ORDER_BODY_BYTES,\s*ADMIN_ORDER_BODY_TIMEOUT_MS\)/);
  assert.match(adminOrderRoute, /RequestBodyTimeoutError/);
  assert.match(adminOrderRoute, /Expected JSON request/);
  assert.match(adminOrderRoute, /Array\.isArray\(parsed\)/);
  assert.doesNotMatch(adminOrderRoute, /await req\.json\(\)/);
});

test('checkout attempt rate limiting keeps per-client limits while bounding unique client state', () => {
  const limit = createCheckoutAttemptLimiter(1_000, 2, 3);
  const requestFor = (ip) => new Request('https://qyroam.test/api/checkout', { headers: { 'cf-connecting-ip': ip } });
  assert.equal(limit(requestFor('198.51.100.1'), 100), false);
  assert.equal(limit(requestFor('198.51.100.1'), 101), false);
  assert.equal(limit(requestFor('198.51.100.1'), 102), true);
  // Filling the bounded registry evicts its oldest key rather than growing
  // process memory for every new, attacker-controlled client identifier.
  assert.equal(limit(requestFor('198.51.100.2'), 103), false);
  assert.equal(limit(requestFor('198.51.100.3'), 104), false);
  assert.equal(limit(requestFor('198.51.100.4'), 105), false);
  assert.equal(limit(requestFor('198.51.100.1'), 106), false);
  // A retained client still receives a fresh window after expiry.
  assert.equal(limit(requestFor('198.51.100.1'), 1_200), false);
});

test('checkout rate limiting uses only bounded valid proxy client identities', () => {
  const request = (headers) => new Request('https://qyroam.com/api/checkout', { headers });

  // Nginx overwrites X-Real-IP in production. Spoofable forwarding headers
  // must not take precedence over that trusted socket-peer identity.
  assert.equal(checkoutClientKey(request({
    'x-real-ip': '203.0.113.8',
    'cf-connecting-ip': '198.51.100.7',
    'x-forwarded-for': '192.0.2.4, 203.0.113.8',
  })), '203.0.113.8');

  assert.equal(checkoutClientKey(request({ 'x-real-ip': '2001:db8::17' })), '2001:db8::17');
  assert.equal(checkoutClientKey(request({ 'x-real-ip': 'not-an-ip', 'cf-connecting-ip': '198.51.100.7' })), '198.51.100.7');
  assert.equal(checkoutClientKey(request({ 'x-real-ip': 'not-an-ip', 'cf-connecting-ip': 'x'.repeat(4_000), 'x-forwarded-for': 'also-invalid' })), 'unknown');

  // Invalid caller-controlled identities collapse into one rate-limit bucket
  // instead of bypassing the guard by changing arbitrary header strings.
  const limited = createCheckoutAttemptLimiter(60_000, 1, 10);
  assert.equal(limited(request({ 'cf-connecting-ip': 'forged-a' }), 0), false);
  assert.equal(limited(request({ 'cf-connecting-ip': 'forged-b' }), 1), true);
});

test('customer-facing Stripe session lookups accept only one bounded Checkout Session id', () => {
  assert.equal(validStripeCheckoutSessionId('cs_test_abc123'), 'cs_test_abc123');
  assert.equal(validStripeCheckoutSessionId(' cs_live_ABC123 '), 'cs_live_ABC123');
  assert.equal(validStripeCheckoutSessionId(['cs_test_abc123', 'cs_test_def456']), null);
  assert.equal(validStripeCheckoutSessionId('cs_test_'), null);
  assert.equal(validStripeCheckoutSessionId(`cs_test_${'a'.repeat(300)}`), null);
  assert.match(bookingPage, /validStripeCheckoutSessionId\(searchParams\?\.session_id\)/);
  assert.match(successPage, /validStripeCheckoutSessionId\(searchParams\?\.session_id\)/);
});

test('admin delivery recovery validates its stored Stripe Checkout Session id before retrieval', () => {
  assert.match(adminOrderRoute, /const sessionId = validStripeCheckoutSessionId\(order\.stripe_session_id\)/);
  assert.match(adminOrderRoute, /stripe\.checkout\.sessions\.retrieve\(sessionId\)/);
  assert.doesNotMatch(adminOrderRoute, /stripe\.checkout\.sessions\.retrieve\(order\.stripe_session_id\)/);
});

test('eSIM checkout never redirects a reused idempotency key to another plan', () => {
  assert.match(esimCheckoutRoute, /function matchesRequestedEsim/);
  assert.match(esimCheckoutRoute, /session\.metadata\?\.plan_id === plan\.id/);
  assert.match(esimCheckoutRoute, /checkoutRequestConflict: true/);
  assert.match(esimCheckoutRoute, /if \(!matchesRequestedEsim\(session, requestId, plan\)\)/);
  assert.match(esimPage, /data\.checkoutExpired \|\| data\.checkoutRequestConflict/);
  assert.match(esimCheckoutRoute, /checkout_amount_cents: String\(amount\)/);
});

test('eSIM Checkout Sessions use a bounded, recoverable payment window', () => {
  // A digital plan has no inventory hold, but it still carries a signed price
  // and fulfilment commitment. Do not leave its Checkout URL payable for the
  // much longer Stripe default window after the readiness checks ran.
  assert.equal(CHECKOUT_PAYMENT_WINDOW_MINUTES, 30);
  assert.ok(STRIPE_EXPIRY_SAFETY_SECONDS > 0);
  assert.equal(CHECKOUT_HOLD_WINDOW_SECONDS, CHECKOUT_PAYMENT_WINDOW_MINUTES * 60 + STRIPE_EXPIRY_SAFETY_SECONDS);
  const nowMs = 1_700_000_000_999;
  assert.equal(checkoutExpiresAt(nowMs), Math.floor(nowMs / 1000) + CHECKOUT_HOLD_WINDOW_SECONDS);
  assert.ok(checkoutExpiresAt(nowMs) - Math.ceil(nowMs / 1000) >= 30 * 60);
  assert.match(esimCheckoutRoute, /const expiresAt = checkoutExpiresAt\(\)/);
  assert.match(esimCheckoutRoute, /mode: 'payment',\s*expires_at: expiresAt,/);
  assert.match(esimPage, /data\.checkoutExpired \|\| data\.checkoutRequestConflict/);
});

test('eSIM idempotent recovery uses a fresh Stripe session state before returning a payment URL', () => {
  // Stripe caches idempotent POST responses. The route must not make a
  // recovery decision from a stale original `open` snapshot after payment.
  assert.match(esimCheckoutRoute, /const currentSession = await stripe\.checkout\.sessions\.retrieve\(session\.id\)/);
  assert.match(esimCheckoutRoute, /if \(!validQyRoamProvenance\(currentSession\.id, currentSession\.metadata\)\)/);
  assert.match(esimCheckoutRoute, /currentSession\.status === 'complete' && currentSession\.payment_status === 'paid'/);
  assert.match(esimCheckoutRoute, /url: currentSession\.url/);
  assert.doesNotMatch(esimCheckoutRoute, /if \(session\.status === 'complete' && session\.payment_status === 'paid'\)/);
});

test('browser InitiateCheckout events share the durable Stripe attempt identity on retries', () => {
  // Pixel events are client-side, but checkout retries are an important
  // measurement boundary: one Stripe idempotency key must not inflate the
  // checkout-start funnel merely because a response was lost in transit.
  assert.match(metaClient, /export function trackMeta\(event: string, params: Record<string, unknown> = \{\}, options: Record<string, unknown> = \{\}\)/);
  assert.match(metaClient, /fbq\('track', event, params, options\)/);
  assert.match(homePage, /trackMeta\('InitiateCheckout',[\s\S]*?\{ eventID: `checkout_\$\{activeCheckoutAttempt\.current\.requestId\}` \}\);/);
  assert.match(esimPage, /trackMeta\('InitiateCheckout',[\s\S]*?\{ eventID: `checkout_\$\{activeCheckoutAttempt\.current\.requestId\}` \}\);/);
  assert.match(homePage, /const fingerprint = JSON\.stringify[\s\S]*?checkoutAttempt\('pocket_wifi', fingerprint, activeCheckoutAttempt\.current\)[\s\S]*?trackMeta\('InitiateCheckout'/);
  assert.match(esimPage, /const fingerprint = JSON\.stringify[\s\S]*?checkoutAttempt\('esim', fingerprint, activeCheckoutAttempt\.current\)[\s\S]*?trackMeta\('InitiateCheckout'/);
});

test('Pocket WiFi expiry and inventory scans share the Stripe-safe hold window', () => {
  assert.match(wifiCheckoutRoute, /const expiresAtSeconds=checkoutExpiresAt\(\)/);
  assert.match(wifiCheckoutRoute, /expires_at:expiresAtSeconds/);
  assert.match(wifiCheckoutRoute, /const cutoff=nowSeconds-CHECKOUT_HOLD_WINDOW_SECONDS/);
  assert.match(availabilityRoute, /const cutoff = nowSeconds - CHECKOUT_HOLD_WINDOW_SECONDS/);
});

test('eSIM checkout fails closed when its durable post-payment order boundary is unavailable', () => {
  assert.match(esimCheckoutRoute, /hasRequiredEsimOrderSchema/);
  assert.match(esimCheckoutRoute, /if \(!await hasRequiredEsimOrderSchema\(\)\)/);
  assert.match(esimCheckoutRoute, /status: 503/);
  // A paid eSIM must retain a non-secret provider/email-log audit reference
  // when it is fulfilled. That field is part of its pre-payment schema gate,
  // even though Pocket WiFi-only inventory fields remain out of this smaller
  // digital-order contract.
  assert.match(productionReadiness, /const REQUIRED_ESIM_ORDER_SCHEMA = REQUIRED_PAYMENT_SCHEMA\.slice\(0, 5\)\.map/);
  assert.match(productionReadiness, /columns: `\$\{requirement\.columns\},digital_delivery_reference`/);
  assert.match(productionReadiness, /export async function hasRequiredEsimOrderSchema\(\)/);
});

test('post-payment readiness checks every webhook-persisted delivery field and paid-order trigger dependency', () => {
  // A table-only (or partial-column) probe can pass before an additive schema
  // migration is deployed. Checkout must fail closed rather than accepting a
  // payment whose webhook cannot persist its retry and deduplication state.
  assert.match(productionReadiness, /customer_name,email,phone,amount_sgd,product_type,plan_id,plan_name,data_allowance,country/);
  assert.match(productionReadiness, /last_attempt_at,sent_at,last_error/);
  assert.match(productionReadiness, /status,event_time,attempts,last_attempt_at,sent_at,last_error,updated_at/);
  assert.match(productionReadiness, /id,email,phone,name,status,source,total_orders,lifetime_value_sgd,last_order_at,updated_at/);
});

test('production readiness aborts stalled database probes instead of holding checkout workers', () => {
  // Readiness is evaluated on the public checkout path. A timeout must abort
  // the underlying PostgREST request, not merely race its promise and leave
  // unbounded background requests alive during a database/network incident.
  assert.match(productionReadiness, /const READINESS_PROBE_TIMEOUT_MS = 8_000/);
  assert.match(productionReadiness, /class ReadinessProbeTimeoutError extends Error/);
  assert.match(productionReadiness, /const controller = new AbortController\(\)/);
  assert.match(productionReadiness, /setTimeout\(\(\) => controller\.abort\(\), READINESS_PROBE_TIMEOUT_MS\)/);
  assert.match(productionReadiness, /throw new ReadinessProbeTimeoutError\('Production readiness probe timed out'\)/);
  assert.match(productionReadiness, /\.select\(columns\)\.limit\(1\)\.abortSignal\(signal\)/);
  assert.match(productionReadiness, /qy_reserve_pocket_wifi[\s\S]{0,500}\.abortSignal\(signal\)/);
  assert.match(productionReadiness, /qy_transition_pocket_wifi_order[\s\S]{0,500}\.abortSignal\(signal\)/);
  assert.match(productionReadiness, /qy_adjust_inventory[\s\S]{0,300}\.abortSignal\(signal\)/);
  assert.match(productionReadiness, /qy_set_inventory_status[\s\S]{0,300}\.abortSignal\(signal\)/);
});

test('checkout never exposes payment when human fulfilment email is not configured', () => {
  assert.match(esimCheckoutRoute, /hasRequiredFulfilmentEmailConfig/);
  assert.match(esimCheckoutRoute, /if \(!hasRequiredFulfilmentEmailConfig\(\)\)/);
  assert.match(wifiCheckoutRoute, /if\(!hasRequiredFulfilmentEmailConfig\(\)\)/);
  assert.match(productionReadiness, /export function hasRequiredFulfilmentEmailConfig\(\)/);
  assert.match(productionReadiness, /ORDER_FULFILMENT_EMAIL \|\| process\.env\.FULFILMENT_TO/);
});

test('checkout never exposes payment when signed Stripe webhook processing is not configured', () => {
  for (const route of [esimCheckoutRoute, wifiCheckoutRoute]) {
    assert.match(route, /hasRequiredStripeWebhookConfig/);
    assert.match(route, /if\s*\(!hasRequiredStripeWebhookConfig\(\)\)/);
  }
  assert.match(productionReadiness, /export function hasRequiredStripeWebhookConfig\(\)/);
  assert.match(productionReadiness, /\^whsec_\[A-Za-z0-9\]\+\$/);
});

test('production checkout and recovery reject test-mode Stripe server credentials', () => {
  const previousKey = process.env.STRIPE_SECRET_KEY;
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    process.env.STRIPE_SECRET_KEY = 'sk_test_not_for_a_production_storefront';
    assert.equal(hasRequiredStripeCheckoutConfig(), false);
    process.env.STRIPE_SECRET_KEY = 'sk_live_production_checkout_key';
    assert.equal(hasRequiredStripeCheckoutConfig(), true);
    process.env.STRIPE_SECRET_KEY = 'rk_live_production_checkout_key';
    assert.equal(hasRequiredStripeCheckoutConfig(), true);
    process.env.NODE_ENV = 'test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_local_test_key';
    assert.equal(hasRequiredStripeCheckoutConfig(), true);
  } finally {
    if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousKey;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
  // Availability is a purchase promise, so it must not report a router as
  // purchasable when the production checkout gate will reject test-mode
  // Stripe credentials.
  for (const source of [esimCheckoutRoute, wifiCheckoutRoute, availabilityRoute, webhookRoute, adminOrderRoute, bookingPage, successPage]) {
    assert.match(source, /hasRequiredStripeCheckoutConfig/);
  }
  assert.match(availabilityRoute, /!hasRequiredStripeCheckoutConfig\(\)/);
  assert.match(healthRoute, /stripe: hasRequiredStripeCheckoutConfig\(\)/);
  assert.match(productionReadiness, /export \{ hasRequiredStripeCheckoutConfig \} from '@\/lib\/stripeCheckoutConfig';/);
  assert.match(stripeCheckoutConfig, /key\.startsWith\('sk_live_'\).*key\.startsWith\('rk_live_'\)/);
});

test('signed Stripe webhooks cannot cross the configured test/live boundary', () => {
  assert.equal(stripeEventMatchesConfiguredMode('sk_live_secret', true), true);
  assert.equal(stripeEventMatchesConfiguredMode('rk_live_secret', true), true);
  assert.equal(stripeEventMatchesConfiguredMode('sk_live_secret', false), false);
  assert.equal(stripeEventMatchesConfiguredMode('rk_live_secret', false), false);
  assert.equal(stripeEventMatchesConfiguredMode('sk_test_secret', false), true);
  assert.equal(stripeEventMatchesConfiguredMode('rk_test_secret', false), true);
  assert.equal(stripeEventMatchesConfiguredMode('sk_test_secret', true), false);
  // Runtime webhook/API data is deserialised. A truthy value must not be
  // mistaken for the boolean `true` required by a live Stripe credential.
  assert.equal(stripeEventMatchesConfiguredMode('sk_live_secret', 'true'), false);
  assert.equal(stripeEventMatchesConfiguredMode('sk_live_secret', 1), false);
  assert.equal(stripeEventMatchesConfiguredMode('sk_test_secret', null), false);
  assert.equal(stripeEventMatchesConfiguredMode('unknown_secret', false), false);
  assert.match(stripeCheckoutConfig, /if \(typeof livemode !== 'boolean'\) return false/);
  assert.match(webhookRoute, /stripeEventMatchesConfiguredMode\(key,event\.livemode\)/);
  assert.match(webhookRoute, /Stripe event mode mismatch/);
  assert.match(webhookRoute, /return NextResponse\.json\(\{error:'Stripe event mode mismatch'\},\{status:400\}\)/);
});

test('customer payment confirmation and status views enforce the Stripe credential mode boundary', () => {
  assert.match(successPage, /stripeEventMatchesConfiguredMode\(key, session\.livemode\)/);
  assert.match(bookingPage, /stripeEventMatchesConfiguredMode\(key, session\.livemode\)/);
  assert.match(adminOrderRoute, /stripeEventMatchesConfiguredMode\(stripeKey, session\.livemode\)/);
  assert.match(successPage, /Stripe Checkout Session mode does not match configured credential/);
  assert.match(bookingPage, /Stripe Checkout Session mode does not match configured credential/);
  assert.match(adminOrderRoute, /Stripe Checkout Session mode does not match configured credential/);
});

test('customer confirmation views require a completed Checkout Session before presenting payment as confirmed', () => {
  // Keep the customer-facing state machine aligned with the webhook. Stripe
  // owns both fields, but an inconsistent response must fail closed instead
  // of showing an order-confirmed view or emitting a browser Purchase event.
  assert.match(successPage, /paid = session\.status === 'complete' && session\.payment_status === 'paid';/);
  assert.match(bookingPage, /const paid = session\.status === 'complete' && session\.payment_status === 'paid';/);
});

test('fulfilment recipients are explicitly configured and never fall back to a historical mailbox', () => {
  assert.match(productionReadiness, /ORDER_FULFILMENT_EMAIL \|\| process\.env\.FULFILMENT_TO \|\| ''/);
  assert.match(webhookRoute, /to=\(process\.env\.ORDER_FULFILMENT_EMAIL\|\|process\.env\.FULFILMENT_TO\|\|''\)\.trim\(\)/);
  assert.match(webhookRoute, /if\(!host\|\|!user\|\|!pass\|\|!from\|\|!to\)/);
  assert.doesNotMatch(productionReadiness, /enquiries@sgsimshop\.com/);
  assert.doesNotMatch(webhookRoute, /enquiries@sgsimshop\.com/);
});

test('SMTP transport independently validates the envelope and message header boundary', () => {
  // Checkout readiness is intentionally not the sole guard: older paid orders
  // can be retried after an environment edit, directly invoking this sender.
  assert.match(smtpClient, /export function isSafeSmtpMailbox/);
  assert.match(smtpClient, /function normalizedMailbox\(value: string, field: 'from' \| 'to'\)/);
  assert.match(smtpClient, /function safeSmtpSubject\(value: string\)/);
  assert.match(smtpClient, /normalizedMailbox\(options\.from, 'from'\)/);
  assert.match(smtpClient, /normalizedMailbox\(options\.to, 'to'\)/);
  assert.match(smtpClient, /Invalid SMTP subject/);
  assert.match(smtpClient, /const safeOptions = \{ \.\.\.options, host, from, to, subject \}/);
  assert.match(productionReadiness, /isSafeSmtpMailbox/);
  assert.match(webhookRoute, /from=\(process\.env\.SMTP_FROM\|\|user\|\|''\)\.trim\(\)/);
  assert.match(webhookRoute, /to=\(process\.env\.ORDER_FULFILMENT_EMAIL\|\|process\.env\.FULFILMENT_TO\|\|''\)\.trim\(\)/);
});

test('checkout readiness rejects an SMTP host the fulfilment transport would reject', () => {
  assert.match(smtpClient, /export function isSafeSmtpHost\(value: string \| undefined\)/);
  assert.match(smtpClient, /host\.length <= 253/);
  assert.match(smtpClient, /!\/\[\\s\\r\\n\]\//);
  assert.match(productionReadiness, /import \{ isSafeSmtpHost, isSafeSmtpMailbox \} from '@\/lib\/smtp';/);
  assert.match(productionReadiness, /isSafeSmtpHost\(host\)/);
});

test('SMTP fulfilment delivery upgrades every non-implicit-TLS transport before authentication', () => {
  assert.match(smtpClient, /if \(!options\.secure\) \{\s*await command\(activeSocket, 'STARTTLS', \[220\]\);/);
  assert.doesNotMatch(smtpClient, /!options\.secure\s*&&\s*options\.port\s*===\s*587/);
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
  // Authenticated health monitoring can run concurrently on several workers.
  // Its operations contract probe is expensive but must retain the same
  // fail-closed, success-only caching semantics as checkout readiness.
  assert.match(productionReadiness, /let operationsSchemaCheckInFlight: Promise<boolean> \| null = null/);
  assert.match(productionReadiness, /if \(Date\.now\(\) < operationsSchemaReadyUntil\) return true/);
  assert.match(productionReadiness, /if \(!operationsSchemaCheckInFlight\)/);
  assert.match(productionReadiness, /if \(ready\) operationsSchemaReadyUntil = Date\.now\(\) \+ READINESS_CACHE_MS/);
  assert.match(productionReadiness, /async function checkRequiredOperationsSchema\(\)/);
});

test('Pocket WiFi checkout fails closed when its paid-order schema is unavailable', () => {
  assert.match(wifiCheckoutRoute, /hasRequiredPaymentSchema/);
  assert.match(wifiCheckoutRoute, /if\(!await hasRequiredPaymentSchema\(\)\)/);
  assert.match(wifiCheckoutRoute, /Pocket WiFi ordering is temporarily unavailable/);
  assert.match(wifiCheckoutRoute, /'Retry-After':'30'/);
});

test('Pocket WiFi capacity cannot exceed physically saleable inventory', () => {
  // The configured fleet number is only an upper bound. Both the atomic
  // reservation paths and customer-facing availability must apply the
  // available-status on-hand ledger so quarantined or empty units are not
  // sold before dispatch discovers the shortage.
  assert.match(schema, /v_effective_inventory := least\(greatest\(0, p_inventory\), v_saleable_inventory\)/);
  assert.match(schema, /from public\.inventory_items[\s\S]*?status = 'available'/);
  assert.match(schema, /if v_effective_inventory < 1 or v_committed >= v_effective_inventory then/);
  assert.match(schema, /if v_effective_inventory < 1 or v_booked \+ v_reserved >= v_effective_inventory then/);
  assert.match(productionReadiness, /table: 'inventory_items',[\s\S]*?columns: 'id,product_type,status,quantity_on_hand'/);
  assert.match(availabilityRoute, /supabase\.from\('inventory_items'\)\.select\('quantity_on_hand'\)/);
  assert.match(availabilityRoute, /const effectiveInventory = Math\.min\(inventory, inventoryState\.saleableInventory\)/);
});

test('Pocket WiFi payment persistence atomically replaces its checkout hold with a durable capacity commitment', () => {
  assert.match(webhookRoute, /qy_persist_stripe_pocket_wifi_order/);
  assert.match(schema, /create or replace function public\.qy_persist_stripe_pocket_wifi_order/);
  assert.match(schema, /pg_advisory_xact_lock\(hashtext\('qy_roam_pocket_wifi_checkout'\)\)/);
  assert.match(schema, /payment_status = 'paid' or fulfilment_status = 'awaiting_payment'/);
  assert.match(schema, /expires_at > now\(\) - interval '4 days'/);
  assert.match(availabilityRoute, /fulfilment_status\.eq\.awaiting_payment/);
  assert.match(availabilityRoute, /CHECKOUT_WEBHOOK_HANDOFF_GRACE_MS/);
  assert.match(schema, /delete from public\.checkout_reservations[\s\S]*checkout_request_id = p_checkout_request_id and stripe_session_id = p_stripe_session_id/);
  assert.match(productionReadiness, /production_payment_persistence_rpc_check_failed/);
});

test('Pocket WiFi reservation retries revalidate current physical capacity', () => {
  // A worker may die after reserving but before creating its Stripe Session.
  // Reusing that request id must not bypass a router that was subsequently
  // quarantined, damaged, or otherwise removed from saleable stock.
  assert.doesNotMatch(schema, /if found then[\s\S]{0,300}return query select true, greatest\(0, p_inventory - 1\)/);
  assert.match(schema, /if v_existing\.checkout_request_id is not null then[\s\S]{0,300}v_effective_inventory >= 1 and v_committed <= v_effective_inventory/);
  assert.match(schema, /greatest\(0, v_effective_inventory - v_committed\)/);
});

test('Pocket WiFi capacity does not double-count dispatched routers', () => {
  // Dispatch atomically decrements the available inventory ledger. Both the
  // checkout RPC and public availability exclude assigned dispatched orders,
  // otherwise each dispatched router reduces capacity twice. Legacy rows with
  // no assigned inventory item remain conservatively committed.
  const dispatchBoundaries = schema.match(/and \(dispatched_at is null or inventory_item_id is null\)/g) || [];
  assert.equal(dispatchBoundaries.length, 2);
  assert.match(availabilityRoute, /\.or\('dispatched_at\.is\.null,inventory_item_id\.is\.null'\)/);
  assert.match(availabilityRoute, /inventory_item_id\.is\.null/);
});

test('Pocket WiFi availability does not promise stock when checkout cannot safely accept payment', () => {
  assert.match(availabilityRoute, /hasRequiredPaymentSchema/);
  assert.match(availabilityRoute, /if \(!await hasRequiredPaymentSchema\(\)\)/);
  assert.match(availabilityRoute, /hasRequiredStripeWebhookConfig/);
  assert.match(availabilityRoute, /hasRequiredFulfilmentEmailConfig/);
  assert.match(availabilityRoute, /ORDER_INTEGRITY_SECRET/);
  assert.match(availabilityRoute, /orderIntegritySecret\.length < 32/);
  assert.match(availabilityRoute, /Live availability is temporarily unavailable/);
  assert.match(availabilityRoute, /'Retry-After': '30'/);
});

test('Pocket WiFi availability bounds public Stripe and database capacity scans', () => {
  assert.match(availabilityRoute, /import \{ createCheckoutAttemptLimiter \} from '@\/lib\/checkoutRateLimit';/);
  assert.match(availabilityRoute, /const limited = createCheckoutAttemptLimiter\(60_000, 30\)/);
  assert.match(availabilityRoute, /if \(limited\(req\)\)/);
  assert.match(availabilityRoute, /Too many availability checks/);
  assert.match(availabilityRoute, /status: 429/);
  assert.match(availabilityRoute, /'Retry-After': '60'/);
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

test('idempotent checkout replays recover paid orders without a second payment attempt', () => {
  assert.match(wifiCheckoutRoute, /if\(!matchesRequestedPocketWifi\(session,requestId,requested\)\)/);
  assert.match(wifiCheckoutRoute, /currentSession\.status==='complete'&&currentSession\.payment_status==='paid'/);
  assert.match(wifiCheckoutRoute, /\{completed:true,sessionId:currentSession\.id\}/);
  assert.match(wifiCheckoutRoute, /\.eq\('stripe_session_id',currentSession\.id\)\.maybeSingle\(\)/);
  assert.match(wifiCheckoutRoute, /paymentPending:true/);
  assert.match(esimCheckoutRoute, /const currentSession = await stripe\.checkout\.sessions\.retrieve\(session\.id\)/);
  assert.match(esimCheckoutRoute, /currentSession\.status === 'complete' && currentSession\.payment_status === 'paid'/);
  assert.match(esimCheckoutRoute, /\{ completed: true, sessionId: currentSession\.id \}/);
  assert.match(esimCheckoutRoute, /paymentPending: true/);
  assert.match(homePage, /data\.completed && typeof data\.sessionId === 'string'/);
  assert.match(esimPage, /data\.completed && typeof data\.sessionId === 'string'/);
});

test('Pocket WiFi create recovery uses fresh Stripe state and confirms provenance before exposing checkout', () => {
  const createCall = wifiCheckoutRoute.indexOf("session=await stripe.checkout.sessions.create");
  const currentRead = wifiCheckoutRoute.indexOf("const currentSession=await stripe.checkout.sessions.retrieve(session.id)", createCall);
  const paidBranch = wifiCheckoutRoute.indexOf("if(currentSession.status==='complete'&&currentSession.payment_status==='paid')", currentRead);
  const expiredBranch = wifiCheckoutRoute.indexOf("if(currentSession.status==='expired')", currentRead);
  const urlResponse = wifiCheckoutRoute.indexOf("{url:currentSession.url}", currentRead);
  assert.ok(createCall > -1 && currentRead > createCall, 'the idempotent create response must be refreshed');
  assert.ok(paidBranch > currentRead && expiredBranch > paidBranch && urlResponse > expiredBranch, 'fresh state must control paid, expired, and redirect outcomes');
  assert.match(wifiCheckoutRoute.slice(currentRead, paidBranch), /validQyRoamProvenance\(currentSession\.id,currentSession\.metadata\)/);
  assert.doesNotMatch(wifiCheckoutRoute.slice(currentRead), /\{url:session\.url\}/);
});

test('Pocket WiFi open-session retries honor the freshly retrieved Stripe state', () => {
  // Listing and retrieving are separate Stripe calls. A traveller can pay or
  // the session can expire between them, so the stale listed URL must never be
  // returned without checking the retrieved session status.
  assert.match(wifiCheckoutRoute, /const existing=await stripe\.checkout\.sessions\.retrieve\(holdState\.existingSessionId\)/);
  const replayBranch = wifiCheckoutRoute.slice(
    wifiCheckoutRoute.indexOf('if(holdState.existingUrl&&holdState.existingSessionId)'),
    wifiCheckoutRoute.indexOf('const expiresAt=', wifiCheckoutRoute.indexOf('if(holdState.existingUrl&&holdState.existingSessionId)')),
  );
  assert.match(replayBranch, /matchesRequestedPocketWifi\(existing,requestId,requested\)/);
  assert.match(replayBranch, /existing\.status==='complete'&&existing\.payment_status==='paid'/);
  assert.match(replayBranch, /existing\.status==='expired'/);
  assert.match(replayBranch, /existing\.status!=='open'\|\|!existing\.url/);
  assert.match(replayBranch, /\{url:existing\.url\}/);
  assert.doesNotMatch(replayBranch, /\{url:holdState\.existingUrl\}/);
});

test('paid Pocket WiFi checkout replays release only their own linked hold', () => {
  // A response can be lost after the webhook persists payment but before it
  // removes the temporary reservation. The idempotent replay must clear that
  // stale hold promptly, without releasing another session's reservation.
  assert.match(wifiCheckoutRoute, /if\(order\.data\?\.payment_status==='paid'\)\{[\s\S]*?\.eq\('checkout_request_id',requestId\)\s*\.eq\('stripe_session_id',currentSession\.id\)/);
});

test('Pocket WiFi payment URLs require a durable matching reservation link', () => {
  assert.match(wifiCheckoutRoute, /async function linkReservationToSession/);
  assert.match(wifiCheckoutRoute, /stripe_session_id\.is\.null,stripe_session_id\.eq\.\$\{sessionId\}/);
  assert.match(wifiCheckoutRoute, /if\(!await linkReservationToSession\(supabase,requestId,existing\.id\)\)/);
  assert.match(wifiCheckoutRoute, /if\(!await linkReservationToSession\(supabase,requestId,currentSession\.id\)\)/);
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

test('fulfilment notification recovery cannot revive completed or cancelled orders', () => {
  assert.equal(fulfilmentNotificationActionable('pocket_wifi', 'paid'), true);
  assert.equal(fulfilmentNotificationActionable('pocket_wifi', 'packing'), true);
  assert.equal(fulfilmentNotificationActionable('pocket_wifi', 'dispatched'), false);
  assert.equal(fulfilmentNotificationActionable('pocket_wifi', 'returned'), false);
  assert.equal(fulfilmentNotificationActionable('pocket_wifi', 'cancelled'), false);
  assert.equal(fulfilmentNotificationActionable('esim', 'awaiting_fulfilment'), true);
  assert.equal(fulfilmentNotificationActionable('esim', 'fulfilled'), false);
  assert.equal(fulfilmentNotificationActionable('esim', 'cancelled'), false);
});

test('Pocket WiFi cannot leave the return workflow after physical dispatch', () => {
  assert.deepEqual(allowedFulfilmentStatuses('pocket_wifi', 'dispatched'), [
    'dispatched', 'with_customer', 'return_due', 'returned'
  ]);
  assert.deepEqual(allowedFulfilmentStatuses('pocket_wifi', 'with_customer'), [
    'with_customer', 'return_due', 'returned'
  ]);
  assert.deepEqual(allowedFulfilmentStatuses('pocket_wifi', 'return_due'), [
    'return_due', 'returned'
  ]);
  for (const [current, next] of [
    ['dispatched', 'packing'],
    ['with_customer', 'dispatched'],
    ['return_due', 'with_customer'],
  ]) assert.equal(validFulfilmentTransition('pocket_wifi', current, next), false);

  assert.doesNotMatch(schema, /p_expected_status = 'dispatched' and p_next_status in \('packing'/);
  assert.doesNotMatch(schema, /p_expected_status = 'with_customer' and p_next_status in \('dispatched'/);
  assert.doesNotMatch(schema, /p_expected_status = 'return_due' and p_next_status in \('with_customer'/);
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

test('Pocket WiFi Stripe-hold scans paginate recent sessions with a fail-closed work ceiling', () => {
  for (const source of [wifiCheckoutRoute, availabilityRoute]) {
    assert.match(source, /created:\s*\{\s*gte:\s*cutoff\s*\}/);
    assert.match(source, /starting_after/);
    assert.doesNotMatch(source, /limit:\s*(?:[1-9]|[1-9]\d)(?!\d)/);
    assert.match(source, /pagesScanned\s*>=\s*MAX_STRIPE_HOLD_SCAN_PAGES/);
    assert.match(source, /Stripe Pocket WiFi hold scan exceeded its safe page limit/);
  }
  const checkoutExpiry = fs.readFileSync(require.resolve('../lib/checkoutExpiry.ts'), 'utf8');
  assert.match(checkoutExpiry, /export const MAX_STRIPE_HOLD_SCAN_PAGES\s*=\s*5/);
});

test('Pocket WiFi holds require server-issued checkout provenance', () => {
  const checkoutRoute = fs.readFileSync(require.resolve('../app/api/checkout/route.ts'), 'utf8');
  for (const source of [checkoutRoute, availabilityRoute]) {
    assert.match(source, /validQyRoamProvenance\(session\.id,\s*session\.metadata\)/);
  }
});

test('Pocket WiFi holds require an explicit Pocket WiFi product identity', () => {
  const checkoutRoute = fs.readFileSync(require.resolve('../app/api/checkout/route.ts'), 'utf8');
  for (const source of [checkoutRoute, availabilityRoute]) {
    assert.match(source, /session\.metadata\?\.product_type\s*!==?\s*['"]pocket_wifi['"]/);
    assert.doesNotMatch(source, /session\.metadata\?\.product_type\s*&&\s*session\.metadata\.product_type\s*!==?\s*['"]pocket_wifi['"]/);
  }
});

test('manual orders cannot bypass paid-order lifecycle, pricing, or WiFi capacity fields', () => {
  assert.match(adminOpsRoute, /\['paid', 'unpaid', 'pending', 'failed'\]\.includes\(paymentStatus\)/);
  assert.match(adminOpsRoute, /function money\(value: unknown\)/);
  assert.match(adminOpsRoute, /parseExactIsoDate\(startRaw\)/);
  assert.match(adminOpsRoute, /New orders must start in their initial fulfilment status/);
  assert.match(adminOpsRoute, /Pocket WiFi orders require a destination and valid travel start and end dates/);
});

test('manual eSIM orders retain the same safe email delivery boundary as Checkout', () => {
  assert.match(adminOpsRoute, /import \{ isSafeSmtpMailbox \} from '@\/lib\/smtp';/);
  assert.match(adminOpsRoute, /product === 'esim' && !isSafeSmtpMailbox\(row\.email \|\| undefined\)/);
  assert.match(adminOpsRoute, /eSIM orders require a valid customer email for digital delivery/);
  assert.match(manualOrderForm, /eSIM orders require a valid customer email for digital delivery/);
});

test('opening Pocket WiFi stock is created through an audited database boundary', () => {
  assert.match(adminOpsRoute, /qy_create_inventory_item/);
  assert.doesNotMatch(adminOpsRoute, /from\('inventory_items'\)\.insert\(row\)/);
  assert.match(schema, /create or replace function public\.qy_create_inventory_item/);
  assert.match(schema, /'opening_stock'/);
  assert.match(schema, /grant execute on function public\.qy_create_inventory_item\(text,text,text,text,text,integer,integer,numeric,text,text\) to service_role/);
  assert.match(productionReadiness, /qy_create_inventory_item/);
  assert.match(productionReadiness, /inventory SKU is required/);
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

test('database enforces product-specific fulfilment status domains on new order writes', () => {
  // API validation is useful feedback for staff, but this constraint is the
  // final persistence boundary for webhook recovery and service-role work.
  // NOT VALID preserves visibility of any historic imports while PostgreSQL
  // still enforces the rule for all subsequent inserts and updates.
  assert.match(schema, /orders_product_fulfilment_status_check/);
  assert.match(schema, /product_type = 'pocket_wifi' and fulfilment_status in \(/);
  assert.match(schema, /'with_customer', 'return_due', 'returned', 'closed', 'cancelled'/);
  assert.match(schema, /product_type = 'esim' and fulfilment_status in \(/);
  assert.match(schema, /'awaiting_fulfilment', 'fulfilled',\s*'closed', 'cancelled'/);
  assert.match(schema, /\) not valid;/);
});

test('fulfilled eSIM orders cannot be reopened or cancelled after digital delivery', () => {
  assert.equal(validFulfilmentTransition('esim', 'awaiting_fulfilment', 'fulfilled'), true);
  assert.equal(validFulfilmentTransition('esim', 'awaiting_fulfilment', 'cancelled'), true);
  assert.equal(validFulfilmentTransition('esim', 'fulfilled', 'closed'), true);
  assert.equal(validFulfilmentTransition('esim', 'fulfilled', 'awaiting_fulfilment'), false);
  assert.equal(validFulfilmentTransition('esim', 'fulfilled', 'cancelled'), false);
});

test('eSIM fulfilment requires a non-secret delivery audit reference', () => {
  assert.match(adminOrderRoute, /function digitalDeliveryReference\(value: unknown, existing: string \| null\)/);
  assert.match(adminOrderRoute, /status === 'fulfilled' && !deliveryReference/);
  assert.match(adminOrderRoute, /A delivery reference is required before marking an eSIM order fulfilled/);
  assert.match(adminOrderRoute, /patch\.digital_delivery_reference = deliveryReference \|\| null/);
  assert.match(adminOrderActions, /status === 'fulfilled' && !deliveryReference\.trim\(\)/);
  assert.match(adminOrderActions, /aria-label="eSIM delivery reference"/);
  assert.match(adminOrderActions, /Do not enter the QR code/);
  assert.match(schema, /digital_delivery_reference text/);
  assert.match(productionReadiness, /digital_delivery_reference/);
  assert.match(adminPage, /digitalDeliveryReference=\{isSafeDigitalDeliveryReference\(o\.digital_delivery_reference\) \? o\.digital_delivery_reference : ''\}/);
});

test('eSIM delivery references are safe audit pointers and cannot be changed after fulfilment', () => {
  assert.equal(digitalDeliveryReferenceIssue('Provider order #QYR-1024'), null);
  for (const unsafe of ['LPA:1$consumer.smdp.example$activation-token', 'QR code: ABC123', 'https://provider.example/delivery/secret', 'mail log\nsecret']) {
    assert.notEqual(digitalDeliveryReferenceIssue(unsafe), null);
    assert.equal(isSafeDigitalDeliveryReference(unsafe), false);
  }
  assert.match(adminOrderRoute, /The delivery reference is immutable after an eSIM order is fulfilled/);
  assert.match(adminOrderRoute, /digitalDeliveryReferenceIssue\(deliveryReference\)/);
  assert.match(adminPage, /Unsafe legacy delivery value hidden/);
  assert.match(adminPage, /isSafeDigitalDeliveryReference\(o\.digital_delivery_reference\) \? o\.digital_delivery_reference : ''/);
  assert.match(adminOrderActions, /if \(deliveryReference\.trim\(\)\) body\.digital_delivery_reference = deliveryReference/);
  assert.match(adminOrderActions, /readOnly=\{currentStatus === 'fulfilled'\}/);
  assert.match(schema, /orders_digital_delivery_reference_safe_check/);
  assert.match(schema, /digital_delivery_reference !~\* '\(lpa:/);
  assert.match(schema, /orders_esim_fulfilled_delivery_reference_required_check/);
  assert.match(schema, /digital_delivery_reference is not null and btrim\(digital_delivery_reference\) <> ''/);
  assert.match(schema, /qy_enforce_esim_delivery_reference_immutability/);
  assert.match(schema, /old\.fulfilment_status = 'fulfilled'/);
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

test('database preserves dispatch and return evidence throughout the Pocket WiFi lifecycle', () => {
  // The RPC is the atomic stock-movement authority, but this protects service
  // role recovery/import writes from making a device look dispatched or
  // returned without the durable evidence needed to reconcile that movement.
  assert.match(schema, /orders_pocket_wifi_dispatch_evidence_check/);
  assert.match(schema, /inventory_item_id is not null/);
  assert.match(schema, /dispatched_at is not null/);
  assert.match(schema, /courier_tracking is not null and btrim\(courier_tracking\) <> ''/);
  assert.match(schema, /orders_pocket_wifi_return_evidence_check/);
  assert.match(schema, /returned_at is not null/);
  assert.match(schema, /return_tracking is not null and btrim\(return_tracking\) <> ''/);
  assert.match(schema, /return_disposition in \('restock', 'quarantine', 'damaged'\)/);
});

test('Pocket WiFi dispatch and return atomically reconcile the assigned stock item', () => {
  const schema = fs.readFileSync(require.resolve('../supabase/schema.sql'), 'utf8');
  assert.match(schema, /add column if not exists inventory_item_id bigint references public\.inventory_items/);
  assert.match(schema, /create or replace function public\.qy_transition_pocket_wifi_order/);
  assert.match(schema, /movement_type, quantity, reference, notes\)\s*\n    values \(v_item_id, 'dispatch', -1/);
  assert.match(schema, /case v_return_disposition when 'restock' then 'return'/);
  assert.match(schema, /case when v_return_disposition = 'restock' then 1 else 0 end/);
  assert.match(adminOrderRoute, /rpc\('qy_transition_pocket_wifi_order'/);
  assert.match(adminOrderActions, /Select the Pocket WiFi inventory item being dispatched/);
});

test('Pocket WiFi returns explicitly quarantine damaged or inspection-required units instead of silently restocking them', () => {
  assert.match(schema, /return_disposition text/);
  assert.match(schema, /p_return_disposition text/);
  assert.doesNotMatch(schema, /p_return_disposition text default/);
  assert.match(schema, /Require an explicit[\s\S]*rather than defaulting an omitted[\s\S]*restock/);
  assert.match(schema, /v_return_disposition not in \('restock', 'quarantine', 'damaged'\)/);
  assert.match(schema, /case when v_return_disposition = 'restock' then 1 else 0 end/);
  assert.match(schema, /return_quarantined/);
  assert.match(adminOrderRoute, /\['restock', 'quarantine', 'damaged'\]/);
  assert.match(adminOrderActions, /Quarantine for inspection/);
  assert.match(adminOrderActions, /Damaged — do not restock/);
  assert.match(adminOrderActions, /status === 'returned' && !returnDisposition/);
  assert.match(adminOrderActions, /Choose inspection disposition/);
  assert.match(productionReadiness, /return_disposition/);
});

test('Pocket WiFi non-restock returns remove the exact device from dispatchable stock until inspection clears it', () => {
  assert.match(schema, /set status = case when v_return_disposition = 'damaged' then 'damaged' else 'quarantined' end/);
  assert.match(schema, /status = 'available'/);
  assert.match(adminOpsRoute, /action === 'inventory_status'/);
  assert.match(adminOpsRoute, /\['available', 'quarantined', 'damaged', 'maintenance'\]/);
  assert.match(inventoryPage, /InventoryStatusForm items=\{items\}/);
});

test('Pocket WiFi inspection status changes are durably audited before a unit can return to service', () => {
  assert.match(schema, /movement_type in \('return_quarantined', 'return_damaged', 'status_change'\)/);
  assert.match(schema, /create or replace function public\.qy_set_inventory_status/);
  assert.match(schema, /'status_change',\s*\n    0,/);
  assert.match(schema, /grant execute on function public\.qy_set_inventory_status\(bigint,text,text,text\) to service_role/);
  assert.match(adminOpsRoute, /rpc\('qy_set_inventory_status'/);
  assert.doesNotMatch(adminOpsRoute, /from\('inventory_items'\)\s*\n\s*\.update\(\{ status/);
  assert.match(adminOpsRoute, /p_reference: reference/);
  assert.match(adminOpsRoute, /p_notes: text\(body\.notes, 1000\) \|\| null/);
});

test('generic inventory adjustments cannot bypass the Pocket WiFi hand-off and inspection audit boundaries', () => {
  assert.match(schema, /dispatches and returns must be recorded through the Pocket WiFi order workflow/);
  assert.match(schema, /inventory adjustment reference is required/);
  assert.match(schema, /inventory status reference is required/);
  assert.match(adminOpsRoute, /Use the Pocket WiFi order workflow to record dispatches and returns/);
  assert.match(adminOpsRoute, /An inventory adjustment reference is required/);
  assert.match(adminOpsRoute, /An inspection or repair reference is required before changing device status/);
  assert.doesNotMatch(adminOpsForms, /<option>dispatch<\/option>/);
  assert.doesNotMatch(adminOpsForms, /<option>return<\/option>/);
  assert.match(adminOpsForms, /name="reference" placeholder="Count sheet \/ PO reference" required/);
  assert.match(adminOpsForms, /name="reference" placeholder="Inspection \/ repair reference" required/);
});

test('production readiness verifies the deployed Pocket WiFi dispatch and return contract', () => {
  assert.match(productionReadiness, /inventory_item_id,courier_tracking,return_tracking,digital_delivery_reference,return_disposition,dispatched_at,returned_at/);
  assert.match(productionReadiness, /database\.rpc\('qy_transition_pocket_wifi_order'/);
  assert.match(productionReadiness, /database\.rpc\('qy_adjust_inventory'/);
  assert.match(productionReadiness, /database\.rpc\('qy_set_inventory_status'/);
  assert.match(productionReadiness, /database\.rpc\('qy_create_manual_pocket_wifi_order'/);
  assert.match(productionReadiness, /p_order_id: 0/);
  assert.match(productionReadiness, /p_item_id: 0/);
  assert.match(productionReadiness, /production_operations_inventory_rpc_check_failed/);
  assert.match(productionReadiness, /manual order reference is required/);
  assert.match(productionReadiness, /production_operations_manual_order_rpc_check_failed/);
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

test('admin operational visibility pages beyond one Supabase response and warns before a bounded view can hide work', () => {
  // Order, fulfilment-email, and CAPI exception counts must not silently stop
  // at the first response once the business has more than a few hundred rows.
  // The hard ceiling keeps server rendering bounded, while the alert prevents
  // staff from treating a partial view as complete operations data.
  assert.match(adminPage, /const ADMIN_PAGE_SIZE = 250/);
  assert.match(adminPage, /const ADMIN_MAX_ROWS = 5_000/);
  assert.match(adminPage, /async function loadPages/);
  assert.match(adminPage, /\.range\(from, to\)/);
  assert.match(adminPage, /const truncatedPanels = \[/);
  assert.match(adminPage, /Operational data needs archiving or a dedicated reporting view/);
  assert.doesNotMatch(adminPage, /from\('orders'\)\.select\('\*'\)\.order\('created_at', \{ ascending: false \}\)\.limit\(500\)/);
});

test('launch control reports the same checkout prerequisites that protect real orders', () => {
  // The launch dashboard is an operational decision surface. It must not show
  // a green storefront state based only on a Stripe key and partial schema
  // probe while either public checkout route would reject a customer.
  assert.match(launchPage, /function isProductionSiteUrl/);
  assert.match(launchPage, /function hasLiveStripeSecret/);
  assert.match(launchPage, /hasRequiredStripeWebhookConfig\(\)/);
  assert.match(launchPage, /function hasOrderIntegritySecret/);
  assert.match(launchPage, /hasRequiredEsimOrderSchema\(\)/);
  assert.match(launchPage, /const commonCheckoutReady=stripe&&webhook&&site&&orderIntegrity&&smtp/);
  assert.match(launchPage, /const esimReady=commonCheckoutReady&&esimOrderDbOk/);
  assert.match(launchPage, /const wifiReady=commonCheckoutReady&&paymentDbOk&&wifiInventory/);
  assert.doesNotMatch(launchPage, /const esimReady=.*paymentDbOk/);
  assert.match(launchPage, /const paidReady=esimReady&&wifiReady&&metaCapi/);
  assert.match(launchPage, /eSIM checkout blockers/);
  assert.match(launchPage, /Pocket WiFi checkout blockers/);
  assert.match(launchPage, /eSIM checkout/);
  assert.match(launchPage, /Pocket WiFi checkout/);
  assert.doesNotMatch(launchPage, /const site=true/);
  assert.doesNotMatch(launchPage, /const organicReady=stripe&&paymentDbOk/);
});

test('authenticated health readiness fails when any order-critical dependency is unavailable', () => {
  // Public unauthenticated probes intentionally report process liveness, but
  // the token-authenticated response is used as the production readiness
  // boundary and must not return 200 for a service unable to take orders.
  assert.match(healthRoute, /hasRequiredEsimOrderSchema/);
  assert.match(healthRoute, /const \[esimOrderSchema, paymentSchema, operationsSchema\] = await Promise\.all\(\[/);
  assert.match(healthRoute, /esimOrderSchema,/);
  assert.match(healthRoute, /const launchReady = Object\.values\(checks\)\.every\(Boolean\)/);
  assert.match(healthRoute, /ok: launchReady/);
  assert.match(healthRoute, /status: launchReady \? 200 : 503/);
  assert.doesNotMatch(healthRoute, /const coreReady/);
});

test('inventory visibility distinguishes unavailable data from zero stock and exposes saleable router stock', () => {
  assert.match(inventoryPage, /await Promise\.all\(\[/);
  assert.match(inventoryPage, /const failedPanels=\[itemsResult\.error&&'inventory register',movesResult\.error&&'movement audit trail'\]/);
  assert.match(inventoryPage, /Operational inventory data is currently unavailable/);
  assert.match(inventoryPage, /Do not treat empty lists or totals as current stock/);
  assert.match(inventoryPage, /x\.product_type==='pocket_wifi'&&x\.status==='available'/);
  assert.match(inventoryPage, /Saleable Pocket WiFi units/);
  assert.match(inventoryPage, /Quarantined Pocket WiFi units/);
});

test('inventory register and movement audit visibility page beyond one Supabase response and warn before a bounded view can hide operations data', () => {
  assert.match(inventoryPage, /const INVENTORY_ITEM_PAGE_SIZE=250/);
  assert.match(inventoryPage, /const INVENTORY_ITEM_MAX_ROWS=5_000/);
  assert.match(inventoryPage, /async function loadInventoryItemPages/);
  assert.match(inventoryPage, /from\('inventory_items'\)\.select\('\*'\)\.order\('name'\)\.order\('id'\)\.range\(from,from\+INVENTORY_ITEM_PAGE_SIZE-1\)/);
  assert.match(inventoryPage, /itemsResult\.truncated/);
  assert.match(inventoryPage, /Do not treat the stock totals, asset count, or device selector as complete/);
  assert.match(inventoryPage, /const INVENTORY_MOVEMENT_PAGE_SIZE=250/);
  assert.match(inventoryPage, /const INVENTORY_MOVEMENT_MAX_ROWS=5_000/);
  assert.match(inventoryPage, /async function loadMovementPages/);
  assert.match(inventoryPage, /\.range\(from,from\+INVENTORY_MOVEMENT_PAGE_SIZE-1\)/);
  assert.match(inventoryPage, /\.range\(INVENTORY_MOVEMENT_MAX_ROWS,INVENTORY_MOVEMENT_MAX_ROWS\)/);
  assert.match(inventoryPage, /movesResult\.truncated&&/);
  assert.match(inventoryPage, /Inventory movement history needs archiving or a dedicated audit view/);
});

test('admin order visibility identifies the specific Meta CAPI delivery needing recovery', () => {
  assert.match(adminPage, /const metaDeliveryBySession = new Map/);
  assert.match(adminPage, /const metaDeliveryExceptions = orders\.filter/);
  assert.match(adminPage, /order\.measurement_consent === 'accepted'/);
  assert.match(adminPage, /metaDeliveryExceptions\.length/);
  assert.match(adminPage, /const metaDelivery:any = metaDeliveryBySession\.get\(o\.stripe_session_id\)/);
  assert.match(adminPage, /Meta CAPI/);
  assert.match(adminPage, /metaDelivery\?\.last_error/);
  assert.match(adminPage, /Not requested \/ not recorded/);
});

test('admin email exceptions include paid Stripe orders missing their notification ledger', () => {
  assert.match(adminPage, /const notificationExceptions = orders\.filter/);
  assert.match(adminPage, /isStripeCheckoutOrder\(order\)/);
  assert.match(adminPage, /fulfilmentNotificationActionable\(order\.product_type, order\.fulfilment_status\)/);
  assert.match(adminPage, /notificationBySession\.get\(order\.stripe_session_id\)\?\.status !== 'sent'/);
  assert.match(adminPage, /notificationExceptions\.length/);
  assert.match(adminPage, /canRetryNotifications/);
  assert.match(adminOrderActions, /canRetryNotifications = false/);
  assert.match(adminOrderActions, /\{canRetryNotifications && <button/);
});

test('admin CAPI recovery is limited to consented purchases and remains available after email delivery', () => {
  assert.match(schema, /measurement_consent text/);
  assert.match(productionReadiness, /measurement_consent/);
  assert.match(webhookRoute, /const measurementConsent=session\.metadata\?\.measurement_consent==='accepted'\?'accepted':'essential'/);
  assert.match(webhookRoute, /measurement_consent:measurementConsent/);
  assert.match(adminPage, /fulfilmentNotificationActionable\(o\.product_type, o\.fulfilment_status\) && notification\?\.status !== 'sent'[\s\S]{0,180}o\.measurement_consent === 'accepted' && metaDelivery\?\.status !== 'sent'/);
  assert.match(adminOrderActions, /Retry order deliveries/);
});

test('admin recovery only resumes actionable fulfilment while preserving consented CAPI recovery', () => {
  assert.match(adminOrderRoute, /export async function POST/);
  assert.match(adminOrderRoute, /validateQyRoamSession\(session\)/);
  assert.match(adminOrderRoute, /fulfilmentNotificationActionable\(validation\.productType, order\.fulfilment_status\)/);
  assert.match(adminOrderRoute, /const metaRequested = order\.measurement_consent === 'accepted'/);
  assert.match(adminOrderRoute, /if \(metaRequested && !hasRequiredMetaCapiPurchaseConfig\(\)\)/);
  assert.match(adminOrderRoute, /const retryMeta = metaRequested/);
  assert.match(adminOrderRoute, /deliverFulfilmentNotification\(supabase, session\)/);
  assert.match(adminOrderRoute, /deliverMetaPurchase\(supabase, session, metaEventTime\)/);
  assert.match(adminOrderActions, /Retry order deliveries/);
});

test('SMTP and Meta delivery settlement retain ownership of their sending leases', () => {
  // A worker can outlive the stale-lease timeout while its provider call is
  // in flight. Its completion or failure must not overwrite the newer retry.
  assert.match(webhookRoute, /Fulfilment notification delivery lease was lost/);
  assert.match(webhookRoute, /Meta purchase delivery lease was lost/);
  assert.match(webhookRoute, /from\('fulfilment_notifications'\)[\s\S]{0,700}\.eq\('status','sending'\)\.eq\('updated_at',now\)/);
  assert.match(webhookRoute, /from\('meta_purchase_deliveries'\)[\s\S]{0,700}\.eq\('status','sending'\)\.eq\('updated_at',now\)/);
});

test('invalid delivery-lease timestamps are recoverable instead of permanently blocking paid-order retries', () => {
  assert.match(webhookRoute, /const DELIVERY_LEASE_STALE_MS=15\*60_000/);
  assert.match(webhookRoute, /function deliveryLeaseIsStale\(updatedAt: string \| null \| undefined\)/);
  assert.match(webhookRoute, /return !Number\.isFinite\(updatedAtMs\)\|\|Date\.now\(\)-updatedAtMs>DELIVERY_LEASE_STALE_MS/);
  assert.match(webhookRoute, /notification\.status==='sending'&&deliveryLeaseIsStale\(notification\.updated_at\)/);
  assert.match(webhookRoute, /delivery\.status==='sending'&&deliveryLeaseIsStale\(delivery\.updated_at\)/);
});

test('Stripe order persistence cannot overwrite concurrent fulfilment progress', () => {
  // An operator or another webhook can change either field after the initial
  // read. The update must compare both values and retry from the winning row.
  assert.match(webhookRoute, /for\(let attempt=0;attempt<5;attempt\+=1\)/);
  assert.match(webhookRoute, /\.eq\('fulfilment_status',existing\.data\.fulfilment_status\)/);
  assert.match(webhookRoute, /update\.is\('payment_status',null\)/);
  assert.match(webhookRoute, /update\.eq\('payment_status',existing\.data\.payment_status\)/);
  assert.match(webhookRoute, /if\(updated\.data\?\.length===1\) return/);
  assert.doesNotMatch(webhookRoute, /if\(inserted\.error\.code!==['"]23505['"]\)[\s\S]{0,300}from\('orders'\)\.update\(order\)/);
});

test('failed Stripe webhook claims remain visible and immediately retryable', () => {
  assert.match(schema, /stripe_events add column if not exists attempts integer not null default 1/);
  assert.match(schema, /stripe_events add column if not exists last_failed_at timestamptz/);
  assert.match(schema, /stripe_events add column if not exists last_error text/);
  assert.match(productionReadiness, /processing_started_at,processed_at,attempts,last_failed_at,last_error/);
  assert.match(webhookRoute, /async function recordEventFailure/);
  assert.match(webhookRoute, /last_error:message\.slice\(0,500\)/);
  assert.match(webhookRoute, /!existing\.data\?\.last_error/);
  assert.doesNotMatch(webhookRoute, /from\('stripe_events'\)\.delete\(\)/);
  assert.match(adminPage, /Stripe webhook failures/);
  assert.match(adminPage, /failed or abandoned events awaiting a signed retry/);
});

test('durable Stripe delivery ledgers upgrade every retry and ownership field additively', () => {
  // A live project can have one of these tables from an earlier release.
  // `create table if not exists` alone does not add later columns, so ensure
  // the clean-install schema remains a safe upgrade migration as well.
  for (const [table, fields] of [
    ['fulfilment_notifications', ['status text not null default \'pending\'', 'attempts integer not null default 0', 'last_attempt_at timestamptz', 'sent_at timestamptz', 'last_error text', 'created_at timestamptz not null default now()', 'updated_at timestamptz not null default now()']],
    ['meta_purchase_deliveries', ['status text not null default \'pending\'', 'attempts integer not null default 0', 'last_attempt_at timestamptz', 'sent_at timestamptz', 'last_error text', 'created_at timestamptz not null default now()', 'updated_at timestamptz not null default now()', 'event_time bigint']],
  ]) {
    for (const field of fields) {
      assert.match(schema, new RegExp(`alter table public\\.${table} add column if not exists ${field.replace(/[()]/g, '\\$&')}`));
    }
  }
});

test('admin visibility detects abandoned Stripe claims using the webhook recovery lease', () => {
  // A process can terminate before recordEventFailure runs. Such a claim has
  // no last_error, but it is just as actionable once the webhook lease expires.
  assert.equal(STRIPE_EVENT_CLAIM_STALE_MS, 30 * 60_000);
  assert.match(webhookRoute, /Date\.now\(\)-previousStartedMs<=STRIPE_EVENT_CLAIM_STALE_MS/);
  assert.match(adminPage, /select\('event_id,event_type,stripe_session_id,attempts,processing_started_at,last_failed_at,last_error'\)/);
  assert.match(adminPage, /last_error\.not\.is\.null,processing_started_at\.lt\.\$\{webhookExceptionCutoff\}/);
  assert.match(adminPage, /if \(event\.last_error\) return true/);
  assert.match(adminPage, /Date\.now\(\) - processingStartedMs > STRIPE_EVENT_CLAIM_STALE_MS/);
  assert.match(adminPage, /failed or abandoned events awaiting a signed retry/);
  assert.match(adminPage, /Processing worker stopped before completion/);
});

test('Stripe event idempotency records stay bound to one event type and Checkout Session', () => {
  // A corrupt or imported row must never make a different signed event look
  // processed, in-flight, or eligible for stale-lease takeover solely because
  // its event_id collides with the ledger primary key.
  assert.match(webhookRoute, /select\('event_type,stripe_session_id,processed_at,processing_started_at,last_error,attempts'\)/);
  const duplicateClaim = webhookRoute.slice(
    webhookRoute.indexOf("if(claimed.error?.code==='23505')"),
    webhookRoute.indexOf('async function recordEventFailure'),
  );
  const identityGuard = duplicateClaim.indexOf("existing.data.event_type!==type||existing.data.stripe_session_id!==sessionId");
  const processedAck = duplicateClaim.indexOf("if(existing.data?.processed_at) return {status:'processed'}");
  const staleReclaim = duplicateClaim.indexOf("const reclaimed=await supabase.from('stripe_events')");
  assert.notEqual(identityGuard, -1);
  assert.ok(identityGuard < processedAck);
  assert.ok(identityGuard < staleReclaim);
  assert.match(duplicateClaim, /Stripe event idempotency identity mismatch/);
});

test('Stripe terminal events must agree with their Checkout Session payment state before any mutation', () => {
  const webhookRoute = fs.readFileSync(require.resolve('../app/api/stripe-webhook/route.ts'), 'utf8');
  assert.match(webhookRoute, /function stripeCheckoutEventStateIssue\(eventType:Stripe\.Event\.Type,session:Stripe\.Checkout\.Session\)/);
  assert.match(webhookRoute, /eventType==='checkout\.session\.expired'[\s\S]{0,220}session\.status==='expired'&&session\.payment_status!=='paid'/);
  assert.match(webhookRoute, /session\.status!=='complete'/);
  assert.match(webhookRoute, /eventType==='checkout\.session\.async_payment_succeeded'&&session\.payment_status!=='paid'/);
  assert.match(webhookRoute, /eventType==='checkout\.session\.async_payment_failed'&&session\.payment_status==='paid'/);
  const stateCheck = webhookRoute.indexOf('const eventStateIssue=stripeCheckoutEventStateIssue(event.type,eventStateSession)');
  const expiryMutation = webhookRoute.indexOf("if(event.type==='checkout.session.expired')");
  const paidValidation = webhookRoute.indexOf('const validation=validateQyRoamSession(sessionForEvent)');
  const paidClaim = webhookRoute.lastIndexOf("const eventClaimId=`stripe:${stripeEventId}`", paidValidation);
  assert.ok(stateCheck > 0 && stateCheck < expiryMutation && paidClaim < paidValidation);
  assert.match(webhookRoute, /stripe_webhook_event_state_error/);
  assert.match(webhookRoute, /Stripe event state validation failed/);
  assert.ok(paidClaim < webhookRoute.indexOf('if(eventStateIssue) {', paidClaim), 'invalid paid-event state must be retained in the durable event ledger');
});

test('Stripe payment event timestamps are bounded before order persistence or CAPI delivery', () => {
  const now = 1_800_000_000;
  assert.equal(validStripeEventCreated(now, now), now);
  assert.equal(validStripeEventCreated(now - 86_400, now), now - 86_400, 'historical Stripe retries remain valid');
  assert.equal(validStripeEventCreated(0, now), null);
  assert.equal(validStripeEventCreated(1.5, now), null);
  assert.equal(validStripeEventCreated(now + STRIPE_EVENT_CREATED_MAX_FUTURE_SECONDS + 1, now), null);

  const paidClaim = webhookRoute.lastIndexOf("const eventClaimId=`stripe:${stripeEventId}`");
  const timestampValidation = webhookRoute.indexOf('const eventCreated=validStripeEventCreated(event.created)', paidClaim);
  const persistence = webhookRoute.indexOf('await persistSession(sessionForEvent,event.type,eventCreated)', timestampValidation);
  const capiDelivery = webhookRoute.indexOf('await deliverPaidOrderSideEffects(supabase,sessionForEvent,eventCreated)', timestampValidation);
  assert.ok(timestampValidation > paidClaim, 'invalid timestamp must be retained in the claimed webhook ledger');
  assert.ok(persistence > timestampValidation && capiDelivery > timestampValidation);
  assert.match(webhookRoute, /Invalid Stripe event timestamp/);
});

test('signed QY Roam integrity failures remain visible in the webhook recovery ledger', () => {
  const validation = webhookRoute.indexOf('const validation=validateQyRoamSession(sessionForEvent)');
  const paidClaim = webhookRoute.lastIndexOf("const eventClaimId=`stripe:${stripeEventId}`", validation);
  const failureRecord = webhookRoute.indexOf('if(claimStartedAt) await recordEventFailure(supabase,eventClaimId,claimStartedAt,error)', validation);
  assert.ok(paidClaim >= 0 && validation > paidClaim, 'claim before validating the persisted order boundary');
  assert.ok(failureRecord > validation, 'malformed signed events must be recorded for operator recovery');
  assert.match(webhookRoute, /Order integrity validation failed: \$\{validation\.reason\}/);
});

test('Stripe terminal events refresh the Checkout Session before persisting or delivering an order', () => {
  const processing = webhookRoute.slice(
    webhookRoute.indexOf("if(!['checkout.session.completed'"),
    webhookRoute.indexOf("if(event.type==='checkout.session.expired')"),
  );
  const sourceBoundary = processing.indexOf("if(eventSession.metadata?.source!=='qyroam.com')");
  const sessionIdBoundary = processing.indexOf('const eventSessionId=validStripeCheckoutSessionId(eventSession.id)');
  const refresh = processing.indexOf('session=await stripe.checkout.sessions.retrieve(eventSessionId)');
  const identityBoundary = processing.indexOf('if(session.id!==eventSessionId||session.livemode!==event.livemode)');
  const eventState = processing.indexOf('const eventStateIssue=stripeCheckoutEventStateIssue(event.type,eventStateSession)');
  assert.ok(sourceBoundary >= 0 && sessionIdBoundary > sourceBoundary && refresh > sessionIdBoundary, 'only QY Roam events with a valid bounded Session id should cause a Stripe Session refresh');
  assert.ok(identityBoundary > refresh, 'the refreshed Session must match the signed event identity and mode');
  assert.ok(eventState > identityBoundary, 'terminal-state validation must occur after the refreshed Session identity boundary');
  assert.match(processing, /stripe_webhook_invalid_session_id/);
  assert.match(processing, /stripe_webhook_session_retrieve_error/);
  assert.match(processing, /stripe_webhook_session_identity_mismatch/);
  assert.match(processing, /Retrieved Checkout Session does not match webhook event/);
});

test('fulfilment-bearing Stripe events are durably claimed before the outbound Session refresh', () => {
  const claimPosition = webhookRoute.indexOf("claimOnce(supabase,eventClaimId,event.type,eventSessionId)");
  const retrievePosition = webhookRoute.indexOf('stripe.checkout.sessions.retrieve(eventSessionId)');
  assert.ok(claimPosition >= 0 && claimPosition < retrievePosition);
  assert.match(webhookRoute, /stripe_webhook_session_retrieve_error[\s\S]*recordEventFailure\(supabase,eventClaimId,claimStartedAt,error\)/);
  assert.match(webhookRoute, /stripe_webhook_session_identity_mismatch[\s\S]*recordEventFailure\(supabase,eventClaimId,claimStartedAt,new Error\('Retrieved Checkout Session does not match webhook event'\)\)/);
  // Inventory-release events retain their stricter provenance-before-claim
  // ordering so sessions from another product in a shared account cannot
  // pollute QY Roam's operational recovery ledger.
  const expiryBranch = webhookRoute.indexOf("if(event.type==='checkout.session.expired'){");
  const expiryProvenance = webhookRoute.indexOf('if(!validQyRoamProvenance(session.id,session.metadata))', expiryBranch);
  const expiryClaim = webhookRoute.indexOf('claimOnce(supabase,expiryEventClaimId,event.type,session.id)', expiryBranch);
  assert.ok(expiryProvenance >= 0 && expiryProvenance < expiryClaim);
});

test('retried completion events cannot steal a later asynchronous payment timestamp', () => {
  // Customer and shipping data come from the fresh Stripe read, but the
  // signed event snapshot remains authoritative for the transition. This
  // prevents an originally-unpaid completion retry from observing a later
  // paid Session and backdating both payment_confirmed_at and Meta Purchase.
  assert.match(webhookRoute, /const eventStateSession=event\.type==='checkout\.session\.expired'\?session:eventSession/);
  assert.match(webhookRoute, /status:eventSession\.status,[\s\S]*payment_status:eventSession\.payment_status/);
  assert.match(webhookRoute, /persistSession\(sessionForEvent,event\.type,eventCreated\)/);
  assert.match(webhookRoute, /deliverPaidOrderSideEffects\(supabase,sessionForEvent,eventCreated\)/);
  assert.doesNotMatch(webhookRoute, /persistSession\(session,event\.type,event\.created\)/);
});

test('failed Stripe webhook records identify the affected Checkout Session for recovery', () => {
  assert.match(schema, /stripe_session_id text/);
  assert.match(productionReadiness, /event_id,event_type,stripe_session_id,processing_started_at/);
  assert.match(webhookRoute, /claimOnce\(supabase:ReturnType<[^>]+>, id:string, type:string, sessionId:string\)/);
  assert.match(webhookRoute, /stripe_session_id:sessionId/);
  assert.match(webhookRoute, /claimOnce\(supabase,eventClaimId,event\.type,eventSessionId\)/);
  assert.match(adminPage, /event_id,event_type,stripe_session_id,attempts/);
  assert.match(adminPage, /failure\.stripe_session_id/);
});

test('Meta Purchase retries preserve one durable event timestamp for deduplication', () => {
  const schema = fs.readFileSync(require.resolve('../supabase/schema.sql'), 'utf8');
  assert.match(schema, /event_time bigint check \(event_time is null or event_time > 0\)/);
  assert.match(schema, /payment_confirmed_at timestamptz/);
  assert.match(webhookRoute, /insert\(\{stripe_session_id:session\.id,status:'pending',event_time:requestedEventTime\}\)/);
  assert.match(webhookRoute, /async function persistSession\(session:Stripe\.Checkout\.Session,eventType:Stripe\.Event\.Type,eventCreated:number\)/);
  assert.match(webhookRoute, /payment_confirmed_at:confirmedAt/);
  assert.match(webhookRoute, /await sendMetaPurchase\(session,Number\(attempt\.data\[0\]\.event_time\)\)/);
  assert.match(adminOrderRoute, /select\('stripe_session_id,payment_status,payment_confirmed_at,product_type,fulfilment_status,measurement_consent'\)/);
  assert.match(adminOrderRoute, /const metaEventTime=Number\.isFinite\(confirmedAtMs\)/);
  assert.match(adminOrderRoute, /deliverMetaPurchase\(supabase, session, metaEventTime\)/);
  assert.doesNotMatch(adminOrderRoute, /Math\.floor\(Date\.now\(\) \/ 1000\)/);
});

test('paid-order email and Meta deliveries are attempted independently', () => {
  // A persistent failure in either external provider must not starve the
  // other's durable delivery attempt. Promise.allSettled guarantees both are
  // invoked while the rejected result still causes Stripe to retry the event.
  assert.match(webhookRoute, /Promise\.allSettled\(\[\s*deliverFulfilmentNotification\(supabase,session\),\s*deliverMetaPurchase\(supabase,session,eventTime\),\s*\]\)/);
  assert.match(webhookRoute, /if\(failures\.length\) throw new AggregateError/);
  assert.match(webhookRoute, /await deliverPaidOrderSideEffects\(supabase,sessionForEvent,eventCreated\)/);
  assert.match(adminOrderRoute, /Promise\.allSettled\(\[/);
  assert.match(adminOrderRoute, /retryFulfilment \? \[deliverFulfilmentNotification\(supabase, session\)\]/);
  assert.match(adminOrderRoute, /retryMeta \? \[deliverMetaPurchase\(supabase, session, metaEventTime\)\]/);
});

test('Meta CAPI requires a complete destination and admin recovery never reports a no-op retry', () => {
  const originalPixel = process.env.NEXT_PUBLIC_META_PIXEL_ID;
  const originalToken = process.env.META_CAPI_ACCESS_TOKEN;
  const originalLegacyToken = process.env.META_CAPI_TOKEN;
  try {
    process.env.NEXT_PUBLIC_META_PIXEL_ID = 'not-a-pixel';
    process.env.META_CAPI_ACCESS_TOKEN = 'token-that-is-long-enough-to-look-configured';
    delete process.env.META_CAPI_TOKEN;
    assert.equal(hasRequiredMetaCapiPurchaseConfig(), false);
    process.env.NEXT_PUBLIC_META_PIXEL_ID = '123456789';
    process.env.META_CAPI_ACCESS_TOKEN = 'token-that-is-long-enough-to-look-configured';
    assert.equal(hasRequiredMetaCapiPurchaseConfig(), true);
    process.env.META_CAPI_ACCESS_TOKEN = 'token-with-a-newline\n';
    assert.equal(hasRequiredMetaCapiPurchaseConfig(), false);
  } finally {
    if (originalPixel === undefined) delete process.env.NEXT_PUBLIC_META_PIXEL_ID; else process.env.NEXT_PUBLIC_META_PIXEL_ID = originalPixel;
    if (originalToken === undefined) delete process.env.META_CAPI_ACCESS_TOKEN; else process.env.META_CAPI_ACCESS_TOKEN = originalToken;
    if (originalLegacyToken === undefined) delete process.env.META_CAPI_TOKEN; else process.env.META_CAPI_TOKEN = originalLegacyToken;
  }
  assert.match(webhookRoute, /hasRequiredMetaCapiPurchaseConfig\(\)/);
  assert.match(adminOrderRoute, /Meta CAPI is not configured, so this consented Purchase cannot be retried yet\./);
  assert.match(adminPage, /Meta CAPI Purchase delivery is not configured\./);
  assert.match(adminPage, /metaCapiConfigured && o\.measurement_consent === 'accepted'/);
  assert.match(healthRoute, /metaCapi: hasRequiredMetaCapiPurchaseConfig\(\)/);
  assert.match(launchPage, /hasRequiredMetaCapiPurchaseConfig/);
  assert.match(launchPage, /const metaCapi=hasRequiredMetaCapiPurchaseConfig\(\)/);
  assert.doesNotMatch(launchPage, /Boolean\(process\.env\.NEXT_PUBLIC_META_PIXEL_ID\)/);
});

test('admin delivery recovery requires a completed Stripe session and matching persisted product identity', () => {
  assert.match(adminOrderRoute, /!validation\.valid \|\| session\.status !== 'complete' \|\| session\.payment_status !== 'paid'/);
  assert.match(adminOrderRoute, /if \(order\.product_type !== validation\.productType\)/);
  assert.match(adminOrderRoute, /stored order product does not match its signed Stripe session/);
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

test('consented CAPI Purchases retain only safe browser matching context', () => {
  const validFbp = 'fb.1.1725000000000.123456789012345';
  const validFbc = 'fb.1.1725000000000.AbCdEf_123-xyz';
  assert.deepEqual(metaAttributionFromRequest({ fbp: validFbp, fbc: validFbc }, 'Mozilla/5.0\r\nInjected', '203.0.113.42'), {
    meta_fbp: validFbp,
    meta_fbc: validFbc,
    meta_client_user_agent: 'Mozilla/5.0Injected',
    meta_client_ip: '203.0.113.42',
  });
  assert.deepEqual(metaAttributionFromRequest({ fbp: 'not-a-meta-id', fbc: '<script>' }, null, 'not an ip'), {});
  assert.match(metaAttribution, /const META_BROWSER_ID =/);
  assert.match(metaClient, /export function metaAttribution\(\)/);
  assert.match(esimCheckoutRoute, /metaAttributionFromRequest\(body\.attribution, req\.headers\.get\('user-agent'\), req\.headers\.get\('x-real-ip'\)\)/);
  assert.match(wifiCheckoutRoute, /metaAttributionFromRequest\(body\.attribution,req\.headers\.get\('user-agent'\),req\.headers\.get\('x-real-ip'\)\)/);
  assert.match(esimCheckoutRoute, /body\.measurementConsent === true \? metaAttributionFromRequest/);
  assert.match(wifiCheckoutRoute, /body\.measurementConsent===true\?metaAttributionFromRequest/);
  assert.match(webhookRoute, /session\.metadata\?\.meta_fbp/);
  assert.match(webhookRoute, /client_user_agent:clientUserAgent/);
  assert.match(webhookRoute, /client_ip_address:clientIp/);
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
  assert.match(webhookRoute, /const MAX_STRIPE_SIGNATURE_HEADER_BYTES = 8_192/);
  assert.match(webhookRoute, /const STRIPE_WEBHOOK_BODY_TIMEOUT_MS = 15_000/);
  assert.match(webhookRoute, /class StripeWebhookBodyTimeoutError extends Error/);
  assert.match(webhookRoute, /async function readStripeWebhookBody\(req: Request\): Promise<Buffer>/);
  assert.match(webhookRoute, /Number\(contentLength\) > MAX_STRIPE_WEBHOOK_BODY_BYTES/);
  assert.match(webhookRoute, /total > MAX_STRIPE_WEBHOOK_BODY_BYTES/);
  assert.match(webhookRoute, /await Promise\.race\(\[reader\.read\(\), bodyTimeout\]\)/);
  assert.match(webhookRoute, /reject\(new StripeWebhookBodyTimeoutError\('Stripe webhook body timed out'\)\);[\s\S]{0,500}void reader\.cancel\(\)/);
  assert.match(webhookRoute, /void reader\.cancel\(\)\.catch\(\(\) => undefined\)/);
  assert.match(webhookRoute, /Webhook payload timed out/);
  assert.match(webhookRoute, /Webhook payload too large/);
  assert.match(webhookRoute, /function validStripeSignatureHeader\(value: string \| null\)/);
  assert.match(webhookRoute, /value\.length <= MAX_STRIPE_SIGNATURE_HEADER_BYTES/);
  assert.match(webhookRoute, /\^\[\\x20-\\x7e\]\+\$/);
  const signatureValidation = webhookRoute.indexOf("const stripeSignature=validStripeSignatureHeader(req.headers.get('stripe-signature'))");
  const signatureCheck = webhookRoute.indexOf('stripe.webhooks.constructEvent(payload,stripeSignature,webhookSecret)');
  assert.ok(signatureValidation >= 0 && signatureCheck > signatureValidation, 'Stripe signature header must be bounded before verification');
});

test('Stripe webhook bounds third-party delivery responses as well as request time', () => {
  assert.match(webhookRoute, /const MAX_DELIVERY_RESPONSE_BODY_BYTES=64 \* 1024/);
  assert.match(webhookRoute, /async function readDeliveryResponseBody\(response: Response\)/);
  assert.match(webhookRoute, /total>MAX_DELIVERY_RESPONSE_BODY_BYTES/);
  assert.match(webhookRoute, /await readDeliveryResponseBody\(response\)/);
  assert.doesNotMatch(webhookRoute, /const responseBody=await response\.text\(\)/);
});

test('paid-order delivery endpoints are fail-closed and never follow credential-bearing redirects', () => {
  // A relay typo must stop checkout before a customer pays, rather than
  // failing only when the webhook tries to send fulfilment data. Redirects
  // are unsafe here because the relay body has SMTP credentials and the Meta
  // request URL carries its access token.
  assert.match(productionReadiness, /const relayUrl = process\.env\.SMTP_RELAY_URL\?\.trim\(\)/);
  assert.match(productionReadiness, /const relaySecret = process\.env\.SMTP_RELAY_SECRET\?\.trim\(\)/);
  assert.equal(safeHttpsDeliveryEndpoint('https://relay.example.com/orders'), 'https://relay.example.com/orders');
  for (const unsafe of ['http://relay.example.com/orders', 'https://user:pass@relay.example.com/orders', 'not a URL', '']) {
    assert.equal(safeHttpsDeliveryEndpoint(unsafe), null);
  }
  // Runtime settings can change after checkout or before an admin retry. The
  // outbound webhook path must enforce the same boundary as readiness.
  assert.match(productionReadiness, /safeHttpsDeliveryEndpoint\(relayUrl\)/);
  assert.match(webhookRoute, /const relayUrl=safeHttpsDeliveryEndpoint\(configuredRelayUrl\)/);
  assert.match(webhookRoute, /if\(!relayUrl\) throw new Error\('SMTP relay endpoint is invalid'\)/);
  assert.match(productionReadiness, /relaySecret\.length >= 24/);
  assert.match(productionReadiness, /isSafeSmtpMailbox\(from\) && isSafeSmtpMailbox\(recipient\) && relayConfigured/);
  assert.match(webhookRoute, /redirect:'error'/);
});

test('third-party delivery failures never copy response bodies into logs or recovery records', () => {
  // Both provider calls carry sensitive data: the SMTP relay receives its
  // transport credentials and paid-order details, while Meta uses an access
  // token in its request URL. Their response bodies are untrusted and can be
  // surfaced by webhook error logging or the durable retry ledger.
  assert.match(webhookRoute, /Meta CAPI failed \(\$\{response\.status\}\)/);
  assert.match(webhookRoute, /SMTP relay failed \(\$\{response\.status\}\)/);
  assert.doesNotMatch(webhookRoute, /Meta CAPI failed \(\$\{response\.status\}\): \$\{response\.responseBody/);
  assert.doesNotMatch(webhookRoute, /SMTP relay failed \(\$\{response\.status\}\): \$\{response\.responseBody/);
});

test('SMTP delivery failures retain only a safe status code in fulfilment recovery records', () => {
  // SMTP error text is supplied by an external relay and is persisted by the
  // webhook on a failed fulfilment attempt. Do not let it become a durable
  // source of echoed PII, credentials, or arbitrary operator-visible text.
  assert.match(smtpClient, /if \(!expected\.includes\(code\)\) reject\(new Error\(`SMTP error \$\{code\}`\)\);/);
  assert.doesNotMatch(smtpClient, /SMTP error \$\{code\}: \$\{buffer\.trim\(\)\}/);
  assert.match(webhookRoute, /last_error:message\.slice\(0,500\)/);
});

test('Stripe network calls use a bounded shared production client', () => {
  assert.match(stripeClient, /STRIPE_REQUEST_TIMEOUT_MS = 15_000/);
  assert.match(stripeClient, /STRIPE_MAX_NETWORK_RETRIES = 1/);
  assert.match(stripeClient, /timeout: STRIPE_REQUEST_TIMEOUT_MS/);
  assert.match(stripeClient, /maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES/);
  for (const route of [wifiCheckoutRoute, esimCheckoutRoute, availabilityRoute, webhookRoute, adminOrderRoute, successPage, bookingPage]) {
    assert.match(route, /createStripeClient\(/);
    assert.doesNotMatch(route, /new Stripe\(/);
  }
});

test('Supabase order-critical requests use a bounded shared transport', async () => {
  assert.equal(SUPABASE_REQUEST_TIMEOUT_MS, 15_000);
  assert.match(supabaseAdmin, /global: \{ fetch: fetchSupabaseWithTimeout \}/);
  assert.match(supabaseAdmin, /const timeout = setTimeout\(\(\) => controller\.abort\(timeoutError\), timeoutMs\)/);
  assert.match(supabaseAdmin, /requestSignal\?\.addEventListener\('abort', abortFromRequest, \{ once: true \}\)/);

  const originalFetch = global.fetch;
  let receivedSignal;
  global.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    receivedSignal = init.signal;
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  try {
    await assert.rejects(
      () => fetchSupabaseWithTimeout('https://supabase.example/rest/v1/orders', undefined, 1),
      /Supabase request timed out/,
    );
    assert.equal(receivedSignal.aborted, true);
  } finally {
    global.fetch = originalFetch;
  }
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

test('expired lookalike sessions are ignored before claiming the webhook event', () => {
  // The source marker is public metadata and the Stripe account may be shared.
  // Require the server-issued HMAC before an expiry event can consume the
  // durable event ledger, release inventory, or mutate a provisional order.
  const expiryBranch = webhookRoute.slice(
    webhookRoute.indexOf("if(event.type==='checkout.session.expired')"),
    webhookRoute.indexOf("if(!claimStartedAt) throw new Error('Stripe event claim was not acquired')"),
  );
  const provenanceGuard = expiryBranch.indexOf('if(!validQyRoamProvenance(session.id,session.metadata))');
  const eventClaim = expiryBranch.indexOf('await claimOnce(supabase,expiryEventClaimId,event.type,session.id)');
  assert.notEqual(provenanceGuard, -1);
  assert.notEqual(eventClaim, -1);
  assert.ok(provenanceGuard < eventClaim);
  assert.match(expiryBranch, /stripe_webhook_expiry_integrity_error/);
  assert.match(expiryBranch, /return NextResponse\.json\(\{received:true,ignored:true\}\)/);
});

test('expired checkout sessions close only their provisional pending orders', () => {
  // A delayed payment may have created an awaiting-payment order before its
  // Checkout Session reaches Stripe's terminal expiry state.
  assert.match(webhookRoute, /async function closeExpiredAwaitingPaymentOrder/);
  assert.match(webhookRoute, /fulfilment_status:'payment_failed'/);
  assert.match(webhookRoute, /\.eq\('fulfilment_status','awaiting_payment'\)/);
  assert.match(webhookRoute, /payment_status\.is\.null,payment_status\.neq\.paid/);
  assert.match(webhookRoute, /await closeExpiredAwaitingPaymentOrder\(supabase,session\)/);
});

test('only the matching Pocket WiFi terminal event can release a checkout reservation', () => {
  // eSIM and Pocket WiFi have separate Stripe idempotency namespaces, so the
  // shared request-id syntax alone must never make an eSIM payment release a
  // router held by another checkout. The Pocket WiFi-only persistence RPC
  // matches both identities while it holds the inventory lock.
  assert.match(webhookRoute, /if\(productType==='pocket_wifi'\)/);
  assert.match(schema, /where checkout_request_id = p_checkout_request_id and stripe_session_id = p_stripe_session_id/);
});

test('authenticated admin browser mutations reject cross-site request triggering', () => {
  // Basic Auth can be retained by a browser. Protect every mutating admin API
  // route centrally so a hostile page cannot submit an order/stock change or
  // trigger paid-order delivery retries with those cached credentials.
  assert.match(middleware, /req\.nextUrl\.pathname\.startsWith\('\/api\/admin'\)/);
  assert.match(middleware, /!\['GET', 'HEAD', 'OPTIONS'\]\.includes/);
  assert.match(middleware, /req\.headers\.get\('sec-fetch-site'\) === 'cross-site'/);
  assert.match(middleware, /new URL\(origin\)\.origin === req\.nextUrl\.origin/);
  assert.match(middleware, /if \(!isTrustedAdminMutation\(req\)\)/);
  assert.match(middleware, /status: 403/);
  assert.match(middleware, /'Cache-Control': 'no-store'/);
});

test('admin and authenticated health checks bound credential inputs before comparison', () => {
  // Authentication headers are attacker-controlled at the application edge.
  // Keep the constant-time comparison work bounded even if a deployment's
  // outer proxy does not impose its usual header-size limit.
  assert.match(middleware, /MAX_BASIC_AUTH_HEADER_LENGTH = 8_192/);
  assert.match(middleware, /MAX_BASIC_AUTH_DECODED_LENGTH = 4_096/);
  assert.match(middleware, /auth\.length <= MAX_BASIC_AUTH_HEADER_LENGTH/);
  assert.match(middleware, /decoded\.length <= MAX_BASIC_AUTH_DECODED_LENGTH/);
  assert.match(healthRoute, /MAX_HEALTH_AUTHORIZATION_HEADER_LENGTH = 1_024/);
  assert.match(healthRoute, /supplied\.length <= MAX_HEALTH_AUTHORIZATION_HEADER_LENGTH/);
});

test('paid orders reconcile into CRM records idempotently without overwriting operator workflow fields', () => {
  // The CRM must follow the authoritative paid-orders ledger, including a
  // delayed payment that changes an existing order from awaiting payment to
  // paid. Totals are recalculated from orders, so duplicate Stripe terminal
  // events cannot inflate a customer's purchase count or lifetime value.
  assert.match(schema, /create or replace function public\.qy_reconcile_customer_from_paid_order/);
  assert.match(schema, /after insert or update of payment_status, customer_name, email, phone, amount_sgd on public\.orders/);
  assert.match(schema, /if new\.payment_status <> 'paid' or \(v_email is null and v_phone is null\) then/);
  assert.match(schema, /pg_advisory_xact_lock\(hashtext\('qy_roam_customer:' \|\| v_identity\)\)/);
  assert.match(schema, /from public\.orders\s+where payment_status = 'paid'/);
  assert.match(schema, /total_orders = v_orders/);
  assert.match(schema, /lifetime_value_sgd = v_lifetime_value/);
  assert.match(schema, /last_order_at = v_last_order_at/);
  const customerUpdate = schema.slice(
    schema.indexOf('update public.customers set', schema.indexOf('create or replace function public.qy_reconcile_customer_from_paid_order')),
    schema.indexOf('where id = v_customer_id;', schema.indexOf('create or replace function public.qy_reconcile_customer_from_paid_order')),
  );
  assert.doesNotMatch(customerUpdate, /status\s*=/);
  assert.doesNotMatch(customerUpdate, /source\s*=/);
});

test('Stripe Checkout redirects fail closed unless production uses a canonical QY Roam origin', () => {
  const priorEnvironment = process.env.NODE_ENV;
  const priorSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NODE_ENV = 'production';
  try {
    for (const value of ['https://qyroam.com', 'https://www.qyroam.com/store']) {
      process.env.NEXT_PUBLIC_SITE_URL = value;
      assert.equal(isProductionQyRoamOrigin(value), true);
      assert.equal(checkoutSiteOrigin('http://localhost:3000/api/checkout'), new URL(value).origin);
    }
    for (const value of ['http://qyroam.com', 'https://qyroam.com:8443', 'https://staff@qyroam.com', 'https://not-qyroam.example']) {
      process.env.NEXT_PUBLIC_SITE_URL = value;
      assert.equal(isProductionQyRoamOrigin(value), false);
      assert.throws(() => checkoutSiteOrigin('http://localhost:3000/api/checkout'), /canonical QY Roam HTTPS origin/);
    }
  } finally {
    if (priorEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorEnvironment;
    if (priorSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = priorSiteUrl;
  }
  for (const route of [wifiCheckoutRoute, esimCheckoutRoute]) {
    assert.match(route, /checkoutSiteOrigin\(req\.url\)/);
    assert.doesNotMatch(route, /function siteOrigin\(/);
  }
  assert.match(healthRoute, /isProductionQyRoamOrigin\(process\.env\.NEXT_PUBLIC_SITE_URL\)/);
});

test('customer confirmation and booking URLs are never cacheable or indexable', () => {
  assert.match(successPage, /robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/);
  for (const path of ['/success', '/booking']) {
    const source = new RegExp(`source: '${path}',[\\s\\S]{0,260}Cache-Control', value: 'no-store, max-age=0, private'[\\s\\S]{0,260}X-Robots-Tag', value: 'noindex, nofollow, nosnippet'`);
    assert.match(nextConfig, source);
  }
});

test('production CSP does not permit JavaScript eval', () => {
  // `unsafe-eval` is needed by Next's development source-map runtime only.
  // It must not ship as a production browser capability alongside checkout
  // and authenticated operations pages.
  assert.match(nextConfig, /const scriptSources = \[/);
  assert.match(nextConfig, /process\.env\.NODE_ENV === 'development' \? \["'unsafe-eval'"\] : \[\]/);
  assert.match(nextConfig, /`script-src \$\{scriptSources\}`/);
  assert.doesNotMatch(nextConfig, /"script-src 'self' 'unsafe-inline' 'unsafe-eval'/);
});

test('Stripe webhook bounds event identities before logs or durable idempotency writes', () => {
  assert.match(stripeEventId, /typeof value !== 'string'/);
  assert.match(stripeEventId, /\^evt_\[A-Za-z0-9\]\{8,96\}\$/);
  const signatureCheck = webhookRoute.indexOf('stripe.webhooks.constructEvent');
  const eventValidation = webhookRoute.indexOf('const stripeEventId=validStripeEventId(event.id)', signatureCheck);
  const firstEventLog = webhookRoute.indexOf('eventId:stripeEventId', eventValidation);
  const firstClaim = webhookRoute.indexOf('const eventClaimId=`stripe:${stripeEventId}`', eventValidation);
  assert.ok(signatureCheck >= 0 && eventValidation > signatureCheck, 'event id validation must follow signature verification');
  assert.ok(firstEventLog > eventValidation, 'validated event id must be used by webhook logs');
  assert.ok(firstClaim > eventValidation, 'validated event id must be used by the durable claim');
  assert.match(webhookRoute, /if\(!stripeEventId\)[\s\S]{0,180}Invalid Stripe event identifier/);
  assert.doesNotMatch(webhookRoute, /eventId:event\.id/);
  assert.doesNotMatch(webhookRoute, /`stripe:\$\{event\.id\}`/);
});
