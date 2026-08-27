import { NextResponse } from 'next/server';

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
  return Boolean(
    process.env.SMTP_HOST &&
    Number.isInteger(port) && port > 0 && port <= 65535 &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS &&
    process.env.SMTP_FROM &&
    (process.env.ORDER_FULFILMENT_EMAIL || 'enquiries@sgsimshop.com').includes('@')
  );
}

export async function GET() {
  const adminUser = process.env.ADMIN_USER || process.env.ADMIN_BASIC_USER;
  const adminPassword = process.env.ADMIN_PASSWORD || process.env.ADMIN_BASIC_PASSWORD;
  const checks = {
    stripe: hasPrefix(process.env.STRIPE_SECRET_KEY, ['sk_live_', 'rk_live_']),
    publishableKey: hasPrefix(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, ['pk_live_']),
    siteUrl: isProductionSiteUrl(process.env.NEXT_PUBLIC_SITE_URL),
    webhook: hasPrefix(process.env.STRIPE_WEBHOOK_SECRET, ['whsec_']),
    supabase: Boolean(
      process.env.SUPABASE_URL?.startsWith('https://') &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      process.env.SUPABASE_SERVICE_ROLE_KEY.length >= 32,
    ),
    admin: Boolean(adminUser && isStrongAdminPassword(adminPassword)),
    inventory: isPositiveInteger(process.env.POCKET_WIFI_INVENTORY),
    deliveryLeadDays: isPositiveInteger(process.env.MIN_DELIVERY_LEAD_DAYS),
    fulfilmentEmail: isSmtpConfigured(),
  };

  const coreReady = checks.stripe && checks.publishableKey && checks.siteUrl;
  const launchReady = Object.values(checks).every(Boolean);
  const missing = Object.entries(checks)
    .filter(([, configured]) => !configured)
    .map(([name]) => name);

  return NextResponse.json(
    {
      ok: coreReady,
      launchReady,
      service: 'qy-roam',
      checks,
      missing,
      timestamp: new Date().toISOString(),
    },
    {
      status: coreReady ? 200 : 503,
      headers: {
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    },
  );
}
