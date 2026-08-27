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
    return NextResponse.json({ available: false, error: 'Valid start and end dates are required.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  const minLeadDays = Math.max(0, Number.parseInt(process.env.MIN_DELIVERY_LEAD_DAYS || '2', 10) || 0);
  const earliest = new Date(now);
  earliest.setUTCDate(earliest.getUTCDate() + minLeadDays);
  const rentalDays = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;

  if (start < earliest) {
    return NextResponse.json({ available: false, error: `Please book at least ${minLeadDays} day${minLeadDays === 1 ? '' : 's'} before departure.` }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  if (rentalDays < 1 || rentalDays > 90) {
    return NextResponse.json({ available: false, error: 'Bookings must be between 1 and 90 days.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  const inventory = Math.max(0, Number(process.env.POCKET_WIFI_INVENTORY || '10') || 0);
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ available: inventory > 0, remaining: inventory, inventoryMode: 'configured' }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const from = start.toISOString().slice(0, 10);
  const to = end.toISOString().slice(0, 10);
  const url = new URL('/rest/v1/orders', supabaseUrl);
  url.searchParams.set('select', 'id');
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
    return NextResponse.json({ available: inventory > 0, remaining: inventory, inventoryMode: 'fallback' }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
