import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { validFulfilmentStatus, validFulfilmentTransition } from '@/lib/orderLifecycle';
import { validateQyRoamSession } from '@/lib/qyRoamSession';
import { deliverFulfilmentNotification, deliverMetaPurchase } from '@/app/api/stripe-webhook/route';

export const runtime = 'nodejs';

function trackingValue(value: unknown, existing: string | null) {
  // Keep an already-recorded reference when an older admin client submits no
  // tracking field, but treat whitespace as absent. A physical dispatch or
  // return without a reference cannot be reliably followed up by operations
  // or the customer.
  if (typeof value !== 'string') return (existing || '').trim();
  return value.trim().slice(0, 200);
}

function transitionErrorStatus(message: string) {
  // Expected operational conflicts are actionable by staff and should not be
  // reported as a server failure. The database remains the authority because
  // another operator can change stock after this request has loaded the order.
  return /changed since it was loaded|out of stock|not available for dispatch|inventory item not found|required before dispatch|required before receipt|cannot be returned without a recorded dispatch|has no inventory item|invalid Pocket WiFi fulfilment transition/i.test(message) ? 409 : 500;
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return NextResponse.json({ error: 'Order database not configured' }, { status: 503 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const status = String(body.status || '');
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id < 1) return NextResponse.json({ error: 'Invalid order id' }, { status: 400 });

  const existing = await supabase.from('orders').select('product_type,payment_status,fulfilment_status,dispatched_at,returned_at,courier_tracking,return_tracking').eq('id', id).maybeSingle();
  if (existing.error) return NextResponse.json({ error: 'Unable to load order' }, { status: 500 });
  if (!existing.data) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  if (!validFulfilmentStatus(existing.data.product_type, status)) return NextResponse.json({ error: 'Invalid fulfilment status for this order' }, { status: 400 });
  if (existing.data.payment_status !== 'paid') {
    return NextResponse.json({ error: 'Only paid orders can be updated for fulfilment' }, { status: 409 });
  }
  if (!validFulfilmentTransition(existing.data.product_type, existing.data.fulfilment_status, status)) {
    return NextResponse.json({ error: 'This fulfilment transition is not allowed for the current order state' }, { status: 409 });
  }

  const courierTracking = trackingValue(body.courier_tracking, existing.data.courier_tracking);
  const returnTracking = trackingValue(body.return_tracking, existing.data.return_tracking);
  if (existing.data.product_type === 'pocket_wifi' && status === 'dispatched' && !courierTracking) {
    return NextResponse.json({ error: 'Courier tracking or delivery reference is required before dispatching a Pocket WiFi order' }, { status: 400 });
  }
  // `returned` is the inventory-release boundary. Require an operator to
  // record the courier tracking/reference first so a missing device cannot be
  // accidentally made available for another overlapping booking.
  if (existing.data.product_type === 'pocket_wifi' && status === 'returned' && !returnTracking) {
    return NextResponse.json({ error: 'Return tracking or receipt reference is required before marking a Pocket WiFi order returned' }, { status: 400 });
  }

  if (existing.data.product_type === 'pocket_wifi') {
    const selectedInventoryItemId = body.inventory_item_id === undefined || body.inventory_item_id === ''
      ? null
      : Number(body.inventory_item_id);
    if (selectedInventoryItemId !== null && (!Number.isSafeInteger(selectedInventoryItemId) || selectedInventoryItemId < 1)) {
      return NextResponse.json({ error: 'Invalid Pocket WiFi inventory item' }, { status: 400 });
    }
    // Dispatch/return update both ledgers inside the database transaction. This
    // is the physical inventory boundary, so do not fall back to a plain order
    // update if the new RPC has not been deployed yet.
    const { data, error } = await supabase.rpc('qy_transition_pocket_wifi_order', {
      p_order_id: id,
      p_expected_status: existing.data.fulfilment_status,
      p_next_status: status,
      p_courier_tracking: typeof body.courier_tracking === 'string' ? courierTracking : null,
      p_return_tracking: typeof body.return_tracking === 'string' ? returnTracking : null,
      p_notes: typeof body.notes === 'string' ? body.notes.slice(0, 1000) : null,
      p_inventory_item_id: selectedInventoryItemId,
    });
    if (error) {
      const message = error.message || 'Unable to update order';
      const conflict = /changed since it was loaded/i.test(message);
      return NextResponse.json({ error: conflict ? 'Order changed since it was loaded. Refresh before updating it.' : message }, { status: transitionErrorStatus(message) });
    }
    const order = Array.isArray(data) ? data[0] : data;
    if (!order?.id) return NextResponse.json({ error: 'Unable to update order' }, { status: 500 });
    return NextResponse.json({ id: order.id, fulfilment_status: order.fulfilment_status }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const patch: Record<string, any> = {
    fulfilment_status: status,
    updated_at: new Date().toISOString(),
  };
  if (typeof body.courier_tracking === 'string') patch.courier_tracking = courierTracking || null;
  if (typeof body.return_tracking === 'string') patch.return_tracking = returnTracking || null;
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

// Stripe retries delivery failures for a finite window. This protected recovery
// action lets an operator safely resume a failed paid-order notification after
// that window: the same per-session ledgers used by the webhook prevent a
// duplicate email or Meta Purchase once either delivery is already marked sent.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return NextResponse.json({ error: 'Order database not configured' }, { status: 503 });
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 });

  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id < 1) return NextResponse.json({ error: 'Invalid order id' }, { status: 400 });

  try {
    const { data: order, error } = await supabase
      .from('orders')
      .select('stripe_session_id,payment_status')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    if (order.payment_status !== 'paid') return NextResponse.json({ error: 'Only paid orders can retry fulfilment notifications' }, { status: 409 });
    if (!String(order.stripe_session_id).startsWith('cs_')) {
      return NextResponse.json({ error: 'Manual orders do not have a Stripe fulfilment notification to retry' }, { status: 409 });
    }

    const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });
    const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
    const validation = validateQyRoamSession(session);
    if (!validation.valid || session.payment_status !== 'paid') {
      return NextResponse.json({ error: 'The linked Stripe session is not a valid paid QY Roam order' }, { status: 409 });
    }

    await deliverFulfilmentNotification(supabase, session);
    // The delivery ledger preserves the original webhook event timestamp when
    // present. For legacy rows that predate the ledger field, session creation
    // time is stable across every admin retry (unlike the current clock).
    await deliverMetaPurchase(supabase, session, session.created);
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('admin_order_notification_retry_error', error);
    return NextResponse.json({ error: 'Unable to retry order notifications. Please try again shortly.' }, { status: 500 });
  }
}
