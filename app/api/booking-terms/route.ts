import { NextResponse } from 'next/server';
import { operationalConfig } from '@/lib/operationalConfig';

export const dynamic = 'force-dynamic';

// Publish the same lead-time rule enforced by availability and checkout so
// the date picker can be correct before its first provider-backed request.
export function GET() {
  const config = operationalConfig();
  if (!config) {
    return NextResponse.json({ error: 'Booking terms are temporarily unavailable.' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' },
    });
  }

  // Both values affect the price/date promise rendered before a traveller's
  // first availability lookup. They are public booking terms, and checkout
  // still recalculates them from the same server-side configuration before
  // creating a payment Session.
  return NextResponse.json({
    minDeliveryLeadDays: config.minDeliveryLeadDays,
    courierFeeSgd: config.courierFeeCents / 100,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
