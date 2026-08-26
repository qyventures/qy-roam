import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const checks = {
    stripe: Boolean(process.env.STRIPE_SECRET_KEY),
    siteUrl: Boolean(process.env.NEXT_PUBLIC_SITE_URL),
    webhook: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    admin: Boolean(process.env.ADMIN_USER && process.env.ADMIN_PASSWORD),
  };

  const coreReady = checks.stripe && checks.siteUrl;
  const launchReady = coreReady && checks.webhook && checks.supabase && checks.admin;

  return NextResponse.json(
    {
      ok: coreReady,
      launchReady,
      service: 'qy-roam',
      checks,
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
