import { NextResponse } from 'next/server';
import { hasRequiredAdminCredentials, hasRequiredMetaCapiPurchaseConfig } from '@/lib/runtimeConfig';
import { hasRequiredEsimOrderSchema, hasRequiredFulfilmentEmailConfig, hasRequiredOperationsSchema, hasRequiredPaymentSchema, hasRequiredPocketWifiFulfilmentSchema, hasRequiredStripeCheckoutConfig, hasRequiredStripeWebhookConfig } from '@/lib/productionReadiness';
import { operationalConfig } from '@/lib/operationalConfig';
import { isProductionQyRoamOrigin } from '@/lib/siteOrigin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Health credentials are machine-issued bearer tokens, not an unbounded
// request payload. Bound the comparison loop as a defence in depth measure
// for deployments that do not enforce a proxy header limit.
const MAX_HEALTH_AUTHORIZATION_HEADER_LENGTH = 1_024;
// The configured token participates in the same constant-time comparison as
// the request header. Bound it too: a malformed environment value must not
// turn every authenticated readiness probe into work proportional to an
// arbitrarily large secret.
const MAX_HEALTH_CHECK_TOKEN_LENGTH = 1_024;

function isOrderIntegrityConfigured() {
  const current = process.env.ORDER_INTEGRITY_SECRET;
  const previous = process.env.ORDER_INTEGRITY_SECRET_PREVIOUS;
  // A previous key is optional, but if an operator sets it for a rotation it
  // must be a real signing secret rather than silently disabling recovery for
  // in-flight Checkout Sessions.
  return Boolean(current && current.length >= 32 && (!previous || previous.length >= 32));
}

function constantTimeEqual(a: string, b: string) {
  const encoder = new TextEncoder();
  const left = encoder.encode(a), right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) diff |= (left[i % Math.max(left.length, 1)] || 0) ^ (right[i % Math.max(right.length, 1)] || 0);
  return diff === 0;
}

function isAuthorized(req: Request) {
  const expected = process.env.HEALTH_CHECK_TOKEN;
  if (!expected || expected.length < 24 || expected.length > MAX_HEALTH_CHECK_TOKEN_LENGTH) return false;
  const supplied = req.headers.get('authorization');
  return Boolean(
    supplied?.startsWith('Bearer ') &&
    supplied.length <= MAX_HEALTH_AUTHORIZATION_HEADER_LENGTH &&
    constantTimeEqual(supplied.slice(7), expected),
  );
}

export async function GET(req: Request) {
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };

  // Public probes get only liveness and must not trigger external dependency
  // checks or disclose production configuration.
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: true, service: 'qy-roam' }, { status: 200, headers });
  }

  const config = operationalConfig();
  // Checkout has product-specific post-payment contracts. In particular, an
  // eSIM requires its non-secret digital-delivery audit field, which is not a
  // Pocket WiFi requirement. Keep the authenticated release signal aligned
  // with both routes so it cannot declare the store ready while eSIM checkout
  // correctly fails closed against a partial migration.
  const [esimOrderSchema, paymentSchema, pocketWifiFulfilmentSchema, operationsSchema] = await Promise.all([
    hasRequiredEsimOrderSchema(),
    hasRequiredPaymentSchema(),
    hasRequiredPocketWifiFulfilmentSchema(),
    hasRequiredOperationsSchema(),
  ]);
  const checks = {
    stripe: hasRequiredStripeCheckoutConfig(),
    siteUrl: isProductionQyRoamOrigin(process.env.NEXT_PUBLIC_SITE_URL),
    webhook: hasRequiredStripeWebhookConfig(),
    orderIntegrity: isOrderIntegrityConfigured(),
    supabase: Boolean(process.env.SUPABASE_URL?.startsWith('https://') && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY.length >= 32),
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
  const paidAcquisitionChecks = {
    metaCapi: hasRequiredMetaCapiPurchaseConfig(),
  };
  const launchReady = Object.values(checks).every(Boolean);
  const paidAcquisitionReady = launchReady && Object.values(paidAcquisitionChecks).every(Boolean);

  const missing = Object.entries(checks).filter(([, configured]) => !configured).map(([name]) => name);
  const paidAcquisitionMissing = Object.entries(paidAcquisitionChecks)
    .filter(([, configured]) => !configured)
    .map(([name]) => name);
  return NextResponse.json({
    // This authenticated endpoint is the production readiness signal. A 200
    // must mean the service can safely accept and fulfil a real order, not
    // merely that its Stripe keys and public URL look plausible. The public
    // branch above remains a dependency-free liveness probe for process
    // supervision.
    ok: launchReady,
    launchReady,
    paidAcquisitionReady,
    service: 'qy-roam',
    checks,
    paidAcquisitionChecks,
    missing,
    paidAcquisitionMissing,
    timestamp: new Date().toISOString()
  }, { status: launchReady ? 200 : 503, headers });
}
