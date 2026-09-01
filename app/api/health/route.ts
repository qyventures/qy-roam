import { NextResponse } from 'next/server';
import { getAdminCredentials, getMetaCapiToken } from '@/lib/runtimeConfig';
import { hasRequiredOperationsSchema, hasRequiredPaymentSchema } from '@/lib/productionReadiness';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function isPositiveInteger(value?: string) {
  if (!value) return false;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0;
}

function isProductionSiteUrl(value?: string) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['qyroam.com', 'www.qyroam.com'].includes(url.hostname);
  } catch {
    return false;
  }
}

function hasPrefix(value: string | undefined, prefixes: string[]) {
  return Boolean(value && prefixes.some((prefix) => value.startsWith(prefix)));
}

function isStrongAdminPassword(value?: string) {
  if (!value || value.length < 16) return false;
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && /[^A-Za-z0-9]/.test(value);
}

function isSmtpConfigured() {
  const port = Number(process.env.SMTP_PORT || '587');
  const recipient = process.env.ORDER_FULFILMENT_EMAIL || 'qyventures@gmail.com';
  return Boolean(
    process.env.SMTP_HOST &&
    Number.isInteger(port) && port > 0 && port <= 65535 &&
    process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_FROM &&
    recipient.includes('@')
  );
}

function isMetaPixelConfigured() {
  return /^\d{6,25}$/.test(process.env.NEXT_PUBLIC_META_PIXEL_ID || '');
}

function isMetaCapiConfigured() {
  const token = getMetaCapiToken();
  return Boolean(token && token.length >= 20);
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
  if (!expected || expected.length < 24) return false;
  const supplied = req.headers.get('authorization');
  return Boolean(supplied?.startsWith('Bearer ') && constantTimeEqual(supplied.slice(7), expected));
}

export async function GET(req: Request) {
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };

  // Public probes get only liveness and must not trigger external dependency
  // checks or disclose production configuration.
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: true, service: 'qy-roam' }, { status: 200, headers });
  }

  const { user: adminUser, password: adminPassword } = getAdminCredentials();
  const [paymentSchema, operationsSchema] = await Promise.all([
    hasRequiredPaymentSchema(),
    hasRequiredOperationsSchema(),
  ]);
  const checks = {
    stripe: hasPrefix(process.env.STRIPE_SECRET_KEY, ['sk_live_', 'rk_live_']),
    publishableKey: hasPrefix(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, ['pk_live_']),
    siteUrl: isProductionSiteUrl(process.env.NEXT_PUBLIC_SITE_URL),
    webhook: hasPrefix(process.env.STRIPE_WEBHOOK_SECRET, ['whsec_']),
    supabase: Boolean(process.env.SUPABASE_URL?.startsWith('https://') && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY.length >= 32),
    paymentSchema,
    operationsSchema,
    admin: Boolean(adminUser && isStrongAdminPassword(adminPassword)),
    inventory: isPositiveInteger(process.env.POCKET_WIFI_INVENTORY),
    deliveryLeadDays: isPositiveInteger(process.env.MIN_DELIVERY_LEAD_DAYS),
    fulfilmentEmail: isSmtpConfigured(),
  };
  const paidAcquisitionChecks = {
    metaPixel: isMetaPixelConfigured(),
    metaCapi: isMetaCapiConfigured(),
  };
  const coreReady = checks.stripe && checks.publishableKey && checks.siteUrl;
  const launchReady = Object.values(checks).every(Boolean);
  const paidAcquisitionReady = launchReady && Object.values(paidAcquisitionChecks).every(Boolean);

  const missing = Object.entries(checks).filter(([, configured]) => !configured).map(([name]) => name);
  const paidAcquisitionMissing = Object.entries(paidAcquisitionChecks)
    .filter(([, configured]) => !configured)
    .map(([name]) => name);
  return NextResponse.json({
    ok: coreReady,
    launchReady,
    paidAcquisitionReady,
    service: 'qy-roam',
    checks,
    paidAcquisitionChecks,
    missing,
    paidAcquisitionMissing,
    timestamp: new Date().toISOString()
  }, { status: coreReady ? 200 : 503, headers });
}
