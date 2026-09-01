const assert = require('node:assert/strict');
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
const { WIFI_BENCHMARK, WIFI_PLANS } = require('../lib/wifiPlans.ts');
const { allowedFulfilmentStatuses, validFulfilmentTransition } = require('../lib/orderLifecycle.ts');

// The success page, booking-status page, and Stripe webhook must all use this
// same validator rather than trusting the QY Roam source marker by itself.
const bookingPage = fs.readFileSync(require.resolve('../app/booking/page.tsx'), 'utf8');

const requestId = 'checkout_request_123456';

function esimSession(plan = ESIM_PLANS[0]) {
  return {
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
}

function wifiSession(plan = WIFI_PLANS[0]) {
  const days = 4;
  const rental = Math.max(1000, Math.round(plan.daily * days * 100));
  const discount = Math.floor((rental * LAUNCH_PROMO.percent) / 100);
  return {
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

test('checkout request ids use the same production boundary everywhere', () => {
  assert.equal(validCheckoutRequestId(requestId), requestId);
  for (const value of ['short', 'contains spaces 123456', 'bad/slashes/123456', 'x'.repeat(81)]) {
    assert.equal(validCheckoutRequestId(value), null);
  }
});

test('Pocket WiFi fulfilment follows a dispatch and return lifecycle', () => {
  assert.deepEqual(allowedFulfilmentStatuses('pocket_wifi', 'paid'), ['paid', 'packing', 'dispatched', 'cancelled']);
  assert.equal(validFulfilmentTransition('pocket_wifi', 'paid', 'returned'), false);
  assert.equal(validFulfilmentTransition('pocket_wifi', 'dispatched', 'returned'), true);
  assert.equal(validFulfilmentTransition('pocket_wifi', 'returned', 'closed'), true);
  assert.equal(validFulfilmentTransition('pocket_wifi', 'closed', 'packing'), false);
});

test('eSIM lifecycle cannot use router statuses or reopen closed orders', () => {
  assert.deepEqual(allowedFulfilmentStatuses('esim', 'awaiting_fulfilment'), ['awaiting_fulfilment', 'fulfilled', 'cancelled']);
  assert.equal(validFulfilmentTransition('esim', 'awaiting_fulfilment', 'dispatched'), false);
  assert.equal(validFulfilmentTransition('esim', 'fulfilled', 'closed'), true);
  assert.equal(validFulfilmentTransition('esim', 'closed', 'awaiting_fulfilment'), false);
});
