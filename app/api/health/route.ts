import { NextResponse } from 'next/server';
import { hasRequiredAdminCredentials, hasRequiredMetaCapiPurchaseConfig } from '@/lib/runtimeConfig';
import { hasRequiredEsimOrderSchema, hasRequiredFulfilmentEmailConfig, hasRequiredOperationsSchema, hasRequiredPaymentSchema, hasRequiredPocketWifiFulfilmentSchema, hasRequiredStripeApiAccess, hasRequiredStripeCheckoutConfig, hasRequiredStripeWebhookConfig } from '@/lib/productionReadiness';
import { operationalConfig } from '@/lib/operationalConfig';
import { isProductionQyRoamOrigin } from '@/lib/siteOrigin';
import { hasOrderIntegritySigningConfig } from '@/lib/orderProvenance';
import { healthCheckToken, MAX_HEALTH_CHECK_TOKEN_LENGTH } from '@/lib/healthCheckToken';
import { hasRequiredSupabaseAdminConfig } from '@/lib/supabaseAdmin';
import { esimPromoIsActive } from '@/lib/esimPlans';
import { hasSaleablePocketWifiInventory } from '@/lib/pocketWifiStock';
import { tryAcquireHealthConcurrency } from '@/lib/healthConcurrency';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Health credentials are machine-issued bearer tokens, not an unbounded
// request payload. Bound the comparison loop as a defence in depth measure
// for deployments that do not enforce a proxy header limit.
const HEALTH_AUTHORIZATION_PREFIX = 'Bearer ';
const MAX_HEALTH_AUTHORIZATION_HEADER_LENGTH = HEALTH_AUTHORIZATION_PREFIX.length + MAX_HEALTH_CHECK_TOKEN_LENGTH;
function constantTimeEqual(a: string, b: string) {
  const encoder = new TextEncoder();
  const left = encoder.encode(a), right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) diff |= (left[i % Math.max(left.length, 1)] || 0) ^ (right[i % Math.max(right.length, 1)] || 0);
  return diff === 0;
}

type HealthAuthorization = 'public' | 'authorized' | 'invalid';

function healthAuthorization(req: Request): HealthAuthorization {
  const supplied = req.headers.get('authorization');
  // Absence deliberately selects the dependency-free public liveness probe.
  // Once a caller supplies credentials, however, never silently downgrade a
  // malformed or stale token to that HTTP-200 response: status-only monitors
  // could otherwise report readiness while authenticating with the wrong
  // release credential.
  if (supplied === null) return 'public';
  const expected = healthCheckToken();
  const valid = Boolean(
    expected &&
    supplied.startsWith(HEALTH_AUTHORIZATION_PREFIX) &&
    supplied.length <= MAX_HEALTH_AUTHORIZATION_HEADER_LENGTH &&
    constantTimeEqual(supplied.slice(HEALTH_AUTHORIZATION_PREFIX.length), expected),
  );
  return valid ? 'authorized' : 'invalid';
}

