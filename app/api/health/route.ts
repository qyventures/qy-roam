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

export async function GET() {
  const checks = {
    stripe: Boolean(process.env.STRIPE_SECRET_KEY),
    publishableKey: Boolean(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY),
    siteUrl: isProductionSiteUrl(process.env.NEXT_PUBLIC_SITE_URL),
    webhook: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    admin: Boolean(process.env.ADMIN_USER && process.env.ADMIN_PASSWORD),
    inventory: isPositiveInteger(process.env.POCKET_WIFI_INVENTORY),
    deliveryLeadDays: isPositiveInteger(process.env.MIN_DELIVERY_LEAD_DAYS),
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
