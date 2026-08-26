import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function parseDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function GET(req: NextRequest) {
  const start = parseDate(req.nextUrl.searchParams.get('start'));
  const end = parseDate(req.nextUrl.searchParams.get('end'));
  if (!start || !end || end < start) {
    return NextResponse.json({ available: false, error: 'Valid start and end dates are required.' }, { status: 400 });
  }

  const inventory = Math.max(0, Number(process.env.POCKET_WIFI_INVENTORY || '10') || 0);
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // If persistence is not configured yet, expose the configured fleet count rather than blocking the MVP.
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ available: inventory > 0, remaining: inventory, inventoryMode: 'configured' }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const from = start.toISOString().slice(0, 10);
  const to = end.toISOString().slice(0, 10);
  const url = new URL('/rest/v1/orders', supabaseUrl);
  url.searchParams.set('select', 'id');
  // Keep these names aligned with supabase/schema.sql.
  url.searchParams.set('travel_start', `lte.${to}`);
  url.searchParams.set('travel_end', `gte.${from}`);
  url.searchParams.set('fulfilment_status', 'not.in.(cancelled,payment_failed,closed)');

  try {
    const res = await fetch(url, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: 'count=exact' },
      cache: 'no-store'
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}`);
    const rows = (await res.json()) as unknown[];
    const remaining = Math.max(0, inventory - rows.length);
    return NextResponse.json({ available: remaining > 0, remaining, inventoryMode: 'live' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('availability check failed', error);
    // This endpoint is advisory; checkout independently fails closed if its live inventory check fails.
    return NextResponse.json({ available: inventory > 0, remaining: inventory, inventoryMode: 'fallback' }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