export async function GET(req: Request) {
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };

  const authorization = healthAuthorization(req);
  // Public probes with no credentials get only liveness and must not trigger
  // external dependency checks or disclose production configuration.
  if (authorization === 'public') {
    return NextResponse.json({ ok: true, service: 'qy-roam' }, { status: 200, headers });
  }
  if (authorization === 'invalid') {
    return NextResponse.json({ ok: false, service: 'qy-roam', error: 'Invalid health credentials.' }, {
      status: 401,
      headers: { ...headers, 'WWW-Authenticate': 'Bearer realm="qy-roam-health"' },
    });
  }

  // A valid probe performs several provider-backed checks in parallel. When
  // a dependency is slow, overlapping monitor retries must not create an
  // unbounded readiness stampede or crowd out customer checkout work. Public
  // liveness remains dependency-free above; excess authenticated probes fail
  // fast and explicitly ask the monitor to retry.
  const releaseHealth = tryAcquireHealthConcurrency();
  if (!releaseHealth) {
    return NextResponse.json({ ok: false, service: 'qy-roam', error: 'Readiness checks are busy.' }, {
      status: 503,
      headers: { ...headers, 'Retry-After': '5' },
    });
  }

  try {
  const config = operationalConfig();
  // The approved eSIM catalogue can be intentionally paused at its offer
  // boundary. Its readiness probe exercises several privileged tables and
  // RPCs, so do not spend that database work (or make a Pocket WiFi-only
  // deployment wait for it) when the public eSIM checkout is guaranteed to
  // reject every purchase. Capture the offer state once so the dependency
  // plan and the resulting product gate describe the same instant.
  const esimOfferActive = esimPromoIsActive();
  // Checkout has product-specific post-payment contracts. In particular, an
  // eSIM requires its non-secret digital-delivery audit field, which is not a
  // Pocket WiFi requirement. Keep the authenticated release signal aligned
  // with both routes so it cannot declare the store ready while eSIM checkout
  // correctly fails closed against a partial migration.
  let dependencyChecks: [boolean, boolean, boolean, boolean, boolean, boolean];
  try {
    dependencyChecks = await Promise.all([
      hasRequiredStripeApiAccess(),
      esimOfferActive ? hasRequiredEsimOrderSchema() : Promise.resolve(false),
      hasRequiredPaymentSchema(),
      hasRequiredPocketWifiFulfilmentSchema(),
      hasRequiredOperationsSchema(),
      hasSaleablePocketWifiInventory(config?.pocketWifiInventory || 0),
    ]);
  } catch {
    // Every current probe normally converts dependency failures into `false`,
    // but keep the release authority stable if a provider SDK, runtime, or
    // future probe rejects unexpectedly. Deployment automation expects JSON;
    // allowing the exception to reach Next's generic error renderer would
    // hide which boundary failed and can produce a response without this
    // route's explicit retry and privacy contract.
    console.error('production_readiness_dependency_check_failed');
    return NextResponse.json({
      ok: false,
      launchReady: false,
      salesReady: false,
      checkoutReady: false,
      paidAcquisitionReady: false,
      allProductsPaidAcquisitionReady: false,
      service: 'qy-roam',
      error: 'Production readiness checks are temporarily unavailable.',
      timestamp: new Date().toISOString(),
    }, {
      status: 503,
      headers: { ...headers, 'Retry-After': '5' },
    });
  }
  const [stripeApi, esimOrderSchema, paymentSchema, pocketWifiFulfilmentSchema, operationsSchema, pocketWifiStock] = dependencyChecks;
  const checks = {
    stripe: hasRequiredStripeCheckoutConfig(),
    stripeApi,
    siteUrl: isProductionQyRoamOrigin(process.env.NEXT_PUBLIC_SITE_URL),
    webhook: hasRequiredStripeWebhookConfig(),
    orderIntegrity: hasOrderIntegritySigningConfig(),
    supabase: hasRequiredSupabaseAdminConfig(),
    esimOrderSchema,
    paymentSchema,
    pocketWifiFulfilmentSchema,
    operationsSchema,
    admin: hasRequiredAdminCredentials(),
    inventory: Boolean(config && config.pocketWifiInventory > 0),
    deliveryLeadDays: Boolean(config),
    courierFee: Boolean(config),
    fulfilmentEmail: hasRequiredFulfilmentEmailConfig(),
  };
  const measurementChecks = {
    metaCapi: hasRequiredMetaCapiPurchaseConfig(),
  };
  const availabilityChecks = { pocketWifiStock };
  // Product-specific contracts belong to their checkout gate below. Requiring
  // both product schemas (and router stock) here made the supposedly
  // product-tolerant release gate impossible: an intentionally paused eSIM
  // could block a safe Pocket WiFi release, and an unavailable router fleet
  // could block an otherwise safe eSIM release. Keep the shared operational
  // controls launch-critical, then let `salesReady` require at least one
  // complete product path.
  const launchChecks = {
    stripe: checks.stripe,
    stripeApi: checks.stripeApi,
    siteUrl: checks.siteUrl,
    webhook: checks.webhook,
    orderIntegrity: checks.orderIntegrity,
    supabase: checks.supabase,
    operationsSchema: checks.operationsSchema,
    admin: checks.admin,
    fulfilmentEmail: checks.fulfilmentEmail,
  };
  const launchReady = Object.values(launchChecks).every(Boolean);
  // Deployment readiness and product availability are related but distinct.
  // A deliberately paused eSIM offer must not prevent a safe Pocket WiFi
  // release or rollback, while the machine-readable paid-acquisition signal
  // must never turn green if an advertised checkout will reject customers.
  // These expressions mirror the two public checkout routes and the launch
  // dashboard: eSIM has its own order schema and approved-offer window;
  // Pocket WiFi additionally needs reservation, custody, and configured
  // capacity boundaries.
  const commonCheckoutReady = Boolean(
    checks.stripe && checks.stripeApi && checks.siteUrl && checks.webhook &&
    checks.orderIntegrity && checks.supabase && checks.fulfilmentEmail
  );
  const checkoutChecks = {
    esim: commonCheckoutReady && Boolean(esimOrderSchema) && esimOfferActive,
    pocketWifi: commonCheckoutReady && Boolean(paymentSchema) &&
      Boolean(pocketWifiFulfilmentSchema) && checks.inventory && availabilityChecks.pocketWifiStock,
  };
  const checkoutReady = Object.values(checkoutChecks).every(Boolean);
  // A release can intentionally pause one product (for example, when an
  // approved promotional eSIM catalogue expires), but it is not sales-ready
  // if every public checkout is unavailable. Keep this separate from the
  // all-products `checkoutReady` and paid-acquisition gates so a safe organic
  // Pocket WiFi release remains possible while deployment automation can
  // still reject a configuration that leaves customers with nothing to buy.
  const salesReady = launchReady && Object.values(checkoutChecks).some(Boolean);
  // Paid traffic is a product-specific promise. An intentionally paused eSIM
  // offer must not suppress a fully ready Pocket WiFi campaign, but a coarse
  // store-level green light must also never imply that every product is safe
  // to advertise. Publish both boundaries so campaign automation can select
  // the exact product gate and operators can still see the stricter state.
  const paidAcquisitionChecks = {
    esim: launchReady && checkoutChecks.esim && measurementChecks.metaCapi,
    pocketWifi: launchReady && checkoutChecks.pocketWifi && measurementChecks.metaCapi,
  };
  const paidAcquisitionReady = Object.values(paidAcquisitionChecks).some(Boolean);
  const allProductsPaidAcquisitionReady = Object.values(paidAcquisitionChecks).every(Boolean);

  const missing = Object.entries(launchChecks).filter(([, configured]) => !configured).map(([name]) => name);
  const paidAcquisitionMissing = Object.entries(paidAcquisitionChecks)
    .filter(([, ready]) => !ready)
    .map(([name]) => name);
  const checkoutMissing = Object.entries(checkoutChecks)
    .filter(([, ready]) => !ready)
    .map(([name]) => name);
  return NextResponse.json({
    // This authenticated endpoint is the production readiness signal. A 200
    // must mean the service can safely accept and fulfil a real order, not
    // merely that its Stripe keys and public URL look plausible. The public
    // branch above remains a dependency-free liveness probe for process
    // supervision.
    // `ok` and the HTTP status are the coarse signal consumed by monitors
    // that do not understand the richer readiness fields below. A deployment
    // with sound shared configuration but no saleable product is still a
    // customer-facing outage, so only at-least-one-checkout readiness may
    // produce a successful authenticated health response. Keep launchReady as
    // a separate diagnostic so operators can distinguish infrastructure from
    // product-specific stock, schema, or offer blockers.
    ok: salesReady,
    launchReady,
    salesReady,
    checkoutReady,
    paidAcquisitionReady,
    allProductsPaidAcquisitionReady,
    service: 'qy-roam',
    checks,
    checkoutChecks,
    availabilityChecks,
    measurementChecks,
    paidAcquisitionChecks,
    missing,
    checkoutMissing,
    paidAcquisitionMissing,
    timestamp: new Date().toISOString()
  }, { status: salesReady ? 200 : 503, headers });
  } finally {
    releaseHealth();
  }
}
