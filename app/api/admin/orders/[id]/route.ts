import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { validFulfilmentStatus, validFulfilmentTransition } from '@/lib/orderLifecycle';

export const runtime = 'nodejs';

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return NextResponse.json({ error: 'Order database not configured' }, { status: 503 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const status = String(body.status || '');
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id < 1) return NextResponse.json({ error: 'Invalid order id' }, { status: 400 });

  const existing = await supabase.from('orders').select('product_type,payment_status,fulfilment_status,dispatched_at,returned_at').eq('id', id).maybeSingle();
  if (existing.error) return NextResponse.json({ error: 'Unable to load order' }, { status: 500 });
  if (!existing.data) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  if (!validFulfilmentStatus(existing.data.product_type, status)) return NextResponse.json({ error: 'Invalid fulfilment status for this order' }, { status: 400 });
  if (existing.data.payment_status !== 'paid') {
    return NextResponse.json({ error: 'Only paid orders can be updated for fulfilment' }, { status: 409 });
  }
  if (!validFulfilmentTransition(existing.data.product_type, existing.data.fulfilment_status, status)) {
    return NextResponse.json({ error: 'This fulfilment transition is not allowed for the current order state' }, { status: 409 });
  }

  const patch: Record<string, any> = {
    fulfilment_status: status,
    updated_at: new Date().toISOString(),
  };
  if (typeof body.courier_tracking === 'string') patch.courier_tracking = body.courier_tracking.slice(0, 200);
  if (typeof body.return_tracking === 'string') patch.return_tracking = body.return_tracking.slice(0, 200);
  if (typeof body.notes === 'string') patch.notes = body.notes.slice(0, 1000);
  if (status === 'dispatched' && !existing.data.dispatched_at) patch.dispatched_at = new Date().toISOString();
  if (status === 'returned' && !existing.data.returned_at) patch.returned_at = new Date().toISOString();

  // Keep validation and persistence optimistic: another operator may advance
  // the order after the read above. Updating only the state we validated
  // prevents a stale browser from moving a returned/closed order backwards.
  const { data, error } = await supabase.from('orders')
    .update(patch)
    .eq('id', id)
    .eq('payment_status', 'paid')
    .eq('fulfilment_status', existing.data.fulfilment_status)
    .select('id,fulfilment_status')
    .maybeSingle();
  if (error) return NextResponse.json({ error: 'Unable to update order' }, { status: 500 });
  if (!data) {
    return NextResponse.json({ error: 'Order changed since it was loaded. Refresh before updating it.' }, {
      status: 409,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
}
